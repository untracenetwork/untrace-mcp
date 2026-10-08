# untrace-sdk

JavaScript SDK for Untrace Drive developer keys. Your server holds a client id and secret,
reads and uploads files the key is a member of, and manages that file's other keys.

Files are encrypted before they leave your server and stored as 6 encrypted shards. Any 3
rebuild the file. File keys are sealed to your key and opened locally, so Untrace never
sees a plaintext key.

| Package | Use it for |
|---|---|
| `@untracenetwork/next` | Next.js route handler and server actions (recommended) |
| `@untracenetwork/sdk` | The core client for any server runtime (Node 20+, Bun, Deno, Workers) |
| `@untracenetwork/node` | File path and stream helpers, node:http / Express adapter |
| `@untracenetwork/react` | Hooks that call your own backend route |
| `@untracenetwork/vue` | Composables that call your own backend route |

Install only what you use:

```bash
npm i @untracenetwork/next    # Next.js (pulls in @untracenetwork/sdk)
npm i @untracenetwork/sdk     # any server runtime
npm i @untracenetwork/node    # Node path and stream helpers
npm i @untracenetwork/react   # React hooks, browser side
npm i @untracenetwork/vue     # Vue composables, browser side
```

The client secret is server-only. `UntraceClient` refuses to start in a browser. React and Vue
code talks to your backend route, never to Untrace directly.

## 1. Create a key in Drive

1. Open Untrace Drive, then **Settings > Developer keys**, and create a key. Pick its scopes.
2. Copy the **client id** (`utc_...`) and the **client secret** (`untrace_sk_v1_...`). The secret is
   shown once. Untrace does not keep it. If you lose it, revoke the key and create a new one.
3. A key can only see files it is a member of. Open a file's sharing panel in Drive, add the key
   as a member and choose a role: `admin`, `editor` or `viewer`. Files the key uploads itself are
   added for you (as `editor`).
4. Sign in to Drive at least once as the owner before the key uploads. That publishes the sharing
   key new files are sealed to.

```bash
# .env.local (server only, never NEXT_PUBLIC_)
UNTRACE_CLIENT_ID=utc_...
UNTRACE_CLIENT_SECRET=untrace_sk_v1_...
```

## 2. Next.js quick start

```bash
npm install @untracenetwork/next @untracenetwork/react
```

`app/api/untrace/route.ts`:

```ts
import { createUntraceRoute } from "@untracenetwork/next"
import { auth } from "@/auth" // your own session check

export const runtime = "nodejs"

export const { GET, POST } = createUntraceRoute({
  // Required: decide who may call this route. It is public otherwise.
  authorize: async (_request, action, fileId) => Boolean(await auth()),
  // Read-only by default. Opt in to writes.
  allow: ["list", "get", "download", "upload"],
})
```

A client component:

```tsx
"use client"
import { UntraceProvider, useUntraceFiles, useUntraceUpload, useUntrace } from "@untracenetwork/react"

export default function Files() {
  return (
    <UntraceProvider endpoint="/api/untrace">
      <List />
    </UntraceProvider>
  )
}

function List() {
  const { files, loading, refresh } = useUntraceFiles()
  const { upload, uploading } = useUntraceUpload()
  const api = useUntrace()
  if (loading) return <p>Loading</p>
  return (
    <>
      <input type="file" disabled={uploading} onChange={async (e) => {
        const f = e.target.files?.[0]
        if (f) { await upload(f); await refresh() }
      }} />
      <ul>{files.map((f) => <li key={f.fileId}><a href={api.downloadUrl(f.fileId)}>{f.name}</a></li>)}</ul>
    </>
  )
}
```

Server actions:

```ts
"use server"
import { untraceActions, getUntrace } from "@untracenetwork/next"

export async function listFiles() {
  await requireUser()
  return untraceActions.listFiles()
}

export async function uploadAction(form: FormData) {
  await requireUser()
  return untraceActions.uploadFromForm(form) // <input type="file" name="file">
}

// Or the full client:
export async function readReport(fileId: string) {
  const { bytes, name } = await getUntrace().files.download(fileId)
  return { name, text: new TextDecoder().decode(bytes) }
}
```

## 3. Node.js

```ts
import { UntraceClient } from "@untracenetwork/sdk"
import { uploadPath, downloadToPath, untraceNodeHandler } from "@untracenetwork/node"

const untrace = new UntraceClient() // reads UNTRACE_CLIENT_ID / UNTRACE_CLIENT_SECRET

const { files } = await untrace.files.list()
const up = await uploadPath(untrace, "./report.pdf")
await downloadToPath(untrace, up.fileId, "./copy.pdf")

// Express: serve the same route protocol for @untracenetwork/react or @untracenetwork/vue
app.all("/api/untrace", untraceNodeHandler({ authorize: (req) => isLoggedIn(req) }))
```

`untraceNodeHandler` builds the `Request` URL as `http://` + the client's `Host` header. Do not trust
`request.url`'s host or scheme inside `authorize`; check your session instead.

The core API:

```ts
untrace.files.list({ cursor, limit })        // files the key is a member of
untrace.files.get(fileId)                    // metadata and the key's role
untrace.files.download(fileId)               // { bytes, name, mime, nodesChosen }
untrace.files.upload({ data, name, mime })   // new file in the owner's drive, max 95 MB
untrace.files.rename(fileId, name)
untrace.files.delete(fileId)                 // to the trash; only the owner restores or purges
untrace.members.list(fileId)                 // { owner, members }
untrace.members.add(fileId, clientId, role)  // seals the file key to that key locally
untrace.members.setRole(fileId, clientId, role)
untrace.members.remove(fileId, clientId)
```

## 4. React and Vue

Both call your backend route (`createUntraceRoute`, `createUntraceHandler` from
`@untracenetwork/sdk/backend`, or `untraceNodeHandler`).

### Route protocol and CSRF

The route's writes are protected against cross-site request forgery, which matters when
`authorize` trusts a session cookie:

- The action and `fileId` travel in the query string (`POST /api/untrace?action=delete&fileId=...`).
  `authorize(request, action, fileId)` runs on the URL and headers **before the body is read**, so an
  unauthorised caller never gets a body parsed. JSON bodies are capped at 64 KB, uploads at 96 MB (413).
- Every POST must send `x-untrace-request: 1` and `content-type: application/json` (`multipart/form-data`
  for upload). Anything else gets 403 or 415. A cross-site HTML form cannot set either.
- Browser POSTs with `Sec-Fetch-Site` other than `same-origin`, or an `Origin` whose host is not the
  route's host, get 403. To accept a named other origin, pass `allowedOrigins: ["https://admin.example.com"]`
  (the handler does not answer CORS preflights; add your own CORS layer for that).
- Reads are GET only, writes are POST only.

`@untracenetwork/react` and `@untracenetwork/vue` already send all of this. If you call the route yourself, send the
header. Server-to-server callers (no `Origin`) only need the header and the content type. Keep your
session cookie `SameSite=Lax` or `Strict` as a second layer.

```ts
// Vue
import { createApp } from "vue"
import { untracePlugin, useUntraceFiles, useUntraceUpload } from "@untracenetwork/vue"

createApp(App).use(untracePlugin, { endpoint: "/api/untrace" })

// in a component
const { files, loading, refresh } = useUntraceFiles()
const { upload, uploading } = useUntraceUpload()
```

## Scopes and roles

A call is allowed only when the key's **scopes** and its **role on that file** both allow it.

| Scope | Allows |
|---|---|
| `download` | Open files the key is a member of |
| `upload` | Create new files in the owner's drive (billed to the owner) |
| `manage-sharing` | Add, change and remove other keys on files where the key is `admin` |
| `delete` | Move files to the trash where the key is `admin` |

| Permission | owner | admin | editor | viewer |
|---|---|---|---|---|
| download | yes | yes | yes | yes |
| rename | yes | yes | yes | no |
| manage members (except the owner) | yes | yes | no | no |
| delete (to trash) | yes | yes | no | no |
| restore, purge | yes | no | no | no |

- The owner can never be granted, changed or removed (`UntraceOwnerImmutableError`, HTTP 409).
- A file the key is not a member of answers 404, the same as a file that does not exist.
- Members are other developer keys of the same owner. Sharing with people stays in Drive.

## Metering

Uploads by a key count against the **owner's** plan. Upload registration and finalize return:

```ts
const r = await untrace.files.upload({ data, name: "a.pdf" })
r.metering // { billedTo: "owner", meteredBytes, usageBytes, quotaBytes, unlimited, clientId }
```

Other calls have no billing headers, so `meta.metering` is `null` there. `meta.rateLimit` gives
`{ limit, remaining, reset }` (600 requests per minute per key).

## Errors

| Class | When | Retry? |
|---|---|---|
| `UntraceUnavailableError` | 503, network failure | yes, with backoff (`err.retryable`) |
| `UntraceTimeoutError` | no answer within `timeoutMs` | yes |
| `UntraceAbortError` | your `signal` fired | no |
| `UntraceUploadError` | some shards could not be stored (`failedNodes`); the upload was not finalized or billed | retry the whole upload |
| `UntraceFinalizeUnknownError` | the network failed during finalize and Drive could not be asked whether the file was committed (`fileId`) | **do not re-upload**: `files.get(err.fileId)` later, 200 means it is in the drive, 404 means it is not |
| `UntraceRateLimitError` | 429 (`retryAfterSeconds`) | yes |
| `UntraceAuthError` | unknown or revoked key, bad signature | no |
| `UntraceScopeError` | key scopes do not allow it (`required`) | no |
| `UntraceRoleError` | role on this file does not allow it | no |
| `UntraceNotFoundError` | no such file, or the key is not a member | no |
| `UntraceOwnerImmutableError` | tried to change the owner | no |
| `UntraceConflictError` | duplicate member, or the owner has not signed in to Drive yet | no |
| `UntracePaymentRequiredError` | the owner's plan blocks the upload | no |
| `UntraceServerError` / `UntraceUnsupportedError` | 500 / 501 | no |
| `UntraceIntegrityError` | a key, signature or shard failed a local check | no |

Expired access tokens (15 minutes) are refreshed automatically. Concurrent calls share one refresh.

### Timeouts, cancellation and retries

```ts
const untrace = new UntraceClient({
  timeoutMs: 30_000, // per request, default 30 s
  maxRetries: 2,     // extra attempts on 503, 429 and network errors, default 2
  retryBaseMs: 250,  // first backoff delay, doubled per attempt with jitter, capped at 10 s
})

const ctl = new AbortController()
await untrace.files.download(fileId, { signal: ctl.signal, timeoutMs: 60_000 })
```

Only 503, 429 (honouring `Retry-After`) and network errors or timeouts are retried. Any other
4xx or 5xx fails at once. A POST is not resent after a network error, since the server may have
acted on it. An aborted call is never retried.

Upload finalize is the one POST that is retried after a network error, safely: the SDK first asks
Drive (`GET /api/v1/files/{id}`) whether that file was already committed. If it was, the upload
succeeds; if it is still pending, finalize is re-sent for the **same** `fileId` (Drive only promotes a
pending file once, so nothing is billed twice); if Drive cannot be reached, you get
`UntraceFinalizeUnknownError` with the `fileId` instead of a retryable error, so you never create a
second, double-billed copy by uploading again.

Errors never contain your client secret, an access token or a signature: they are redacted from
every message and error body. The SDK writes nothing to the console.

Inputs are checked before any request: the client id (`utc_` + 22 base58 characters), the secret
format, file ids (UUID), file names, `limit` and `cursor`. `members.add` takes a `utc_` id.
`members.setRole` and `members.remove` take a `utc_` id or a base58 wallet, so asking to change
the owner's wallet gets a clear `UntraceOwnerImmutableError`.

## Security notes

- Files are encrypted on your server; Drive only stores shards and sealed file keys.
- **Known limitation (audit M5, planned for v1.1):** `members.add` seals the file key to the public key
  Drive returns for the candidate `utc_` id. The SDK checks that the record is self-consistent (the
  candidate's sign key signed its box key), but nothing yet proves the **owner** created that key, so a
  compromised Drive could substitute a key it controls. The owner's sharing key, by contrast, is checked
  against the owner's wallet signature. The fix needs Drive to have the owner's wallet sign each developer
  key record; until then, only add members on a Drive you trust.

## Advanced: self-hosted nodes

> **Requires untrace-drive at [`b88bf15`](https://github.com/untracenetwork/untrace-drive/commit/b88bf15) or later
> (Drive v1.0.0, sealed-stream format v2).** The SDK writes stream version `0x02` (per-chunk AAD). An older
> Drive cannot open `0x02`, so every file uploaded through the SDK would be unreadable in the owner's
> browser until Drive is upgraded. Check your Drive build before pointing the SDK at it.

If you run your own Drive and storage nodes, follow the self-hosting guide:
https://github.com/untracenetwork/untrace-cli/blob/main/docs/SELF-HOST.md

Then:

1. Install [untrace-cli](https://github.com/untracenetwork/untrace-cli) on your self-hosted backend or
   datacenter server that runs the main validator node, and set up your nodes with it.
2. Rebuild the SDK from source pointed at that setup:

```bash
git clone https://github.com/untracenetwork/untrace-sdk && cd untrace-sdk
npm ci && npm run build
mkdir -p ../tarballs && for p in core next node react vue; do npm pack -w packages/$p --pack-destination ../tarballs; done
```

Then, in your app, install the tarballs you need (core first; `next` and `node` depend on it):

```bash
npm i /path/to/tarballs/untrace-sdk-1.0.0.tgz /path/to/tarballs/untrace-next-1.0.0.tgz
```

The tarball names follow the package names, so they change if the npm scope is renamed (issue #4).

```ts
const untrace = new UntraceClient({
  baseUrl: "https://drive.example.internal",
  endpoints: { files: "/api/v1/files" },          // override any path that differs
  nodeUrls: { 1: "https://node1.example.internal" }, // per node index, when not same-origin
})
```

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run pack:check   # after build: each tarball ships only dist, README and LICENSE
```

`npm run test:live` runs an integration suite against a real Drive. It is skipped unless
`UNTRACE_CLIENT_ID`, `UNTRACE_CLIENT_SECRET`, `UNTRACE_BASE_URL` and `UNTRACE_TEST_FILE_ID` are
set. See [test-live/README.md](test-live/README.md). The **Live integration** workflow runs it
on demand from repo secrets.

`UNTRACE_LIVE_SMOKE=1 npm run test:live` also runs an unauthenticated, read-only smoke against
production (or `UNTRACE_BASE_URL`): bogus client ids only, checks the documented 401/400 error
bodies. It needs no secrets and creates nothing.

Releases: see [docs/RELEASING.md](docs/RELEASING.md). Pushing a `v*` tag only verifies (build, tests,
`npm publish --dry-run`) and never publishes. Publishing is the manual **Publish to npm** workflow: you
type the version, and the job waits in the `npm-publish` environment until JC approves it. JC must
create that environment (JC as required reviewer, `NPM_TOKEN` as an environment secret, not a repo
secret) and protect `main` before the first release.

API contract: untrace-drive `docs/api/developer-keys.md` (merged in PR #328, `c075a6e`). Where the server differs from
the doc, the SDK follows the server: see [docs/contract-notes.md](docs/contract-notes.md).

## License

MIT
