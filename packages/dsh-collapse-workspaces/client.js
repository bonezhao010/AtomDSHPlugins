/**
 * Browser half of dsh-collapse-workspaces.
 *
 * DSH exposes no slot for the Workspaces section header, so this plugin
 * decorates the header action cluster and drives the existing Workspace row
 * toggles. This is an UNSUPPORTED integration: the exact DOM it relies on is
 * documented in README.md and is covered by the package's engines.dsh range.
 * If the markup changes, the module removes nothing and simply no-ops.
 *
 * Loaded by the DSH client module loader: the factory returns the Cordis
 * plugin object for this package's bundle row.
 */
window.__ModuleLoader__.load({
  id: 'dsh-collapse-workspaces',
  factory(require) {
    const NS = 'collapse-workspaces'
    const BUTTON_ATTR = 'data-dsh-collapse-workspaces'

    // Header action cluster: scope by the sidebar column because ui-conversation
    // and ui-user-questions use the same CSS-module local name.
    const SIDEBAR_COLUMN = '[class*="_sidebarCol"]'
    const HEADER_ACTIONS = SIDEBAR_COLUMN + ' [class*="_headerActions"]'
    const SECTION_HEADER = '[class*="_sectionHeader"]'
    // Expanded Workspace rows: project rows are tree items with aria-expanded;
    // session rows share the tree but carry session: keys and no aria-expanded.
    const WORKSPACE_ROW = '[role="tree"] [data-row-key^="workspace:"][role="treeitem"]'
    const EXPANDED_WORKSPACE = WORKSPACE_ROW + '[aria-expanded="true"]'

    const dictionaries = {
      en: { 'collapseAll.label': 'Collapse all workspaces' },
      zh: { 'collapseAll.label': '收起所有工作区' },
    }

    const ICON = [
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"',
      ' stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '<path d="m5.1 3.1 2.9 2.9L10.9 3.1"/>',
      '<path d="m5.1 12.9 2.9-2.9L10.9 12.9"/>',
      '</svg>',
    ].join('')

    const STYLE = [
      `[${BUTTON_ATTR}]{flex:none;display:inline-flex;align-items:center;justify-content:center;`,
      'width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);',
      'background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;}',
      `[${BUTTON_ATTR}]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid `,
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px;}',
      `@media (hover:hover){[${BUTTON_ATTR}]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));`,
      'color:var(--dsw-alias-label-primary,inherit);}}',
      `[${BUTTON_ATTR}][aria-disabled="true"]{opacity:.4;cursor:default;}`,
      `[${BUTTON_ATTR}][aria-disabled="true"]:hover{background:transparent;color:var(--dsw-alias-label-secondary,inherit);}`,
      // The host cluster is sized for its two controls (28 + 4 + 28 = 60px);
      // make room for the third only while ours is mounted.
      `${SIDEBAR_COLUMN} [class*="_headerActions"]:has(> [${BUTTON_ATTR}]){max-width:92px;}`,
    ].join('')

    /** The live header action cluster, or null while the sidebar is not rendered. */
    function findActions() {
      const direct = document.querySelector(HEADER_ACTIONS)
      if (direct !== null) return direct
      // Structural fallback: the section header that owns the wide search input.
      const section = Array.from(document.querySelectorAll(SECTION_HEADER))
        .find(header => header.querySelector('input[type="text"]') !== null)
      if (section === undefined) return null
      return Array.from(section.children).find(child => (
        child.tagName === 'DIV'
        && child.querySelector('input[type="text"]') === null
        && child.querySelector('button') !== null
      )) ?? null
    }

    /** Nesting depth of a Workspace row, so collapsing starts at the leaves. */
    function rowDepth(row) {
      let depth = 0
      for (let node = row.parentElement; node !== null; node = node.parentElement) {
        if (node.getAttribute('role') === 'group') depth += 1
      }
      return depth
    }

    /** Fold every expanded Workspace through its own row toggle, leaves first. */
    function collapseAll() {
      let previous = Number.POSITIVE_INFINITY
      for (let guard = 0; guard < 200; guard += 1) {
        const rows = Array.from(document.querySelectorAll(EXPANDED_WORKSPACE))
          .sort((a, b) => rowDepth(b) - rowDepth(a))
        if (rows.length === 0) return
        if (rows.length >= previous) return
        previous = rows.length
        for (const row of rows) {
          if (row.isConnected && row.getAttribute('aria-expanded') === 'true') row.click()
        }
      }
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'collapse-workspaces: dictionaries')

        const style = document.createElement('style')
        style.textContent = STYLE

        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(BUTTON_ATTR, '')
        button.innerHTML = ICON
        button.addEventListener('click', () => {
          if (button.getAttribute('aria-disabled') === 'true') return
          collapseAll()
        })

        let frame = 0

        function syncCopy() {
          const label = t('collapseAll.label')
          if (button.getAttribute('aria-label') !== label) {
            button.setAttribute('aria-label', label)
            button.title = label
          }
        }

        /** Mount, label, and enable/disable the button for the current sidebar. */
        function sync() {
          frame = 0
          syncCopy()
          const actions = findActions()
          if (actions === null) {
            if (button.isConnected) button.remove()
            return
          }
          // Only the wide header owns the action cluster; the rail keeps an
          // empty copy of it, and flat grouping has no Workspace rows.
          const wide = actions.parentElement?.querySelector('input[type="text"]') != null
          const hasRows = document.querySelector(WORKSPACE_ROW) !== null
          if (!wide || !hasRows) {
            if (button.isConnected) button.remove()
            return
          }
          for (const stale of actions.querySelectorAll('[' + BUTTON_ATTR + ']')) {
            if (stale !== button) stale.remove()
          }
          if (!actions.contains(button)) actions.append(button)
          const expandable = document.querySelector(EXPANDED_WORKSPACE) !== null
          button.setAttribute('aria-disabled', String(!expandable))
        }

        function schedule() {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(sync)
        }

        ctx.effect(() => {
          document.head.append(style)
          const observer = new MutationObserver(schedule)
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-expanded'],
          })
          const offLocale = ctx.on('locale/change', syncCopy)
          sync()
          return () => {
            observer.disconnect()
            offLocale()
            if (frame !== 0) window.cancelAnimationFrame(frame)
            button.remove()
            style.remove()
          }
        }, 'collapse-workspaces: header button')
      },
    }
  },
})
