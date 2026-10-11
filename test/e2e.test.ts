/**
 * End to end: the real @untracenetwork/sdk client against a mock Drive (test/mock-drive.ts).
 * Encryption, key sealing, signature checks and token handling all run for real.
 */
import { UntraceClient } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { UntraceLike } from "../src/server"
import { harness } from "./helpers"
import { BASE, CLIENT_ID, OTHER_CLIENT, SECRET, SECRET_BODY, createMockDrive, type MockDrive } from "./mock-drive"

let drive: MockDrive
let h: Awaited<ReturnType<typeof harness>>

async function setup(opts: Parameters<typeof createMockDrive>[0] = {}) {
  drive = createMockDrive(opts)
  const client = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: drive.fetch, maxRetries: 0 })
  h = await harness({ client: (() => client as unknown as UntraceLike) as never })
}

beforeEach(async () => {
  await setup()
})
afterEach(async () => {
  await h.close()
})

const allText = () => JSON.stringify(drive.requests.map((r) => ({ ...r, body: Buffer.from(r.body).toString("latin1") })))

describe("end to end with the real SDK", () => {
  it("upload encrypts on this machine; download decrypts back to the same bytes", async () => {
    const up = await h.call("untrace_upload_file", { content: "the quarterly numbers", name: "q3.txt", mime: "text/plain" })
    expect(up.isError).toBe(false)
    const fileId = up.json.file.fileId as string
    const stored = drive.files.get(fileId)!
    expect(Buffer.from(stored.body).toString("latin1")).not.toContain("quarterly")
    expect(up.json.metering.billedTo).toBe("owner")

    const down = await h.call("untrace_download_file", { fileId })
    expect(down.content[1]!.resource.text).toBe("the quarterly numbers")
    await h.call("untrace_download_file", { fileId, path: "q3.txt" })
    expect(await h.read("q3.txt")).toBe("the quarterly numbers")
  })

  it("the owner can open the file key the SDK sealed to the owner's sharing key", async () => {
    const up = await h.call("untrace_upload_file", { content: "x", name: "x.txt" })
    expect(drive.ownerOpens(drive.files.get(up.json.file.fileId)!.ownerKey)).toHaveLength(32)
  })

  it("list, rename and delete round trip", async () => {
    const up = await h.call("untrace_upload_file", { content: "x", name: "a.txt" })
    const id = up.json.file.fileId
    const list = await h.call("untrace_list")
    expect(list.json.files.map((f: { fileId: string }) => f.fileId)).toEqual([id])
    expect(list.json.folders).toEqual([])
    expect((await h.call("untrace_rename_file", { fileId: id, name: "b.txt" })).json.name).toBe("b.txt")
    expect((await h.call("untrace_delete_file", { fileId: id, confirm: true })).json.trashed).toBe(true)
    expect((await h.call("untrace_get_file", { fileId: id })).text).toMatch(/^not_found:/)
  })

  it("share by username: the recipient can open the sealed key, Drive never sees it in the clear", async () => {
    const up = await h.call("untrace_upload_file", { content: "shared doc", name: "s.txt" })
    const id = up.json.file.fileId
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: id, username: "bob-untrace", role: "viewer" })
    expect(r.isError).toBe(false)
    expect(r.json.share.sealedKey).toBeUndefined()
    const share = drive.shares[0] as { sealedKey: string; role: string }
    expect(share.role).toBe("viewer")
    const bobKey = drive.bobOpens(share.sealedKey)
    expect(bobKey).toHaveLength(32)
  })

  it("share refuses a recipient key with a bad signature and sends nothing", async () => {
    await h.close()
    await setup({ badUserShareKey: true })
    const up = await h.call("untrace_upload_file", { content: "x", name: "x" })
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: up.json.file.fileId, username: "bob-untrace", role: "viewer" })
    expect(r.text).toMatch(/^integrity:/)
    expect(drive.shares).toHaveLength(0)
  })

  it("attach, list, change and remove a client key", async () => {
    const up = await h.call("untrace_upload_file", { content: "x", name: "x" })
    const id = up.json.file.fileId
    const me = await h.call("untrace_whoami")
    expect(me.json.clientId).toBe(CLIENT_ID)
    const att = await h.call("untrace_attach_key", { resourceType: "file", resourceId: id, keyType: "client", keyId: OTHER_CLIENT, role: "viewer", scopes: ["download"], publicKey: me.json.publicKey })
    expect(att.isError).toBe(false)
    const listed = await h.call("untrace_list_keys", { resourceType: "file", resourceId: id })
    const entry = listed.json.entries.find((e: { keyId: string }) => e.keyId === OTHER_CLIENT)
    expect(entry.role).toBe("viewer")
    expect((await h.call("untrace_change_key", { resourceType: "file", resourceId: id, entryId: entry.entryId, role: "editor" })).json.role).toBe("editor")
    expect((await h.call("untrace_remove_key", { resourceType: "file", resourceId: id, entryId: entry.entryId, confirm: true })).isError).toBe(false)
    expect((await h.call("untrace_list_keys", { resourceType: "file", resourceId: id })).json.entries).toEqual([])
  })

  it("the owner entry can never be changed", async () => {
    const up = await h.call("untrace_upload_file", { content: "x", name: "x" })
    const id = up.json.file.fileId
    const entryId = drive.addEntry(id, { keyType: "passkey", keyId: drive.ownerWallet, role: "owner", scopes: [] })
    const r = await h.call("untrace_change_key", { resourceType: "file", resourceId: id, entryId, role: "viewer" })
    expect(r.text).toMatch(/^owner_immutable:/)
  })

  it("folders: list inside a folder", async () => {
    const up = await h.call("untrace_upload_file", { content: "x", name: "in-folder.txt" })
    const me = await h.call("untrace_whoami")
    const { sealToPublicKey, newFileKey } = await import("@untracenetwork/sdk")
    const folderId = drive.addFolder({ name: "Docs", sealedKey: sealToPublicKey(newFileKey(), new Uint8Array(Buffer.from(me.json.publicKey, "base64"))) })
    drive.moveFile(up.json.file.fileId, folderId)
    const top = await h.call("untrace_list")
    expect(top.json.folders.map((f: { name: string }) => f.name)).toEqual(["Docs"])
    expect(top.json.folders[0].sealedKey).toBeUndefined()
    const inside = await h.call("untrace_list", { folderId })
    expect(inside.json.files.map((f: { name: string }) => f.name)).toEqual(["in-folder.txt"])
    // Attaching on the folder opens the folder key, sealed to this key.
    const att = await h.call("untrace_attach_key", { resourceType: "folder", resourceId: folderId, keyType: "client", keyId: OTHER_CLIENT, role: "viewer", publicKey: me.json.publicKey })
    expect(att.isError).toBe(false)
  })

  it("a Drive without the planned operations: flat list works, key tools say planned", async () => {
    await h.close()
    await setup({ servePlanned: false })
    await h.call("untrace_upload_file", { content: "x", name: "x" })
    const list = await h.call("untrace_list")
    expect(list.isError).toBe(false)
    expect(list.json.folders).toBeNull()
    expect(list.json.files).toHaveLength(1)
    const keys = await h.call("untrace_list_keys", { resourceType: "file", resourceId: list.json.files[0].fileId })
    expect(keys.text).toMatch(/^planned:/)
  })

  it("a missing scope is reported with its name", async () => {
    await h.close()
    await setup({ scopes: ["download"] })
    const r = await h.call("untrace_upload_file", { content: "x", name: "x" })
    expect(r.text).toMatch(/^insufficient_scope:.*"upload"/s)
  })

  it("the client secret never travels to Drive and never shows in a result", async () => {
    await h.call("untrace_upload_file", { content: "x", name: "x" })
    await h.call("untrace_whoami")
    expect(allText()).not.toContain(SECRET_BODY)
  })
})
