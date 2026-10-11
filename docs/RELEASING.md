# Releasing @untracenetwork/mcp

**Pushing a `v*` tag never publishes anything to npm.** Publishing is a separate, manual step
that JC approves. This mirrors untrace-sdk.

## Before the first release

1. `@untracenetwork/sdk@2.0.0` must be on npm. `publish.yml` checks this and never uses the
   CI-only vendored SDK in `ci/vendor/`.
2. JC (repo admin) creates the **`npm-publish` environment**: JC as the only required reviewer,
   deployment tags limited to `v*`, environment secret **`NPM_TOKEN`** (never a repo or org secret).
3. Protect `main` (pull request required, the `ci` check required, no force push) and add a tag
   ruleset so only admins create `v*` tags.

## Workflows

| Workflow | Trigger | What it does | Secrets / OIDC |
|---|---|---|---|
| `ci.yml` (**CI**) | PRs, pushes to `main` | install, build, typecheck, test, pack:check | none |
| `release.yml` (**Release (verify)**) | push of a `v*` tag | checks the tag equals the package version, then build, typecheck, test, pack:check and `npm publish --dry-run`. **Uploads nothing.** | none |
| `publish.yml` (**Publish to npm**) | `workflow_dispatch` only | `verify` job: run from a `v*` tag, `confirm` must equal the tag and package version, the SDK must be on npm, full build and tests. `publish` job: waits in `npm-publish` for JC, then publishes with `--provenance` | `NPM_TOKEN` (environment secret) and `id-token: write`, on the `publish` job only |

`test/release.test.ts` pins these rules, so a change that lets a tag push publish fails CI.

## Cutting a release

1. Bump `package.json` and `src/version.ts`, update `CHANGELOG.md`, merge into `main` with CI green.
2. Tag the merge commit: `git tag -s v2.0.0 -m "v2.0.0" && git push origin v2.0.0`. The
   **Release (verify)** run must be green. Nothing is published yet.
3. Only with JC's explicit yes: Actions > **Publish to npm** > Run workflow, "Use workflow from"
   **Tags: v2.0.0**, `confirm` = `2.0.0`. JC approves the `publish` job in `npm-publish`.
4. Check `npm view @untracenetwork/mcp@2.0.0` and `npx -y @untracenetwork/mcp --version`.

Re-running the publish workflow is safe: a version already on npm is skipped.

## The npm scope

Publish under **`@untracenetwork`** only. The `@untrace` scope on npm belongs to an unrelated
third party: never publish to it and never tell anyone to install from it.
