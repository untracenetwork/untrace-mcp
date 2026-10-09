# Development

## Commands

```bash
npm install            # needs @untracenetwork/sdk ^1.0.0 from npm (see "SDK dependency")
npm run build          # embeds the SDK guide, then tsup -> dist/ (cli.js is the bin)
npm run typecheck      # tsc, no emit
npm test               # vitest, mocked UntraceClient, no network
npm run pack:check     # after build: tarball contents, shebang, ^1.0.0 dependency
node dist/cli.js --help
```

`npm run guide` regenerates `src/generated/guide.ts` from `guide/sdk-readme.md`. It runs
automatically before build, typecheck and test. `src/generated/` is not committed.

## Layout

- `src/cli.ts`: the `untrace-mcp` bin, stdio transport. stdout is protocol only; logs go to stderr.
- `src/server.ts`: `createServer()`, every tool and its zod schema.
- `src/errors.ts`: SDK error to MCP tool error mapping (actionable messages).
- `src/paths.ts`: the `UNTRACE_MCP_ROOT` sandbox (traversal and symlink checks).
- `src/redact.ts`: secret redaction applied to every result and error.
- `src/guide.ts`, `guide/sdk-readme.md`: `untrace_setup_guide`. When the SDK README changes,
  copy it to `guide/sdk-readme.md` again.
- `test/`: one file per concern. `test/release.test.ts` pins the workflow and copy rules.

## SDK dependency

`package.json` depends on `@untracenetwork/sdk` `^1.0.0` and must stay that way. Until 1.0.0 is
on npm, CI installs a tarball of the SDK's `packages/core` built from `untrace-sdk@feat/sdk-v0`
at 40f5335 (`ci/vendor/`, sha256 checked by `ci/use-vendored-sdk.mjs`, wired by `ci/install.sh`).
That path is CI only, and `package.json` is restored before build and tests. Delete `ci/vendor/`,
`ci/use-vendored-sdk.mjs` and the fallback branch of `ci/install.sh` once the SDK is published.

Locally before publish: build the SDK core from an untrace-sdk checkout, `npm pack` it, and
install that tarball with `npm install --no-save <path-to-tgz>`.

## Rules

- Never accept the client secret as a tool argument, never log or return it.
- A developer key is a file member (admin, editor, viewer), never a user. The owner is never
  changed or removed. There is no device-based access: keys are file members only.
- Copy: no em dashes, no certifications, no shard math by storage provider. Say files are encrypted
  into 6 shards and any 3 rebuild the file.
- Do not link private GitHub repos from README.md or llms.txt. Link https://untrace.network/docs/mcp,
  https://untrace.network/llms.txt and the npm package.
- Never publish, tag or merge outside the process in docs/RELEASING.md.
