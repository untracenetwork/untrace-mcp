import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  UntraceAuthError,
  UntraceConflictError,
  UntraceFolderAccessError,
  UntraceNotFoundError,
  UntracePaymentRequiredError,
  UntracePlannedError,
  UntraceRateLimitError,
  UntraceRoleError,
  UntraceScopeError,
  UntraceTooLargeError,
  UntraceUnavailableError,
} from "@untracenetwork/sdk"

import { TOOL_NAMES } from "../src/server"
import { ENTRY_ID, FILE_ID, FOLDER_ID, KEY, KEY2, METERING, PUB, SHARE_ID, harness } from "./helpers"

type H = Awaited<ReturnType<typeof harness>>
let h: H
beforeEach(async () => {
  h = await harness()
})
afterEach(async () => {
  await h.close()
})

const OTHER_FOLDER = "1c7a9d2f-3e4b-4c6d-9e0f-2a3b4c5d6e7f"
const notFound = () => new UntraceNotFoundError({ status: 404, code: "not_found", message: "not_found" })

describe("tool registry", () => {
  it("lists exactly the v2 tools, each with a description, an input schema and annotations", async () => {
    const { tools } = await h.mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(tools).toHaveLength(26)
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(40)
      expect(t.inputSchema.type).toBe("object")
      expect(t.annotations).toBeTruthy()
      expect(JSON.stringify(t)).not.toMatch(/secret"|clientSecret/i)
      expect(t.description).not.toMatch(/\u2014/)
      expect(t.description).not.toMatch(/sha[r]d|node(s)? /i)
    }
  })

  it("no tool accepts a secret argument", async () => {
    const { tools } = await h.mcp.listTools()
    for (const t of tools) for (const k of Object.keys(t.inputSchema.properties ?? {})) expect(k).not.toMatch(/secret|token|password/i)
  })

  it("destructive tools are marked destructive, read tools read-only", async () => {
    const { tools } = await h.mcp.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations!]))
    expect(by.untrace_delete_file!.destructiveHint).toBe(true)
    expect(by.untrace_remove_key!.destructiveHint).toBe(true)
    expect(by.untrace_trash_folder!.destructiveHint).toBe(true)
    for (const n of ["untrace_list", "untrace_get_file", "untrace_get_folder", "untrace_list_keys", "untrace_list_incoming_shares", "untrace_whoami", "untrace_setup_guide"]) expect(by[n]!.readOnlyHint).toBe(true)
  })

  it("no tool or description is still marked planned, and no tool offers a device key", async () => {
    const { tools } = await h.mcp.listTools()
    for (const t of tools) {
      expect(JSON.stringify(t)).not.toMatch(/planned|being rolled out/i)
      expect(JSON.stringify(t)).not.toMatch(/\bdevice\b/i)
    }
    const attach = tools.find((t) => t.name === "untrace_attach_key")!
    expect((attach.inputSchema.properties as Record<string, { enum?: string[] }>).keyType!.enum).toEqual(["client", "passkey"])
  })

  it("upload requires folderId and its description keeps the editor sentence", async () => {
    const { tools } = await h.mcp.listTools()
    const up = tools.find((t) => t.name === "untrace_upload_file")!
    expect(up.inputSchema.required).toContain("folderId")
    expect(up.description).toMatch(/Your key becomes an editor of the new file/)
    expect(up.description).toMatch(/folder this key was added to/)
  })
})

describe("untrace_list", () => {
  it("top level: folders and files, paging passed through, no key material", async () => {
    const r = await h.call("untrace_list", { limit: 10 })
    expect(r.isError).toBe(false)
    expect(r.json.folders).toEqual([{ folderId: FOLDER_ID, name: "Docs", parentId: null, role: "admin", boxPublicKey: PUB, createdAt: "2026-10-08T00:00:00Z" }])
    expect(r.json.files[0].fileId).toBe(FILE_ID)
    expect(r.json.nextCursor).toBe("c2")
    expect(h.client.folders.list).toHaveBeenCalledWith({ parentId: null, cursor: null, limit: 10 })
    expect(h.client.files.list).toHaveBeenCalledWith({ folderId: null, cursor: null, limit: 10 })
  })

  it("inside a folder lists subfolders and that folder's files", async () => {
    const r = await h.call("untrace_list", { folderId: FOLDER_ID })
    expect(r.json.folderId).toBe(FOLDER_ID)
    expect(h.client.folders.list).toHaveBeenCalledWith({ parentId: FOLDER_ID, cursor: null, limit: undefined })
    expect(h.client.files.list).toHaveBeenCalledWith({ folderId: FOLDER_ID, cursor: null, limit: undefined })
  })

  it("a folder cursor pages folders only; a file cursor skips the folder listing", async () => {
    const f = await h.call("untrace_list", { folderCursor: FOLDER_ID })
    expect(f.json.files).toBeUndefined()
    expect(h.client.files.list).not.toHaveBeenCalled()
    await h.call("untrace_list", { cursor: FILE_ID })
    expect(h.client.folders.list).toHaveBeenCalledTimes(1)
  })

  it("rejects an out-of-range limit before calling the SDK", async () => {
    const r = await h.call("untrace_list", { limit: 500 })
    expect(r.isError).toBe(true)
    expect(h.client.files.list).not.toHaveBeenCalled()
  })

  it("maps an auth error to setup help", async () => {
    h.client.folders.list.mockRejectedValueOnce(new UntraceAuthError({ status: 401, code: "invalid_client", message: "invalid_client" }))
    const r = await h.call("untrace_list")
    expect(r.text).toMatch(/^auth:.*Settings > Developer keys/s)
  })

  it("maps 429 with Retry-After and 503 as retryable", async () => {
    h.client.folders.list.mockRejectedValueOnce(new UntraceRateLimitError({ status: 429, code: "rate_limited", message: "slow", retryAfterSeconds: 7 }))
    expect((await h.call("untrace_list")).text).toMatch(/Retry after 7 seconds.*\(retryable\)/)
    h.client.folders.list.mockRejectedValueOnce(new UntraceUnavailableError({ status: 503, code: "unavailable", message: "down" }))
    expect((await h.call("untrace_list")).text).toMatch(/^unavailable:.*\(retryable\)/)
  })

  it("an operation a future contract marks planned still says so", async () => {
    h.client.folders.list.mockRejectedValueOnce(new UntracePlannedError("listFolders"))
    expect((await h.call("untrace_list")).text).toMatch(/^planned:.*does not offer listFolders yet/s)
  })
})

describe("untrace_get_file", () => {
  it("returns metadata without the wrapped key or key path", async () => {
    const r = await h.call("untrace_get_file", { fileId: FILE_ID })
    expect(r.json.fileId).toBe(FILE_ID)
    expect(r.json.folderId).toBe(FOLDER_ID)
    expect(r.json.wrappedKey).toBeUndefined()
    expect(r.json.keyPath).toBeUndefined()
  })

  it("404 says the key may not reach it, never which", async () => {
    h.client.files.get.mockRejectedValueOnce(notFound())
    const r = await h.call("untrace_get_file", { fileId: FILE_ID })
    expect(r.text).toMatch(/^not_found:.*cannot reach it.*never says which/s)
  })

  it("rejects a non-UUID file id", async () => {
    const r = await h.call("untrace_get_file", { fileId: "../etc" })
    expect(r.isError).toBe(true)
    expect(h.client.files.get).not.toHaveBeenCalled()
  })
})

describe("untrace_upload_file", () => {
  it("uploads a local file inside the root and returns the file and metering", async () => {
    await h.write("a.pdf", "hello")
    const r = await h.call("untrace_upload_file", { folderId: FOLDER_ID, path: "a.pdf", mime: "application/pdf" })
    expect(r.isError).toBe(false)
    expect(r.json.file.name).toBe("a.pdf")
    expect(r.json.metering).toEqual(METERING)
    const input = h.client.files.upload.mock.calls[0]![0] as { data: Uint8Array; name: string; mime: string; folderId: string }
    expect(input.folderId).toBe(FOLDER_ID)
    expect(r.json.file.folderId).toBe(FOLDER_ID)
    expect(new TextDecoder().decode(input.data)).toBe("hello")
    expect(input.mime).toBe("application/pdf")
  })

  it("uploads inline text and base64 content", async () => {
    await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "hi there", name: "note.txt", mime: "text/plain" })
    expect(new TextDecoder().decode((h.client.files.upload.mock.calls[0]![0] as { data: Uint8Array }).data)).toBe("hi there")
    await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64", name: "b.bin" })
    expect([...(h.client.files.upload.mock.calls[1]![0] as { data: Uint8Array }).data]).toEqual([1, 2, 3])
  })

  it("needs exactly one of path or content, and a name with content", async () => {
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID,})).text).toMatch(/exactly one of path or content/)
    await h.write("a.txt", "x")
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, path: "a.txt", content: "x", name: "a" })).text).toMatch(/exactly one/)
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x" })).text).toMatch(/name is required/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("refuses bad base64, an empty file and a folder", async () => {
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "%%%", encoding: "base64", name: "x" })).text).toMatch(/not valid base64/)
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "", name: "x" })).text).toMatch(/empty/)
    await h.mkdir("dir")
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, path: "dir" })).text).toMatch(/not a regular file/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("refuses files over the 16 MB limit without uploading", async () => {
    await h.write("big.bin", new Uint8Array(16 * 1024 * 1024))
    const r = await h.call("untrace_upload_file", { folderId: FOLDER_ID, path: "big.bin" })
    expect(r.text).toMatch(/at most 16 MB/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("reports a missing local file", async () => {
    const r = await h.call("untrace_upload_file", { folderId: FOLDER_ID, path: "nope.txt" })
    expect(r.isError).toBe(true)
  })

  it("folderId is required and must be a UUID; nothing is uploaded without it", async () => {
    const missing = await h.call("untrace_upload_file", { content: "x", name: "x" })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/folderId/)
    expect((await h.call("untrace_upload_file", { folderId: "inbox", content: "x", name: "x" })).isError).toBe(true)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("a folder the key was not added to is a clear tool error", async () => {
    h.client.files.upload.mockRejectedValueOnce(new UntraceFolderAccessError({ status: 403, code: "folder_access_required", message: "folder_access_required" }))
    const r = await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^folder_access_required:.*the key was not added to this folder/s)
    expect(r.text).toMatch(/untrace_create_folder/)
  })

  it("409 owner not signed in tells the agent to have the owner sign in once", async () => {
    h.client.files.upload.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "the owner has not signed in to Drive yet" }))
    const r = await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x" })
    expect(r.text).toMatch(/^owner_not_ready:.*sign in to Untrace Drive once/s)
  })

  it("402, 413 and a missing scope are explained", async () => {
    h.client.files.upload.mockRejectedValueOnce(new UntracePaymentRequiredError({ status: 402, code: "payment_required", message: "p" }))
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x" })).text).toMatch(/^payment_required:.*owner's plan/s)
    h.client.files.upload.mockRejectedValueOnce(new UntraceTooLargeError({ status: 413, code: "payload_too_large", message: "big" }))
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x" })).text).toMatch(/^too_large:/)
    h.client.files.upload.mockRejectedValueOnce(new UntraceScopeError({ status: 403, code: "insufficient_scope", message: "s", body: { required: "upload" } }))
    expect((await h.call("untrace_upload_file", { folderId: FOLDER_ID, content: "x", name: "x" })).text).toMatch(/^insufficient_scope:/)
  })

  it("refuses local paths on a server without a root (remote)", async () => {
    const remote = await harness({ root: false })
    try {
      const r = await remote.call("untrace_upload_file", { folderId: FOLDER_ID, path: "a.txt" })
      expect(r.text).toMatch(/local paths are turned off/)
    } finally {
      await remote.close()
    }
  })
})

describe("untrace_download_file", () => {
  it("writes the decrypted bytes inside the root", async () => {
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "out/report.pdf" })
    expect(r.isError).toBe(false)
    expect(await h.read("out/report.pdf")).toBe("hello")
    expect(r.json.size).toBe(5)
  })

  it("refuses to overwrite unless overwrite is true", async () => {
    await h.write("x.pdf", "old")
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "x.pdf" })
    expect(r.text).toMatch(/already exists/)
    expect(await h.read("x.pdf")).toBe("old")
    expect(h.client.files.download).not.toHaveBeenCalled()
    await h.call("untrace_download_file", { fileId: FILE_ID, path: "x.pdf", overwrite: true })
    expect(await h.read("x.pdf")).toBe("hello")
  })

  it("refuses a folder as target", async () => {
    await h.mkdir("d")
    expect((await h.call("untrace_download_file", { fileId: FILE_ID, path: "d" })).text).toMatch(/is a folder/)
  })

  it("maps 404 and writes nothing", async () => {
    h.client.files.download.mockRejectedValueOnce(notFound())
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "n.pdf" })
    expect(r.text).toMatch(/^not_found:/)
    await expect(h.read("n.pdf")).rejects.toThrow()
  })

  it("without a path returns text inline as a resource", async () => {
    h.client.files.download.mockResolvedValueOnce({ bytes: new TextEncoder().encode("# hi"), name: "a.md", mime: "text/markdown" })
    const r = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(r.content[1]!.type).toBe("resource")
    expect(r.content[1]!.resource.text).toBe("# hi")
    expect(r.content[1]!.resource.uri).toBe(`untrace://files/${FILE_ID}`)
  })

  it("without a path returns images as image content and other files as a base64 blob", async () => {
    h.client.files.download.mockResolvedValueOnce({ bytes: new Uint8Array([137, 80]) as Uint8Array<ArrayBuffer>, name: "a.png", mime: "image/png" } as never)
    const img = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(img.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from([137, 80]).toString("base64") })
    const bin = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(bin.content[1]!.resource.blob).toBe(Buffer.from("hello").toString("base64"))
  })

  it("refuses inline content over the limit", async () => {
    h.client.files.download.mockResolvedValueOnce({ bytes: new Uint8Array(4 * 1024 * 1024 + 1), name: "a", mime: "text/plain" } as never)
    expect((await h.call("untrace_download_file", { fileId: FILE_ID })).text).toMatch(/over the inline limit/)
  })
})

describe("untrace_rename_file, untrace_move_file and untrace_delete_file", () => {
  it("moves a file to another folder through the SDK", async () => {
    const r = await h.call("untrace_move_file", { fileId: FILE_ID, folderId: OTHER_FOLDER })
    expect(r.json).toEqual({ fileId: FILE_ID, name: "report.pdf", folderId: OTHER_FOLDER })
    expect(h.client.files.move).toHaveBeenCalledWith(FILE_ID, OTHER_FOLDER)
  })

  it("renames", async () => {
    const r = await h.call("untrace_rename_file", { fileId: FILE_ID, name: "new.pdf" })
    expect(r.json).toEqual({ fileId: FILE_ID, name: "new.pdf" })
  })

  it("a viewer gets a role explanation", async () => {
    h.client.files.rename.mockRejectedValueOnce(new UntraceRoleError({ status: 403, code: "insufficient_role", message: "r" }))
    expect((await h.call("untrace_rename_file", { fileId: FILE_ID, name: "n" })).text).toMatch(/^insufficient_role:.*viewer can download/s)
  })

  it("delete refuses without confirm: true", async () => {
    expect((await h.call("untrace_delete_file", { fileId: FILE_ID, confirm: false })).text).toMatch(/confirm: true/)
    expect((await h.call("untrace_delete_file", { fileId: FILE_ID })).isError).toBe(true)
    expect(h.client.files.delete).not.toHaveBeenCalled()
  })

  it("delete moves to the trash with confirm: true", async () => {
    const r = await h.call("untrace_delete_file", { fileId: FILE_ID, confirm: true })
    expect(r.json).toEqual({ fileId: FILE_ID, trashed: true })
  })
})

describe("folders", () => {
  it("creates at the top level or inside a parent", async () => {
    const top = await h.call("untrace_create_folder", { name: "Reports" })
    expect(top.isError).toBe(false)
    expect(top.json.name).toBe("Reports")
    expect(top.json.sealedKey).toBeUndefined()
    expect(top.json.keyPath).toBeUndefined()
    expect(h.client.folders.create).toHaveBeenLastCalledWith({ name: "Reports", parentId: null })
    await h.call("untrace_create_folder", { name: "Q3", parentId: FOLDER_ID })
    expect(h.client.folders.create).toHaveBeenLastCalledWith({ name: "Q3", parentId: FOLDER_ID })
  })

  it("gets, renames and moves a folder", async () => {
    expect((await h.call("untrace_get_folder", { folderId: FOLDER_ID })).json).toMatchObject({ folderId: FOLDER_ID, role: "admin", boxPublicKey: PUB })
    expect((await h.call("untrace_rename_folder", { folderId: FOLDER_ID, name: "Old" })).json.name).toBe("Old")
    expect(h.client.folders.rename).toHaveBeenCalledWith(FOLDER_ID, "Old")
    expect((await h.call("untrace_move_folder", { folderId: FOLDER_ID, parentId: OTHER_FOLDER })).json.parentId).toBe(OTHER_FOLDER)
    expect(h.client.folders.move).toHaveBeenCalledWith(FOLDER_ID, OTHER_FOLDER)
  })

  it("a move inside itself is a conflict", async () => {
    h.client.folders.move.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "a folder cannot move inside itself" }))
    expect((await h.call("untrace_move_folder", { folderId: FOLDER_ID, parentId: OTHER_FOLDER })).text).toMatch(/^conflict:.*inside itself/s)
  })

  it("trash needs confirm: true", async () => {
    expect((await h.call("untrace_trash_folder", { folderId: FOLDER_ID, confirm: false })).text).toMatch(/confirm: true/)
    expect(h.client.folders.trash).not.toHaveBeenCalled()
    expect((await h.call("untrace_trash_folder", { folderId: FOLDER_ID, confirm: true })).json).toEqual({ folderId: FOLDER_ID, removed: true })
  })

  it("rejects bad names and ids before calling the SDK", async () => {
    expect((await h.call("untrace_create_folder", { name: "" })).isError).toBe(true)
    expect((await h.call("untrace_get_folder", { folderId: "root" })).isError).toBe(true)
    expect(h.client.folders.create).not.toHaveBeenCalled()
    expect(h.client.folders.get).not.toHaveBeenCalled()
  })
})

describe("key entries", () => {
  it("lists entries without sealed keys, on files and folders", async () => {
    const r = await h.call("untrace_list_keys", { resourceType: "folder", resourceId: FOLDER_ID })
    expect(h.client.keys.list).toHaveBeenCalledWith({ type: "folder", id: FOLDER_ID })
    expect(r.json.entries[0].entryId).toBe(ENTRY_ID)
    expect(r.json.entries[0].sealedKey).toBeUndefined()
    await h.call("untrace_list_keys", { resourceType: "file", resourceId: FILE_ID })
    expect(h.client.keys.list).toHaveBeenLastCalledWith({ type: "file", id: FILE_ID })
  })

  it("attach passes the public key to the SDK, which seals on this machine", async () => {
    const r = await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer", scopes: ["download"], publicKey: PUB })
    expect(r.isError).toBe(false)
    expect(h.client.keys.attach).toHaveBeenCalledWith({ type: "file", id: FILE_ID }, { keyType: "client", keyId: KEY2, role: "viewer", scopes: ["download"], publicKey: PUB })
  })

  it("attaches a passkey entry on a folder", async () => {
    const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
    await h.call("untrace_attach_key", { resourceType: "folder", resourceId: FOLDER_ID, keyType: "passkey", keyId: wallet, role: "editor", publicKey: PUB })
    expect(h.client.keys.attach).toHaveBeenCalledWith({ type: "folder", id: FOLDER_ID }, { keyType: "passkey", keyId: wallet, role: "editor", publicKey: PUB })
  })

  it("role none blocks without a public key", async () => {
    await h.call("untrace_attach_key", { resourceType: "folder", resourceId: FOLDER_ID, keyType: "client", keyId: KEY2, role: "none" })
    expect(h.client.keys.attach).toHaveBeenCalledWith({ type: "folder", id: FOLDER_ID }, { keyType: "client", keyId: KEY2, role: "none" })
  })

  it("refuses granting without a public key, role owner, a device key and a bad client id", async () => {
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer" })).text).toMatch(/publicKey is required/)
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "owner", publicKey: PUB })).isError).toBe(true)
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "device", keyId: "hw-key-0001", role: "viewer", publicKey: PUB })).isError).toBe(true)
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: "utc_badbadbad", role: "viewer", publicKey: PUB })).text).toMatch(/utc_ followed by 22/)
    expect(h.client.keys.attach).not.toHaveBeenCalled()
  })

  it("a duplicate attach hints at untrace_change_key", async () => {
    h.client.keys.attach.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "conflict" }))
    const r = await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer", publicKey: PUB })
    expect(r.text).toMatch(/untrace_change_key/)
  })

  it("change needs role or scopes and maps owner_immutable", async () => {
    expect((await h.call("untrace_change_key", { resourceType: "file", resourceId: FILE_ID, entryId: ENTRY_ID })).text).toMatch(/give role, scopes or both/)
    h.client.keys.change.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "owner_immutable", message: "owner_immutable" }))
    const r = await h.call("untrace_change_key", { resourceType: "file", resourceId: FILE_ID, entryId: ENTRY_ID, role: "viewer" })
    expect(r.text).toMatch(/^owner_immutable:.*never be removed/s)
    expect(h.client.keys.change).toHaveBeenCalledWith({ type: "file", id: FILE_ID }, ENTRY_ID, { role: "viewer" })
  })

  it("remove needs confirm: true", async () => {
    expect((await h.call("untrace_remove_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: ENTRY_ID, confirm: false })).text).toMatch(/confirm: true/)
    expect(h.client.keys.remove).not.toHaveBeenCalled()
    const r = await h.call("untrace_remove_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: ENTRY_ID, confirm: true })
    expect(r.json).toEqual({ resourceType: "folder", resourceId: FOLDER_ID, entryId: ENTRY_ID, removed: true })
    expect(h.client.keys.remove).toHaveBeenCalledWith({ type: "folder", id: FOLDER_ID }, ENTRY_ID)
  })

  it("secret unshare needs confirm: true, like remove_key, and calls nothing without it", async () => {
    const { tools } = await h.mcp.listTools()
    const unshare = tools.find((t) => t.name === "untrace_secret_unshare")!
    expect(unshare.inputSchema.required).toContain("confirm")
    expect(unshare.description).toMatch(/Pass confirm: true only after the user has agreed/)
    // Without confirm at all, the input schema refuses it.
    const missing = await h.call("untrace_secret_unshare", { name: "openai", clientId: KEY2 })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/confirm/)
    expect((await h.call("untrace_secret_unshare", { name: "openai", clientId: KEY2, confirm: false })).text).toBe(
      "refused: Refused: unsharing a secret cuts that key's access. Ask the user, then call again with confirm: true."
    )
    expect(h.client.folders.list).not.toHaveBeenCalled()
    expect(h.client.keys.list).not.toHaveBeenCalled()
    expect(h.client.keys.remove).not.toHaveBeenCalled()
  })
})

describe("untrace_whoami", () => {
  it("shows client id, base url, scopes and public key, never the secret", async () => {
    const r = await h.call("untrace_whoami")
    expect(r.json).toEqual({ clientId: "utc_7Kq2mXv9PpR4sTzW8nYbC3", baseUrl: "https://drive.untrace.network", scopes: ["download", "upload"], publicKey: PUB })
  })
})

describe("sharing", () => {
  it("offers through the SDK and returns no sealed key", async () => {
    const r = await h.call("untrace_share", { resourceType: "folder", resourceId: FOLDER_ID, username: "bob-untrace", role: "viewer" })
    expect(r.isError).toBe(false)
    expect(h.client.shares.offer).toHaveBeenCalledWith({ resourceType: "folder", resourceId: FOLDER_ID, username: "bob-untrace", role: "viewer" })
    expect(r.json.share.shareId).toBe(SHARE_ID)
    expect(r.json.share.sealedKey).toBeUndefined()
  })

  it("refuses a bad username before any call", async () => {
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: FILE_ID, username: "Bob!", role: "viewer" })
    expect(r.isError).toBe(true)
    expect(h.client.shares.offer).not.toHaveBeenCalled()
  })

  it("a sharing key that does not verify is an integrity error", async () => {
    const { UntraceIntegrityError } = await import("@untracenetwork/sdk")
    h.client.shares.offer.mockRejectedValueOnce(new UntraceIntegrityError("untrace: the sharing key published for bob-untrace does not verify"))
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: FILE_ID, username: "bob-untrace", role: "viewer" })
    expect(r.text).toMatch(/^integrity:.*does not verify/s)
  })

  it("lists incoming shares without their sealed keys", async () => {
    const r = await h.call("untrace_list_incoming_shares")
    expect(r.json.shares).toEqual([{ shareId: SHARE_ID, resourceType: "folder", resourceId: FOLDER_ID, role: "editor", from: "bob-untrace", createdAt: "2026-10-08T00:00:00Z" }])
  })

  it("accept refuses without a sharing key on this server", async () => {
    delete process.env.UNTRACE_SHARE_SECRET_KEY
    const r = await h.call("untrace_accept_share", { shareId: SHARE_ID })
    expect(r.text).toMatch(/^refused:.*Accept the share in Untrace Drive/s)
    expect(h.client.shares.accept).not.toHaveBeenCalled()
  })

  it("accept with a sharing key attaches this key", async () => {
    const secret = Buffer.alloc(32, 5).toString("base64")
    const s = await harness({ shareSecretKey: secret })
    try {
      const r = await s.call("untrace_accept_share", { shareId: SHARE_ID })
      expect(r.isError).toBe(false)
      expect(r.json.keyId).toBe(KEY)
      const [share, input] = s.client.shares.accept.mock.calls[0]! as [{ shareId: string }, { shareSecretKey: Uint8Array }]
      expect(share.shareId).toBe(SHARE_ID)
      expect(input.shareSecretKey).toHaveLength(32)
      expect(r.text).not.toContain(secret)
      expect((await s.call("untrace_accept_share", { shareId: ENTRY_ID })).text).toMatch(/no pending share/)
    } finally {
      await s.close()
    }
  })

  it("accept refuses a sharing key that is not 32 bytes", async () => {
    const s = await harness({ shareSecretKey: Buffer.alloc(8).toString("base64") })
    try {
      expect((await s.call("untrace_accept_share", { shareId: SHARE_ID })).text).toMatch(/must be 32 bytes/)
    } finally {
      await s.close()
    }
  })
})

describe("untrace_setup_guide", () => {
  it.each(["nextjs", "node", "react", "vue"])("%s guide has steps, install line and code", async (framework) => {
    const r = await h.call("untrace_setup_guide", { framework })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/Settings > Developer keys/)
    expect(r.text).toMatch(/UNTRACE_CLIENT_SECRET/)
    expect(r.text).toMatch(/6 regions, and any 3 recover it/)
    expect(r.text).toMatch(/https:\/\/untrace\.network\/llms\.txt/)
    expect(r.text).toMatch(/```/)
    expect(r.text).not.toMatch(/\u2014/)
    expect(r.text).not.toMatch(/sha[r]d/i)
  })

  it("nextjs uses createUntraceRoute, vue uses untracePlugin", async () => {
    expect((await h.call("untrace_setup_guide", { framework: "nextjs" })).text).toMatch(/createUntraceRoute/)
    expect((await h.call("untrace_setup_guide", { framework: "vue" })).text).toMatch(/untracePlugin/)
    expect((await h.call("untrace_setup_guide", { framework: "node" })).text).toMatch(/new UntraceClient/)
  })

  it("can leave out the reference sections", async () => {
    const full = await h.call("untrace_setup_guide", { framework: "node" })
    const short = await h.call("untrace_setup_guide", { framework: "node", includeReference: false })
    expect(full.text).toMatch(/UntraceRateLimitError/)
    expect(short.text).not.toMatch(/UntraceRateLimitError/)
  })

  it("works without any client configured", async () => {
    await h.call("untrace_setup_guide", { framework: "node" })
    expect(h.client.files.list).not.toHaveBeenCalled()
  })
})
