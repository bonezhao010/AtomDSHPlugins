# AtomDSHPlugins

Small, composable plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Every package under `packages/` is an independent DSH **bundle**: an npm package that ships a
`cordis.patch.yml` configuration layer. A bundle can be installed, versioned, enabled, and removed
on its own, so one repository can host several atomic plugins without giving up per-plugin
installation granularity.

## Plugins

| Package | What it does | Status |
| --- | --- | --- |
| [`dsh-collapse-workspaces`](packages/dsh-collapse-workspaces) | Adds a "Collapse all workspaces" button beside the search, view-options, and add-workspace controls in the Workspaces sidebar header, and folds every expanded Workspace. | 0.1.0, verified on DSH 0.2.2-alpha.2 |
| [`dsh-sidebar-file-editor`](packages/dsh-sidebar-file-editor) | Opens editable text files from the right sidebar's Files view with CodeMirror 6, lazily loaded Prettier formatting, lightweight completion, and Save/Undo/Redo shortcuts. | 0.2.0, build-tested and live-slot verified on DSH 0.2.2-alpha.2 |

## Requirements

- DSH `>=0.2.2-alpha.2` (each package declares its own `engines.dsh`).
- Node.js `>=24.9` and pnpm 11 for development.

## Install a plugin

Install from a local checkout (the profile links the directory, so edits to the plugin's JavaScript are
picked up on the next page reload):

```sh
dsh plugin --profile <profile> add /absolute/path/to/packages/dsh-collapse-workspaces
```

Install a published copy:

```sh
dsh plugin --profile <profile> add dsh-collapse-workspaces
```

Then reload the Web page. Remove it with
`dsh plugin --profile <profile> remove dsh-collapse-workspaces`.

## Development

Most packages are plain ESM JavaScript with no build step: edit `index.js` (Host half),
`client.js` (browser half), `cordis.patch.yml` (the bundle layer), `locale/*.json` (display
metadata), and reload the page. Re-run `dsh plugin add` only when `package.json`,
`cordis.patch.yml`, or the `files` list changes.

`dsh-sidebar-file-editor` is the exception: its browser entry lives in `src/client.js` and is
bundled into the committed `client.js` (CodeMirror + Prettier). Run `pnpm install` after checkout
and `pnpm run build` after editing that source; the generated `client.js` is what DSH serves.

`pnpm run check` syntax-checks every published package module; CI runs it plus a JSON validation pass.

Plugins that need a runtime dependency publish it under `dependencies`; DSH packages that must stay
shared with the Host belong under `peerDependencies` and `devDependencies`, never
`dependencies` (see the DSH packaging guide).

## Compatibility and caveats

Every package declares `engines.dsh`. A plugin that decorates UI which DSH does not expose as a
slot yet must use DOM integration; those packages document the exact DOM they rely on and the DSH
release they were tested against in their own README. Prefer slot-based plugins when a suitable slot
exists.

## Publishing a package

```sh
pnpm --filter dsh-collapse-workspaces pack
pnpm --filter dsh-collapse-workspaces publish --access public
```

Publish each package on its own version. Optional discovery on the Plugins **Discover** page only
needs a self-hosted plugin index JSON listing the published npm packages; DSH ships a reference
generator for that.

## License

[MIT](LICENSE)
