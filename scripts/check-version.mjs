#!/usr/bin/env node
// Usage: node scripts/check-version.mjs 1.0.0
// Fails unless package.json and src/version.ts are both at that version.
import { readFileSync } from "node:fs"

const want = process.argv[2]
if (!want || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(want)) {
  console.error(`check-version: "${want ?? ""}" is not a version`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync("package.json", "utf8")).version
const src = /VERSION = "([^"]+)"/.exec(readFileSync("src/version.ts", "utf8"))?.[1]
if (pkg !== want || src !== want) {
  console.error(`check-version: package.json ${pkg}, src/version.ts ${src}, expected ${want}`)
  process.exit(1)
}
console.log(`check-version: ${want} ok`)
