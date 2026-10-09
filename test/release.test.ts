/**
 * Release gating and package manifest rules. A v* tag push must never publish: only
 * publish.yml publishes, it is manual, needs a typed version, and its publish job runs in the
 * `npm-publish` environment. The published manifest depends on @untracenetwork/sdk ^1.0.0.
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { VERSION } from "../src/version"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (p: string) => readFileSync(`${root}${p}`, "utf8")
const wf = (n: string) => read(`.github/workflows/${n}`)
const pkg = JSON.parse(read("package.json"))

function onBlock(src: string): string {
  const m = /^on:\n([\s\S]*?)^(?=\S)/m.exec(src)
  return m ? m[1]! : ""
}

function jobs(src: string): Record<string, string> {
  const body = src.slice(src.search(/^jobs:\s*$/m))
  const out: Record<string, string> = {}
  const hits = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)]
  hits.forEach((h, i) => {
    out[h[1]!] = body.slice(h.index!, i + 1 < hits.length ? hits[i + 1]!.index : undefined)
  })
  return out
}

const publishes = (s: string) => /npm publish(?![^\n]*--dry-run)/.test(s)

describe("package manifest", () => {
  it("is @untracenetwork/mcp with the untrace-mcp bin", () => {
    expect(pkg.name).toBe("@untracenetwork/mcp")
    expect(pkg.version).toBe(VERSION)
    expect(pkg.bin).toEqual({ "untrace-mcp": "dist/cli.js" })
  })

  it("depends on the published SDK range, never a file: or git dependency", () => {
    expect(pkg.dependencies["@untracenetwork/sdk"]).toBe("^1.0.0")
    for (const v of Object.values<string>(pkg.dependencies)) expect(v).not.toMatch(/^(file:|git|github:|https?:)/)
  })

  it("pins the MCP SDK to an exact version", () => {
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("workflows", () => {
  it("only publish.yml contains a real npm publish", () => {
    const files = readdirSync(`${root}.github/workflows`).filter((f) => /\.ya?ml$/.test(f))
    expect(files.filter((f) => publishes(wf(f)))).toEqual(["publish.yml"])
  })

  it("every action is pinned to a full commit SHA", () => {
    for (const f of readdirSync(`${root}.github/workflows`)) {
      for (const m of wf(f).matchAll(/uses:\s*([^\s#]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it("every workflow defaults to contents: read and never persists checkout credentials", () => {
    for (const f of readdirSync(`${root}.github/workflows`)) {
      const s = wf(f)
      expect(s.slice(0, s.search(/^jobs:/m))).toMatch(/^permissions:\n {2}contents: read$/m)
      expect(s).not.toMatch(/write-all|contents: write|pull_request_target/)
      const checkouts = s.match(/actions\/checkout@/g)?.length ?? 0
      expect(s.match(/persist-credentials: false/g)?.length ?? 0).toBe(checkouts)
    }
  })

  it("a v* tag push only verifies: dry-run, no token, no id-token", () => {
    const r = wf("release.yml")
    expect(onBlock(r)).toMatch(/push:\s*\n\s*tags: \["v\*"\]/)
    expect(r).toMatch(/npm publish[^\n]*--dry-run/)
    expect(publishes(r)).toBe(false)
    expect(r).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token|secrets\./)
  })

  it("publish.yml is workflow_dispatch only, with a required confirm that must equal the tag", () => {
    const p = wf("publish.yml")
    const on = onBlock(p)
    expect(on).toMatch(/^\s{2}workflow_dispatch:/m)
    expect(on).not.toMatch(/^\s{2}(push|pull_request|pull_request_target|release|schedule|workflow_run|workflow_call):/m)
    expect(on).toMatch(/confirm:\s*\n(\s+.*\n)*?\s+required: true/)
    expect(p).toContain('"v$CONFIRM" != "$GITHUB_REF_NAME"')
    for (const line of p.split("\n").filter((l) => l.includes("${{ inputs."))) {
      expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.confirm \}\}$/)
    }
  })

  it("only the publish job has id-token and secrets, in the npm-publish environment", () => {
    const p = wf("publish.yml")
    expect(p.slice(0, p.search(/^jobs:/m))).not.toMatch(/id-token/)
    const j = jobs(p)
    expect(Object.keys(j)).toEqual(["verify", "publish"])
    expect(j.publish).toMatch(/needs: verify/)
    expect(j.publish).toMatch(/environment: npm-publish/)
    expect(j.publish).toMatch(/id-token: write/)
    expect(j.publish).toMatch(/--provenance/)
    expect(j.verify).not.toMatch(/id-token|secrets\.|environment:/)
  })

  it("the vendored SDK is CI-only: never used by publish.yml", () => {
    expect(wf("publish.yml")).not.toMatch(/ci\/install\.sh|use-vendored-sdk|ci\/vendor/)
    expect(wf("ci.yml")).toMatch(/ci\/install\.sh/)
  })
})

describe("docs copy rules", () => {
  const docs = ["README.md", "llms.txt", "docs/DEVELOPMENT.md", "docs/RELEASING.md"]
  it.each(docs)("%s has no em dashes, certifications, shard math or authorized devices", (f) => {
    const s = read(f)
    expect(s).not.toMatch(/\u2014/)
    expect(s).not.toMatch(/authori[sz]ed devices?/i)
    expect(s).not.toMatch(/\b(SOC ?2|ISO ?27001|HIPAA|certified)\b/i)
    expect(s).not.toMatch(/per[- ]provider|\b\d+ shards? (per|on each) /i)
  })

  it("README and llms.txt link no private GitHub repos", () => {
    for (const f of ["README.md", "llms.txt"]) expect(read(f)).not.toMatch(/github\.com\/untracenetwork/)
  })

  it("README documents every tool and the env vars", () => {
    const r = read("README.md")
    for (const t of ["untrace_list_files", "untrace_get_file", "untrace_upload_file", "untrace_download_file", "untrace_rename_file", "untrace_delete_file", "untrace_list_members", "untrace_add_member", "untrace_set_member_role", "untrace_remove_member", "untrace_setup_guide"]) {
      expect(r).toContain(t)
      expect(read("llms.txt")).toContain(t)
    }
    for (const v of ["UNTRACE_CLIENT_ID", "UNTRACE_CLIENT_SECRET", "UNTRACE_BASE_URL", "UNTRACE_MCP_ROOT"]) expect(r).toContain(v)
    expect(r).toContain("npx -y @untracenetwork/mcp")
    expect(r).toContain("https://untrace.network/llms.txt")
  })
})
