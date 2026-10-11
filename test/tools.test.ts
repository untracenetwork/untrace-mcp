import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  UntraceAuthError,
  UntraceConflictError,
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
import { FILE_ID, KEY2, METERING, harness } from "./helpers"

type H = Awaited<ReturnType<typeof harness>>
let h: H
beforeEach(async () => {
  h = await harness()
})
afterEach(async () => {
  await h.close()
})

const FOLDER_ID = "0b6f8c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e"
const ENTRY_ID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"
const PUB = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
const notFound = () => new UntraceNotFoundError({ status: 404, code: "not_found", message: "not_found" })

describe("tool registry", () => {
  it("lists exactly the v2 tools, each with a description, an input schema and annotations", async () => {
    const { tools } = await h.mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(tools).toHaveLength(13)
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
    for (const n of ["untrace_list", "untrace_get_file", "untrace_list_keys", "untrace_whoami", "untrace_setup_guide"]) expect(by[n]!.readOnlyHint).toBe(true)
  })
})

describe("untrace_list", () => {
  it("top level: folders and files, paging passed through", async () => {
    h.client.call.mockResolvedValueOnce({ folders: [{ folderId: FOLDER_ID, name: "Docs", sealedKey: "x".repeat(40) }], nextCursor: null })
    const r = await h.call("untrace_list", { limit: 10 })
    expect(r.isError).toBe(false)
    expect(r.json.folders).toEqual([{ folderId: FOLDER_ID, name: "Docs" }])
    expect(r.json.files[0].fileId).toBe(FILE_ID)
    expect(r.json.nextCursor).toBe("c2")
    expect(h.client.call).toHaveBeenCalledWith("listFolders", { query: { parentId: undefined, cursor: undefined, limit: 10 } })
    expect(h.client.files.list).toHaveBeenCalledWith({ limit: 10, cursor: null })
  })

  it("inside a folder lists subfolders and that folder's files", async () => {
    h.client.call.mockResolvedValueOnce({ folders: [], nextCursor: null }).mockResolvedValueOnce({ files: [{ fileId: FILE_ID }], nextCursor: null })
    const r = await h.call("untrace_list", { folderId: FOLDER_ID })
    expect(r.json.folderId).toBe(FOLDER_ID)
    expect(h.client.call).toHaveBeenLastCalledWith("listFiles", { query: { folderId: FOLDER_ID, cursor: undefined, limit: undefined } })
    expect(h.client.files.list).not.toHaveBeenCalled()
  })

  it("falls back to the flat file list when this Drive does not serve folders yet", async () => {
    h.client.call.mockRejectedValueOnce(new UntracePlannedError("listFolders"))
    const r = await h.call("untrace_list")
    expect(r.isError).toBe(false)
    expect(r.json.folders).toBeNull()
    expect(r.json.note).toMatch(/does not serve folders yet/)
    expect(r.json.files).toHaveLength(1)
  })

  it("a planned folder listing inside a folder is an error, not a silent fallback", async () => {
    h.client.call.mockRejectedValueOnce(new UntracePlannedError("listFolders"))
    const r = await h.call("untrace_list", { folderId: FOLDER_ID })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^planned:/)
  })

  it("a file cursor skips the folder listing", async () => {
    await h.call("untrace_list", { cursor: FILE_ID })
    expect(h.client.call).not.toHaveBeenCalled()
  })

  it("rejects an out-of-range limit before calling the SDK", async () => {
    const r = await h.call("untrace_list", { limit: 500 })
    expect(r.isError).toBe(true)
    expect(h.client.files.list).not.toHaveBeenCalled()
  })

  it("maps an auth error to setup help", async () => {
    h.client.call.mockRejectedValueOnce(new UntraceAuthError({ status: 401, code: "invalid_client", message: "invalid_client" }))
    const r = await h.call("untrace_list")
    expect(r.text).toMatch(/^auth:.*Settings > Developer keys/s)
  })

  it("maps 429 with Retry-After and 503 as retryable", async () => {
    h.client.call.mockRejectedValueOnce(new UntraceRateLimitError({ status: 429, code: "rate_limited", message: "slow", retryAfterSeconds: 7 }))
    expect((await h.call("untrace_list")).text).toMatch(/Retry after 7 seconds.*\(retryable\)/)
    h.client.call.mockRejectedValueOnce(new UntraceUnavailableError({ status: 503, code: "unavailable", message: "down" }))
    expect((await h.call("untrace_list")).text).toMatch(/^unavailable:.*\(retryable\)/)
  })
})

describe("untrace_get_file", () => {
  it("returns metadata without the wrapped key or meta", async () => {
    const r = await h.call("untrace_get_file", { fileId: FILE_ID })
    expect(r.json.fileId).toBe(FILE_ID)
    expect(r.json.wrappedKey).toBeUndefined()
    expect(r.json.meta).toBeUndefined()
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
    const r = await h.call("untrace_upload_file", { path: "a.pdf", mime: "application/pdf" })
    expect(r.isError).toBe(false)
    expect(r.json.file.name).toBe("a.pdf")
    expect(r.json.metering).toEqual(METERING)
    const input = h.client.files.upload.mock.calls[0]![0] as { data: Uint8Array; name: string; mime: string }
    expect(new TextDecoder().decode(input.data)).toBe("hello")
    expect(input.mime).toBe("application/pdf")
  })

  it("uploads inline text and base64 content", async () => {
    await h.call("untrace_upload_file", { content: "hi there", name: "note.txt", mime: "text/plain" })
    expect(new TextDecoder().decode((h.client.files.upload.mock.calls[0]![0] as { data: Uint8Array }).data)).toBe("hi there")
    await h.call("untrace_upload_file", { content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64", name: "b.bin" })
    expect([...(h.client.files.upload.mock.calls[1]![0] as { data: Uint8Array }).data]).toEqual([1, 2, 3])
  })

  it("needs exactly one of path or content, and a name with content", async () => {
    expect((await h.call("untrace_upload_file", {})).text).toMatch(/exactly one of path or content/)
    await h.write("a.txt", "x")
    expect((await h.call("untrace_upload_file", { path: "a.txt", content: "x", name: "a" })).text).toMatch(/exactly one/)
    expect((await h.call("untrace_upload_file", { content: "x" })).text).toMatch(/name is required/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("refuses bad base64, an empty file and a folder", async () => {
    expect((await h.call("untrace_upload_file", { content: "%%%", encoding: "base64", name: "x" })).text).toMatch(/not valid base64/)
    expect((await h.call("untrace_upload_file", { content: "", name: "x" })).text).toMatch(/empty/)
    await h.mkdir("dir")
    expect((await h.call("untrace_upload_file", { path: "dir" })).text).toMatch(/not a regular file/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("refuses files over the 16 MB limit without uploading", async () => {
    await h.write("big.bin", new Uint8Array(16 * 1024 * 1024))
    const r = await h.call("untrace_upload_file", { path: "big.bin" })
    expect(r.text).toMatch(/at most 16 MB/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("reports a missing local file", async () => {
    const r = await h.call("untrace_upload_file", { path: "nope.txt" })
    expect(r.isError).toBe(true)
  })

  it("409 owner not signed in tells the agent to have the owner sign in once", async () => {
    h.client.files.upload.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "the owner has not signed in to Drive yet" }))
    const r = await h.call("untrace_upload_file", { content: "x", name: "x" })
    expect(r.text).toMatch(/^owner_not_ready:.*sign in to Untrace Drive once/s)
  })

  it("402, 413 and a missing scope are explained", async () => {
    h.client.files.upload.mockRejectedValueOnce(new UntracePaymentRequiredError({ status: 402, code: "payment_required", message: "p" }))
    expect((await h.call("untrace_upload_file", { content: "x", name: "x" })).text).toMatch(/^payment_required:.*owner's plan/s)
    h.client.files.upload.mockRejectedValueOnce(new UntraceTooLargeError({ status: 413, code: "payload_too_large", message: "big" }))
    expect((await h.call("untrace_upload_file", { content: "x", name: "x" })).text).toMatch(/^too_large:/)
    h.client.files.upload.mockRejectedValueOnce(new UntraceScopeError({ status: 403, code: "insufficient_scope", message: "s", body: { required: "upload" } }))
    expect((await h.call("untrace_upload_file", { content: "x", name: "x" })).text).toMatch(/^insufficient_scope:/)
  })

  it("refuses local paths on a server without a root (remote)", async () => {
    const remote = await harness({ root: false })
    try {
      const r = await remote.call("untrace_upload_file", { path: "a.txt" })
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
    h.client.files.download.mockResolvedValueOnce({ fileId: FILE_ID, bytes: new TextEncoder().encode("# hi"), name: "a.md", mime: "text/markdown", size: 4 } as never)
    const r = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(r.content[1]!.type).toBe("resource")
    expect(r.content[1]!.resource.text).toBe("# hi")
    expect(r.content[1]!.resource.uri).toBe(`untrace://files/${FILE_ID}`)
  })

  it("without a path returns images as image content and other files as a base64 blob", async () => {
    h.client.files.download.mockResolvedValueOnce({ fileId: FILE_ID, bytes: new Uint8Array([137, 80]), name: "a.png", mime: "image/png", size: 2 } as never)
    const img = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(img.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from([137, 80]).toString("base64") })
    const bin = await h.call("untrace_download_file", { fileId: FILE_ID })
    expect(bin.content[1]!.resource.blob).toBe(Buffer.from("hello").toString("base64"))
  })

  it("refuses inline content over the limit", async () => {
    h.client.files.download.mockResolvedValueOnce({ fileId: FILE_ID, bytes: new Uint8Array(4 * 1024 * 1024 + 1), name: "a", mime: "text/plain", size: 0 } as never)
    expect((await h.call("untrace_download_file", { fileId: FILE_ID })).text).toMatch(/over the inline limit/)
  })
})

describe("untrace_rename_file and untrace_delete_file", () => {
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

describe("key entries", () => {
  it("lists entries without sealed keys, on files and folders", async () => {
    h.client.call.mockResolvedValueOnce({ entries: [{ entryId: ENTRY_ID, keyType: "client", keyId: KEY2, role: "viewer", sealedKey: "s".repeat(50) }] })
    const r = await h.call("untrace_list_keys", { resourceType: "folder", resourceId: FOLDER_ID })
    expect(h.client.call).toHaveBeenCalledWith("listFolderKeys", { params: { folderId: FOLDER_ID } })
    expect(r.json.entries[0].sealedKey).toBeUndefined()
    await h.call("untrace_list_keys", { resourceType: "file", resourceId: FILE_ID })
    expect(h.client.call).toHaveBeenLastCalledWith("listFileKeys", { params: { fileId: FILE_ID } })
  })

  it("attach seals the file key to the given public key on this machine", async () => {
    h.client.call.mockResolvedValueOnce({ entryId: ENTRY_ID })
    const r = await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer", scopes: ["download"], publicKey: PUB })
    expect(r.isError).toBe(false)
    expect(h.client.openFileKey).toHaveBeenCalledWith("c2VhbGVkLWtleS1ieXRlcw==")
    const [op, input] = h.client.call.mock.calls[0]! as [string, { params: unknown; body: Record<string, unknown> }]
    expect(op).toBe("attachFileKey")
    expect(input.params).toEqual({ fileId: FILE_ID })
    expect(input.body).toMatchObject({ keyType: "client", keyId: KEY2, role: "viewer", scopes: ["download"] })
    expect(typeof input.body.sealedKey).toBe("string")
  })

  it("attach to a folder opens the folder's sealed key", async () => {
    h.client.call.mockResolvedValueOnce({ folderId: FOLDER_ID, sealedKey: "Zm9sZGVyLWtleQ==" }).mockResolvedValueOnce({ entryId: ENTRY_ID })
    await h.call("untrace_attach_key", { resourceType: "folder", resourceId: FOLDER_ID, keyType: "client", keyId: KEY2, role: "editor", publicKey: PUB })
    expect(h.client.call.mock.calls[0]).toEqual(["getFolder", { params: { folderId: FOLDER_ID } }])
    expect(h.client.openFileKey).toHaveBeenCalledWith("Zm9sZGVyLWtleQ==")
    expect(h.client.call.mock.calls[1]![0]).toBe("attachFolderKey")
  })

  it("role none blocks without a public key and opens no key", async () => {
    await h.call("untrace_attach_key", { resourceType: "folder", resourceId: FOLDER_ID, keyType: "client", keyId: KEY2, role: "none" })
    expect(h.client.openFileKey).not.toHaveBeenCalled()
    expect((h.client.call.mock.calls[0]![1] as { body: Record<string, unknown> }).body.sealedKey).toBeUndefined()
  })

  it("refuses granting without a public key, role owner, and a bad client id", async () => {
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer" })).text).toMatch(/publicKey is required/)
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "owner", publicKey: PUB })).isError).toBe(true)
    expect((await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: "utc_bad", role: "viewer", publicKey: PUB })).text).toMatch(/utc_ followed by 22/)
    expect(h.client.call).not.toHaveBeenCalled()
  })

  it("a duplicate attach hints at untrace_change_key", async () => {
    h.client.call.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "conflict" }))
    const r = await h.call("untrace_attach_key", { resourceType: "file", resourceId: FILE_ID, keyType: "client", keyId: KEY2, role: "viewer", publicKey: PUB })
    expect(r.text).toMatch(/untrace_change_key/)
  })

  it("change needs role or scopes and maps owner_immutable", async () => {
    expect((await h.call("untrace_change_key", { resourceType: "file", resourceId: FILE_ID, entryId: ENTRY_ID })).text).toMatch(/give role, scopes or both/)
    h.client.call.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "owner_immutable", message: "owner_immutable" }))
    const r = await h.call("untrace_change_key", { resourceType: "file", resourceId: FILE_ID, entryId: ENTRY_ID, role: "viewer" })
    expect(r.text).toMatch(/^owner_immutable:.*never be removed/s)
    expect(h.client.call).toHaveBeenCalledWith("changeFileKey", { params: { fileId: FILE_ID, entryId: ENTRY_ID }, body: { role: "viewer" } })
  })

  it("remove needs confirm: true", async () => {
    expect((await h.call("untrace_remove_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: ENTRY_ID, confirm: false })).text).toMatch(/confirm: true/)
    expect(h.client.call).not.toHaveBeenCalled()
    await h.call("untrace_remove_key", { resourceType: "folder", resourceId: FOLDER_ID, entryId: ENTRY_ID, confirm: true })
    expect(h.client.call).toHaveBeenCalledWith("removeFolderKey", { params: { folderId: FOLDER_ID, entryId: ENTRY_ID } })
  })

  it("planned operations say so and change nothing", async () => {
    h.client.call.mockRejectedValueOnce(new UntracePlannedError("listFileKeys"))
    const r = await h.call("untrace_list_keys", { resourceType: "file", resourceId: FILE_ID })
    expect(r.text).toMatch(/^planned:.*does not offer listFileKeys yet/s)
  })
})

describe("untrace_whoami", () => {
  it("shows client id, base url, scopes and public key, never the secret", async () => {
    const r = await h.call("untrace_whoami")
    expect(r.json).toEqual({ clientId: "utc_7Kq2mXv9PpR4sTzW8nYbC3", baseUrl: "https://drive.untrace.network", scopes: ["download", "upload"], publicKey: PUB })
  })
})

describe("untrace_share", () => {
  it("refuses a bad username before any call", async () => {
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: FILE_ID, username: "Bob!", role: "viewer" })
    expect(r.isError).toBe(true)
    expect(h.client.call).not.toHaveBeenCalled()
  })

  it("refuses a sharing key that does not verify, and opens no key", async () => {
    h.client.call.mockResolvedValueOnce({ wallet: "x", publicKey: PUB, keySignature: "y", signedMessagePrefix: "z" })
    const r = await h.call("untrace_share", { resourceType: "file", resourceId: FILE_ID, username: "bob-untrace", role: "viewer" })
    expect(r.text).toMatch(/^integrity:.*does not verify/s)
    expect(h.client.openFileKey).not.toHaveBeenCalled()
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
