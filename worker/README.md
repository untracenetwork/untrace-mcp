# Hosted MCP server

This folder is a Cloudflare Worker that serves the Untrace MCP tools that need no key at
`https://mcp.untrace.network/mcp`. Anyone can add it to Claude as a custom connector. It needs no
sign-in.

## What it serves

| Tool | What it does |
| --- | --- |
| `untrace_generate_link` | Turns an HTML document, or one of Drive's templates with its fields, into a link that opens it in Untrace Drive's editor. |
| `untrace_setup_guide` | Returns the steps and code for adding the Drive SDK to a Next.js, Node.js, React or Vue app. |

Both are the npm package's own tools (`src/keyless.ts`), so the same input gets the same answer.
The one difference: `untrace_generate_link` here has no `path` input, because the Worker has no
files to read. Write the document into `html` instead.

The tools that reach a Drive (files, folders, keys, shares, secrets, `untrace_save_document`) are
not served here: a shared server would have to hold each person's developer key, and access to a
person's files must stay with a key that person holds. Run the npm package
(`npx -y @untracenetwork/mcp`) with your own key for those.

## Limits

- **HTML.** More than 2 MB of HTML is refused. Above about 200 KB the answer carries a
  `warning`: the link works, but some chat apps cut very long links.
- **Request body.** A body over 2.5 MB is refused with 413. A `Content-Length` over the limit is
  refused before the body is read; a body without one stops being read at the limit.
- **Rate limit.** 60 requests a minute per IP address (`CF-Connecting-IP`), in each Cloudflare
  location. Over that, the answer is 429 with a JSON-RPC error and `Retry-After: 60`.
- **Stores and logs nothing.** The HTML reaches the Worker inside the request and stays in memory
  while the link is built. The Worker has no storage binding and no secrets, never writes to the
  console, and has Workers Logs turned off. The part of the link after `#` is never sent to Drive.
- **Stateless.** `POST /mcp` answers JSON. `GET /mcp` answers 405: there is no event stream and
  no session. CORS is open, so claude.ai can call it from the browser.

## Routes

| Route | Answer |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP: `initialize`, `notifications/initialized` (202), `tools/list`, `tools/call`, `ping`. |
| `GET /mcp` | 405, `Allow: POST, OPTIONS`. |
| `OPTIONS` (any path) | 204 with the CORS headers. |
| `GET /health`, `HEAD /health` | 200 `{ "ok": true, "name": "untrace-mcp", "version": "...", "tools": [...] }`, `cache-control: no-store`. |
| anything else | 404 `{ "error": "not_found" }`. |

## Before you start

- A Cloudflare account that has the `untrace.network` zone.
- Node.js 20 or later, and this repo installed (`npm ci`, or `ci/local-install.sh`).
- Wrangler signed in to that account (`npx wrangler@4 login`), or `CLOUDFLARE_API_TOKEN` set to a
  token with **Workers Scripts: Edit** and **Workers Routes: Edit** on the account and zone.

## Deploy

Run these from the repo root.

1. Check that it bundles. This needs no sign-in:

   ```bash
   npx wrangler@4 deploy --config worker/wrangler.toml --dry-run --outdir "$(mktemp -d)"
   ```

2. Deploy:

   ```bash
   npx wrangler@4 deploy --config worker/wrangler.toml
   ```

   The Worker is named `untrace-mcp`. It has no `workers.dev` address.

3. Add the domain. In the Cloudflare dashboard, open **Workers & Pages**, select
   **untrace-mcp**, then **Settings > Domains & Routes > Add > Custom domain**. Enter
   `mcp.untrace.network` and select **Add domain**. Cloudflare creates the DNS record.

   To keep the domain in config instead, uncomment the `routes` line in `worker/wrangler.toml`
   and deploy again.

4. Check it:

   ```bash
   curl -s https://mcp.untrace.network/health
   ```

   The answer is `{"ok":true,"name":"untrace-mcp","version":"...","tools":["untrace_generate_link","untrace_setup_guide"]}`.

   ```bash
   curl -s https://mcp.untrace.network/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -H 'mcp-protocol-version: 2025-06-18' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   The answer lists `untrace_generate_link` and `untrace_setup_guide`.
   `curl -si https://mcp.untrace.network/mcp` answers `405`.

## Add it to Claude

1. In Claude, open **Settings > Connectors**.
2. Select **Add custom connector**.
3. Name: `Untrace`. URL: `https://mcp.untrace.network/mcp`.
4. Leave **Advanced settings** empty.
5. Select **Add**.

On Team and Enterprise plans an owner adds the connector for the organisation first.

Try it: "Write a one-page business plan for my bakery and open it in Untrace Drive." Claude
answers with a link. Opening it shows the plan in Drive's editor.

## Change the rate limit

The limit is in two places that must match: `[[ratelimits]]` in `wrangler.toml` (`limit`, with
`period` 10 or 60 seconds) and `RATE_LIMIT_PER_MINUTE` in `src/mcp.ts`. A test checks they match.

## Test

The tests run with the rest of the package, from the repo root:

```bash
npm test -- test/worker.test.ts
```

They call the Worker's fetch handler with `Request` objects, compare every answer with the npm
package's tool for the same input, and run one session with the official MCP client.
