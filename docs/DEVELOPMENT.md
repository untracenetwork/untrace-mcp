# Development

## Commands

```bash
ci/local-install.sh    # npm install, with the vendored SDK until @untracenetwork/sdk 2.0.0 is on npm
npm run build          # embeds the SDK guide, then tsup -> dist/ (cli.js is the bin)
npm run typecheck      # tsc, no emit
npm test               # vitest: unit tests, end to end with the real SDK against a mock Drive, HTTP + OAuth
npm run pack:check     # after build: tarball contents, shebang, ^2.0.0 dependency
npm run check:public   # the leak gate in MCP mode (no crypto here, no internals, no secrets)
node dist/cli.js --help
```

`npm run guide` regenerates `src/generated/guide.ts` from `guide/sdk-readme.md`. It runs
automatically before build, typecheck and test. `src/generated/` is not committed.

## Layout

- `src/cli.ts`: the `untrace-mcp` bin: `stdio` (default), `http`, `new-connector-secret`.
  On stdio, stdout is protocol only; logs go to stderr.
- `src/server.ts`: `createServer()`, every tool and its zod schema.
- `src/http.ts`: Streamable HTTP (stateless, JSON responses) and the OAuth 2.1 authorization
  server for one confidential client (authorization code + PKCE, refresh rotation, revocation).
- `src/errors.ts`: SDK error to MCP tool error mapping (actionable messages).
- `src/paths.ts`: the `UNTRACE_MCP_ROOT` sandbox (traversal and symlink checks).
- `src/agent/`: `untrace-mcp agent init|code|status` (docs/AGENT-PAIRING.md). `keys.ts` is the
  only file allowed a crypto primitive: it derives the agent key's Ed25519 sign key, which the SDK
  does not export, to sign the pairing code. `store.ts` is the keychain / 0600 file store.
- `src/redact.ts`: secret redaction applied to every result, error and log line.
- `src/guide.ts`, `guide/sdk-readme.md`: `untrace_setup_guide`. `guide/sdk-readme.md` is the
  untrace-sdk README without its "How ... works" internals notes and with the secret shown as a
  placeholder. Refresh it when the SDK README changes.
- `test/`: one file per concern. `test/mock-drive.ts` is the SDK's contract mock of Drive API v1
  (copied from untrace-sdk `packages/core/test/mock-drive.ts`), which the real SDK runs against. `test/release.test.ts` pins the workflow and copy rules.

## SDK dependency

`package.json` depends on `@untracenetwork/sdk` `^2.0.0` and must stay that way. Until 2.0.0 is on
npm, CI installs a tarball of the SDK's `packages/core` built from untrace-sdk main `ceb6ea4`
(PR #7, typed from Drive main `1b18365`) (`ci/vendor/`, sha256 checked by `ci/use-vendored-sdk.mjs`, wired by `ci/install.sh`). That path is
CI only, and `package.json` is restored before build and tests. Delete `ci/vendor/`,
`ci/use-vendored-sdk.mjs`, `ci/local-install.sh` and the fallback branch of `ci/install.sh` once
the SDK is published.

## Rules

- The MCP server does no cryptography (one exception: `src/agent/keys.ts`, above). The SDK encrypts, seals and opens keys; this repo only
  calls the SDK's typed APIs (files, folders, keys, shares) and zeroes the one key it holds (the
  optional sharing secret) after use. `scripts/check-public.mjs` enforces it.
- Never accept a secret as a tool argument, never log or return one.
- A developer key is a key, never a user. The owner is never changed or removed. Unknown and
  unreachable both answer `not_found`.
- Copy: no em dashes, no certifications, no storage internals. Say files are stored in 6 regions
  and any 3 recover a file.
- Do not link private GitHub repos from README.md or llms.txt. Link https://untrace.network/docs/mcp,
  https://untrace.network/llms.txt and the npm package.
- Never publish, tag or merge outside the process in docs/RELEASING.md.
