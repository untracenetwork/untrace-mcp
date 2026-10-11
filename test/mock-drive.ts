/**
 * A mock of the Untrace Drive API v1 as a `fetch` function, for tests only. It follows the
 * contract the SDK is generated from (docs/api/openapi.yaml, Drive 1.1.0): OAuth client
 * credentials, the owner's signed sharing key, UTE1 upload and download, files, and the
 * PLANNED folders, key entries and sharing operations (answer 404 with `planned: false`
 * removed, i.e. when `servePlanned` is false, exactly like a Drive that does not ship them yet).
 *
 * The real SDK runs against it, so encryption, sealing and token handling are exercised end to end.
 */
import { randomUUID } from "node:crypto"

import { ed25519, x25519 } from "@noble/curves/ed25519"
import { CLIENT_SECRET_PREFIX, deriveOAuthClientSecret, exportClientSecret, openSealed, parseUte1Header, SHARE_KEY_SIGN_PREFIX } from "@untracenetwork/sdk"

export const BASE = "https://drive.test"
export const CLIENT_ID = "utc_7Kq2mXv9PpR4sTzW8nYbC3"
export const OTHER_CLIENT = "utc_9Ab3cDe4FgH5jKm6NpQ7rS"
export const RAW_SECRET = new Uint8Array(32).map((_, i) => i + 7)
export const SECRET = exportClientSecret(RAW_SECRET)
export const SECRET_BODY = SECRET.slice(CLIENT_SECRET_PREFIX.length)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
export function toBase58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`)
  let out = ""
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")

export interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: Uint8Array
  json: any
}

interface Item {
  id: string
  name: string
  mime: string
  body: Uint8Array
  selfKey: string
  ownerKey: string
  role: "owner" | "admin" | "editor" | "viewer"
  createdAt: string
  trashed: boolean
  folderId: string | null
}
interface Folder {
  id: string
  name: string
  parentId: string | null
  sealedKey: string
  role: "owner" | "admin" | "editor" | "viewer"
  createdAt: string
}
interface Entry {
  entryId: string
  keyType: string
  keyId: string
  role: string
  scopes: string[]
  createdAt: string
  sealedKey?: string
}

export interface MockOptions {
  scopes?: string[]
  /** Serve folders, key entries and sharing (the planned part of the contract). Default true. */
  servePlanned?: boolean
  /** Answer the next N calls to a path (exact or prefix) with this status. */
  failures?: { match: string; status: number; body?: Record<string, unknown>; headers?: Record<string, string>; times: number }[]
  /** Sign a user's sharing key with the wrong key. */
  badUserShareKey?: boolean
}

export function createMockDrive(opts: MockOptions = {}) {
  const requests: Recorded[] = []
  const files = new Map<string, Item>()
  const folders = new Map<string, Folder>()
  const entries = new Map<string, Entry[]>() // by resource id
  const shares: Record<string, unknown>[] = []
  const tokens = new Set<string>()
  const scopes = opts.scopes ?? ["download", "upload", "delete", "manage-sharing"]
  const servePlanned = opts.servePlanned ?? true
  const failures = (opts.failures ?? []).map((f) => ({ ...f }))
  let oauth: string | null = null

  const owner = ed25519.utils.randomPrivateKey()
  const ownerWallet = toBase58(ed25519.getPublicKey(owner))
  const ownerBoxSecret = x25519.utils.randomPrivateKey()
  const ownerBoxPublic = b64(x25519.getPublicKey(ownerBoxSecret))
  const ownerSig = toBase58(ed25519.sign(new TextEncoder().encode(SHARE_KEY_SIGN_PREFIX + ownerBoxPublic), owner))

  // A second user, "bob-untrace", with a published sharing key.
  const bob = ed25519.utils.randomPrivateKey()
  const bobBoxSecret = x25519.utils.randomPrivateKey()
  const bobBoxPublic = b64(x25519.getPublicKey(bobBoxSecret))
  const bobSigner = opts.badUserShareKey ? ed25519.utils.randomPrivateKey() : bob
  const bobRecord = {
    wallet: toBase58(ed25519.getPublicKey(bob)),
    publicKey: bobBoxPublic,
    keySignature: toBase58(ed25519.sign(new TextEncoder().encode(SHARE_KEY_SIGN_PREFIX + bobBoxPublic), bobSigner)),
    signedMessagePrefix: SHARE_KEY_SIGN_PREFIX,
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
  const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, message: error, ...extra }, status)
  const summary = (f: Item) => ({ fileId: f.id, name: f.name, size: f.body.length, mime: f.mime, role: f.role, createdAt: f.createdAt, folderId: f.folderId })
  const folderView = (f: Folder) => ({ folderId: f.id, name: f.name, parentId: f.parentId, role: f.role, sealedKey: f.sealedKey, createdAt: f.createdAt })
  const need = (s: string) => (scopes.includes(s) ? null : err(403, "insufficient_scope", { required: s }))

  async function handler(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? "GET").toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    let body: Uint8Array = new Uint8Array(0)
    if (init.body instanceof Uint8Array) body = init.body
    else if (typeof init.body === "string") body = new TextEncoder().encode(init.body)
    else if (init.body) body = new Uint8Array(await new Response(init.body as any).arrayBuffer())
    let parsed: any = null
    if (headers["content-type"]?.includes("json") && body.length) parsed = JSON.parse(new TextDecoder().decode(body))
    requests.push({ method, path: url.pathname + url.search, headers, body, json: parsed })
    if (url.origin !== BASE) return err(404, "not_found")
    const path = url.pathname

    for (const f of failures) {
      if (f.times > 0 && (path === f.match || path.startsWith(f.match))) {
        f.times--
        return json(f.body ?? { error: "unavailable", message: "try later" }, f.status, f.headers)
      }
    }

    if (path === "/api/v1/oauth/token" && method === "POST") {
      const form = new URLSearchParams(new TextDecoder().decode(body))
      oauth ??= await deriveOAuthClientSecret(RAW_SECRET)
      if (form.get("grant_type") !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400)
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== oauth) return json({ error: "invalid_client" }, 401)
      const t = `tok_${randomUUID()}`
      tokens.add(t)
      return json({ access_token: t, token_type: "Bearer", expires_in: 900, scope: scopes.join(" ") }, 200, { "cache-control": "no-store" })
    }
    const auth = headers.authorization ?? ""
    if (!tokens.has(auth.replace(/^Bearer /, ""))) return err(401, "invalid_client")

    if (path === "/api/v1/owner/share-key" && method === "GET") {
      return json({ wallet: ownerWallet, publicKey: ownerBoxPublic, keySignature: ownerSig, signedMessagePrefix: SHARE_KEY_SIGN_PREFIX })
    }

    if (path === "/api/v1/files" && method === "GET") {
      const folderId = url.searchParams.get("folderId")
      if (folderId && !servePlanned) return err(404, "not_found")
      const limit = Number(url.searchParams.get("limit") ?? 100)
      const cursor = url.searchParams.get("cursor")
      const all = [...files.values()].filter((f) => !f.trashed && (!folderId || f.folderId === folderId)).sort((a, b) => (a.id < b.id ? -1 : 1))
      const start = cursor ? all.findIndex((f) => f.id > cursor) : 0
      const page = start < 0 ? [] : all.slice(start, start + limit)
      const next = start >= 0 && start + limit < all.length ? page[page.length - 1]!.id : null
      return json({ files: page.map(summary), nextCursor: next })
    }

    if (path === "/api/v1/files/upload" && method === "POST") {
      const denied = need("upload")
      if (denied) return denied
      const h = parseUte1Header(body)
      if (!h || h.sealedBytes !== body.length) return err(400, "invalid_request")
      if (body.length > 16 * 1024 * 1024) return err(413, "payload_too_large")
      const f: Item = {
        id: randomUUID(),
        name: decodeURIComponent(headers["x-untrace-file-name"] ?? ""),
        mime: headers["x-untrace-file-type"] ?? "application/octet-stream",
        body,
        selfKey: headers["x-untrace-sealed-key"] ?? "",
        ownerKey: headers["x-untrace-owner-sealed-key"] ?? "",
        role: "editor",
        createdAt: new Date().toISOString(),
        trashed: false,
        folderId: null,
      }
      files.set(f.id, f)
      return json(summary(f), 201, { "x-untrace-billed-to": "owner", "x-untrace-metered-bytes": String(body.length), "x-untrace-usage-bytes": String(body.length + 1000), "x-untrace-quota-bytes": "-1" })
    }

    let m = /^\/api\/v1\/files\/([^/]+)(\/content)?$/.exec(path)
    if (m) {
      const f = files.get(decodeURIComponent(m[1]!))
      if (!f || f.trashed) return err(404, "not_found")
      if (m[2] && method === "GET") {
        return new Response(f.body as any, {
          status: 200,
          headers: { "content-type": "application/octet-stream", "x-untrace-sealed-key": f.selfKey, "x-untrace-file-name": encodeURIComponent(f.name), "x-untrace-file-type": f.mime },
        })
      }
      if (method === "GET") return json({ ...summary(f), wrappedKey: f.selfKey })
      if (method === "PATCH") {
        f.name = parsed?.name ?? f.name
        return json({ fileId: f.id, name: f.name })
      }
      if (method === "DELETE") {
        const denied = need("delete")
        if (denied) return denied
        f.trashed = true
        return json({ fileId: f.id, trashed: true })
      }
    }

    if (!servePlanned) return err(404, "not_found")

    if (path === "/api/v1/folders" && method === "GET") {
      const parent = url.searchParams.get("parentId")
      if (parent && !folders.has(parent)) return err(404, "not_found")
      const list = [...folders.values()].filter((f) => f.parentId === (parent ?? null))
      return json({ folders: list.map(folderView), nextCursor: null })
    }
    m = /^\/api\/v1\/folders\/([^/]+)$/.exec(path)
    if (m && method === "GET") {
      const f = folders.get(m[1]!)
      return f ? json(folderView(f)) : err(404, "not_found")
    }
    m = /^\/api\/v1\/(files|folders)\/([^/]+)\/keys(?:\/([^/]+))?$/.exec(path)
    if (m) {
      const id = m[2]!
      if (!(m[1] === "files" ? files.has(id) : folders.has(id))) return err(404, "not_found")
      const list = entries.get(id) ?? []
      entries.set(id, list)
      if (!m[3] && method === "GET") return json({ entries: list.map(({ sealedKey: _s, ...e }) => e) })
      const denied = need("manage-sharing")
      if (denied) return denied
      if (!m[3] && method === "POST") {
        if (list.some((e) => e.keyId === parsed.keyId)) return err(409, "conflict")
        const e: Entry = { entryId: randomUUID(), keyType: parsed.keyType, keyId: parsed.keyId, role: parsed.role, scopes: parsed.scopes ?? [], createdAt: new Date().toISOString(), sealedKey: parsed.sealedKey }
        list.push(e)
        const { sealedKey: _s, ...view } = e
        return json(view, 201)
      }
      const e = list.find((x) => x.entryId === m![3])
      if (!e) return err(404, "not_found")
      if (e.role === "owner") return err(409, "owner_immutable")
      if (method === "PATCH") {
        if (parsed.role) e.role = parsed.role
        if (parsed.scopes) e.scopes = parsed.scopes
        const { sealedKey: _s, ...view } = e
        return json(view)
      }
      if (method === "DELETE") {
        list.splice(list.indexOf(e), 1)
        return json({ removed: true })
      }
    }
    m = /^\/api\/v1\/users\/([^/]+)\/share-key$/.exec(path)
    if (m && method === "GET") return m[1] === "bob-untrace" ? json(bobRecord) : err(404, "not_found")
    if (path === "/api/v1/shares" && method === "POST") {
      const denied = need("manage-sharing")
      if (denied) return denied
      if (parsed.username !== "bob-untrace") return err(404, "not_found")
      const s = { shareId: randomUUID(), resourceType: parsed.resourceType, resourceId: parsed.resourceId, role: parsed.role, from: "owner-account", createdAt: new Date().toISOString(), sealedKey: parsed.sealedKey }
      shares.push(s)
      const { sealedKey: _s, ...view } = s
      return json(view, 201)
    }
    return err(404, "not_found")
  }

  return {
    fetch: handler as typeof fetch,
    requests,
    files,
    folders,
    entries,
    shares,
    ownerWallet,
    /** What Bob's Drive would do with a share: open the sealed key with his sharing key. */
    bobOpens: (sealed: string) => openSealed(sealed, bobBoxSecret),
    ownerOpens: (sealed: string) => openSealed(sealed, ownerBoxSecret),
    /** Add a folder whose key is sealed to `boxPublicKey` (base64), as Drive would after a share. */
    addFolder(f: { name: string; parentId?: string | null; sealedKey: string; role?: Folder["role"] }) {
      const id = randomUUID()
      folders.set(id, { id, name: f.name, parentId: f.parentId ?? null, sealedKey: f.sealedKey, role: f.role ?? "admin", createdAt: new Date().toISOString() })
      return id
    },
    addEntry(resourceId: string, e: Omit<Entry, "entryId" | "createdAt">) {
      const list = entries.get(resourceId) ?? []
      const full = { entryId: randomUUID(), createdAt: new Date().toISOString(), ...e }
      list.push(full)
      entries.set(resourceId, list)
      return full.entryId
    },
    moveFile(fileId: string, folderId: string | null) {
      files.get(fileId)!.folderId = folderId
    },
  }
}

export type MockDrive = ReturnType<typeof createMockDrive>
