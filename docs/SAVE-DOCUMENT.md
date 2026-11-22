# Save a document: HTML to a PDF in Drive

`untrace_save_document` takes an HTML document from the agent, turns it into a PDF on the machine
running this server, and saves the PDF into a folder in the user's Untrace Drive. The agent does
not build the PDF.

## How it works

1. The server reads the HTML with the same rules as Drive's Generate editor (see
   [What is kept](#what-is-kept) below).
2. It lays the document out on A4, US Letter or Legal with Drive's print styles and writes a PDF.
   Nothing is fetched: the fonts ship with the package.
3. It uploads the PDF with the SDK's normal upload, as this server's key. The PDF is encrypted on
   this machine before it is stored, like any `untrace_upload_file`.

Rendering is local. Only the upload talks to Drive.

## Before you start

The key needs the `upload` scope and role `editor` or `admin` on the folder it saves into.

With an agent key:

1. Run `untrace-mcp agent init` on the agent's machine, or `untrace-mcp agent claim <link>` with a
   one-time link from Drive (Settings > Developer > Give your agent access).
2. Ask the owner to give the key a folder with write access, for example
   `--want files:<folder id>:read_write`, and approve it in Drive.
3. Start the server. With no `UNTRACE_CLIENT_ID` set, it uses the agent key.

A developer key in `UNTRACE_CLIENT_ID` and `UNTRACE_CLIENT_SECRET` works the same way.

## Tool

| Argument | Required | What it does |
|---|---|---|
| `html` | one of `html`, `path`, `template` | The document: a full page or a fragment. At most 256 KB of UTF-8 |
| `path` | one of `html`, `path`, `template` | A local `.html` or `.htm` file inside `UNTRACE_MCP_ROOT`. Not on a remote server |
| `template` | one of `html`, `path`, `template` | `mutual-nda`, `invoice`, `proposal-quote`, `letter` or `meeting-minutes`, as in `untrace_generate_link` |
| `fields` | no | Only with `template`: field name to value |
| `name` | no | The file name. `.pdf` is added. Default: the first heading, else `Untitled document` |
| `paper` | no | `a4` (default), `letter` or `legal` |
| `folderId` | no | The folder to save into. Leave it out when the key can add files to exactly one top-level folder |

The answer:

```json
{
  "fileId": "6f1c2a4e-8b3d-4c7a-9e21-0d5b7f9a1c33",
  "name": "Quarterly plan.pdf",
  "folderId": "0b6f8c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e",
  "pages": 2,
  "paper": "a4",
  "size": 29278,
  "htmlBytes": 1834,
  "url": "https://drive.untrace.network/?tab=all-files&folder=0b6f8c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e&file=6f1c2a4e-8b3d-4c7a-9e21-0d5b7f9a1c33",
  "metering": { "billedTo": "owner", "meteredBytes": 29278, "usageBytes": 1029278, "quotaBytes": 10000000000 }
}
```

`url` opens the file in Drive for its owner. `warnings` is added when some characters could not be
drawn (see [Fonts](#fonts)).

## Limits

| Limit | Value | Over it |
|---|---|---|
| HTML | 256 KB (262,144 bytes of UTF-8) | Refused before anything else |
| Pages | 10 | Refused before any request. Split the document into parts and save each part with its own name |

Over either limit nothing is uploaded.

## What is kept

The rules are Drive's (lib/generate/sanitize.ts and the editor's HTML reader). The test corpus in
`test/fixtures/drive-generate-corpus.json` is Drive's own editor output for 42 inputs.

| HTML | In the PDF |
|---|---|
| `h1` to `h6` | Headings, Geist SemiBold: 22, 15, 12 and 10.5 pt |
| `p`, `br` | Paragraphs (10.5 pt, line height 1.5) and line breaks |
| `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `strike` | Bold, italic, underline, strikethrough |
| `code` | Geist Mono 9 pt |
| `mark` | Yellow highlight |
| `sub`, `sup` | Subscript, superscript |
| `ul`, `ol`, `li` | Bulleted and numbered lists, nested too. Adjacent lists of the same kind join |
| `blockquote` | Indented, with a grey bar |
| `hr` | A thin rule |
| `table`, `tr`, `th`, `td`, `colspan`, `rowspan` | Full-width tables, 9 pt, header cells shaded. A header row repeats on every page the table runs onto. Rows never split. Number cells are right-aligned |
| `div` | A paragraph |
| `section`, `article`, `header`, `footer`, `main`, `pre`, `figure`, `span`, `a`, `small`, `kbd` | Their text flows on. `pre` keeps its line breaks |
| `caption` | A paragraph above the table |
| `style="break-before: page"`, `page-break-before: always` (and the `after` forms) | A new page |

Headings stay on the page with what follows them. A paragraph leaves at least two lines on each
page. Each page has `page / pages` at the bottom.

## What is removed

- Images (`img`, `picture`, `svg`): the editor has no image block yet.
- Scripts, styles, `link`, `meta`, `iframe`, `object`, `embed`, forms, `math`.
- Every attribute except `colspan` and `rowspan`, so no CSS (except the page break above).
- Link targets. The link text stays.

## Differences from Drive

- Drive draws each page as an image. Here the text is real PDF text, so it can be selected and
  searched.
- A list item that holds a heading and a paragraph keeps both here. Drive keeps the last one.
- A table caption is a paragraph above the table. Drive draws it inside the table.

## Fonts

The PDF uses Geist and Geist Mono, the fonts of Drive's print view. They ship in `fonts/` under the
SIL Open Font License 1.1 (`fonts/OFL.txt`). Only the characters used are embedded.

Geist covers Latin, Greek and Cyrillic. Other characters (Chinese, Japanese, Arabic, emoji, box
symbols) show as `?`, and the answer lists them in `warnings`.

## Example

```json
{
  "name": "untrace_save_document",
  "arguments": {
    "html": "<h1>Quarterly plan</h1><p>Revenue grew <strong>12%</strong>.</p><table><tr><th>Quarter</th><th>Revenue</th></tr><tr><td>Q3</td><td>$1,200</td></tr></table>",
    "paper": "letter"
  }
}
```
