/**
 * The Untrace MCP server: tools over @untracenetwork/sdk (Drive API v1).
 *
 * Credentials come from the environment only (UNTRACE_CLIENT_ID, UNTRACE_CLIENT_SECRET,
 * optional UNTRACE_BASE_URL). No tool accepts a secret as an argument. The client is created
 * lazily, so the server starts (and untrace_setup_guide works) before a key is configured.
 *
 * Files are encrypted and decrypted by the SDK on the machine running this server. Folder and
 * file keys only ever leave it sealed to a recipient's public key, and the SDK does all of that
 * sealing: this server holds no cryptography of its own.
 */
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  UntraceClient,
  type AcceptShareInput,
  type AttachKeyInput,
  type CallOptions,
  type CreateFolderInput,
  type DownloadResult,
  type EntryRole,
  type FileList,
  type FileWithKey,
  type Folder,
  type FolderList,
  type GrantRole,
  type KeyEntry,
  type ListOptions,
  type OfferShareInput,
  type ResourceRef,
  type Scope,
  type Share,
  type UploadInput,
  type UploadResult,
} from "@untracenetwork/sdk"
import { z } from "zod"

import { ToolRefusal, toolError } from "./errors"
import { FRAMEWORKS, setupGuide } from "./guide"
import { isSymlink, resolveInsideRoot, resolveRoot } from "./paths"
import { configuredSecrets, redact, redactExcept, rememberSecretValue } from "./redact"
import { MAX_SECRET_BYTES, Vault, validateSecretName } from "./secrets"
import { VERSION } from "./version"

/** Drive accepts at most 16 MiB of ciphertext per upload in API v1; leave room for the framing. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 - 64 * 1024
/** Largest file returned inline (in the tool result) when no local path is used. */
export const DEFAULT_MAX_INLINE_BYTES = 4 * 1024 * 1024

/** The subset of UntraceClient this server uses (a mock in tests). */
export interface UntraceLike {
  readonly clientId: string
  readonly baseUrl: string
  files: {
    list(opts?: ListOptions & { folderId?: string | null }): Promise<FileList>
    get(fileId: string): Promise<FileWithKey>
    upload(input: UploadInput): Promise<UploadResult>
    download(fileId: string): Promise<DownloadResult>
    rename(fileId: string, name: string): Promise<{ fileId: string; name: string }>
    move(fileId: string, folderId: string | null): Promise<{ fileId: string; name: string; folderId: string | null }>
    delete(fileId: string): Promise<{ fileId: string; trashed: boolean }>
  }
  folders: {
    list(opts?: ListOptions & { parentId?: string | null }): Promise<FolderList>
    get(folderId: string): Promise<Folder>
    create(input: CreateFolderInput): Promise<Folder>
    rename(folderId: string, name: string): Promise<Folder>
    move(folderId: string, parentId: string | null): Promise<Folder>
    trash(folderId: string): Promise<{ removed: true }>
  }
  keys: {
    list(resource: ResourceRef): Promise<KeyEntry[]>
    attach(resource: ResourceRef, input: AttachKeyInput): Promise<KeyEntry>
    change(resource: ResourceRef, entryId: string, change: { role?: EntryRole; scopes?: Scope[] }): Promise<KeyEntry>
    remove(resource: ResourceRef, entryId: string): Promise<{ removed: true }>
  }
  shares: {
    offer(input: OfferShareInput): Promise<Share>
    incoming(call?: CallOptions): Promise<Share[]>
    accept(share: Pick<Share, "shareId" | "sealedKey">, input: AcceptShareInput): Promise<KeyEntry>
  }
  boxPublicKey(): Promise<string>
  getToken(): Promise<{ scopes: string[]; expiresAt: number }>
}

export interface ServerOptions {
  /** A client, or a factory called on first use. Defaults to `new UntraceClient()` from env. */
  client?: UntraceLike | (() => UntraceLike)
  /**
   * Filesystem root for path-based uploads and downloads. Defaults to UNTRACE_MCP_ROOT, then
   * the working directory. `false` turns local paths off (the HTTP default unless
   * UNTRACE_MCP_ROOT is set): content then travels inline in tool arguments and results.
   */
  root?: string | false
  /** Inline download limit in bytes. Default UNTRACE_MCP_MAX_INLINE_BYTES or 4 MiB. */
  maxInlineBytes?: number
  /**
   * The account's sharing secret key (32 bytes), to accept shares with this key. Default
   * UNTRACE_SHARE_SECRET_KEY (standard base64). Unset: untrace_accept_share refuses and the
   * person accepts in Drive.
   */
  shareSecretKey?: string
}

export const TOOL_NAMES = [
  "untrace_list",
  "untrace_get_file",
  "untrace_upload_file",
  "untrace_download_file",
  "untrace_rename_file",
  "untrace_move_file",
  "untrace_delete_file",
  "untrace_create_folder",
  "untrace_get_folder",
  "untrace_rename_folder",
  "untrace_move_folder",
  "untrace_trash_folder",
  "untrace_share",
  "untrace_list_incoming_shares",
  "untrace_accept_share",
  "untrace_list_keys",
  "untrace_attach_key",
  "untrace_change_key",
  "untrace_remove_key",
  "untrace_whoami",
  "untrace_setup_guide",
  "untrace_secret_set",
  "untrace_secret_get",
  "untrace_secret_list",
  "untrace_secret_share",
  "untrace_secret_unshare",
] as const

const uuid = z.string().uuid()
const fileIdSchema = uuid.describe("The file id (a UUID), as returned by untrace_list or untrace_upload_file.")
const folderIdSchema = uuid.describe("The folder id (a UUID), as returned by untrace_list or untrace_create_folder.")
const resourceType = z.enum(["file", "folder"]).describe("Whether resourceId is a file or a folder.")
const resourceId = uuid.describe("The file id or folder id (a UUID).")
const nameSchema = z.string().min(1).max(256)
const roleSchema = z
  .enum(["admin", "editor", "viewer"])
  .describe("admin: everything below plus manage keys and delete. editor: download, add files, rename. viewer: download only. The owner role is never granted.")
const entryRole = z
  .enum(["admin", "editor", "viewer", "none"])
  .describe("admin, editor or viewer grant access. none is an explicit block: it denies this key here even if a parent folder grants it.")
const scopeSchema = z.enum(["download", "upload", "manage-sharing", "delete"])
const usernameSchema = z
  .string()
  .regex(/^[a-z0-9-]{6,32}$/, "username is 6 to 32 characters: a-z, 0-9 and -")
  .describe("The Untrace username of the person to share with.")
const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "publicKey is a 32-byte key in standard base64 (44 characters)")
  .describe("The box public key of the key you attach (standard base64, 44 characters). A server running as that key shows it with untrace_whoami.")

type ResourceType = "file" | "folder"

function ok(data: unknown) {
  const text = redact(JSON.stringify(data, null, 2), configuredSecrets())
  return { content: [{ type: "text" as const, text }] }
}

/** Drop key material from API results before returning them. Public keys stay. */
function clean(o: object | null | undefined): Record<string, unknown> {
  const { wrappedKey: _wk, sealedKey: _sk, keyPath: _kp, meta: _meta, ...rest } = (o ?? {}) as Record<string, unknown>
  return rest
}

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|toml|csv)\b)|\+(json|xml)$/i
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i
const CLIENT_ID_RE = /^utc_[1-9A-HJ-NP-Za-km-z]{22}$/

function decodeShareSecret(b64: string | undefined): Uint8Array | null {
  const v = b64?.trim()
  if (!v) return null
  const bytes = new Uint8Array(Buffer.from(v, "base64"))
  if (bytes.length !== 32) throw new ToolRefusal("Refused: UNTRACE_SHARE_SECRET_KEY must be 32 bytes in standard base64.")
  return bytes
}

export function createServer(opts: ServerOptions = {}): McpServer {
  let client: UntraceLike | null = null
  const getClient = (): UntraceLike => {
    if (client) return client
    const c = opts.client
    client = typeof c === "function" ? c() : (c ?? (new UntraceClient() as unknown as UntraceLike))
    return client
  }
  const rootSetting = opts.root === undefined ? (process.env.UNTRACE_MCP_ROOT ?? process.cwd()) : opts.root
  let rootPromise: Promise<string> | null = null
  const getRoot = (): Promise<string> => {
    if (rootSetting === false) {
      return Promise.reject(
        new ToolRefusal("Refused: local paths are turned off on this server (remote MCP). Upload with content, and download without a path to get the content inline.")
      )
    }
    return (rootPromise ??= resolveRoot(rootSetting))
  }
  const maxInline = opts.maxInlineBytes ?? (Number(process.env.UNTRACE_MCP_MAX_INLINE_BYTES) || DEFAULT_MAX_INLINE_BYTES)
  const shareSecretSetting = opts.shareSecretKey ?? process.env.UNTRACE_SHARE_SECRET_KEY

  const server = new McpServer(
    { name: "untrace-mcp", version: VERSION },
    {
      instructions: [
        "Untrace Drive tools. This server acts as ONE developer key (client id utc_...). It reaches only folders and files where that key holds a key entry. A not_found answer means the item does not exist OR this key cannot reach it, never which.",
        "Files are encrypted on the machine running this server before upload, and decrypted there after download. Drive stores ciphertext only, in 6 regions, and any 3 recover a file. Untrace cannot read the files.",
        "Every file lives in a folder. A key uploads only into a folder it was added to (role editor or admin, scope upload): pick one with untrace_list or make one with untrace_create_folder.",
        "Sharing with a person: untrace_share offers a file or folder to their Untrace username; they accept by attaching their OWN key. Nobody can attach a key in someone else's name. The owner can never be removed or demoted.",
        "Credentials are set in this server's environment. Never ask the user for the client secret in chat. Deleting a file, trashing a folder or removing a key needs confirm: true after the user agrees.",
        "Developers adding Untrace to their own app: call untrace_setup_guide once the stack is known.",
        "Secrets (API keys, tokens, passwords): when the user gives you one, store it with untrace_secret_set instead of keeping it in the chat, and read it back with untrace_secret_get only when a task needs it. Never print a secret value in the chat unless the user explicitly asks to see it.",
      ].join(" "),
    }
  )

  type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean }
  const isToolResult = (v: unknown): v is ToolResult =>
    Boolean(v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content))

  const run =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<any> => {
      try {
        const out = await fn(args)
        return isToolResult(out) ? out : ok(out)
      } catch (err) {
        return toolError(err)
      }
    }

  const ref = (type: ResourceType, id: string): ResourceRef => ({ type, id })

server.registerTool(
    "untrace_list",
    {
      title: "List folders and files",
      description:
        "List what this key can reach: the subfolders and files inside one folder (folderId), or the top-level folders this key was added to plus every file it can reach when folderId is left out. Items come with their id, name and this key's role. Paged: pass nextCursor (files) or nextFolderCursor (folders) from a previous answer.",
      inputSchema: {
        folderId: uuid.optional().describe("List inside this folder. Leave out for the top level."),
        limit: z.number().int().min(1).max(200).optional().describe("Items per page, 1 to 200."),
        cursor: uuid.optional().describe("nextCursor from a previous answer: the next page of files."),
        folderCursor: uuid.optional().describe("nextFolderCursor from a previous answer: the next page of folders."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ folderId, limit, cursor, folderCursor }: { folderId?: string; limit?: number; cursor?: string; folderCursor?: string }) => {
      const c = getClient()
      let folders: unknown[] | null = null
      let nextFolderCursor: string | null = null
      if (!cursor) {
        const r = await c.folders.list({ parentId: folderId ?? null, cursor: folderCursor ?? null, limit })
        folders = r.folders.map((f) => clean(f))
        nextFolderCursor = r.nextCursor
      }
      if (folderCursor) return { folderId: folderId ?? null, folders, nextFolderCursor }
      const r = await c.files.list({ folderId: folderId ?? null, cursor: cursor ?? null, limit })
      return { folderId: folderId ?? null, folders, nextFolderCursor, files: r.files.map((f) => clean(f)), nextCursor: r.nextCursor }
    })
  )

  server.registerTool(
    "untrace_get_file",
    {
      title: "Get file details",
      description: "Get one file's metadata (name, size, mime type, folder, created date) and this key's role on it. Does not download the content.",
      inputSchema: { fileId: fileIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ fileId }: { fileId: string }) => clean(await getClient().files.get(fileId)))
  )

  server.registerTool(
    "untrace_upload_file",
    {
      title: "Upload a file",
      description:
        "Encrypt a file and upload it as a NEW file into a folder (needs the upload scope; billed to the owner's plan). folderId is required: the file must go into a folder this key was added to, with role editor or admin (see untrace_list, or make one with untrace_create_folder). Give either path (a local file inside the allowed folder, UNTRACE_MCP_ROOT) or content (the file itself, as text or base64) with a name. At most 16 MB. Returns the new file and the metering. Your key becomes an editor of the new file.",
      inputSchema: {
        folderId: uuid.describe("REQUIRED. The folder to put the file in. This key must have been added to it (role editor or admin)."),
        path: z.string().min(1).optional().describe("Local file to upload, relative to the allowed folder (UNTRACE_MCP_ROOT). Not available on a remote server."),
        content: z.string().max(23_000_000).optional().describe("The file content, when no path is given."),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8").describe("How content is encoded. Default utf8 (plain text)."),
        name: nameSchema.optional().describe("File name in Drive. Required with content; defaults to the local file name with path."),
        mime: z.string().max(128).optional().describe("MIME type, for example application/pdf. Default application/octet-stream."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ folderId, path, content, encoding, name, mime }: { folderId: string; path?: string; content?: string; encoding?: "utf8" | "base64"; name?: string; mime?: string }) => {
      if ((path == null) === (content == null)) throw new ToolRefusal("Refused: give exactly one of path or content.")
      let data: Uint8Array
      let fileName: string
      if (path != null) {
        const abs = await resolveInsideRoot(await getRoot(), path)
        const info = await stat(abs)
        if (!info.isFile()) throw new ToolRefusal(`Refused: ${path} is not a regular file.`)
        if (info.size > MAX_UPLOAD_BYTES) throw new ToolRefusal(`Refused: ${path} is ${info.size} bytes. One upload is at most 16 MB in this version.`)
        data = new Uint8Array(await readFile(abs))
        fileName = name ?? basename(abs)
      } else {
        if (!name) throw new ToolRefusal("Refused: name is required when uploading content.")
        if (encoding === "base64") {
          const b64 = content!.replace(/\s+/g, "")
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new ToolRefusal("Refused: content is not valid base64.")
          data = new Uint8Array(Buffer.from(b64, "base64"))
        } else data = new TextEncoder().encode(content!)
        fileName = name
      }
      if (data.length === 0) throw new ToolRefusal("Refused: the file is empty.")
      if (data.length > MAX_UPLOAD_BYTES) throw new ToolRefusal(`Refused: the file is ${data.length} bytes. One upload is at most 16 MB in this version.`)
      const r = await getClient().files.upload({ folderId, data, name: fileName, mime })
      return { file: clean(r.file), metering: r.metering }
    })
  )

  server.registerTool(
    "untrace_download_file",
    {
      title: "Download a file",
      description:
        "Download a file this key can reach (needs the download scope) and decrypt it on the machine running this server. With path, write it inside the allowed folder (UNTRACE_MCP_ROOT); an existing file is only replaced with overwrite: true. Without path, return the content in the answer (text, image or base64), up to the inline limit.",
      inputSchema: {
        fileId: fileIdSchema,
        path: z.string().min(1).optional().describe("Where to write the file, relative to the allowed folder. Leave out to get the content inline."),
        overwrite: z.boolean().optional().default(false).describe("Replace the target if it already exists. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, path, overwrite }: { fileId: string; path?: string; overwrite?: boolean }) => {
      if (path != null) {
        const root = await getRoot()
        const abs = await resolveInsideRoot(root, path)
        if (await isSymlink(abs)) throw new ToolRefusal(`Refused: ${path} is a symlink. Choose another path.`)
        const existing = await stat(abs).catch(() => null)
        if (existing?.isDirectory()) throw new ToolRefusal(`Refused: ${path} is a folder. Give a file path.`)
        if (existing && !overwrite) throw new ToolRefusal(`Refused: ${path} already exists. Pass overwrite: true to replace it, or choose another path.`)
        const r = await getClient().files.download(fileId)
        await mkdir(dirname(abs), { recursive: true })
        // Re-check after mkdir: a parent created by another process must not lead outside the root.
        await resolveInsideRoot(root, path)
        const fh = await open(abs, overwrite ? "w" : "wx", 0o600)
        try {
          await fh.writeFile(r.bytes)
        } finally {
          await fh.close()
        }
        return { fileId, path: abs, name: r.name, mime: r.mime, size: r.bytes.length }
      }
      const r = await getClient().files.download(fileId)
      if (r.bytes.length > maxInline) {
        throw new ToolRefusal(`Refused: the file is ${r.bytes.length} bytes, over the inline limit of ${maxInline} bytes. Download it to a path with a local server instead.`)
      }
      const meta = ok({ fileId, name: r.name, mime: r.mime, size: r.bytes.length }).content[0]!
      const uri = `untrace://files/${fileId}`
      if (IMAGE_MIME.test(r.mime)) {
        return { content: [meta, { type: "image", data: Buffer.from(r.bytes).toString("base64"), mimeType: r.mime }] }
      }
      if (TEXT_MIME.test(r.mime)) {
        return { content: [meta, { type: "resource", resource: { uri, mimeType: r.mime, text: new TextDecoder().decode(r.bytes) } }] }
      }
      return { content: [meta, { type: "resource", resource: { uri, mimeType: r.mime, blob: Buffer.from(r.bytes).toString("base64") } }] }
    })
  )

  server.registerTool(
    "untrace_rename_file",
    {
      title: "Rename a file",
      description: "Rename a file in Drive. Needs role editor or admin on that file.",
      inputSchema: { fileId: fileIdSchema, name: nameSchema.describe("The new file name, 1 to 256 characters.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, name }: { fileId: string; name: string }) => clean(await getClient().files.rename(fileId, name)))
  )

  server.registerTool(
    "untrace_move_file",
    {
      title: "Move a file to another folder",
      description:
        "Move a file into another folder. Needs role admin on the file and on the target folder. The file key is opened on this machine and sealed to the target folder's public key, which is checked first, so Untrace never sees it.",
      inputSchema: { fileId: fileIdSchema, folderId: folderIdSchema.describe("The target folder (a UUID).") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, folderId }: { fileId: string; folderId: string }) => clean(await getClient().files.move(fileId, folderId)))
  )

  server.registerTool(
    "untrace_delete_file",
    {
      title: "Move a file to the trash",
      description:
        "Move a file to the owner's trash. Needs the delete scope and role admin on that file. Only the owner can restore or purge it afterwards, in Drive. Pass confirm: true only after the user has agreed.",
      inputSchema: {
        fileId: fileIdSchema,
        confirm: z.boolean().describe("Must be true. Set it only after the user has confirmed the deletion."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, confirm }: { fileId: string; confirm: boolean }) => {
      if (confirm !== true) throw new ToolRefusal("Refused: deleting moves the file to the owner's trash. Ask the user, then call again with confirm: true.")
      return clean(await getClient().files.delete(fileId))
    })
  )

  server.registerTool(
    "untrace_create_folder",
    {
      title: "Create a folder",
      description:
        "Create a folder, at the top level of the key owner's Drive (this key becomes its admin) or inside a folder this key can add to (parentId, role editor or admin). Needs the upload scope. A fresh folder key is made on this machine; Drive only receives its public key and sealed copies.",
      inputSchema: {
        name: nameSchema.describe("The folder name, 1 to 256 characters."),
        parentId: uuid.optional().describe("Create inside this folder. Leave out for the top level."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ name, parentId }: { name: string; parentId?: string }) => clean(await getClient().folders.create({ name, parentId: parentId ?? null })))
  )

  server.registerTool(
    "untrace_get_folder",
    {
      title: "Get folder details",
      description: "Get one folder's name, parent, created date, this key's role on it and its public key. Lists nothing inside it: use untrace_list with folderId for that.",
      inputSchema: { folderId: folderIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ folderId }: { folderId: string }) => clean(await getClient().folders.get(folderId)))
  )

  server.registerTool(
    "untrace_rename_folder",
    {
      title: "Rename a folder",
      description: "Rename a folder. Needs role editor or admin on it.",
      inputSchema: { folderId: folderIdSchema, name: nameSchema.describe("The new folder name, 1 to 256 characters.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ folderId, name }: { folderId: string; name: string }) => clean(await getClient().folders.rename(folderId, name)))
  )

  server.registerTool(
    "untrace_move_folder",
    {
      title: "Move a folder under another folder",
      description:
        "Move a folder, with everything in it, under another folder. Needs role admin on the folder and role editor or admin on the target. A folder cannot move inside itself. The folder key is opened on this machine and sealed to the target's checked public key.",
      inputSchema: { folderId: folderIdSchema, parentId: uuid.describe("The target parent folder (a UUID).") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ folderId, parentId }: { folderId: string; parentId: string }) => clean(await getClient().folders.move(folderId, parentId)))
  )

  server.registerTool(
    "untrace_trash_folder",
    {
      title: "Move a folder to the trash",
      description:
        "Move a folder, its subfolders and their files to the owner's trash. Needs the delete scope and role admin. Only the owner can restore or purge it afterwards, in Drive. Pass confirm: true only after the user has agreed.",
      inputSchema: {
        folderId: folderIdSchema,
        confirm: z.boolean().describe("Must be true. Set it only after the user has confirmed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ folderId, confirm }: { folderId: string; confirm: boolean }) => {
      if (confirm !== true) throw new ToolRefusal("Refused: this moves the folder and everything in it to the owner's trash. Ask the user, then call again with confirm: true.")
      return { folderId, ...(await getClient().folders.trash(folderId)) }
    })
  )

  server.registerTool(
    "untrace_share",
    {
      title: "Share with a person by username",
      description:
        "Offer a file or folder to another Untrace user by username, with a role. The file or folder key is opened on the machine running this server and sealed to that user's published sharing key (its signature is checked first), so Untrace never sees it. Nothing is attached yet: the person accepts, which attaches their OWN key. Needs the manage-sharing scope and role admin.",
      inputSchema: { resourceType, resourceId, username: usernameSchema, role: roleSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id, username, role }: { resourceType: ResourceType; resourceId: string; username: string; role: GrantRole }) => {
      const share = await getClient().shares.offer({ resourceType: type, resourceId: id, username, role })
      return { share: clean(share), next: `${username} accepts the share, which attaches their own key.` }
    })
  )

  server.registerTool(
    "untrace_list_incoming_shares",
    {
      title: "List shares offered to you",
      description: "List the pending shares other users offered to the account that owns this key: share id, file or folder, role and who offered it.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => ({ shares: (await getClient().shares.incoming()).map((s) => clean(s)) }))
  )

  server.registerTool(
    "untrace_accept_share",
    {
      title: "Accept a share with this key",
      description:
        "Accept a pending share by attaching THIS developer key to the shared file or folder. The offered key is sealed to the account's sharing key, so this works only when the server runs with UNTRACE_SHARE_SECRET_KEY set; otherwise accept in Untrace Drive. The key is opened and re-sealed to this key on this machine.",
      inputSchema: { shareId: uuid.describe("The share id, from untrace_list_incoming_shares.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ shareId }: { shareId: string }) => {
      const secret = decodeShareSecret(shareSecretSetting)
      if (!secret) {
        throw new ToolRefusal("Refused: this server has no sharing key (UNTRACE_SHARE_SECRET_KEY is not set). Accept the share in Untrace Drive instead.")
      }
      try {
        const c = getClient()
        const share = (await c.shares.incoming()).find((s) => s.shareId === shareId)
        if (!share) throw new ToolRefusal("Refused: no pending share with that id. untrace_list_incoming_shares lists them.")
        return clean(await c.shares.accept(share, { shareSecretKey: secret }))
      } finally {
        secret.fill(0)
      }
    })
  )

  server.registerTool(
    "untrace_list_keys",
    {
      title: "List the keys on a file or folder",
      description:
        "List the key entries set on a file or folder: entry id, key type (passkey or client), key id, role (owner, admin, editor, viewer, or none for an explicit block) and scopes. Access is resolved from the top folder down and the nearest entry wins. Needs the manage-sharing scope and role admin.",
      inputSchema: { resourceType, resourceId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id }: { resourceType: ResourceType; resourceId: string }) => {
      const entries = await getClient().keys.list(ref(type, id))
      return { resourceType: type, resourceId: id, entries: entries.map((e) => clean(e)) }
    })
  )

  server.registerTool(
    "untrace_attach_key",
    {
      title: "Attach a key to a file or folder",
      description:
        "Attach a key the account holds (another developer key, keyType client, or the account's passkey, keyType passkey) to a file or folder, with a role and scopes. The file or folder key is opened here and sealed to the attached key's publicKey. Use role none, without publicKey, to block a key here even if a parent folder grants it. To give a person access, use untrace_share instead. Needs the manage-sharing scope and role admin.",
      inputSchema: {
        resourceType,
        resourceId,
        keyType: z.enum(["client", "passkey"]).describe("client: a developer key (keyId utc_...). passkey: the account's passkey (keyId: the account address)."),
        keyId: z.string().min(8).max(128).describe("The key's public id: a client id (utc_...) or an account address."),
        role: entryRole,
        scopes: z.array(scopeSchema).max(4).optional().describe("Scopes for this entry: download, upload, manage-sharing, delete."),
        publicKey: publicKeySchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: { resourceType: ResourceType; resourceId: string; keyType: "client" | "passkey"; keyId: string; role: EntryRole; scopes?: Scope[]; publicKey?: string }) => {
      if (a.keyType === "client" && !CLIENT_ID_RE.test(a.keyId)) throw new ToolRefusal("Refused: a client keyId is utc_ followed by 22 characters.")
      if (a.role !== "none" && !a.publicKey) throw new ToolRefusal("Refused: publicKey is required to grant access, because the key is sealed to it. Only role none works without it.")
      const input: AttachKeyInput = { keyType: a.keyType, keyId: a.keyId, role: a.role }
      if (a.scopes) input.scopes = a.scopes
      if (a.role !== "none") input.publicKey = a.publicKey
      return clean(await getClient().keys.attach(ref(a.resourceType, a.resourceId), input))
    })
  )

  server.registerTool(
    "untrace_change_key",
    {
      title: "Change a key's role or scopes",
      description:
        "Change the role (admin, editor, viewer, or none to block) or the scopes of a key entry on a file or folder. The owner entry can never be changed. Needs the manage-sharing scope and role admin.",
      inputSchema: {
        resourceType,
        resourceId,
        entryId: uuid.describe("The entry id, from untrace_list_keys."),
        role: entryRole.optional(),
        scopes: z.array(scopeSchema).max(4).optional().describe("The new scopes for this entry."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id, entryId, role, scopes }: { resourceType: ResourceType; resourceId: string; entryId: string; role?: EntryRole; scopes?: Scope[] }) => {
      if (role === undefined && scopes === undefined) throw new ToolRefusal("Refused: give role, scopes or both.")
      const change: { role?: EntryRole; scopes?: Scope[] } = {}
      if (role !== undefined) change.role = role
      if (scopes !== undefined) change.scopes = scopes
      return clean(await getClient().keys.change(ref(type, id), entryId, change))
    })
  )

  server.registerTool(
    "untrace_remove_key",
    {
      title: "Remove a key from a file or folder",
      description:
        "Remove a key entry from a file or folder, so that key no longer reaches it through this entry. The owner entry can never be removed. Pass confirm: true only after the user has agreed. Needs the manage-sharing scope and role admin.",
      inputSchema: {
        resourceType,
        resourceId,
        entryId: uuid.describe("The entry id, from untrace_list_keys."),
        confirm: z.boolean().describe("Must be true. Set it only after the user has confirmed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id, entryId, confirm }: { resourceType: ResourceType; resourceId: string; entryId: string; confirm: boolean }) => {
      if (confirm !== true) throw new ToolRefusal("Refused: removing a key cuts its access. Ask the user, then call again with confirm: true.")
      const r = await getClient().keys.remove(ref(type, id), entryId)
      return { resourceType: type, resourceId: id, entryId, ...(r ?? {}) }
    })
  )

  server.registerTool(
    "untrace_whoami",
    {
      title: "Show this key",
      description:
        "Show the developer key this server acts as: its client id, the Drive it talks to, the scopes its token holds, and its box public key. The public key is safe to share: an admin passes it to untrace_attach_key to give this key access. Never shows the secret.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => {
      const c = getClient()
      const [publicKey, token] = await Promise.all([c.boxPublicKey(), c.getToken()])
      return { clientId: c.clientId, baseUrl: c.baseUrl, scopes: token.scopes, publicKey }
    })
  )

  server.registerTool(
    "untrace_setup_guide",
    {
      title: "Set up the Drive SDK in an app",
      description:
        "Return step-by-step instructions, with code, for adding Untrace Drive to a developer's own Next.js, Node.js, React or Vue app with the @untracenetwork packages. Works offline and needs no key.",
      inputSchema: {
        framework: z.enum(FRAMEWORKS).describe("nextjs, node, react or vue."),
        includeReference: z.boolean().optional().default(true).describe("Also include the scopes, roles and errors reference. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ framework, includeReference }: { framework: (typeof FRAMEWORKS)[number]; includeReference?: boolean }) => ({
      content: [{ type: "text" as const, text: setupGuide(framework, includeReference ?? true) }],
    })
  )

  const secretNameSchema = z
    .string()
    .min(1)
    .max(128)
    .describe("The secret name, for example openai or stripe/live_key: letters, digits, . _ - and / between parts, at most 128 characters. Case sensitive.")
  const NEVER_PRINT = "Never print a secret value in the chat unless the user explicitly asks to see it."
  const vault = () => new Vault(getClient())
  const sharedFlag = z
    .boolean()
    .optional()
    .describe("Use a secret another key of the same owner shared with this key, instead of this key's own vault. Default false: own vault only.")
  const sharedId = uuid.optional().describe("The shared secret's id, from untrace_secret_list with includeShared: true. Implies shared: true.")
  type Target = { shared?: boolean; id?: string }

  server.registerTool(
    "untrace_secret_set",
    {
      title: "Store a secret value",
      description: `Store a secret value (an API key, token or password) in Untrace under a name, so it never has to be pasted into a chat again. The value is encrypted on the machine running this server, like any file, into this key's vault. Setting a name again stores a new version; the old one is kept. It writes only into this key's own vault, even if a shared secret has the same name. To set a new version of a secret shared with this key, pass shared: true (or its id): Untrace accepts that only when the secret belongs to this key's own owner and this key is editor or admin. The answer never contains the value: only the name, id and version. Needs the upload scope. ${NEVER_PRINT}`,
      inputSchema: {
        name: secretNameSchema,
        value: z.string().min(1).max(MAX_SECRET_BYTES).describe("The value to keep. It is never sent back by this tool."),
        shared: sharedFlag,
        id: sharedId,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ name, value, shared, id }: { name: string; value: string } & Target) => {
      rememberSecretValue(value)
      validateSecretName(name)
      if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) throw new ToolRefusal(`Refused: a secret value is at most ${MAX_SECRET_BYTES} bytes.`)
      const r = await vault().set(name, value, { shared, id })
      return { ...r, stored: true }
    })
  )

  server.registerTool(
    "untrace_secret_get",
    {
      title: "Read a secret value",
      description: `Read the newest version of a secret in this key's own vault. For a secret another key shared with this key, pass shared: true (or its id); the answer then says shared: true. Returns the value so you can use it in a task, for example in an API call or a config file. ${NEVER_PRINT} Do not repeat it in your reply, and do not write it to a file the user did not ask for. Needs the download scope.`,
      inputSchema: { name: secretNameSchema, shared: sharedFlag, id: sharedId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ name, shared, id }: { name: string } & Target) => {
      validateSecretName(name)
      const r = await vault().get(name, { shared, id })
      const text = redactExcept({ name: r.name, id: r.id, version: r.version, createdAt: r.createdAt, shared: r.shared, value: r.value }, "value", configuredSecrets())
      return { content: [{ type: "text" as const, text }] }
    })
  )

  server.registerTool(
    "untrace_secret_list",
    {
      title: "List secrets",
      description:
        "List the secrets in this key's own vault, by name, with id, this key's role, newest version and when it was last set. With includeShared: true, also the secrets shared with this key, marked shared: true. Never returns a value: read one with untrace_secret_get when a task needs it.",
      inputSchema: {
        includeShared: z.boolean().optional().describe("Also list secrets shared with this key, marked shared: true. Default false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ includeShared }: { includeShared?: boolean }) => ({ secrets: await vault().list({ includeShared }) }))
  )

  server.registerTool(
    "untrace_secret_share",
    {
      title: "Share a secret with another agent key",
      description:
        "Give another developer key of the SAME owner access to a secret, with a role: viewer can read it, editor can also set new versions, admin can also share it on. Untrace enforces the same owner: it attaches only keys of this key's own owner and refuses any other. The secret key is opened on this machine and sealed to that key's public key, so Untrace never sees it. Later versions reach it without sharing again. To find the other key's publicKey, run untrace_whoami on the server that runs as it. Needs the manage-sharing scope and role admin on the secret. To give a person access, use Untrace Drive.",
      inputSchema: {
        name: secretNameSchema,
        clientId: z.string().regex(CLIENT_ID_RE, "clientId is utc_ followed by 22 characters").describe("The other developer key's client id (utc_...)."),
        publicKey: publicKeySchema,
        role: roleSchema,
        shared: sharedFlag,
        id: sharedId,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ name, clientId, publicKey, role, shared, id }: { name: string; clientId: string; publicKey: string; role: GrantRole } & Target) => {
      validateSecretName(name)
      if (clientId === getClient().clientId) throw new ToolRefusal("Refused: this key already holds the secret. Give the client id of another key.")
      const r = await vault().share(name, clientId, publicKey, role, { shared, id })
      return { name: r.name, id: r.id, entry: clean(r.entry) }
    })
  )

  server.registerTool(
    "untrace_secret_unshare",
    {
      title: "Stop sharing a secret with a key",
      description:
        "Remove another developer key's access to a secret, so it can no longer read new or old versions from Untrace. It cannot un-read a value it already read: rotate the secret at its provider and set the new value with untrace_secret_set. Pass confirm: true only after the user has agreed. Needs the manage-sharing scope and role admin on the secret.",
      inputSchema: {
        name: secretNameSchema,
        clientId: z.string().regex(CLIENT_ID_RE, "clientId is utc_ followed by 22 characters").describe("The client id (utc_...) to remove."),
        shared: sharedFlag,
        id: sharedId,
        confirm: z.boolean().describe("Must be true. Set it only after the user has confirmed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ name, clientId, shared, id, confirm }: { name: string; clientId: string; confirm: boolean } & Target) => {
      if (confirm !== true) throw new ToolRefusal("Refused: unsharing a secret cuts that key's access. Ask the user, then call again with confirm: true.")
      validateSecretName(name)
      return vault().unshare(name, clientId, { shared, id })
    })
  )

  return server
}
