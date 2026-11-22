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

Input, exactly one of `html`, `path` or `template`:

| Field | Meaning |
|---|---|
| `html` | The HTML document |
| `path` | A local `.html` or `.htm` file (UTF-8), inside `UNTRACE_MCP_ROOT`, with the same rules as uploads. Off on a remote server |
| `template` | One of Drive's templates. See [Templates](#templates) |
| `fields` | Only with `template`: field name to value. See [Templates](#templates) |
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
Above about 200 KB of HTML the output also has `warning` (see [Limits](#limits)). With
`template`, the output also has `template`, `fieldsFilled` and `fieldsLeft`.

## Templates

`template` starts from the same templates as Untrace Drive's editor, byte for byte.

| `template` | Document |
|---|---|
| `mutual-nda` | Common Paper Mutual NDA 1.0 (CC BY 4.0): cover page, standard terms and signature table. The clauses are word for word and the credit line stays |
| `invoice` | Seller and client details, line items with subtotal, tax and total, and payment details |
| `proposal-quote` | Summary, scope, deliverables, timeline, price table and an acceptance block |
| `letter` | A business letter with sender, recipient, subject, body and closing |
| `meeting-minutes` | Details, attendees, agenda, discussion, decisions and an action items table |

A field is a highlighted value in square brackets, written `<mark>[Field name]</mark>` in the
HTML. Its name is the text inside the brackets, for example `Party 1 company`.

- `fields` maps a field name to its value. The value replaces every copy of that field, as plain
  text (HTML-escaped, so `<script>` arrives as text) and no longer highlighted.
- An empty value leaves the field highlighted.
- A name that is not in the template is refused. The refusal names the field, never a value.
- At most 200 fields per call and 2,000 characters per value.
- `fieldsFilled` counts the fields given a value. `fieldsLeft` lists the fields still highlighted,
  in document order, each once.

Call once with `template` alone: the link opens the blank template and `fieldsLeft` lists every
field. Then call again with `fields`.

```json
{
  "template": "letter",
  "fields": {
    "Your name or business name": "Northwind Studio",
    "Recipient name": "Maya Haddad",
    "Subject": "Project kickoff",
    "Date": "14 November 2026"
  }
}
```

Output:

```json
{
  "url": "https://drive.untrace.network/generate#doc=...",
  "format": "doc",
  "htmlBytes": 783,
  "urlChars": 479,
  "template": "letter",
  "fieldsFilled": 4,
  "fieldsLeft": [
    "Street address",
    "City, postal code, country",
    "Email",
    "Phone",
    "Recipient title",
    "Recipient company",
    "Recipient street address",
    "Recipient city, postal code, country",
    "First paragraph: why you are writing",
    "Second paragraph: the details",
    "Third paragraph: what you ask for or the next step",
    "Closing, such as Kind regards",
    "Your name",
    "Your title"
  ]
}
```

`Recipient name` appears twice in the letter (the address block and "Dear ..."); both copies are
filled.

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
| Decoded HTML | 2 MiB (2,097,152 bytes) of UTF-8 | Refused before a link is built |
| Payload after `doc=` or `html=` | 1,500,000 characters | Refused before a link is built. With `html`, the answer says to use `doc` |
| Chat links | about 200 KB (204,800 bytes) of HTML | Not refused. The answer carries `warning`: some chat apps and browsers cut very long links, so open the link in a browser instead of pasting it into a chat |

The first two are Drive's own limits (`lib/generate/fragment.ts` in untrace-drive: `MAX_HTML_BYTES`,
`MAX_FRAGMENT_CHARS`); Drive shows "That document is too large to open here" past either. The
third is guidance from Drive's handoff doc, not a limit in code.

Without compression, base64url makes the payload about 4/3 of the HTML size, so `html` stops at
about 1.1 MB of HTML. Text compresses well with `doc`: a 300 KB, multi-page business plan with
tables gives a link of about 71,000 characters.

## What to put in the HTML

Drive cleans the HTML (DOMPurify with an allowlist, `lib/generate/sanitize.ts`), then the editor
turns it into its own blocks. What reaches the editor:

- **Kept:** headings `h1` to `h6`, paragraphs, line breaks, bold, italic, underline,
  strikethrough (`s`, `del`), inline `code`, highlight (`mark`), `sub`, `sup`, bulleted and
  numbered lists, quotes (`blockquote`), dividers (`hr`), tables with header cells (`th`),
  `colspan` and `rowspan`.
- **Flattened to paragraphs:** `div`, `section`, `article`, `header`, `footer`, `main`, `pre`,
  `figure`, `figcaption`, `caption`. `kbd` and `small` keep their text only.
- **Removed:** scripts, event handlers (`on...`), `style` and `link` tags, every attribute except
  `colspan` and `rowspan` (so no `style`, `class`, `id`, `srcset`), `iframe`, `object`, `embed`,
  forms, `svg`, `math`, `base`, `meta`, media, and anything loaded from another site. Links keep
  their text and lose their `href`.
- **Images:** the cleanup lets only `data:image/png|jpeg|gif|webp|avif|bmp` and `blob:` images
  through, but the editor has no image block yet, so images do not show. Do not rely on them.

A full page (`<html><head>...<body>`) is fine: only the body is used. The PDF is named after the
first heading. Design with structure, not CSS: the print view sets its own type and spacing.

## Example

The document `<h1>Plan</h1><p>Hello.</p>` becomes:

```
https://drive.untrace.network/generate#doc=s8kwtAvIScyz0c8wtLMpsPNIzcnJ17PRL7ADAA
https://drive.untrace.network/generate#html=PGgxPlBsYW48L2gxPjxwPkhlbGxvLjwvcD4
```

From code, with this package's encoder (no Node built-ins, so it also runs in a browser or a
edge worker):

```js
import { buildGenerateLink } from "@untracenetwork/mcp/generate"

const { url, warning } = await buildGenerateLink("<h1>Plan</h1><p>Hello.</p>")
```

`buildGenerateLink(html, { format?, origin? })` resolves to `{ url, format, htmlBytes, urlChars,
warning? }` and rejects with `GenerateLinkError` past the 2 MiB or 1,500,000-character limit.

Building the same link yourself in Node:

```js
import { deflateRawSync } from "node:zlib"

const html = "<h1>Plan</h1><p>Hello.</p>"
const url = `https://drive.untrace.network/generate#doc=${deflateRawSync(Buffer.from(html, "utf8")).toString("base64url")}`
```

The public guide, with browser and Python versions:
[untrace.network/docs/generate-links](https://untrace.network/docs/generate-links).

Reading it back in a browser:

```js
const payload = location.hash.slice("#doc=".length)
const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4)
const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
const html = await new Response(stream).text()
```
