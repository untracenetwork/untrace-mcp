import { afterEach, describe, expect, it } from "vitest"
import { UntraceClient, UntraceError, UntraceServerError } from "@untracenetwork/sdk"

import { redact } from "../src/redact"
import { createServer } from "../src/server"
import { FILE_ID, SECRET, harness, mockClient } from "./helpers"

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

const BODY = SECRET.slice("untrace_sk_v1_".length)

describe("secret redaction", () => {
  it("redact() strips prefixed secrets, bare configured secrets, bearer tokens and token fields", () => {
    const out = redact(`a ${SECRET} b ${BODY} Bearer abc.def.ghi "accessToken":"eyJhbGciOiJFZERTQSJ9"`, [SECRET, BODY])
    expect(out).not.toContain(BODY)
    expect(out).not.toContain("abc.def.ghi")
    expect(out).not.toContain("eyJhbGciOiJFZERTQSJ9")
    expect(out).toContain("[redacted]")
  })

  it("an SDK error that somehow carries the secret is redacted in the tool result", async () => {
    process.env.UNTRACE_CLIENT_SECRET = SECRET
    const h = await harness()
    try {
      // Bypass the SDK's own redaction to prove this layer redacts too.
      const err = new UntraceServerError({ status: 500, code: "server_error", message: "boom" })
      Object.defineProperty(err, "message", { value: `boom ${BODY} and ${SECRET}` })
      h.client.files.get.mockRejectedValueOnce(err)
      const r = await h.call("untrace_get_file", { fileId: FILE_ID })
      expect(r.isError).toBe(true)
      expect(r.text).not.toContain(BODY)
      expect(r.text).toMatch(/\[redacted\]/)
    } finally {
      await h.close()
    }
  })

  it("a successful result that contains the secret is redacted", async () => {
    process.env.UNTRACE_CLIENT_SECRET = SECRET
    const c = mockClient()
    c.files.rename.mockResolvedValueOnce({ fileId: FILE_ID, name: `leak ${SECRET}`, meta: {} as never })
    const h = await harness({ client: c })
    try {
      const r = await h.call("untrace_rename_file", { fileId: FILE_ID, name: "x" })
      expect(r.text).not.toContain(BODY)
    } finally {
      await h.close()
    }
  })

  it("a malformed secret in the environment is reported without echoing it", async () => {
    process.env.UNTRACE_CLIENT_ID = "utc_7Kq2mXv9PpR4sTzW8nYbC3"
    process.env.UNTRACE_CLIENT_SECRET = "untrace_sk_v1_tooShortButSecretish"
    delete process.env.UNTRACE_BASE_URL
    const h = await harness({ client: () => new UntraceClient() as never })
    try {
      const r = await h.call("untrace_list_files")
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^not_configured:/)
      expect(r.text).toMatch(/Settings > Developer keys/)
      expect(r.text).not.toContain("tooShortButSecretish")
    } finally {
      await h.close()
    }
  })

  it("missing credentials give setup help, and the server still starts", async () => {
    delete process.env.UNTRACE_CLIENT_ID
    delete process.env.UNTRACE_CLIENT_SECRET
    const server = createServer({ root: process.cwd() })
    expect(server).toBeTruthy()
    const h = await harness({ client: () => new UntraceClient() as never })
    try {
      const r = await h.call("untrace_list_files")
      expect(r.text).toMatch(/^not_configured:.*UNTRACE_CLIENT_ID/s)
      const g = await h.call("untrace_setup_guide", { framework: "node" })
      expect(g.isError).toBe(false)
    } finally {
      await h.close()
    }
  })

  it("generic UntraceError messages pass through redacted", async () => {
    process.env.UNTRACE_CLIENT_SECRET = SECRET
    const h = await harness()
    try {
      h.client.files.list.mockRejectedValueOnce(new UntraceError({ status: 400, code: "invalid_request", message: "untrace: limit must be an integer from 1 to 200" }))
      const r = await h.call("untrace_list_files")
      expect(r.text).toMatch(/^invalid_request: untrace: limit/)
    } finally {
      await h.close()
    }
  })
})

