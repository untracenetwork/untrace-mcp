# Generate: open an HTML document in Drive's editor

`untrace_generate_link` turns an HTML document into a link. Opening the link shows the document in
Untrace Drive's editor at `/generate`. The person fixes the text, then presses Split & Upload to
save it as a PDF in their Drive. Nothing is uploaded before that.

## Privacy

- The document is carried in the URL fragment, the part after `#`. Browsers never send the
  fragment to a server, so neither Untrace nor anyone in between receives the draft while it is
  being edited.
- The tool builds the link on the machine running this server. It makes no network request and
  does not need a developer key.
- The document and the link are never written to a log. A refusal never repeats the document.
- The link holds the whole document. Treat it like the document itself: open it, do not post it
  publicly or paste it into a shared chat.

## Tool

Input, exactly one of `html` or `path`:

| Field | Meaning |
|---|---|
| `html` | The HTML document |
| `path` | A local `.html` or `.htm` file (UTF-8), inside `UNTRACE_MCP_ROOT`, with the same rules as uploads. Off on a remote server |
| `format` | `doc` (default, compressed) or `html` (not compressed, for small documents) |

Output:

```json
{
  "url": "https://drive.untrace.network/generate#doc=...",
  "format": "doc",
  "htmlBytes": 302177,
  "urlChars": 70687
}
```

`htmlBytes` is the size of the HTML in UTF-8 bytes. `urlChars` is the length of the whole link.

## Wire format

```
<origin>/generate#doc=<base64url(deflate-raw(utf8 html))>    default
<origin>/generate#html=<base64url(utf8 html)>                fallback
```

- `<origin>` is the origin of `UNTRACE_BASE_URL`, default `https://drive.untrace.network`. A path
  or trailing slash in `UNTRACE_BASE_URL` is dropped.
- base64url is the URL-safe alphabet (`A-Z a-z 0-9 - _`) with no `=` padding.
- deflate-raw is DEFLATE with no zlib header or checksum (RFC 1951). In Node:
  `zlib.deflateRawSync`. In a browser: `new CompressionStream("deflate-raw")`.

## Limits

| Limit | Value | When it is over |
|---|---|---|
| Payload after `doc=` or `html=` | 1,500,000 characters | Refused before a link is built. With `html`, the answer says to use `doc` |
| Decoded HTML | 2 MiB (2,097,152 bytes) of UTF-8 | Refused before a link is built |

Without compression, base64url makes the payload about 4/3 of the HTML size, so `html` stops at
about 1.1 MB of HTML. Text compresses well with `doc`: a 300 KB, multi-page business plan with
tables gives a link of about 71,000 characters.

## What to put in the HTML

A self-contained document: headings, paragraphs, lists and tables. Inline styles are fine. Images
only as `data:` URIs. The editor removes remote images, fonts and scripts.

## Example

The document `<h1>Plan</h1><p>Hello.</p>` becomes:

```
https://drive.untrace.network/generate#doc=s8kwtAvIScyz0c8wtLMpsPNIzcnJ17PRL7ADAA
https://drive.untrace.network/generate#html=PGgxPlBsYW48L2gxPjxwPkhlbGxvLjwvcD4
```

Building the same link yourself in Node:

```js
import { deflateRawSync } from "node:zlib"

const html = "<h1>Plan</h1><p>Hello.</p>"
const url = `https://drive.untrace.network/generate#doc=${deflateRawSync(Buffer.from(html, "utf8")).toString("base64url")}`
```

Reading it back in a browser:

```js
const payload = location.hash.slice("#doc=".length)
const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4)
const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
const html = await new Response(stream).text()
```
