/**
 * Secrets v0: untrace_secret_set, _get, _list, _share, _unshare.
 *
 * End to end with the real SDK against the mock Drive (test/mock-drive.ts), so the values are
 * really encrypted on this machine and Drive only ever sees ciphertext. Name validation and
 * redaction have their own unit tests below.
 */
import { UntraceClient } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { configuredSecrets, forgetSecretValues, redact, redactExcept, rememberSecretValue } from "../src/redact"
import { SECRET_MIME, validateSecretName } from "../src/secrets"
import type { UntraceLike } from "../src/server"
import { harness } from "./helpers"
import { BASE, CLIENT_ID, OTHER_CLIENT, SECRET, createMockDrive, type MockDrive } from "./mock-drive"

const ALL = ["download", "upload", "delete", "manage-sharing"]
const VALUE = "fake-api-key-for-tests-0123456789abcdef"
const OTHER_PUB = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="

let drive: MockDrive
let client: UntraceClient
let h: Awaited<ReturnType<typeof harness>>

async function setup(opts: Parameters<typeof createMockDrive>[0] = { scopes: ALL }) {
  drive = createMockDrive(opts)
  client = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: drive.handler, maxRetries: 0 })
  h = await harness({ client: (() => client as unknown as UntraceLike) as never })
}

beforeEach(async () => {
  forgetSecretValues()
  await setup()
})
afterEach(async () => {
  await h.close()
  forgetSecretValues()
})

const wire = () => drive.requests.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.headers)} ${Buffer.from(r.body).toString("latin1")}`).join("\n")
const folderNamed = (name: string, parentId: string | null) => [...drive.folders.values()].find((f) => f.name === name && f.parentId === parentId)

describe("untrace_secret_set", () => {
  it("stores the value encrypted under /.untrace/secrets/<name> and never echoes it", async () => {
    const r = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain(VALUE)
    expect(r.json).toMatchObject({ name: "openai", version: 1, stored: true, shared: false })
    expect(r.json.value).toBeUndefined()

    const vault = folderNamed(".untrace", null)!
    const secrets = folderNamed("secrets", vault.folderId)!
    const folder = folderNamed("openai", secrets.folderId)!
    expect(r.json.id).toBe(folder.folderId)
    const files = [...drive.files.values()].filter((f) => f.folderId === folder.folderId)
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe("v1")
    expect(files[0]!.mime).toBe(SECRET_MIME)
    // Drive only ever saw ciphertext.
    expect(wire()).not.toContain(VALUE)
    // The owner can open it, like any file an agent uploads.
    expect(drive.openOwnerKey(files[0]!)).toHaveLength(32)
  })

  it("setting again adds the next version and reuses the vault folders", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    const r = await h.call("untrace_secret_set", { name: "openai", value: `${VALUE}-rotated` })
    expect(r.json.version).toBe(2)
    expect([...drive.folders.values()].filter((f) => f.name === ".untrace")).toHaveLength(1)
    expect([...drive.folders.values()].filter((f) => f.name === "openai")).toHaveLength(1)
    expect(r.text).not.toContain(VALUE)
  })

  it("nested names are one folder each, named by the full name", async () => {
    const r = await h.call("untrace_secret_set", { name: "stripe/live_key", value: VALUE })
    expect(r.isError).toBe(false)
    expect(folderNamed("stripe/live_key", folderNamed("secrets", folderNamed(".untrace", null)!.folderId)!.folderId)).toBeTruthy()
  })

  it.each(["../escape", "a/../b", "/abs", "trailing/", "a//b", ".", "..", "has space", "semi;colon", "x".repeat(129), ""])(
    "refuses the name %j before calling Drive",
    async (name) => {
      const before = drive.requests.length
      const r = await h.call("untrace_secret_set", { name, value: VALUE })
      expect(r.isError).toBe(true)
      expect(r.text).not.toContain(VALUE)
      expect(drive.requests.length).toBe(before)
    }
  )

  it("refuses a value over 64 KB without echoing it", async () => {
    const big = `${VALUE}${"x".repeat(70_000)}`
    const r = await h.call("untrace_secret_set", { name: "big", value: big })
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(VALUE)
  })

  it("without the upload scope it fails with insufficient_scope and no value", async () => {
    await h.close()
    await setup({ scopes: ["download"] })
    const r = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^insufficient_scope:/)
    expect(r.text).not.toContain(VALUE)
  })
})

describe("untrace_secret_get", () => {
  it("returns the newest value, decrypted on this machine", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.call("untrace_secret_set", { name: "openai", value: `${VALUE}-v2` })
    const r = await h.call("untrace_secret_get", { name: "openai" })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ name: "openai", version: 2, value: `${VALUE}-v2` })
  })

  it("an unknown name is refused, never a guess", async () => {
    const r = await h.call("untrace_secret_get", { name: "nope" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^refused: .*no secret named nope/)
  })

  it("refuses a path-unsafe name", async () => {
    const r = await h.call("untrace_secret_get", { name: "../../etc/passwd" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^refused:/)
  })

  it("values with quotes, newlines and unicode come back exactly", async () => {
    const odd = 'line1\nline2 "quoted" \\ back ünï 🔑 and more'
    await h.call("untrace_secret_set", { name: "odd", value: odd })
    const r = await h.call("untrace_secret_get", { name: "odd" })
    expect(r.json.value).toBe(odd)
  })

  it("reads a secret another key shared with this key (a top-level secret folder)", async () => {
    // The other key's vault folder, which this key cannot reach, holds the secret folder.
    const theirs = await drive.addFolder({ name: "secrets", mine: false })
    const f = await drive.addFolder({ name: "github/token", parentId: theirs.folderId, mine: true, role: "viewer" })
    // Another key of the owner wrote v1 into it; this key reaches it through its entry.
    await drive.addFolder({ name: "Unrelated", mine: true })
    const writer = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: drive.handler, maxRetries: 0 })
    f.entries[0]!.role = "admin"
    await writer.files.upload({ folderId: f.folderId, data: new TextEncoder().encode(VALUE), name: "v1", mime: SECRET_MIME })
    f.entries[0]!.role = "viewer"
    const r = await h.call("untrace_secret_get", { name: "github/token" })
    expect(r.isError).toBe(false)
    expect(r.json.value).toBe(VALUE)
    const l = await h.call("untrace_secret_list")
    expect(l.json.secrets).toEqual([expect.objectContaining({ name: "github/token", shared: true, role: "viewer", version: 1 })])
  })
})

describe("untrace_secret_list", () => {
  it("names and metadata only, never values", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.call("untrace_secret_set", { name: "anthropic", value: `${VALUE}-b` })
    await h.call("untrace_secret_set", { name: "anthropic", value: `${VALUE}-c` })
    const r = await h.call("untrace_secret_list")
    expect(r.isError).toBe(false)
    expect(r.json.secrets.map((s: { name: string }) => s.name)).toEqual(["anthropic", "openai"])
    expect(r.json.secrets[0]).toMatchObject({ version: 2, role: "admin", shared: false })
    expect(r.json.secrets[0].value).toBeUndefined()
    expect(r.text).not.toContain(VALUE)
    // Listing never downloads content.
    expect(drive.requests.some((q) => q.url.includes("/content"))).toBe(false)
  })

  it("an empty vault lists nothing and creates nothing", async () => {
    const r = await h.call("untrace_secret_list")
    expect(r.json.secrets).toEqual([])
    expect(folderNamed(".untrace", null)).toBeUndefined()
  })

  it("ordinary top-level folders are not mistaken for secrets", async () => {
    await drive.addFolder({ name: "Contracts", mine: true })
    const r = await h.call("untrace_secret_list")
    expect(r.json.secrets).toEqual([])
  })
})

describe("untrace_secret_share and untrace_secret_unshare", () => {
  it("share attaches another key of the same owner to the secret's folder, sealed to its public key", async () => {
    const s = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    const r = await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "viewer" })
    expect(r.isError).toBe(false)
    expect(r.json.entry).toMatchObject({ keyType: "client", keyId: OTHER_CLIENT, role: "viewer", scopes: ["download"] })
    expect(r.json.entry.sealedKey).toBeUndefined()
    const entry = drive.folders.get(s.json.id)!.entries.find((e) => e.keyId === OTHER_CLIENT)!
    expect(entry.sealedKey).toBeTruthy()
    expect(r.text).not.toContain(VALUE)
  })

  it("sharing again changes the role instead of adding a second entry", async () => {
    const s = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "viewer" })
    const r = await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "editor" })
    expect(r.json.entry.role).toBe("editor")
    expect(drive.folders.get(s.json.id)!.entries.filter((e) => e.keyId === OTHER_CLIENT)).toHaveLength(1)
  })

  it("refuses sharing with this same key, a bad client id or a bad public key", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    expect((await h.call("untrace_secret_share", { name: "openai", clientId: CLIENT_ID, publicKey: OTHER_PUB, role: "viewer" })).text).toMatch(/^refused:/)
    expect((await h.call("untrace_secret_share", { name: "openai", clientId: "utc_bad", publicKey: OTHER_PUB, role: "viewer" })).isError).toBe(true)
    expect((await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: "short", role: "viewer" })).isError).toBe(true)
    expect((await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "owner" })).isError).toBe(true)
  })

  it("without manage-sharing, share fails with insufficient_scope", async () => {
    await h.close()
    await setup({ scopes: ["download", "upload"] })
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    const r = await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "viewer" })
    expect(r.text).toMatch(/^insufficient_scope:/)
  })

  it("unshare removes the key's entry; unsharing again is refused", async () => {
    const s = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "editor" })
    const r = await h.call("untrace_secret_unshare", { name: "openai", clientId: OTHER_CLIENT })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ name: "openai", clientId: OTHER_CLIENT, removed: true })
    expect(drive.folders.get(s.json.id)!.entries.some((e) => e.keyId === OTHER_CLIENT)).toBe(false)
    const again = await h.call("untrace_secret_unshare", { name: "openai", clientId: OTHER_CLIENT })
    expect(again.text).toMatch(/^refused: .*not shared with/)
  })

  it("unshare also removes the other key's entries on versions it wrote", async () => {
    const s = await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.call("untrace_secret_share", { name: "openai", clientId: OTHER_CLIENT, publicKey: OTHER_PUB, role: "editor" })
    const v1 = [...drive.files.values()].find((f) => f.folderId === s.json.id)!
    ;(v1.entries ??= []).push({ entryId: crypto.randomUUID(), keyType: "client", keyId: OTHER_CLIENT, role: "editor", scopes: ["download"], sealedKey: null, createdAt: new Date().toISOString() })
    v1.role = "admin"
    const r = await h.call("untrace_secret_unshare", { name: "openai", clientId: OTHER_CLIENT })
    expect(r.json.versionEntriesRemoved).toBe(1)
    expect(v1.entries!.some((e) => e.keyId === OTHER_CLIENT)).toBe(false)
  })

  it("the unshare tool is marked destructive", async () => {
    const { tools } = await h.mcp.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(by.untrace_secret_unshare!.annotations!.destructiveHint).toBe(true)
    expect(by.untrace_secret_list!.annotations!.readOnlyHint).toBe(true)
    expect(by.untrace_secret_get!.annotations!.readOnlyHint).toBe(true)
  })
})

describe("secret tool descriptions", () => {
  it("tell the model never to print values unless the user explicitly asks, with no dashes", async () => {
    const { tools } = await h.mcp.listTools()
    for (const n of ["untrace_secret_set", "untrace_secret_get"]) {
      const t = tools.find((x) => x.name === n)!
      expect(t.description).toMatch(/Never print a secret value in the chat unless the user explicitly asks/)
    }
    for (const t of tools.filter((x) => x.name.startsWith("untrace_secret_"))) expect(JSON.stringify(t)).not.toMatch(/[\u2013\u2014]/)
    expect(tools.find((x) => x.name === "untrace_secret_list")!.description).toMatch(/Never returns a value/)
  })
})

describe("secret redaction", () => {
  it("a value set once is redacted from every later result and error", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    // A later tool whose output happens to contain the value (here: a file named after it).
    const up = await h.call("untrace_upload_file", { folderId: (await h.call("untrace_list")).json.folders[0].folderId, content: "x", name: `leak ${VALUE}` })
    expect(up.text).not.toContain(VALUE)
    expect(up.text).toContain("[redacted]")
  })

  it("a value read with get is redacted everywhere except get's own value field", async () => {
    const f = await drive.addFolder({ name: "shared-key", mine: true })
    await client.files.upload({ folderId: f.folderId, data: new TextEncoder().encode(VALUE), name: "v1", mime: SECRET_MIME })
    forgetSecretValues()
    const g = await h.call("untrace_secret_get", { name: "shared-key" })
    expect(g.json.value).toBe(VALUE)
    const again = await h.call("untrace_secret_get", { name: "shared-key" })
    expect(again.json.value).toBe(VALUE)
    expect(again.text.split(VALUE)).toHaveLength(2)
    expect(configuredSecrets({})).toContain(VALUE)
  })

  it("redactExcept keeps only the named field, and still redacts the client secret elsewhere", () => {
    const out = redactExcept({ name: `n ${SECRET}`, value: VALUE }, "value", [VALUE, SECRET])
    expect(JSON.parse(out).value).toBe(VALUE)
    expect(out).not.toContain(SECRET)
  })

  it("rememberSecretValue covers the JSON-escaped form, and short values are left alone", () => {
    const v = 'pa"ss\nword-12345'
    rememberSecretValue(v)
    expect(redact(JSON.stringify({ x: v }), configuredSecrets({}))).not.toContain("word-12345")
    rememberSecretValue("short")
    expect(configuredSecrets({})).not.toContain("short")
  })

  it("an SDK error that carries a stored value is redacted", async () => {
    await h.call("untrace_secret_set", { name: "openai", value: VALUE })
    await h.close()
    const leaky = createMockDrive({ scopes: ALL, failures: [{ match: "/api/v1/folders", status: 500, body: { error: "server_error", message: `boom ${VALUE}` }, times: 1 }] })
    const c = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: leaky.handler, maxRetries: 0 })
    h = await harness({ client: (() => c as unknown as UntraceLike) as never })
    const r = await h.call("untrace_secret_list")
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(VALUE)
  })
})

describe("validateSecretName", () => {
  it.each(["openai", "stripe/live_key", "a.b-c_d", "A/B/C", "x".repeat(64)])("accepts %j", (n) => {
    expect(validateSecretName(n)).toBe(n)
  })
  it.each(["", "..", ".", "../x", "x/..", "x/./y", "/x", "x/", "x//y", "a b", "a\\b", "a\u0000b", "é", "x".repeat(65), "a/b/c/d/e/f/g/h/i"])("refuses %j", (n) => {
    expect(() => validateSecretName(n)).toThrow(/^Refused:/)
  })
  it("refuses non-strings", () => {
    expect(() => validateSecretName(undefined)).toThrow(/required/)
    expect(() => validateSecretName(42)).toThrow(/required/)
  })
})
