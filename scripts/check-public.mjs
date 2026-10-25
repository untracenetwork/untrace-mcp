#!/usr/bin/env node
// Public-surface gate for this repo (the leak gate, MCP mode; Product/public-surface-staging.md).
//
//   node scripts/check-public.mjs
//
// The MCP server does no cryptography of its own: the SDK encrypts, seals and opens keys. So,
// stricter than the SDK's gate, this fails (exit 1) when a tracked file:
//   1. names core internals (split, redundancy coding, secret sharing, field math, storage topology,
//      core key-derivation labels);
//   2. calls any crypto primitive (except src/agent/keys.ts, the agent key, see CRYPTO_ALLOWED).
//      Hashing and randomness (createHash, randomBytes, timingSafeEqual) are allowed in
//      src/http.ts, src/cli.ts and src/agent/keys.ts only;
//   3. holds a secret or the literal client secret prefix, a private host, or native code;
//   4. lacks the Apache-2.0 LICENSE, or package.json says another licence.
// Patterns are assembled from pieces so this file does not trip the stock leak gate itself.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => existsSync(f))

const TEXT = /\.(m?[jt]sx?|c?js|json|ya?ml|md|txt|html|sh)$/
const HASH_ALLOWED = new Set(["src/http.ts", "src/cli.ts", "src/agent/keys.ts", "ci/use-vendored-sdk.mjs", "scripts/check-public.mjs"])
// The one exception to "no cryptography here": `agent init` creates a developer key on the agent's
// own machine and signs its pairing code. The SDK exports the box key and the OAuth value but
// not the Ed25519 sign key, so that half is derived in this file only (see docs/AGENT-PAIRING.md).
const CRYPTO_ALLOWED = new Set(["src/agent/keys.ts"])

const j = (...parts) => parts.join("")
const re = (src, flags = "") => new RegExp(src, flags)
const BANNED_NAMES = [
  re(j("sha", "mir"), "i"),
  re(j("reed[-_ ]?", "solomon"), "i"),
  re(j("\\b", "era", "sure"), "i"),
  re(j("\\bgf ?", "256\\b|gf\\(2\\^8\\)"), "i"),
  re(j("lag", "range"), "i"),
  re(j("\\bsha", "rds?\\b"), "i"),
  re(j("split", "_secret|combine", "_secret|split", "Secret|combine", "Secret")),
  re(j("untrace:(file-(k", "ek|d", "ek)|wal", "let)")),
  re(j("\\/api\\/nodes\\b|node", "Urls?|UNTRACE_NODE", "_URLS|nodes", "Chosen")),
  re(j("k[- ]of", "[- ]n"), "i"),
]
const CRYPTO_CALL = re(
  j("subtle\\.(en", "crypt|de", "crypt|derive", "Key|derive", "Bits|import", "Key)|create", "Cipheriv|create", "Decipheriv|AES-", "GCM|\\bhk", "df\\b|HK", "DF|pb", "kdf2|sc", "rypt\\(|xsalsa20", "poly1305|getShared", "Secret")
)
const HASHING = /createHash|randomBytes|timingSafeEqual/
const SECRET = re(
  j("BEGIN [A-Z ]*PRIVATE ", "KEY|untrace", "_sk_v1_|gh", "p_[A-Za-z0-9]{30,}|github", "_pat_|np", "m_[A-Za-z0-9]{30,}|sk", "_live_|sk", "_test_|AK", "IA[0-9A-Z]{16}")
)
// The public domain aiteam.space is allowed: it is the one connected project in the agent claim
// (src/agent/claim.ts CONNECTED_PROJECTS). Any other use of the name (repos, hosts) still fails.
const PRIVATE_INFRA = re(j("core", "-pm|\\.inter", "nal\\b|34\\.", "9\\.|neon\\.", "tech|untrace-sha", "rds|ai", "team(?!\\.space\\b)|([0-9]{1,3}\\.){3}[0-9]{1,3}"))
const NATIVE = /\.(rs|c|cc|cpp|so|dylib|dll|a|wasm)$|(^|\/)Cargo\.(toml|lock)$|crates\/|untrace-cli\/|untrace-core-ffi\/|flavors\//

const hits = []
const hit = (f, why) => hits.push(`${f}: ${why}`)

for (const f of files) {
  if (NATIVE.test(f)) hit(f, "native, compiled or private folder")
  if (!TEXT.test(f)) continue
  const text = readFileSync(f, "utf8")
  const isTest = /(^|\/)test\//.test(f)
  const sm = text.match(SECRET)
  if (sm) hit(f, `secret pattern (${sm[0]})`)
  const pm = text.match(PRIVATE_INFRA)
  // Loopback addresses are fine in code and tests (the HTTP server binds to loopback); docs say "localhost".
  if (pm && !(/^(127\.0\.0\.1|0\.0\.0\.0)$/.test(pm[0]) && (isTest || f.startsWith("src/")))) hit(f, `private infra reference (${pm[0]})`)
  for (const r of BANNED_NAMES) {
    const m = text.match(r)
    if (m) hit(f, `core internals name "${m[0]}"`)
  }
  const cm = text.match(CRYPTO_CALL)
  if (cm && !CRYPTO_ALLOWED.has(f)) hit(f, `crypto primitive (${cm[0]}): the MCP server leaves all cryptography to the SDK`)
  if (!isTest && !HASH_ALLOWED.has(f) && HASHING.test(text)) hit(f, `hashing or randomness outside src/http.ts and src/cli.ts (${text.match(HASHING)[0]})`)
}

if (!existsSync("LICENSE") || !/Apache License\s+Version 2\.0/.test(readFileSync("LICENSE", "utf8"))) hit("LICENSE", "not the Apache-2.0 licence")
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (pkg.license !== "Apache-2.0") hit("package.json", `license is ${pkg.license}`)

if (hits.length) {
  console.error(hits.join("\n"))
  console.error(`public check: ${hits.length} problem(s)`)
  process.exit(1)
}
console.log(`public check: clean (${files.length} files)`)
