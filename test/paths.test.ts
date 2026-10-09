import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveInsideRoot } from "../src/paths"
import { FILE_ID, harness } from "./helpers"

type H = Awaited<ReturnType<typeof harness>>
let h: H
let outside: string
beforeEach(async () => {
  h = await harness()
  outside = await realpath(await mkdtemp(join(tmpdir(), "untrace-outside-")))
  await writeFile(join(outside, "secret.txt"), "top secret")
})
afterEach(async () => {
  await h.close()
  await rm(outside, { recursive: true, force: true })
})

describe("path sandbox (UNTRACE_MCP_ROOT)", () => {
  it.each(["../secret.txt", "../../etc/passwd", "a/../../x", "/etc/passwd"])("upload refuses %s", async (p) => {
    const r = await h.call("untrace_upload_file", { path: p })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^path_refused:/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("upload refuses an absolute path outside the root", async () => {
    const r = await h.call("untrace_upload_file", { path: join(outside, "secret.txt") })
    expect(r.text).toMatch(/^path_refused:.*outside the allowed folder/s)
  })

  it("upload accepts an absolute path inside the root", async () => {
    await h.write("in.txt", "hi")
    const r = await h.call("untrace_upload_file", { path: join(h.root, "in.txt") })
    expect(r.isError).toBe(false)
  })

  it("upload refuses a symlink that points outside the root", async () => {
    await h.symlink(join(outside, "secret.txt"), "link.txt")
    const r = await h.call("untrace_upload_file", { path: "link.txt" })
    expect(r.text).toMatch(/^path_refused:.*symlink/s)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("download refuses traversal and never calls the SDK", async () => {
    for (const p of ["../evil.sh", join(outside, "x.txt")]) {
      const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: p, overwrite: true })
      expect(r.text).toMatch(/^path_refused:/)
    }
    expect(h.client.files.download).not.toHaveBeenCalled()
  })

  it("download refuses writing through a symlinked folder that leaves the root", async () => {
    await h.symlink(outside, "escape")
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "escape/new.txt" })
    expect(r.text).toMatch(/^path_refused:/)
    expect(h.client.files.download).not.toHaveBeenCalled()
  })

  it("download refuses to write onto a symlink even inside the root", async () => {
    await h.write("real.txt", "keep")
    await h.symlink(join(h.root, "real.txt"), "alias.txt")
    const r = await h.call("untrace_download_file", { fileId: FILE_ID, path: "alias.txt", overwrite: true })
    expect(r.text).toMatch(/symlink/)
    expect(await h.read("real.txt")).toBe("keep")
  })

  it("resolveInsideRoot rejects NUL bytes and empty paths", async () => {
    await expect(resolveInsideRoot(h.root, "a\u0000b")).rejects.toThrow(/NUL/)
    await expect(resolveInsideRoot(h.root, "  ")).rejects.toThrow(/required/)
    await expect(resolveInsideRoot(h.root, "sub/new.txt")).resolves.toBe(join(h.root, "sub/new.txt"))
  })

  it("a sibling folder sharing the root's prefix is outside", async () => {
    const sibling = `${h.root}-evil`
    await expect(resolveInsideRoot(h.root, `${sibling}/x`)).rejects.toThrow(/outside/)
  })
})
