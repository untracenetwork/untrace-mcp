#!/usr/bin/env node
// CI ONLY. @untracenetwork/sdk 2.0.0 is not on npm yet, and untracenetwork/untrace-sdk is a
// private repo the default GITHUB_TOKEN of this repo cannot check out. Until the SDK is
// published, CI installs a tarball of packages/core built from untrace-sdk@feat/oauth-option-b
// (2579596, PR untrace-sdk#7), committed at ci/vendor/. This script checks its sha256 and points the
// dependency at it for the CI install only. The published package.json keeps "^2.0.0"
// (test/release.test.ts and scripts/check-pack.mjs enforce that).
//
// Usage: node ci/use-vendored-sdk.mjs   (then npm install; git checkout package.json after)
// Remove this script, ci/vendor/ and the CI step once @untracenetwork/sdk@2.0.0 is on npm.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const TARBALL = "ci/vendor/untracenetwork-sdk-2.0.0.tgz"
const SHA256 = "964e6377bd7e6d2adb820aabf2079601ae2f2c76561d9598d6f0ad51d5d2aee4"

if (!process.env.CI) {
  console.error("use-vendored-sdk: CI only. Locally, install @untracenetwork/sdk from npm (or npm link a checkout).")
  process.exit(1)
}
const got = createHash("sha256").update(readFileSync(TARBALL)).digest("hex")
if (got !== SHA256) {
  console.error(`use-vendored-sdk: ${TARBALL} sha256 is ${got}, expected ${SHA256}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (pkg.dependencies["@untracenetwork/sdk"] !== "^2.0.0") {
  console.error("use-vendored-sdk: package.json must depend on @untracenetwork/sdk ^2.0.0")
  process.exit(1)
}
pkg.dependencies["@untracenetwork/sdk"] = `file:${TARBALL}`
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`use-vendored-sdk: @untracenetwork/sdk -> ${TARBALL} (sha256 ok). CI only, not committed.`)
