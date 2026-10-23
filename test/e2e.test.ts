/**
 * End to end: the real @untracenetwork/sdk client against a mock Drive (test/mock-drive.ts, the
 * SDK's contract mock). Encryption, key sealing, key paths, signature checks and token handling
 * all run for real.
 */
import { UntraceClient, openSealed } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { UntraceLike } from "../src/server"
import { harness } from "./helpers"
import { BASE, CLIENT_ID, FOLDER_ID, OTHER_CLIENT, SECRET, SECRET_BODY, createMockDrive, type MockDrive } from "./mock-drive"

const ALL = ["download", "upload", "delete", "manage-sharing"]
let drive: MockDrive
let h: Awaited<ReturnType<typeof harness>>

async function connect(shareSecretKey?: string) {
  const client = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: drive.handler, maxRetries: 0 })
  h = await harness({ client: (() => client as unknown as UntraceLike) as never, shareSecretKey })
}

async function setup(opts: Parameters<typeof createMockDrive>[0] = { scopes: ALL }) {
  drive = createMockDrive(opts)
  await connect()
}

beforeEach(async () => {
  await setup()
})
afterEach(async () => {
  await h.close()
})

const allText = () => JSON.stringify(drive.requests.map((r) => ({ ...r, body: Buffer.from(r.body).toString("latin1") })))
const upload = (args: Record<string, unknown> = {}) => h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x.txt", ...args })

describe("end to end with the real SDK", () => {
  it("upload into a folder encrypts on this machine; download decrypts back to the same bytes", async () => {
    const up = await upload({ content: "the quarterly numbers", name: "q3.txt", mime: "text/plain" })
    expect(up.isError).toBe(false)
    expect(up.json.file.folderId).toBe(FOLDER_ID)
    expect(up.json.file.role).toBe("editor")
    const fileId = up.json.file.fileId as string
    const stored = drive.files.get(fileId)!
    expect(Buffer.from(stored.body).toString("latin1")).not.toContain("quarterly")
    expect(up.json.metering.billedTo).toBe("owner")

    const down = await h.call("untrace_download_file", { fileId })
    expect(down.content[1]!.resource.text).toBe("the quarterly numbers")
    await h.call("untrace_download_file", { fileId, path: "q3.txt" })
    expect(await h.read("q3.txt")).toBe("the quarterly numbers")
  })

  it("the owner can open the file key, and the folder holds its own sealed copy", async () => {
    const up = await upload()
    const f = drive.files.get(up.json.file.fileId)!
    expect(drive.openOwnerKey(f)).toHaveLength(32)
    expect(f.folderSealedKey).toBeTruthy()
  })

  it("upload without folderId is refused before anything reaches Drive", async () => {
    const before = drive.requests.length
    const r = await h.call("untrace_upload_file", { content: "x", name: "x" })
    expect(r.isError).toBe(true)
    expect(drive.requests.length).toBe(before)
  })

  it("upload into a folder the key was not added to says so and stores nothing", async () => {
    // Not reachable at all: the SDK checks the folder's public key first, which answers 404.
    const other = await drive.addFolder({ name: "Not mine", mine: false })
    const r = await upload({ folderId: other.folderId })
    expect(r.text).toMatch(/^not_found:/)
    // Reachable as a viewer, but not added as editor: Drive answers 403 folder_access_required.
    const viewer = await drive.addFolder({ name: "Read only", mine: true, role: "viewer" })
    const v = await upload({ folderId: viewer.folderId })
    expect(v.isError).toBe(true)
    expect(v.text).toMatch(/^folder_access_required:.*the key was not added to this folder/s)
    expect(drive.files.size).toBe(0)
  })

  it("folders: create, list, get, rename, move, upload into a subfolder, trash", async () => {
    const top = await h.call("untrace_create_folder", { name: "Reports" })
    expect(top.isError).toBe(false)
    expect(top.json.role).toBe("admin")
    expect(top.json.sealedKey).toBeUndefined()
    const sub = await h.call("untrace_create_folder", { name: "Q3", parentId: top.json.folderId })
    expect(sub.json.parentId).toBe(top.json.folderId)

    const listed = await h.call("untrace_list")
    expect(listed.json.folders.map((f: { name: string }) => f.name).sort()).toEqual(["Inbox", "Reports"])
    const inside = await h.call("untrace_list", { folderId: top.json.folderId })
    expect(inside.json.folders.map((f: { name: string }) => f.name)).toEqual(["Q3"])

    // The subfolder is reached through a key path, opened locally by the SDK.
    const up = await upload({ folderId: sub.json.folderId, content: "deep", name: "deep.txt", mime: "text/plain" })
    expect(up.isError).toBe(false)
    expect((await h.call("untrace_download_file", { fileId: up.json.file.fileId })).content[1]!.resource.text).toBe("deep")

    expect((await h.call("untrace_get_folder", { folderId: sub.json.folderId })).json.name).toBe("Q3")
    expect((await h.call("untrace_rename_folder", { folderId: sub.json.folderId, name: "Q4" })).json.name).toBe("Q4")
    const moved = await h.call("untrace_move_folder", { folderId: sub.json.folderId, parentId: FOLDER_ID })
    expect(moved.json.parentId).toBe(FOLDER_ID)
    expect((await h.call("untrace_move_folder", { folderId: top.json.folderId, parentId: top.json.folderId })).text).toMatch(/^conflict:/)

    expect((await h.call("untrace_trash_folder", { folderId: top.json.folderId, confirm: true })).json.removed).toBe(true)
    expect((await h.call("untrace_get_folder", { folderId: top.json.folderId })).text).toMatch(/^not_found:/)
  })

  it("list, rename, move and delete a file round trip", async () => {
    const up = await upload({ name: "a.txt" })
    const id = up.json.file.fileId
    const list = await h.call("untrace_list", { folderId: FOLDER_ID })
    expect(list.json.files.map((f: { fileId: string }) => f.fileId)).toEqual([id])
    expect((await h.call("untrace_rename_file", { fileId: id, name: "b.txt" })).json.name).toBe("b.txt")
    // The key is an editor of a file it uploaded, and moving needs admin on the file: refused, nothing moves.
    const target = await h.call("untrace_create_folder", { name: "Archive" })
    expect((await h.call("untrace_move_file", { fileId: id, folderId: target.json.folderId })).text).toMatch(/^not_found:/)
    expect(drive.files.get(id)!.folderId).toBe(FOLDER_ID)
    // As admin of the file, the move works: the file key is re-sealed to the target folder here.
    drive.files.get(id)!.role = "admin"
    expect((await h.call("untrace_move_file", { fileId: id, folderId: target.json.folderId })).json.folderId).toBe(target.json.folderId)
    expect(drive.files.get(id)!.folderId).toBe(target.json.folderId)
    expect((await h.call("untrace_download_file", { fileId: id })).isError).toBe(false)
    expect((await h.call("untrace_delete_file", { fileId: id, confirm: true })).json.trashed).toBe(true)
    expect((await h.call("untrace_get_file", { fileId: id })).text).toMatch(/^not_found:/)
  })

  it("share by username: the recipient opens the folder key, Drive never sees it in the clear", async () => {
    const r = await h.call("untrace_share", { resourceType: "folder", resourceId: FOLDER_ID, username: "bob-user", role: "viewer" })
    expect(r.isError).toBe(false)
    expect(r.json.share.sealedKey).toBeUndefined()
    const share = [...drive.shares.values()][0]!
    expect(share.role).toBe("viewer")
    const opened = openSealed(share.sealedKey, drive.userShareSecret("bob-user"))
    expect(Buffer.from(opened).equals(Buffer.from(drive.folderKey(FOLDER_ID)!))).toBe(true)
  })

  it("share refuses a recipient key with a bad signature and sends nothing", async () => {
    const r = await h.call("untrace_share", { resourceType: "folder", resourceId: FOLDER_ID, username: "mallory-user", role: "viewer" })
    expect(r.text).toMatch(/^integrity:/)
    expect(drive.shares.size).toBe(0)
  })

  it("incoming shares, then accept with this key", async () => {
    const theirs = await drive.addFolder({ name: "Bob's folder", mine: false })
    const offered = drive.offerToMe("folder", theirs.folderId, drive.folderKey(theirs.folderId)!, "editor")
    const secret = Buffer.from(drive.myShareSecret).toString("base64")
    await h.close()
    await connect(secret)

    const incoming = await h.call("untrace_list_incoming_shares")
    expect(incoming.json.shares.map((s: { shareId: string }) => s.shareId)).toEqual([offered.shareId])
    expect(incoming.json.shares[0].sealedKey).toBeUndefined()
    const acc = await h.call("untrace_accept_share", { shareId: offered.shareId })
    expect(acc.isError).toBe(false)
    expect(acc.json).toMatchObject({ keyType: "client", keyId: CLIENT_ID, role: "editor" })
    expect(acc.text).not.toContain(secret)
    // This key now reaches the folder and can put files in it.
    expect((await upload({ folderId: theirs.folderId })).isError).toBe(false)
  })

  it("attach, list, change and remove a client key on a folder", async () => {
    const me = await h.call("untrace_whoami")
    expect(me.json.clientId).toBe(CLIENT_ID)
    const att = await h.call("untrace_attach_key", { resourceType: "folder", resourceId: FOLDER_ID, keyType: "client", keyId: OTHER_CLIENT, role: "viewer", scopes: ["download"], publicKey: me.json.publicKey })
    expect(att.isError).toBe(false)
    const listed = await h.call("untrace_list_keys", { resourceType: "folder", resourceId: FOLDER_ID })
    const entry = listed.json.entries.find((e: { keyId: string }) => e.keyId === OTHER_CLIENT)
    expect(entry.role).toBe("viewer")
    expect(entry.sealedKey).toBeUndefined()
    expect((await h.call("untrace_change_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: entry.entryId, role: "editor" })).json.role).toBe("editor")
    expect((await h.call("untrace_remove_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: entry.entryId, confirm: true })).isError).toBe(false)
    const after = await h.call("untrace_list_keys", { resourceType: "folder", resourceId: FOLDER_ID })
    expect(after.json.entries.some((e: { keyId: string }) => e.keyId === OTHER_CLIENT)).toBe(false)
  })

  it("a passkey entry and a block (none) on a folder", async () => {
    const id = FOLDER_ID
    const me = await h.call("untrace_whoami")
    const pk = await h.call("untrace_attach_key", { resourceType: "folder", resourceId: id, keyType: "passkey", keyId: drive.ownerWallet, role: "viewer", publicKey: me.json.publicKey })
    expect(pk.isError).toBe(false)
    expect(pk.json.keyType).toBe("passkey")
    const block = await h.call("untrace_attach_key", { resourceType: "folder", resourceId: id, keyType: "client", keyId: OTHER_CLIENT, role: "none" })
    expect(block.json.role).toBe("none")
  })

  it("the owner entry can never be changed", async () => {
    const entryId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"
    await drive.seed()
    drive.folders.get(FOLDER_ID)!.entries.push({ entryId, keyType: "passkey", keyId: drive.ownerWallet, role: "owner", scopes: [], sealedKey: null, createdAt: new Date().toISOString() })
    const r = await h.call("untrace_change_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId, role: "viewer" })
    expect(r.text).toMatch(/^owner_immutable:/)
  })

  it("a missing scope is reported with its name", async () => {
    await h.close()
    await setup({ scopes: ["download"] })
    const r = await upload()
    expect(r.text).toMatch(/^insufficient_scope:.*"upload"/s)
  })

  it("the client secret never travels to Drive and never shows in a result", async () => {
    await upload()
    await h.call("untrace_create_folder", { name: "Docs" })
    await h.call("untrace_whoami")
    expect(allText()).not.toContain(SECRET_BODY)
  })
})
