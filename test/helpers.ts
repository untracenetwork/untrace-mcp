import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { vi } from "vitest"

import { createServer, type UntraceLike } from "../src/server"

export const FILE_ID = "6f1c2a4e-8b3d-4c7a-9e21-0d5b7f9a1c33"
export const KEY = "utc_7Kq2mXv9PpR4sTzW8nYbC3"
export const KEY2 = "utc_9Ab3cDe4FgH5jKm6NpQ7rS"
export const OWNER_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
export const SECRET = "untrace_sk_v1_Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"

const meta = { metering: null, rateLimit: { limit: 600, remaining: 599, reset: 0 } }
const file = { fileId: FILE_ID, name: "report.pdf", size: 5, mime: "application/pdf", role: "admin", createdAt: "2026-10-08T00:00:00Z" }
export const METERING = { clientId: KEY, billedTo: "owner", meteredBytes: 5, usageBytes: 1005, quotaBytes: 10_000, unlimited: false }

export function mockClient() {
  return {
    files: {
      list: vi.fn(async () => ({ files: [file], nextCursor: "c2", meta })),
      get: vi.fn(async () => ({ ...file, scheme: "rs", keyMode: "sealed", wrappedKey: "c2VhbGVkLWtleS1ieXRlcw==", meta })),
      upload: vi.fn(async (input: { data: Uint8Array; name: string }) => ({
        fileId: FILE_ID,
        name: input.name,
        size: input.data.length,
        finalized: true,
        metering: METERING,
        registrationMetering: null,
      })),
      download: vi.fn(async () => ({ fileId: FILE_ID, bytes: new TextEncoder().encode("hello"), name: "report.pdf", mime: "application/pdf", size: 5, nodesChosen: [1, 2, 3], meta })),
      rename: vi.fn(async (_id: string, name: string) => ({ fileId: FILE_ID, name, meta })),
      delete: vi.fn(async () => ({ fileId: FILE_ID, trashed: true, meta })),
    },
    members: {
      list: vi.fn(async () => ({ owner: OWNER_WALLET, members: [{ clientId: KEY, label: "ci", role: "admin", createdAt: "2026-10-08T00:00:00Z" }], meta })),
      add: vi.fn(async (fileId: string, clientId: string, role: string) => ({ fileId, clientId, role })),
      setRole: vi.fn(async (fileId: string, clientId: string, role: string) => ({ fileId, clientId, role })),
      remove: vi.fn(async (fileId: string, clientId: string) => ({ fileId, clientId, revoked: true })),
    },
  }
}

export type MockClient = ReturnType<typeof mockClient>

export async function harness(opts: { client?: MockClient | (() => UntraceLike) } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "untrace-mcp-")))
  const client = opts.client ?? mockClient()
  const server = createServer({ client: client as unknown as UntraceLike, root })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(a), mcp.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> }
    const text = r.content.map((c) => c.text).join("\n")
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { isError: Boolean(r.isError), text, json }
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
