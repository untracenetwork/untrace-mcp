#!/usr/bin/env bash
# Local dev install: same as CI (vendored SDK until @untracenetwork/sdk 2.0.0 is on npm).
set -euo pipefail
cd "$(dirname "$0")/.."
CI=1 RUNNER_TEMP="${TMPDIR:-/tmp}" ci/install.sh
