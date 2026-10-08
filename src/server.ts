/**
 * The Untrace MCP server: one tool per UntraceClient operation, plus a setup guide.
 *
 * Credentials come from the environment only (UNTRACE_CLIENT_ID, UNTRACE_CLIENT_SECRET,
 * optional UNTRACE_BASE_URL). No tool accepts a secret as an argument. The client is created
 * lazily, so the server starts (and untrace_setup_guide works) before a key is configured.
 */
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { UntraceClient, type FileDetails, type FileList, type MemberList, type UploadInput, type UploadResult, type DownloadResult } from "@untracenetwork/sdk"
import { z } from "zod"

import { ToolRefusal, toolError } from "./errors"
import { FRAMEWORKS, setupGuide } from "./guide"
import { isSymlink, resolveInsideRoot, resolveRoot } from "./paths"
import { configuredSecrets, redact } from "./redact"
import { VERSION } from "./version"

export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024

type Role = "admin" | "editor" | "viewer"

/** The subset of UntraceClient this server uses (a mock in tests). */
export interface UntraceLike {
  files: {
    list(opts?: { cursor?: string | null; limit?: number }): Promise<FileList>
    get(fileId: string): Promise<FileDetails & { meta?: unknown }>
    upload(input: UploadInput): Promise<UploadResult>
    download(fileId: string): Promise<DownloadResult>
    rename(fileId: string, name: string): Promise<{ fileId: string; name: string }>
    delete(fileId: string): Promise<{ fileId: string; trashed: boolean }>
  }
  members: {
    list(fileId: string): Promise<MemberList>
    add(fileId: string, clientId: string, role: Role): Promise<{ fileId: string; clientId: string; role: Role }>
    setRole(fileId: string, clientId: string, role: Role): Promise<{ fileId: string; clientId: string; role: Role }>
    remove(fileId: string, clientId: string): Promise<{ fileId: string; clientId: string; revoked: boolean }>
  }
}

export interface ServerOptions {
  /** A client, or a factory called on first use. Defaults to `new UntraceClient()` from env. */
  client?: UntraceLike | (() => UntraceLike)
  /** Filesystem root for uploads and downloads. Defaults to UNTRACE_MCP_ROOT, then cwd. */
  root?: string
}

export const TOOL_NAMES = [
  "untrace_list_files",
  "untrace_get_file",
  "untrace_upload_file",
  "untrace_download_file",
  "untrace_rename_file",
  "untrace_delete_file",
  "untrace_list_members",
  "untrace_add_member",
  "untrace_set_member_role",
  "untrace_remove_member",
  "untrace_setup_guide",
] as const

const fileId = z.string().uuid().describe("The file id (a UUID), as returned by untrace_list_files or untrace_upload_file.")
const clientIdSchema = z
  .string()
  .regex(/^utc_[1-9A-HJ-NP-Za-km-z]{22}$/, "clientId must be utc_ followed by 22 base58 characters")
  .describe("The developer key's client id (utc_ followed by 22 characters). Never a secret, never a wallet.")
const role = z.enum(["admin", "editor", "viewer"]).describe("admin: download, rename, manage members, delete. editor: download, rename. viewer: download only. The owner role can never be granted.")

function ok(data: unknown) {
  const text = redact(JSON.stringify(data, null, 2), configuredSecrets())
  return { content: [{ type: "text" as const, text }] }
}

/** Drop rate-limit plumbing and any key material from SDK results before returning them. */
function clean(o: object): Record<string, unknown> {
  const { meta: _meta, wrappedKey: _wk, ...rest } = o as Record<string, unknown>
  return rest
}

export function createServer(opts: ServerOptions = {}): McpServer {
  let client: UntraceLike | null = null
  const getClient = (): UntraceLike => {
    if (client) return client
    const c = opts.client
    client = typeof c === "function" ? c() : (c ?? (new UntraceClient() as unknown as UntraceLike))
    return client
  }
  let rootPromise: Promise<string> | null = null
  const getRoot = () => (rootPromise ??= resolveRoot(opts.root ?? process.env.UNTRACE_MCP_ROOT ?? process.cwd()))

  const server = new McpServer(
    { name: "untrace-mcp", version: VERSION },
    {
      instructions:
        "Untrace Drive tools and routing docs for agents. First ask whether the user is protecting files on desktop or adding secure storage to a website/app. Desktop/personal files route to Untrace Drive or untrace-cli. Developers route to the Drive SDK: Next.js first, then Node.js, React or Vue. AI-agent workflows use this MCP server and untrace_setup_guide. Untrace protects sensitive files by removing the single complete file that normally leaks: files are encrypted and split into shards, but do not claim leaks are impossible. This server acts as ONE developer key, which is a member of individual files (admin, editor or viewer), never a user. It only sees files it is a member of; a 404 means not found OR not a member. The owner of a file can never be changed or removed. Local paths are relative to the allowed folder (UNTRACE_MCP_ROOT). Credentials are set in the environment; never ask the user for the client secret in chat.",
    }
  )

  const run = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (err) {
      return toolError(err)
    }
  }

  server.registerTool(
    "untrace_list_files",
    {
      title: "List files",
      description:
        "List the Untrace Drive files this developer key is a member of, with each file's id, name, size, mime type and the key's role on it. Paged: pass nextCursor from a previous answer to get the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Files per page, 1 to 200. Default is the server's page size."),
        cursor: z.string().max(512).optional().describe("nextCursor from a previous untrace_list_files answer."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ limit, cursor }: { limit?: number; cursor?: string }) => {
      const r = await getClient().files.list({ limit, cursor: cursor ?? null })
      return { files: r.files, nextCursor: r.nextCursor }
    })
  )

  server.registerTool(
    "untrace_get_file",
    {
      title: "Get file details",
      description: "Get one file's metadata (name, size, mime type, created date) and this key's role on it. Does not download the content. A not_found error means the file does not exist or this key is not a member of it.",
      inputSchema: { fileId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ fileId }: { fileId: string }) => clean(await getClient().files.get(fileId)))
  )

  server.registerTool(
    "untrace_upload_file",
    {
      title: "Upload a local file",
      description:
        "Encrypt a local file and upload it as a NEW file in the key owner's Untrace Drive (needs the upload scope; billed to the owner's plan). The file is split into 6 encrypted shards, any 3 rebuild it. Max 95 MB. The path must be inside the allowed folder (UNTRACE_MCP_ROOT). Returns the new fileId and the metering (bytes billed, owner's usage and quota). The key becomes an editor of the new file.",
      inputSchema: {
        path: z.string().min(1).describe("Local file to upload, relative to the allowed folder (UNTRACE_MCP_ROOT)."),
        name: z.string().min(1).max(256).optional().describe("File name in Drive. Defaults to the local file name."),
        mime: z.string().max(128).optional().describe("MIME type, for example application/pdf. Defaults to application/octet-stream."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ path, name, mime }: { path: string; name?: string; mime?: string }) => {
      const abs = await resolveInsideRoot(await getRoot(), path)
      const info = await stat(abs)
      if (!info.isFile()) throw new ToolRefusal(`Refused: ${path} is not a regular file.`)
      if (info.size === 0) throw new ToolRefusal(`Refused: ${path} is empty.`)
      if (info.size > MAX_UPLOAD_BYTES) throw new ToolRefusal(`Refused: ${path} is ${info.size} bytes. Files uploaded with a developer key are limited to 95 MB.`)
      const data = new Uint8Array(await readFile(abs))
      const r = await getClient().files.upload({ data, name: name ?? basename(abs), mime })
      return { fileId: r.fileId, name: r.name, size: r.size, finalized: r.finalized, metering: r.metering ?? r.registrationMetering ?? null }
    })
  )

  server.registerTool(
    "untrace_download_file",
    {
      title: "Download a file to a local path",
      description:
        "Download a file this key is a member of (needs the download scope), decrypt it locally and write it to a path inside the allowed folder (UNTRACE_MCP_ROOT). Refuses to replace an existing file unless overwrite is true. Missing parent folders are created. Returns the written path, name, size and mime type.",
      inputSchema: {
        fileId,
        path: z.string().min(1).describe("Where to write the file, relative to the allowed folder (UNTRACE_MCP_ROOT)."),
        overwrite: z.boolean().optional().default(false).describe("Replace the target if it already exists. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, path, overwrite }: { fileId: string; path: string; overwrite?: boolean }) => {
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
    })
  )

  server.registerTool(
    "untrace_rename_file",
    {
      title: "Rename a file",
      description: "Rename a file in Drive. Needs role editor or admin on that file.",
      inputSchema: { fileId, name: z.string().min(1).max(256).describe("The new file name, 1 to 256 characters.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, name }: { fileId: string; name: string }) => clean(await getClient().files.rename(fileId, name)))
  )

  server.registerTool(
    "untrace_delete_file",
    {
      title: "Move a file to the trash",
      description:
        "Move a file to the owner's trash. Needs the delete scope and role admin on that file. Only the owner can restore or purge it afterwards. You must pass confirm: true; confirm with the user first.",
      inputSchema: {
        fileId,
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
    "untrace_list_members",
    {
      title: "List a file's members",
      description:
        "List the owner (a wallet, never changeable) and the developer keys that are members of a file, with their roles. Needs the manage-sharing scope and role admin on that file.",
      inputSchema: { fileId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ fileId }: { fileId: string }) => {
      const r = await getClient().members.list(fileId)
      return { fileId, owner: r.owner, members: r.members }
    })
  )

  server.registerTool(
    "untrace_add_member",
    {
      title: "Add a developer key to a file",
      description:
        "Make another developer key (same owner) a member of a file with role admin, editor or viewer. The file key is sealed to that key locally; Untrace never sees it. Needs the manage-sharing scope and role admin. Members are developer keys only: people are shared with in Drive.",
      inputSchema: { fileId, clientId: clientIdSchema, role },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ fileId, clientId, role }: { fileId: string; clientId: string; role: Role }) => getClient().members.add(fileId, clientId, role))
  )

  server.registerTool(
    "untrace_set_member_role",
    {
      title: "Change a member's role",
      description: "Change a developer key's role on a file to admin, editor or viewer. The owner's role can never be changed. Needs the manage-sharing scope and role admin.",
      inputSchema: { fileId, clientId: clientIdSchema, role },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, clientId, role }: { fileId: string; clientId: string; role: Role }) => getClient().members.setRole(fileId, clientId, role))
  )

  server.registerTool(
    "untrace_remove_member",
    {
      title: "Remove a developer key from a file",
      description:
        "Remove a developer key's membership of a file, so it can no longer reach it. The owner can never be removed. Needs the manage-sharing scope and role admin.",
      inputSchema: {
        fileId,
        clientId: z.string().min(1).max(64).describe("The member's client id (utc_...). Passing the owner's wallet is refused."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ fileId, clientId }: { fileId: string; clientId: string }) => {
      if (!/^utc_/.test(clientId)) {
        throw new ToolRefusal("Refused: only developer keys (utc_...) are members. The owner of a file can never be removed.")
      }
      return getClient().members.remove(fileId, clientId)
    })
  )

  server.registerTool(
    "untrace_setup_guide",
    {
      title: "Set up the Drive SDK in an app",
      description:
        "Return step-by-step instructions, with code, for adding Untrace Drive to a developer's own Next.js, Node.js, React or Vue app using the @untracenetwork packages. Works offline and needs no key.",
      inputSchema: {
        framework: z.enum(FRAMEWORKS).describe("nextjs, node, react or vue."),
        includeReference: z.boolean().optional().default(true).describe("Also include scopes, roles, metering and error reference. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ framework, includeReference }: { framework: (typeof FRAMEWORKS)[number]; includeReference?: boolean }) => ({
      content: [{ type: "text" as const, text: setupGuide(framework, includeReference ?? true) }],
    })
  )

  return server
}
