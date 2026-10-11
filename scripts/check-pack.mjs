#!/usr/bin/env node
// Verify the npm tarball: only dist/, README.md, LICENSE, llms.txt, SKILL.md and package.json; the bin has a
// shebang; nothing looks like a secret, a test or the CI-only vendored SDK; and the published
// manifest depends on @untracenetwork/sdk ^2.0.0. Run after `npm run build`.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const ALLOWED = /^(package\.json|README\.md|LICENSE|llms\.txt|SKILL\.md|dist\/.+)$/
const FORBIDDEN = [/\.env/, /\.test\./, /(^|\/)test\//, /(^|\/)src\//, /(^|\/)ci\//, /\.tgz$/, /\.tsbuildinfo$/]
import { CLIENT_SECRET_PREFIX } from "@untracenetwork/sdk"
const SECRET_RE = new RegExp(`${CLIENT_SECRET_PREFIX}[A-Za-z0-9_-]{20,}`)

const parsed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }))
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
const files = info.files.map((f) => f.path)
const bad = files.filter((f) => !ALLOWED.test(f) || FORBIDDEN.some((re) => re.test(f)))
for (const f of files.filter((f) => /\.(c?js|d\.c?ts|map|md|txt)$/.test(f))) {
  if (SECRET_RE.test(readFileSync(f, "utf8"))) bad.push(`${f} (contains a client secret)`)
}
for (const must of ["package.json", "README.md", "LICENSE", "llms.txt", "SKILL.md", "dist/cli.js", "dist/index.js", "dist/index.d.ts"]) {
  if (!files.includes(must)) bad.push(`missing ${must}`)
}
if (files.includes("dist/cli.js") && !readFileSync("dist/cli.js", "utf8").startsWith("#!/usr/bin/env node")) bad.push("dist/cli.js has no shebang")
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (pkg.dependencies?.["@untracenetwork/sdk"] !== "^2.0.0") bad.push(`@untracenetwork/sdk dependency is ${pkg.dependencies?.["@untracenetwork/sdk"]}, must be ^2.0.0 (restore package.json after the CI install)`)
if (pkg.bin?.["untrace-mcp"] !== "dist/cli.js") bad.push("bin untrace-mcp must be dist/cli.js")

console.log(`${info.name}@${info.version}: ${files.length} files, ${info.size} B packed`)
if (bad.length) {
  console.error(`pack check failed: ${bad.join(", ")}`)
  process.exit(1)
}
