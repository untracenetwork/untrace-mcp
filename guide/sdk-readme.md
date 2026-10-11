# untrace-sdk

JavaScript SDK for the Untrace Drive API v1. Thin, typed wrappers over the API, generated from the
Drive OpenAPI contract.

Your server holds a client id and a client secret. Files are encrypted on your machine before they
are sent, with one standard step (AES-256-GCM). Drive stores the ciphertext in 6 regions, and any 3
recover it. The file key is sealed to your key and to the account owner's key, so only those keys
can open it. We cannot read your files.

| Package | Use it for |
|---|---|
| `@untracenetwork/sdk` | The core client for any server runtime (Node 20+, Bun, Deno, Workers) |
| `@untracenetwork/next` | Next.js route handler and server actions |
| `@untracenetwork/react` | Hooks that call your own backend route |
| `@untracenetwork/vue` | Composables that call your own backend route |

```bash
npm i @untracenetwork/sdk     # any server runtime
npm i @untracenetwork/next    # Next.js (pulls in @untracenetwork/sdk)
npm i @untracenetwork/react   # React hooks, browser side
npm i @untracenetwork/vue     # Vue composables, browser side
```

The client secret is server-only. `UntraceClient` refuses to start in a browser. React and Vue code
talks to your backend route, never to Untrace directly. Minimal apps for each package are in
[`examples/`](./examples).

## 1. Create a key in Drive

1. Open Untrace Drive, then **Settings > Developer keys**, and create a key. Pick its scopes:
   `download`, `upload`, `delete`, `manage-sharing`.
2. Copy the **client id** (`utc_...`) and the **client secret** (shown in Drive). The secret is
   shown once. Untrace does not keep it. If you lose it, revoke the key and create a new one.
3. The account that owns the key needs an active plan. Without one, Drive answers 402.
4. Sign in to Drive at least once as the owner before the key uploads. That publishes the sharing key
   new files are sealed to.

```bash
# server env only (never NEXT_PUBLIC_)
UNTRACE_CLIENT_ID=utc_...
UNTRACE_CLIENT_SECRET=<client secret>
```

## 2. Core client

```ts
import { UntraceClient } from "@untracenetwork/sdk"

const untrace = new UntraceClient() // reads UNTRACE_CLIENT_ID and UNTRACE_CLIENT_SECRET

const { file, metering } = await untrace.files.upload({ data: bytes, name: "report.pdf", mime: "application/pdf" })
const { files, nextCursor } = await untrace.files.list({ limit: 50 })
for await (const f of untrace.files.listAll()) console.log(f.name)
const { bytes: plain, name, mime } = await untrace.files.download(file.fileId)
await untrace.files.rename(file.fileId, "report-final.pdf")
await untrace.files.delete(file.fileId) // moves it to the trash
```

`upload` takes a `Uint8Array`, an `ArrayBuffer` or a `Blob`. In this version one upload is at most
16 MiB once encrypted. `metering` reports what was billed to the owner's plan.

Every operation in the contract is also reachable by its `operationId`:

```ts
const shareKey = await untrace.call("getOwnerShareKey")
```

Operations marked `planned` in the contract (folders, key entries, sharing) throw
`UntracePlannedError` until Drive ships them. `OPERATIONS` lists every operation with its status.

## 3. Next.js

```bash
npm install @untracenetwork/next @untracenetwork/react
```

`app/api/untrace/route.ts`:

```ts
import { createUntraceRoute } from "@untracenetwork/next"
import { auth } from "@/auth" // your own session check

export const { GET, POST } = createUntraceRoute({
  authorize: async () => Boolean(await auth()), // required: the route is public otherwise
  allow: ["list", "get", "download", "upload"], // read-only by default
})
export const runtime = "nodejs"
```

Server actions: `untraceActions.listFiles()`, `getFile()`, `uploadFromForm(formData)`, `renameFile()`,
`deleteFile()`. Wrap them in your own `"use server"` functions after checking the session.
`getUntrace()` returns one shared client per server process. See [`examples/next`](./examples/next).

## 4. React and Vue

```tsx
import { UntraceProvider, useUntraceFiles, useUntraceUpload } from "@untracenetwork/react"

<UntraceProvider endpoint="/api/untrace"><Files /></UntraceProvider>
```

```ts
import { untracePlugin, useUntraceFiles, useUntraceUpload } from "@untracenetwork/vue"

app.use(untracePlugin, { endpoint: "/api/untrace" })
```

### Route protocol and CSRF

`createUntraceHandler` (from `@untracenetwork/sdk/backend`) is a Web `Request` to `Response` handler
for any server. One route:

| Request | Answer |
|---|---|
| `GET ?action=list[&cursor=&limit=]` | `{ files, nextCursor }` |
| `GET ?action=get&fileId=` | file metadata, no key material |
| `GET ?action=download&fileId=` | the decrypted bytes |
| `POST ?action=upload`, multipart `file[, name]` | `{ file }` |
| `POST ?action=rename&fileId=`, JSON `{ name }` | `{ fileId, name }` |
| `POST ?action=delete&fileId=`, JSON `{}` | `{ fileId, trashed }` |

- `authorize(request, action, fileId)` is required and runs before any body is read.
- Only `list`, `get` and `download` are enabled by default. Opt in to writes with `allow`.
- Every POST needs `x-untrace-request: 1` and a JSON content type (multipart for upload), which a
  cross-site form cannot send. Cross-site and foreign-origin requests are refused unless listed in
  `allowedOrigins`. Keep your session cookie `SameSite=Lax` or `Strict` as a second layer.

## Scopes and roles

| Scope | Allows |
|---|---|
| `download` | read files the key can reach |
| `upload` | upload new files, billed to the owner's plan |
| `delete` | move files to the trash where the key is `admin` |
| `manage-sharing` | manage key entries and shares (planned) |

A key that uploads a file becomes its `editor`. A file the key cannot reach answers 404, the same as a
file that does not exist. Pass `scope` to `UntraceClient` to ask for fewer scopes than the key holds.

## Errors

Every error is an `UntraceError` with `status`, `code`, `retryable` and a redacted `message`.

| Class | When |
|---|---|
| `UntraceAuthError` | 401 `invalid_client` or `token_expired` (the SDK refreshes once for you) |
| `UntraceScopeError` | 403 `insufficient_scope` or 400 `invalid_scope`; `required` names the scope |
| `UntraceRoleError` | 403 `insufficient_role` |
| `UntraceNotFoundError` | 404 |
| `UntracePaymentRequiredError` | 402: the owner's plan does not allow it; `planCode` says why |
| `UntraceConflictError` | 409 `conflict`, `owner_immutable`, `unsupported_format` (a file made in the Drive app) |
| `UntraceTooLargeError` | 413, or refused locally before sending |
| `UntraceRateLimitError` | 429; `retryAfterSeconds` |
| `UntraceUnavailableError`, `UntraceTimeoutError` | 503, network, timeout: retry with backoff |
| `UntraceIntegrityError` | a sealed key, a signature or the ciphertext failed a local check |
| `UntracePlannedError` | the operation is planned and not served yet |
| `UntraceAbortError` | your `AbortSignal` fired |

### Timeouts, cancellation and retries

```ts
const untrace = new UntraceClient({ timeoutMs: 30_000, maxRetries: 2, retryBaseMs: 250 })
const ctl = new AbortController()
await untrace.files.download(fileId, { signal: ctl.signal, timeoutMs: 60_000 })
```

Only 503, 429 (honouring `Retry-After`) and network errors or timeouts are retried. Other 4xx never
are. A network failure on an upload is not retried, so a file is never stored twice.

## Security notes

- Keep `UNTRACE_CLIENT_SECRET` on the server. The client keeps it in a private field and never prints
  it; error messages and bodies are redacted.
## Contract and generated types

`contract/openapi.yaml` is a byte copy of untrace-drive `docs/api/openapi.yaml`, and
`contract/SOURCE.json` records the commit it came from. `npm run gen:types` regenerates
`packages/core/src/generated/`; `npm run check:types` (in CI) fails if they are stale. To update from a
Drive checkout:

```bash
node scripts/gen-types.mjs --from ../untrace-drive
```

## Development

```bash
npm ci --no-audit --no-fund
npm run check:types    # generated types match the contract
npm run check:public   # no internals, no secrets, Apache-2.0 everywhere
npm run build
npm run typecheck      # packages and examples
npm test               # unit tests against a mock Drive (fetch is mocked)
npm run pack:check     # tarballs ship dist, README, LICENSE only
npm run test:live      # opt-in, against a real Drive
```

`npm run test:live` is skipped unless `UNTRACE_CLIENT_ID`, `UNTRACE_CLIENT_SECRET` and
`UNTRACE_BASE_URL` are set. The manual **Live integration** workflow runs it from repo secrets.

Releases: see [docs/RELEASING.md](docs/RELEASING.md). A `v*` tag only verifies; publishing is a manual
workflow that waits for JC's approval.

## License

Apache-2.0. See [LICENSE](./LICENSE).
