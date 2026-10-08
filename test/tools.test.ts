import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  UntraceAuthError,
  UntraceConflictError,
  UntraceFinalizeUnknownError,
  UntraceNotFoundError,
  UntraceOwnerImmutableError,
  UntracePaymentRequiredError,
  UntraceRateLimitError,
  UntraceRoleError,
  UntraceScopeError,
  UntraceUnavailableError,
  UntraceUploadError,
} from "@untracenetwork/sdk"

import { TOOL_NAMES } from "../src/server"
import { FILE_ID, KEY, KEY2, METERING, OWNER_WALLET, harness } from "./helpers"

type H = Awaited<ReturnType<typeof harness>>
let h: H
beforeEach(async () => {
  h = await harness()
})
afterEach(async () => {
  await h.close()
})

const notFound = () => new UntraceNotFoundError({ status: 404, code: "not_found", message: "not_found" })

describe("tool registry", () => {
  it("lists exactly the v1 tools, each with a description and an input schema", async () => {
    const { tools } = await h.mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(40)
      expect(t.inputSchema.type).toBe("object")
      expect(JSON.stringify(t)).not.toMatch(/secret"|clientSecret/i)
      expect(t.description).not.toMatch(/\u2014/)
    }
  })

  it("no tool accepts a secret argument", async () => {
    const { tools } = await h.mcp.listTools()
    for (const t of tools) for (const k of Object.keys(t.inputSchema.properties ?? {})) expect(k).not.toMatch(/secret|token|password/i)
  })
})

describe("untrace_list_files", () => {
  it("returns files and nextCursor, passes paging through", async () => {
    const r = await h.call("untrace_list_files", { limit: 10, cursor: "abc" })
    expect(r.isError).toBe(false)
    expect(r.json.files[0].fileId).toBe(FILE_ID)
    expect(r.json.nextCursor).toBe("c2")
    expect(h.client.files.list).toHaveBeenCalledWith({ limit: 10, cursor: "abc" })
  })

  it("rejects an out-of-range limit before calling the SDK", async () => {
    const r = await h.call("untrace_list_files", { limit: 500 })
    expect(r.isError).toBe(true)
    expect(h.client.files.list).not.toHaveBeenCalled()
  })

  it("maps an auth error to setup help", async () => {
    h.client.files.list.mockRejectedValueOnce(new UntraceAuthError({ status: 401, code: "invalid_client", message: "invalid_client" }))
    const r = await h.call("untrace_list_files")
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^auth:/)
    expect(r.text).toMatch(/Settings > Developer keys/)
  })

  it("maps 429 with Retry-After", async () => {
    h.client.files.list.mockRejectedValueOnce(new UntraceRateLimitError({ status: 429, code: "rate_limited", message: "slow down", retryAfterSeconds: 7 }))
    const r = await h.call("untrace_list_files")
    expect(r.text).toMatch(/Retry after 7 seconds/)
    expect(r.text).toMatch(/\(retryable\)/)
  })

  it("maps 503 as retryable", async () => {
    h.client.files.list.mockRejectedValueOnce(new UntraceUnavailableError({ status: 503, code: "unavailable", message: "down" }))
    const r = await h.call("untrace_list_files")
    expect(r.text).toMatch(/^unavailable:.*retryable/s)
  })
})

describe("untrace_get_file", () => {
  it("returns metadata without the wrapped key or rate-limit meta", async () => {
    const r = await h.call("untrace_get_file", { fileId: FILE_ID })
    expect(r.isError).toBe(false)
    expect(r.json.name).toBe("report.pdf")
    expect(r.json.role).toBe("admin")
    expect(r.json).not.toHaveProperty("wrappedKey")
    expect(r.json).not.toHaveProperty("meta")
  })

  it("404 explains that the key may not be a member", async () => {
    h.client.files.get.mockRejectedValueOnce(notFound())
    const r = await h.call("untrace_get_file", { fileId: FILE_ID })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^not_found:/)
    expect(r.text).toMatch(/not a member/)
    expect(r.text).toMatch(/add this key as a member/)
  })

  it("rejects a non-UUID file id", async () => {
    const r = await h.call("untrace_get_file", { fileId: "../../etc" })
    expect(r.isError).toBe(true)
    expect(h.client.files.get).not.toHaveBeenCalled()
  })
})

describe("untrace_upload_file", () => {
  it("uploads a file inside the root and returns fileId and metering", async () => {
    await h.write("a.pdf", "hello")
    const r = await h.call("untrace_upload_file", { path: "a.pdf", mime: "application/pdf" })
    expect(r.isError).toBe(false)
    expect(r.json).toEqual({ fileId: FILE_ID, name: "a.pdf", size: 5, finalized: true, metering: METERING })
    const arg = h.client.files.upload.mock.calls[0]![0]
    expect(new TextDecoder().decode(arg.data)).toBe("hello")
    expect(arg).toMatchObject({ name: "a.pdf", mime: "application/pdf" })
  })

  it("uses the given Drive name", async () => {
    await h.write("a.pdf", "hello")
    const r = await h.call("untrace_upload_file", { path: "./a.pdf", name: "Q3 report.pdf" })
    expect(r.json.name).toBe("Q3 report.pdf")
  })

  it("refuses files over 95 MB without reading them", async () => {
    const { truncate, open } = await import("node:fs/promises")
    const p = `${h.root}/big.bin`
    await (await open(p, "w")).close()
    await truncate(p, 95 * 1024 * 1024 + 1)
    const r = await h.call("untrace_upload_file", { path: "big.bin" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/95 MB/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("refuses an empty file and a folder", async () => {
    await h.write("empty.txt", "")
    await h.mkdir("dir")
    expect((await h.call("untrace_upload_file", { path: "empty.txt" })).text).toMatch(/empty/)
    expect((await h.call("untrace_upload_file", { path: "dir" })).text).toMatch(/not a regular file/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("reports a missing local file", async () => {
    const r = await h.call("untrace_upload_file", { path: "nope.txt" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^file_missing:/)
  })

  it("409 owner not signed in tells the agent to have the owner sign in once", async () => {
    await h.write("a.pdf", "hello")
    h.client.files.upload.mockRejectedValueOnce(
      new UntraceConflictError({ status: 409, code: "conflict", message: "The owner of this developer key has not signed in to Untrace Drive yet" })
    )
    const r = await h.call("untrace_upload_file", { path: "a.pdf" })
    expect(r.text).toMatch(/^owner_not_ready:/)
    expect(r.text).toMatch(/sign in to Drive once/)
  })

  it("finalize unknown says do not re-upload", async () => {
    await h.write("a.pdf", "hello")
    h.client.files.upload.mockRejectedValueOnce(new UntraceFinalizeUnknownError({ fileId: FILE_ID, message: "unknown" }))
    const r = await h.call("untrace_upload_file", { path: "a.pdf" })
    expect(r.text).toMatch(/Do NOT upload again/)
    expect(r.text).toContain(FILE_ID)
  })

  it("partial shard failure is retryable and not billed", async () => {
    await h.write("a.pdf", "hello")
    h.client.files.upload.mockRejectedValueOnce(new UntraceUploadError({ fileId: FILE_ID, failedNodes: [2, 5], message: "partial" }))
    const r = await h.call("untrace_upload_file", { path: "a.pdf" })
    expect(r.text).toMatch(/nothing was billed/)
    expect(r.text).toMatch(/nodes 2, 5/)
  })

  it("402 explains the owner's plan", async () => {
    await h.write("a.pdf", "hello")
    h.client.files.upload.mockRejectedValueOnce(new UntracePaymentRequiredError({ status: 402, code: "payment_required", message: "quota" }))
    const r = await h.call("untrace_upload_file", { path: "a.pdf" })
    expect(r.text).toMatch(/^payment_required:.*owner's plan/s)
  })

  it("missing upload scope names the scope", async () => {
    await h.write("a.pdf", "hello")
    h.client.files.upload.mockRejectedValueOnce(new UntraceScopeError({ status: 403, code: "insufficient_scope", message: "scope", body: { required: "upload" } }))
    const r = await h.call("untrace_upload_file", { path: "a.pdf" })
    expect(r.text).toMatch(/"upload" scope/)
  })
})

describe("untrace_download_file", () => {
  it("writes the decrypted bytes inside the root", async () => {
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "out/report.pdf" })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ fileId: FILE_ID, name: "report.pdf", size: 5, path: `${h.root}/out/report.pdf` })
    expect(await h.read("out/report.pdf")).toBe("hello")
  })

  it("refuses to overwrite unless overwrite is true", async () => {
    await h.write("report.pdf", "old")
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "report.pdf" })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/already exists.*overwrite: true/)
    expect(h.client.files.download).not.toHaveBeenCalled()
    expect(await h.read("report.pdf")).toBe("old")

    const r2 = await h.call("untrace_download_file", { fileId: FILE_ID, path: "report.pdf", overwrite: true })
    expect(r2.isError).toBe(false)
    expect(await h.read("report.pdf")).toBe("hello")
  })

  it("refuses a folder as target", async () => {
    await h.mkdir("d")
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "d", overwrite: true })
    expect(r.text).toMatch(/is a folder/)
  })

  it("maps 404 and writes nothing", async () => {
    h.client.files.download.mockRejectedValueOnce(notFound())
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "x.pdf" })
    expect(r.text).toMatch(/^not_found:/)
    await expect(h.read("x.pdf")).rejects.toThrow()
  })
})

describe("untrace_rename_file", () => {
  it("renames", async () => {
    const r = await h.call("untrace_rename_file", { fileId: FILE_ID, name: "new.pdf" })
    expect(r.json).toEqual({ fileId: FILE_ID, name: "new.pdf" })
    expect(h.client.files.rename).toHaveBeenCalledWith(FILE_ID, "new.pdf")
  })

  it("viewer gets a role explanation", async () => {
    h.client.files.rename.mockRejectedValueOnce(new UntraceRoleError({ status: 403, code: "insufficient_role", message: "role" }))
    const r = await h.call("untrace_rename_file", { fileId: FILE_ID, name: "new.pdf" })
    expect(r.text).toMatch(/^insufficient_role:.*editor can also rename/s)
  })
})

describe("untrace_delete_file", () => {
  it("refuses without confirm: true", async () => {
    const r = await h.call("untrace_delete_file", { fileId: FILE_ID, confirm: false })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/confirm: true/)
    expect(h.client.files.delete).not.toHaveBeenCalled()
  })

  it("refuses when confirm is missing", async () => {
    const r = await h.call("untrace_delete_file", { fileId: FILE_ID })
    expect(r.isError).toBe(true)
    expect(h.client.files.delete).not.toHaveBeenCalled()
  })

  it("moves to the trash with confirm: true", async () => {
    const r = await h.call("untrace_delete_file", { fileId: FILE_ID, confirm: true })
    expect(r.json).toEqual({ fileId: FILE_ID, trashed: true })
  })

  it("maps a missing delete scope", async () => {
    h.client.files.delete.mockRejectedValueOnce(new UntraceScopeError({ status: 403, code: "insufficient_scope", message: "scope", body: { required: "delete" } }))
    const r = await h.call("untrace_delete_file", { fileId: FILE_ID, confirm: true })
    expect(r.text).toMatch(/"delete" scope/)
  })
})

describe("members", () => {
  it("lists the owner and members", async () => {
    const r = await h.call("untrace_list_members", { fileId: FILE_ID })
    expect(r.json.owner).toBe(OWNER_WALLET)
    expect(r.json.members[0].clientId).toBe(KEY)
  })

  it("list members maps 404", async () => {
    h.client.members.list.mockRejectedValueOnce(notFound())
    expect((await h.call("untrace_list_members", { fileId: FILE_ID })).text).toMatch(/not a member/)
  })

  it("adds a key with a grantable role", async () => {
    const r = await h.call("untrace_add_member", { fileId: FILE_ID, clientId: KEY2, role: "viewer" })
    expect(r.json).toEqual({ fileId: FILE_ID, clientId: KEY2, role: "viewer" })
  })

  it("refuses role owner and non-utc ids for add", async () => {
    expect((await h.call("untrace_add_member", { fileId: FILE_ID, clientId: KEY2, role: "owner" })).isError).toBe(true)
    expect((await h.call("untrace_add_member", { fileId: FILE_ID, clientId: OWNER_WALLET, role: "admin" })).isError).toBe(true)
    expect(h.client.members.add).not.toHaveBeenCalled()
  })

  it("duplicate member hints at set_member_role", async () => {
    h.client.members.add.mockRejectedValueOnce(new UntraceConflictError({ status: 409, code: "conflict", message: "already a member" }))
    const r = await h.call("untrace_add_member", { fileId: FILE_ID, clientId: KEY2, role: "editor" })
    expect(r.text).toMatch(/untrace_set_member_role/)
  })

  it("sets a role", async () => {
    const r = await h.call("untrace_set_member_role", { fileId: FILE_ID, clientId: KEY2, role: "admin" })
    expect(r.json.role).toBe("admin")
    expect((await h.call("untrace_set_member_role", { fileId: FILE_ID, clientId: KEY2, role: "owner" })).isError).toBe(true)
  })

  it("set role on the owner maps owner_immutable", async () => {
    h.client.members.setRole.mockRejectedValueOnce(new UntraceOwnerImmutableError({ status: 409, code: "owner_immutable", message: "owner" }))
    const r = await h.call("untrace_set_member_role", { fileId: FILE_ID, clientId: KEY2, role: "viewer" })
    expect(r.text).toMatch(/^owner_immutable:/)
  })

  it("removes a key", async () => {
    const r = await h.call("untrace_remove_member", { fileId: FILE_ID, clientId: KEY2 })
    expect(r.json).toEqual({ fileId: FILE_ID, clientId: KEY2, revoked: true })
  })

  it("refuses to remove the owner wallet before calling the SDK", async () => {
    const r = await h.call("untrace_remove_member", { fileId: FILE_ID, clientId: OWNER_WALLET })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/owner of a file can never be removed/)
    expect(h.client.members.remove).not.toHaveBeenCalled()
  })

  it("maps an owner_immutable answer from the SDK on remove", async () => {
    h.client.members.remove.mockRejectedValueOnce(new UntraceOwnerImmutableError({ status: 409, code: "owner_immutable", message: "owner" }))
    const r = await h.call("untrace_remove_member", { fileId: FILE_ID, clientId: KEY2 })
    expect(r.text).toMatch(/can never be added, changed or removed/)
  })
})

describe("untrace_setup_guide", () => {
  it.each(["nextjs", "node", "react", "vue"])("%s guide has steps, install line and code", async (framework) => {
    const r = await h.call("untrace_setup_guide", { framework })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/Settings > Developer keys/)
    expect(r.text).toMatch(/UNTRACE_CLIENT_SECRET/)
    expect(r.text).toMatch(/6 encrypted shards\. Any 3 rebuild the file/)
    expect(r.text).toMatch(/https:\/\/untrace\.network\/llms\.txt/)
    expect(r.text).toMatch(/```/)
    expect(r.text).not.toMatch(/\u2014/)
    expect(r.text).not.toMatch(/authorized devices/i)
  })

  it("nextjs uses createUntraceRoute, vue uses untracePlugin", async () => {
    expect((await h.call("untrace_setup_guide", { framework: "nextjs" })).text).toMatch(/createUntraceRoute/)
    expect((await h.call("untrace_setup_guide", { framework: "vue" })).text).toMatch(/untracePlugin/)
    expect((await h.call("untrace_setup_guide", { framework: "node" })).text).toMatch(/uploadPath/)
  })

  it("can leave out the reference sections", async () => {
    const full = await h.call("untrace_setup_guide", { framework: "node" })
    const short = await h.call("untrace_setup_guide", { framework: "node", includeReference: false })
    expect(full.text).toMatch(/UntraceRateLimitError/)
    expect(short.text).not.toMatch(/UntraceRateLimitError/)
  })

  it("works without any client configured", async () => {
    expect(h.client.files.list).not.toHaveBeenCalled()
  })
})
