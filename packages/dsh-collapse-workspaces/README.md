# dsh-collapse-workspaces

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a
**Collapse all workspaces** button to the left sidebar, beside the Workspaces search,
view-options, and add-workspace controls. One click folds every expanded Workspace, like
VS Code's *Collapse All* in the Explorer.

## Install

Install from a checkout (the profile links the directory):

```sh
dsh plugin --profile <profile> add /absolute/path/to/packages/dsh-collapse-workspaces
```

Install the published copy:

```sh
dsh plugin --profile <profile> add dsh-collapse-workspaces
```

Reload the Web page. Remove it with:

```sh
dsh plugin --profile <profile> remove dsh-collapse-workspaces
```

## Use

The button joins the Workspaces section header when the sidebar is expanded. It is disabled while
no Workspace is expanded, and disappears while the sidebar is collapsed to its rail, while grouping
is set to the flat list, or while session search replaces the list. Fold is saved in the browser
exactly like a manual fold, and each fold resets that Workspace's "Show more" watermark.

Nested Workspaces fold leaves first. Workspaces that are already hidden inside a collapsed ancestor
cannot be reached from the DOM; if you re-expand that ancestor they may still be expanded, and a
second click folds them. This matches the expansion state the browser holds.

## How it works — and what it depends on

DSH currently exposes no slot for the Workspaces section header. This bundle therefore decorates the
header and drives the existing row toggles. **This is an unsupported integration**, flagged by the
DSH plugin practice docs ("do not write DOM outside your component", "do not read another plugin's
DOM ... choose a slot that already allocates space"). It is kept small and fails closed: when the
DOM it expects is missing, the plugin does nothing rather than misbehaving.

Files:

- `index.js` — a no-op Host half; the bundle row needs a valid Host plugin.
- `cordis.patch.yml` — the bundle layer that inserts the row.
- `client.js` — the plain-JS browser module.

DOM contract (verified against DSH `0.2.2-alpha.2`):

- Header action cluster: `[class*="_sidebarCol"] [class*="_headerActions"]`, found in the built
  `@deepseek-ai/dsh-client-ui-workspace` client bundle. The button is appended after the
  view-options and add-workspace controls; an injected rule raises the cluster's `max-width` from
  60px to 92px only while the button is mounted, because the host sizes it for exactly two icons.
- Wide mode: detected by the wide search `input[type="text"]` inside the same section header; the
  rail keeps an empty copy of the cluster and gets no button.
- Workspace rows: `[role="tree"] [data-row-key^="workspace:"][role="treeitem"]`; expanded rows
  carry `aria-expanded="true"`. Collapsing clicks the row itself, deepest first (`role="group"`
  ancestors give the depth). Clicks are real user-path clicks, so the host's store, persistence,
  watermark reset, and analytics behave normally.
- A single `MutationObserver` on `document.documentElement` (childList, plus `aria-expanded`
  attributes) coalesces a rAF-scheduled idempotent sync that mounts/removes the button, keeps it one
  instance, and updates its disabled state. All listeners, the observer, the style tag, and the
  button are removed by the plugin's `ctx.effect` cleanup.

If a future DSH release renames these CSS-module locals or adds a proper header-action slot, this
implementation should be replaced (a slot-based registration is always preferable). The declared
`engines.dsh` range is the compatibility promise; the module no-ops outside it.

## Limitations

- No keyboard shortcut yet.
- The tooltip is the native `title` popup; the button inherits the theme tokens of the header icon
  buttons.
- The button's icon and enabled state update through DOM sync, not React; it is intentionally
  minimal to keep the unsupported surface small.

## Development

Plain ESM, no build step. Edit `client.js` and reload the page; re-run `dsh plugin add` only when
`package.json` or `cordis.patch.yml` changes.

## License

MIT
