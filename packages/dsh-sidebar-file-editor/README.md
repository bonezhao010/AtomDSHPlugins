# dsh-sidebar-file-editor

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns text files
in the right sidebar's workspace **Files** view into editable tabs. The editor is **CodeMirror 6**
with syntax highlighting, Prettier formatting, and lightweight completion. Changes are saved back
to the local workspace through authenticated Host routes.

## Install

Install from a checkout (the profile links the directory):

```sh
dsh plugin --profile <profile> add /absolute/path/to/packages/dsh-sidebar-file-editor
```

Install the published copy:

```sh
dsh plugin --profile <profile> add dsh-sidebar-file-editor
```

Reload the Web page. Remove it with:

```sh
dsh plugin --profile <profile> remove dsh-sidebar-file-editor
```

## Use

1. Open a Session whose workspace contains the file you want to edit.
2. Open **Files** in the right sidebar and pick a text file.
3. Edit it in the tab that opens. The tab keeps its buffer when you switch away.
4. Press **Save**, or use **Format** / `Shift+Alt+F` for languages Prettier supports.
5. Closing a dirty editor tab asks for confirmation, and reloading or closing the page triggers the
   browser's unload prompt.

Keyboard shortcuts work while the editor or its toolbar has focus:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Save | `⌘S` | `Ctrl+S` |
| Undo | `⌘Z` | `Ctrl+Z` |
| Redo | `⇧⌘Z` | `Ctrl+Shift+Z` or `Ctrl+Y` |
| Format document | `⇧⌥F` | `Shift+Alt+F` |

Undo/redo use CodeMirror's history. The header buttons and keyboard shortcuts share that same
history; saving or formatting a buffer does not reset it. The tab title shows a dot while the
buffer differs from the file on disk.

## Editing features

- CodeMirror 6 editor with line numbers, active-line highlighting, bracket matching, auto-closing
  brackets and quotes, folding, multi-cursor, search/replace (`⌘F` / `Ctrl+F`), and undo/redo.
- Syntax highlighting for JavaScript, TypeScript, JSX/TSX, JSON, CSS/SCSS/Less, HTML/Vue, Markdown,
  Python, YAML, SQL, and XML. Other text files open in a plain monospace editor.
- A **Format** toolbar button and `Shift+Alt+F`. Formatting is performed locally in the browser by
  lazily loaded Prettier chunks: only the formatter core plus the target language's parser/printer
  are fetched, and only when you format that language.
- Completion popup on typing or `Ctrl+Space`:
  - words already present in the current document,
  - language keywords/snippets, including CodeMirror's JavaScript/TypeScript snippets,
  - JavaScript/TypeScript local-scope completions,
  - Python local/global completions, CSS property completions, HTML tag/attribute completions, and
    SQL keyword completions.
- **No cross-file type inference, project index, diagnostics, or language server.** Completion is
  intentionally document- and language-grammar-local.

## Formatting support

Formatting is offered only for extensions Prettier supports. Unsupported languages show a
"Prettier does not support this language" message rather than failing silently.

| Extension | Prettier parser | Lazy chunk |
| --- | --- | --- |
| `.js` `.jsx` `.mjs` `.cjs` | Babel | `javascript` |
| `.json` `.jsonc` `.json5` | JSON / JSON5 | `javascript` |
| `.ts` `.tsx` `.mts` `.cts` | TypeScript | `typescript` |
| `.css` `.scss` `.less` | PostCSS | `css` |
| `.html` `.htm` `.vue` | HTML | `html` |
| `.md` `.markdown` `.mdx` | Markdown | `markdown` |
| `.yaml` `.yml` | YAML | `yaml` |
| `.graphql` `.gql` | GraphQL | `graphql` |

The shared core is a separate 0.08 MiB chunk. Before formatting, none of
these chunks are loaded; the first format of a language downloads only its
chunk (minified: JavaScript 0.51 MiB, TypeScript 1.06 MiB, CSS 0.15 MiB, HTML
0.16 MiB, Markdown 0.28 MiB, YAML 0.14 MiB, GraphQL 0.04 MiB).

Python, Go, Rust, Java, SQL, XML, TOML, shell files, and plain `.txt` are highlighted (where a
grammar exists) but not formatted. The toolbar button remains available and reports the unsupported
language.

Formatting uses Prettier defaults with `endOfLine: 'auto'`; it does not read project Prettier config
files, plugins, or `.editorconfig`, and it does not format on save. Buffers over 512K characters
are not formatted, to keep the browser responsive. The 2 MiB editor read/write limit is unchanged.

Only the target file's language chunk is loaded. HTML/Vue script or style blocks and Markdown code
fences are not formatted unless their own language chunk is already loaded; the lazy split favors
page weight over embedded-language formatting.

## What opens in the editor

The plugin registers a new right-sidebar tab kind at the `extension` priority band for Session file
addresses. It claims common text and source formats, including `.md`, `.txt`, `.json`, `.yaml`,
`.toml`, `.js`, `.ts`, `.tsx`, `.jsx`, `.css`, `.html`, `.py`, `.go`, `.rs`, `.java`, `.sh`, `.sql`,
`.xml`, `.svg`, `.csv`, `.env*`, and common extensionless names such as `Dockerfile`, `Makefile`,
`LICENSE`, and `Cargo.lock`. Other files keep their normal viewer (images, PDFs, Office documents,
and unsupported extensions are not claimed).

## How it works — and what it depends on

The **Host half** (`index.js`) registers two exact Fetch routes through
`ctx.connection.fetch`:

- `POST /api/sidebar-file-editor.open`
- `POST /api/sidebar-file-editor.save`

Connection admits only the authenticated owner peer and applies the Host/Origin fence before the
plugin sees a request. Each request also names a live Session and a path; the plugin:

1. resolves the Session's working directory (falling back to the sandbox workspace root),
2. rejects a final symlink, a non-regular file, or a missing file,
3. resolves the canonical filesystem target and refuses it unless the workspace contains it,
4. caps text at 2 MiB in both directions, and
5. writes through the composed `fs` service with a `replaceIfVersion` guard, so a save made against
   a stale read reports a conflict instead of overwriting an external change.

The editor's **Overwrite** action explicitly removes that guard after a second confirmation. Saves
still pass the Session's resolved sandbox policy to the filesystem, so a read-only Session refuses
the write.

The **browser half** (`client.js`) registers the tab type, its body, and a title member through the
public `ctx.sidebarRightTabs` and `ctx.slots` APIs. It owns no filesystem access; every read and
write goes through the two routes above. CodeMirror 6 is bundled into the main `client.js` (about
0.70 MiB minified, 250 KiB gzip), so the editor has no runtime npm dependency. Prettier is split
into package-local chunks: a small shared core plus one parser/printer chunk per language family.
They are fetched with the DSH module loader's `require.async` only on the first format of a
language. The main page never downloads a formatter parser you have not used.

## Limits

- Existing regular files only: the editor does not create, rename, or delete files.
- 2 MiB of UTF-8 text per file. Binary and non-UTF-8 files are refused with a readable message.
- The first line-ending style (LF or CRLF) and a leading BOM are preserved when saving, including after formatting.
- Formatting is limited to 512K characters and the listed Prettier languages; project Prettier
  configuration is not applied.
- Completion never crosses files and does not infer types. It is not a language server.
- The editor does not watch the file. If another process changes it, the next save shows a conflict
  with **Reload** and **Overwrite** choices.
- Undo history is per mounted tab and is not persisted across a page reload.
- The plugin is authored against DSH `0.2.2-alpha.2` and declares an `engines.dsh` range of
  `>=0.2.2-alpha.2 <0.3.0`.

## Development

The browser entry is authored in `src/client.js` and bundled into `client.js`. Do not edit the
generated `client.js` directly.

```sh
pnpm install
pnpm --filter dsh-sidebar-file-editor build
pnpm run check
```

Reload the page after a client rebuild. `package.json`, `cordis.patch.yml`, or the published `files`
list changes require a `dsh plugin add`/reinstall. The build writes the main `client.js` last so its
revision moves when only a formatter chunk changes.

## License

MIT. The bundled CodeMirror/Lezer and Prettier licenses are reproduced in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
