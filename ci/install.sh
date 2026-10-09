#!/usr/bin/env bash
# CI install. Uses @untracenetwork/sdk from npm once 1.0.0 is published there; until then it
# falls back to the CI-only vendored tarball (see ci/use-vendored-sdk.mjs). package.json is
# restored afterwards so the build, tests and pack check see the published manifest (^1.0.0).
set -euo pipefail
if npm view "@untracenetwork/sdk@1.0.0" version >/dev/null 2>&1; then
  echo "@untracenetwork/sdk@1.0.0 is on npm: installing from the registry"
  npm install --no-audit --no-fund --no-package-lock
else
  echo "@untracenetwork/sdk@1.0.0 is not on npm yet: using the CI-only vendored tarball"
  cp package.json "${RUNNER_TEMP:-/tmp}/package.json.orig"
  node ci/use-vendored-sdk.mjs
  npm install --no-audit --no-fund --no-package-lock
  cp "${RUNNER_TEMP:-/tmp}/package.json.orig" package.json
fi
node -e 'const p=require("./package.json");if(p.dependencies["@untracenetwork/sdk"]!=="^1.0.0"){console.error("package.json was not restored");process.exit(1)}'
