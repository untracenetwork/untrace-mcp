import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CLIENT_SECRET_PREFIX } from "@untracenetwork/sdk"
import { vi } from "vitest"

import { createServer, type UntraceLike } from "../src/server"

export const FILE_ID = "6f1c2a4e-8b3d-4c7a-9e21-0d5b7f9a1c33"
export const KEY = "utc_7Kq2mXv9PpR4sTzW8nYbC3"
export const KEY2 = "utc_9Ab3cDe4FgH5jKm6NpQ7rS"
export const OWNER_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
export const SECRET = `${CLIENT_SECRET_PREFIX}Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg`

export const FOLDER_ID = "0b6f8c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e"
export const ENTRY_ID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"
export const SHARE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
export const PUB = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
const SEALED = "c2VhbGVkLWtleS1ieXRlcw=="

const file = { fileId: FILE_ID, folderId: FOLDER_ID, name: "report.pdf", size: 5, mime: "application/pdf", role: "admin", createdAt: "2026-10-08T00:00:00Z" }
const folder = { folderId: FOLDER_ID, name: "Docs", parentId: null, role: "admin", boxPublicKey: PUB, sealedKey: SEALED, keyPath: [] as string[], createdAt: "2026-10-08T00:00:00Z" }
const entry = { entryId: ENTRY_ID, keyType: "client", keyId: KEY2, role: "viewer", scopes: ["download"], createdAt: "2026-10-08T00:00:00Z" }
const share = { shareId: SHARE_ID, resourceType: "folder", resourceId: FOLDER_ID, role: "editor", from: "bob-untrace", sealedKey: SEALED, createdAt: "2026-10-08T00:00:00Z" }
export const METERING = { billedTo: "owner", meteredBytes: 5, usageBytes: 1005, quotaBytes: 10_000 }

export function mockClient() {
  return {
    files: {
      list: vi.fn(async (_o?: unknown) => ({ files: [file], nextCursor: "c2" as string | null })),
      get: vi.fn(async (_id: string) => ({ ...file, wrappedKey: SEALED, keyPath: [] as string[] })),
      upload: vi.fn(async (input: { data: Uint8Array; name: string; folderId: string }) => ({
        file: { ...file, folderId: input.folderId, name: input.name, size: input.data.length, role: "editor" },
        metering: METERING,
      })),
      download: vi.fn(async (_id: string) => ({ bytes: new TextEncoder().encode("hello"), name: "report.pdf", mime: "application/pdf" })),
      rename: vi.fn(async (_id: string, name: string) => ({ fileId: FILE_ID, name })),
      move: vi.fn(async (_id: string, folderId: string | null) => ({ fileId: FILE_ID, name: "report.pdf", folderId })),
      delete: vi.fn(async (_id: string) => ({ fileId: FILE_ID, trashed: true })),
    },
    folders: {
      list: vi.fn(async (_o?: unknown) => ({ folders: [folder] as Record<string, unknown>[], nextCursor: null as string | null })),
      get: vi.fn(async (_id: string) => folder),
      create: vi.fn(async (input: { name: string; parentId?: string | null }) => ({ ...folder, name: input.name, parentId: input.parentId ?? null })),
      rename: vi.fn(async (_id: string, name: string) => ({ ...folder, name })),
      move: vi.fn(async (_id: string, parentId: string | null) => ({ ...folder, parentId })),
      trash: vi.fn(async (_id: string) => ({ removed: true as const })),
    },
    keys: {
      list: vi.fn(async (_r: unknown) => [{ ...entry, sealedKey: SEALED }] as Record<string, unknown>[]),
      attach: vi.fn(async (_r: unknown, input: Record<string, unknown>) => ({ ...entry, keyId: input.keyId, role: input.role })),
      change: vi.fn(async (_r: unknown, _e: string, change: Record<string, unknown>) => ({ ...entry, ...change })),
      remove: vi.fn(async (_r: unknown, _e: string) => ({ removed: true as const })),
    },
    shares: {
      offer: vi.fn(async (input: Record<string, unknown>) => ({ shareId: SHARE_ID, resourceType: input.resourceType, resourceId: input.resourceId, role: input.role, from: "me", createdAt: "2026-10-08T00:00:00Z" })),
      incoming: vi.fn(async () => [share] as Record<string, unknown>[]),
      accept: vi.fn(async (_s: unknown, _i: unknown) => ({ ...entry, keyId: KEY, role: "editor" })),
    },
    clientId: KEY,
    baseUrl: "https://drive.untrace.network",
    boxPublicKey: vi.fn(async () => PUB),
    getToken: vi.fn(async () => ({ scopes: ["download", "upload"], expiresAt: Date.now() + 900_000 })),
  }
}

export type MockClient = ReturnType<typeof mockClient>

export async function harness(opts: { client?: MockClient | (() => UntraceLike); root?: false; shareSecretKey?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "untrace-mcp-")))
  const client = opts.client ?? mockClient()
  const server = createServer({ client: client as unknown as UntraceLike, root: opts.root === false ? false : root, shareSecretKey: opts.shareSecretKey })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(a), mcp.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; [k: string]: any }> }
    const text = r.content.map((c) => c.text ?? "").join("\n")
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { isError: Boolean(r.isError), text, json, content: r.content }
  }
  return {
    root,
    client: client as MockClient,
    mcp,
    call,
    write: (rel: string, data: string | Uint8Array) => writeFile(join(root, rel), data),
    read: (rel: string) => readFile(join(root, rel), "utf8"),
    mkdir: (rel: string) => mkdir(join(root, rel), { recursive: true }),
    symlink: (target: string, rel: string) => symlink(target, join(root, rel)),
    close: async () => {
      await mcp.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
