/**
 * The Untrace MCP server: tools over @untracenetwork/sdk (Drive API v1).
 *
 * Credentials come from the environment only (UNTRACE_CLIENT_ID, UNTRACE_CLIENT_SECRET,
 * optional UNTRACE_BASE_URL). No tool accepts a secret as an argument. The client is created
 * lazily, so the server starts (and untrace_setup_guide works) before a key is configured.
 *
 * Files are encrypted and decrypted by the SDK on the machine running this server. Folder and
 * file keys only ever leave it sealed to a recipient's public key.
 */
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  UntraceClient,
  UntraceIntegrityError,
  sealToPublicKey,
  verifyShareKey,
  type DownloadResult,
  type FileList,
  type FileWithKey,
  type OperationId,
  type OwnerShareKey,
  type UploadInput,
  type UploadResult,
} from "@untracenetwork/sdk"
import { z } from "zod"

import { ToolRefusal, toolError } from "./errors"
import { FRAMEWORKS, setupGuide } from "./guide"
import { isSymlink, resolveInsideRoot, resolveRoot } from "./paths"
import { configuredSecrets, redact } from "./redact"
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
    list(opts?: { cursor?: string | null; limit?: number }): Promise<FileList>
    get(fileId: string): Promise<FileWithKey>
    upload(input: UploadInput): Promise<UploadResult>
    download(fileId: string): Promise<DownloadResult>
    rename(fileId: string, name: string): Promise<{ fileId: string; name: string }>
    delete(fileId: string): Promise<{ fileId: string; trashed: boolean }>
  }
  call<T = unknown>(
    operationId: OperationId,
    input?: { params?: Record<string, string>; query?: Record<string, string | number | null | undefined>; body?: unknown }
  ): Promise<T>
  boxPublicKey(): Promise<string>
  openFileKey(sealed: string | null | undefined): Promise<Uint8Array>
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
}

export const TOOL_NAMES = [
  "untrace_list",
  "untrace_get_file",
  "untrace_upload_file",
  "untrace_download_file",
  "untrace_rename_file",
  "untrace_delete_file",
  "untrace_share",
  "untrace_list_keys",
  "untrace_attach_key",
  "untrace_change_key",
  "untrace_remove_key",
  "untrace_whoami",
  "untrace_setup_guide",
] as const

const uuid = z.string().uuid()
const fileIdSchema = uuid.describe("The file id (a UUID), as returned by untrace_list or untrace_upload_file.")
const resourceType = z.enum(["file", "folder"]).describe("Whether resourceId is a file or a folder.")
const resourceId = uuid.describe("The file id or folder id (a UUID).")
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

type Role = z.infer<typeof roleSchema>
type EntryRole = z.infer<typeof entryRole>
type Scope = z.infer<typeof scopeSchema>
type ResourceType = "file" | "folder"

function ok(data: unknown) {
  const text = redact(JSON.stringify(data, null, 2), configuredSecrets())
  return { content: [{ type: "text" as const, text }] }
}

/** Drop key material from API results before returning them. */
function clean(o: object): Record<string, unknown> {
  const { wrappedKey: _wk, sealedKey: _sk, meta: _meta, ...rest } = o as Record<string, unknown>
  return rest
}

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|toml|csv)\b)|\+(json|xml)$/i
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i

const KEY_OPS: Record<ResourceType, { list: OperationId; attach: OperationId; change: OperationId; remove: OperationId; param: string }> = {
  file: { list: "listFileKeys", attach: "attachFileKey", change: "changeFileKey", remove: "removeFileKey", param: "fileId" },
  folder: { list: "listFolderKeys", attach: "attachFolderKey", change: "changeFolderKey", remove: "removeFolderKey", param: "folderId" },
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

  const server = new McpServer(
    { name: "untrace-mcp", version: VERSION },
    {
      instructions: [
        "Untrace Drive tools. This server acts as ONE developer key (client id utc_...). It reaches only folders and files where that key holds a key entry. A not_found answer means the item does not exist OR this key cannot reach it, never which.",
        "Files are encrypted on the machine running this server before upload, and decrypted there after download. Drive stores ciphertext only, in 6 regions, and any 3 recover a file. Untrace cannot read the files.",
        "Sharing with a person: untrace_share offers a file or folder to their Untrace username; they accept in Drive by attaching their OWN key. Nobody can attach a key in someone else's name. The owner can never be removed or demoted.",
        "Credentials are set in this server's environment. Never ask the user for the client secret in chat. Deleting a file or removing a key needs confirm: true after the user agrees.",
        "Developers adding Untrace to their own app: call untrace_setup_guide once the stack is known.",
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

  /** Fetch the sealed key of a file or folder this key holds, and open it on this machine. */
  async function openResourceKey(type: ResourceType, id: string): Promise<Uint8Array> {
    const c = getClient()
    const sealed =
      type === "file"
        ? (await c.files.get(id)).wrappedKey
        : (await c.call<{ sealedKey?: string }>("getFolder", { params: { folderId: id } }))?.sealedKey
    return c.openFileKey(sealed)
  }

  server.registerTool(
    "untrace_list",
    {
      title: "List folders and files",
      description:
        "List what this key can reach: the subfolders and files inside one folder (folderId), or the top level when folderId is left out. Files come with their id, name, size, mime type and this key's role. Paged: pass nextCursor (files) or nextFolderCursor (folders) from a previous answer. If this Drive does not serve folders yet, folders is null and every file the key can reach is listed.",
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
      let note: string | undefined
      if (!cursor) {
        try {
          const r = await c.call<{ folders?: Record<string, unknown>[]; nextCursor?: string | null }>("listFolders", {
            query: { parentId: folderId, cursor: folderCursor, limit },
          })
          folders = (r?.folders ?? []).map((f) => clean(f))
          nextFolderCursor = r?.nextCursor ?? null
        } catch (err) {
          if ((err as { code?: string })?.code !== "planned" || folderId || folderCursor) throw err
          note = "This Drive does not serve folders yet, so every file this key can reach is listed."
        }
      }
      if (folderCursor) return { folderId: folderId ?? null, folders, nextFolderCursor }
      let files: unknown[]
      let nextCursor: string | null
      if (folderId) {
        const r = await c.call<FileList>("listFiles", { query: { folderId, cursor, limit } })
        files = r?.files ?? []
        nextCursor = r?.nextCursor ?? null
      } else {
        const r = await c.files.list({ limit, cursor: cursor ?? null })
        files = r.files
        nextCursor = r.nextCursor
      }
      return { folderId: folderId ?? null, folders, nextFolderCursor, files, nextCursor, ...(note ? { note } : {}) }
    })
  )

  server.registerTool(
    "untrace_get_file",
    {
      title: "Get file details",
      description: "Get one file's metadata (name, size, mime type, created date) and this key's role on it. Does not download the content.",
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
        "Encrypt a file and upload it as a NEW file in the key owner's Drive (needs the upload scope; billed to the owner's plan). Give either path (a local file inside the allowed folder, UNTRACE_MCP_ROOT) or content (the file itself, as text or base64) with a name. At most 16 MB. Returns the new file and the metering. The key becomes an editor of the new file.",
      inputSchema: {
        path: z.string().min(1).optional().describe("Local file to upload, relative to the allowed folder (UNTRACE_MCP_ROOT). Not available on a remote server."),
        content: z.string().max(23_000_000).optional().describe("The file content, when no path is given."),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8").describe("How content is encoded. Default utf8 (plain text)."),
        name: z.string().min(1).max(256).optional().describe("File name in Drive. Required with content; defaults to the local file name with path."),
        mime: z.string().max(128).optional().describe("MIME type, for example application/pdf. Default application/octet-stream."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ path, content, encoding, name, mime }: { path?: string; content?: string; encoding?: "utf8" | "base64"; name?: string; mime?: string }) => {
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
      const r = await getClient().files.upload({ data, name: fileName, mime })
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
      inputSchema: { fileId: fileIdSchema, name: z.string().min(1).max(256).describe("The new file name, 1 to 256 characters.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, name }: { fileId: string; name: string }) => clean(await getClient().files.rename(fileId, name)))
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
    "untrace_share",
    {
      title: "Share with a person by username",
      description:
        "Offer a file or folder to another Untrace user by username, with a role. The file or folder key is opened on the machine running this server and sealed to that user's published sharing key (its signature is checked first), so Untrace never sees it. Nothing is attached yet: the person accepts in Drive, which attaches their OWN key. Needs the manage-sharing scope and role admin.",
      inputSchema: { resourceType, resourceId, username: usernameSchema, role: roleSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id, username, role }: { resourceType: ResourceType; resourceId: string; username: string; role: Role }) => {
      const c = getClient()
      const rec = await c.call<OwnerShareKey>("getUserShareKey", { params: { username } })
      if (!rec || typeof rec.publicKey !== "string" || !verifyShareKey(rec)) {
        throw new UntraceIntegrityError(`untrace: the sharing key published for ${username} does not verify; nothing was shared`)
      }
      const recipient = new Uint8Array(Buffer.from(rec.publicKey, "base64"))
      if (recipient.length !== 32) throw new UntraceIntegrityError(`untrace: the sharing key published for ${username} is not 32 bytes; nothing was shared`)
      const key = await openResourceKey(type, id)
      let sealedKey: string
      try {
        sealedKey = sealToPublicKey(key, recipient)
      } finally {
        key.fill(0)
      }
      const share = await c.call<Record<string, unknown>>("createShare", { body: { resourceType: type, resourceId: id, username, role, sealedKey } })
      return { share: clean(share ?? {}), next: `${username} accepts the share in Untrace Drive, which attaches their own key.` }
    })
  )

  server.registerTool(
    "untrace_list_keys",
    {
      title: "List the keys on a file or folder",
      description:
        "List the key entries set on a file or folder: entry id, key type (passkey, client or device), key id, role (owner, admin, editor, viewer, or none for an explicit block) and scopes. Access is resolved from the top folder down and the nearest entry wins. Needs role admin.",
      inputSchema: { resourceType, resourceId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ resourceType: type, resourceId: id }: { resourceType: ResourceType; resourceId: string }) => {
      const op = KEY_OPS[type]
      const r = await getClient().call<{ entries?: Record<string, unknown>[] }>(op.list, { params: { [op.param]: id } })
      return { resourceType: type, resourceId: id, entries: (r?.entries ?? []).map((e) => clean(e)) }
    })
  )

  server.registerTool(
    "untrace_attach_key",
    {
      title: "Attach a key to a file or folder",
      description:
        "Attach a key the account holds (for example another developer key, keyType client) to a file or folder, with a role and scopes. The file or folder key is opened here and sealed to the attached key's publicKey. Use role none, without publicKey, to block a key here even if a parent folder grants it. To give a person access, use untrace_share instead. Needs the manage-sharing scope and role admin.",
      inputSchema: {
        resourceType,
        resourceId,
        keyType: z.enum(["client", "passkey", "device"]).describe("client: a developer key (keyId utc_...). passkey: an account passkey. device: a hardware key the user holds."),
        keyId: z.string().min(1).max(128).describe("The key's public id: a client id (utc_...), an account address or a hardware key id."),
        role: entryRole,
        scopes: z.array(scopeSchema).max(4).optional().describe("Scopes for this entry: download, upload, manage-sharing, delete."),
        publicKey: publicKeySchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: { resourceType: ResourceType; resourceId: string; keyType: string; keyId: string; role: EntryRole; scopes?: Scope[]; publicKey?: string }) => {
      if (a.keyType === "client" && !/^utc_[1-9A-HJ-NP-Za-km-z]{22}$/.test(a.keyId)) throw new ToolRefusal("Refused: a client keyId is utc_ followed by 22 characters.")
      const body: Record<string, unknown> = { keyType: a.keyType, keyId: a.keyId, role: a.role }
      if (a.scopes) body.scopes = a.scopes
      if (a.role !== "none") {
        if (!a.publicKey) throw new ToolRefusal("Refused: publicKey is required to grant access, because the key is sealed to it. Only role none works without it.")
        const key = await openResourceKey(a.resourceType, a.resourceId)
        try {
          body.sealedKey = sealToPublicKey(key, new Uint8Array(Buffer.from(a.publicKey, "base64")))
        } finally {
          key.fill(0)
        }
      }
      const op = KEY_OPS[a.resourceType]
      return clean((await getClient().call<Record<string, unknown>>(op.attach, { params: { [op.param]: a.resourceId }, body })) ?? {})
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
      const op = KEY_OPS[type]
      const body: Record<string, unknown> = {}
      if (role !== undefined) body.role = role
      if (scopes !== undefined) body.scopes = scopes
      return clean((await getClient().call<Record<string, unknown>>(op.change, { params: { [op.param]: id, entryId }, body })) ?? {})
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
      const op = KEY_OPS[type]
      const r = await getClient().call<Record<string, unknown>>(op.remove, { params: { [op.param]: id, entryId } })
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

  return server
}
