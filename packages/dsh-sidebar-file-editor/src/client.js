/**
 * Browser half of the sidebar file editor bundle.
 *
 * A new right-Sidebar tab kind claims editable workspace text files at the
 * `extension` band, so picking one in the Files tree opens the editor instead
 * of the read-only document preview. The body reads and writes through the two
 * owner-authenticated Host routes registered by `index.js`; it never touches
 * the filesystem itself.
 *
 * Shortcuts are scoped to the focused editor: Save is Mod+S, Undo is Mod+Z and
 * Redo is Mod+Shift+Z or Mod+Y. Undo history is editor-owned so toolbar buttons
 * and all three shortcut spellings share one stack.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view'
import {
  HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput,
  indentUnit, syntaxHighlighting,
} from '@codemirror/language'
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completeFromList,
  completionKeymap, snippetCompletion, snippetKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  autoCloseTags as javascriptAutoCloseTags, javascript, localCompletionSource as javascriptLocalCompletion,
  snippets as javascriptSnippets, typescriptSnippets,
} from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css, cssCompletionSource } from '@codemirror/lang-css'
import { autoCloseTags as htmlAutoCloseTags, html, htmlCompletionSource } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import {
  globalCompletion as pythonGlobalCompletion, localCompletionSource as pythonLocalCompletion, python,
} from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { StandardSQL, keywordCompletionSource, sql } from '@codemirror/lang-sql'
import { autoCloseTags as xmlAutoCloseTags, xml } from '@codemirror/lang-xml'
import { tags } from '@lezer/highlight'

/** Prettier formatting is capped separately from the 2 MiB editor cap to keep the UI responsive. */
const FORMAT_MAX_CHARS = 512 * 1024

/** Extension → Prettier parser plus the lazily loaded language chunk that supplies it. */
const FORMAT_LANGUAGES = {
  cjs: { chunk: 'javascript', parser: 'babel' },
  css: { chunk: 'css', parser: 'css' },
  cts: { chunk: 'typescript', parser: 'typescript' },
  gql: { chunk: 'graphql', parser: 'graphql' },
  graphql: { chunk: 'graphql', parser: 'graphql' },
  htm: { chunk: 'html', parser: 'html' },
  html: { chunk: 'html', parser: 'html' },
  js: { chunk: 'javascript', parser: 'babel' },
  json: { chunk: 'javascript', parser: 'json' },
  json5: { chunk: 'javascript', parser: 'json5' },
  jsonc: { chunk: 'javascript', parser: 'json' },
  jsx: { chunk: 'javascript', parser: 'babel' },
  less: { chunk: 'css', parser: 'less' },
  markdown: { chunk: 'markdown', parser: 'markdown' },
  md: { chunk: 'markdown', parser: 'markdown' },
  mdx: { chunk: 'markdown', parser: 'mdx' },
  mjs: { chunk: 'javascript', parser: 'babel' },
  mts: { chunk: 'typescript', parser: 'typescript' },
  scss: { chunk: 'css', parser: 'scss' },
  ts: { chunk: 'typescript', parser: 'typescript' },
  tsx: { chunk: 'typescript', parser: 'typescript' },
  vue: { chunk: 'html', parser: 'vue' },
  yaml: { chunk: 'yaml', parser: 'yaml' },
  yml: { chunk: 'yaml', parser: 'yaml' },
}

/** Prettier formatter chunks are loaded only when a supported file is formatted. */
const FORMAT_CHUNKS = new Set(['core', 'javascript', 'typescript', 'css', 'html', 'markdown', 'yaml', 'graphql'])

class FormatIssue extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FormatIssue'
    this.code = code
  }
}

/** Preserve the first line ending style CodeMirror normalizes while editing. */
function lineEndingOf(text) {
  const match = /\r\n|\r|\n/.exec(text)
  return match === null ? '\n' : match[0]
}

/** Lowercase final extension of a `/`-separated workspace path. */
function extensionOf(path) {
  const name = String(path).replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

/** Formatting configuration for this path, or undefined when Prettier cannot format it. */
function formatConfigForPath(path) {
  const extension = extensionOf(path)
  return Object.prototype.hasOwnProperty.call(FORMAT_LANGUAGES, extension)
    ? FORMAT_LANGUAGES[extension]
    : undefined
}

/** UI-facing support probe; result is stable for the life of a tab. */
function formatParserForPath(path) {
  return formatConfigForPath(path)?.parser
}

/**
 * Format one buffer with Prettier defaults after lazily loading only the core
 * plus the one language chunk that supplies this parser and its printer.
 */
async function formatText(path, text, loadChunk) {
  const config = formatConfigForPath(path)
  if (config === undefined) {
    throw new FormatIssue('editor/format-unsupported', 'Prettier does not support this language.')
  }
  if (!FORMAT_CHUNKS.has(config.chunk)) {
    throw new FormatIssue('editor/format-failed', 'The formatter chunk is not registered.')
  }
  if (text.length > FORMAT_MAX_CHARS) {
    throw new FormatIssue('editor/format-too-large', 'The buffer is too large to format.')
  }
  try {
    const [core, language] = await Promise.all([
      loadChunk('core'),
      loadChunk(config.chunk),
    ])
    if (typeof core?.prettier?.format !== 'function' || !Array.isArray(language?.plugins)) {
      throw new Error('The formatter chunk did not provide the expected exports.')
    }
    return await core.prettier.format(text, {
      parser: config.parser,
      plugins: language.plugins,
      endOfLine: 'auto',
    })
  } catch (cause) {
    throw new FormatIssue('editor/format-failed', cause instanceof Error ? cause.message : String(cause))
  }
}

/** CodeMirror language support for the file's extension. Unsupported languages stay plain text. */
function languageSupportFor(path) {
  switch (extensionOf(path)) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return [javascript({ jsx: true }), javascriptAutoCloseTags]
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return [javascript({ typescript: true, jsx: true }), javascriptAutoCloseTags]
    case 'json':
    case 'jsonc':
    case 'json5':
      return json()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'html':
    case 'htm':
    case 'vue':
      return [html(), htmlAutoCloseTags]
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'sql':
      return sql()
    case 'xml':
      return [xml(), xmlAutoCloseTags]
    default:
      return []
  }
}

function makeSnippet(label, template, detail) {
  return snippetCompletion(template, { label, detail, type: 'keyword' })
}

const PYTHON_SNIPPETS = [
  makeSnippet('def', 'def ${name}(${params}):\n\t${}', 'function'),
  makeSnippet('class', 'class ${Name}:\n\tdef __init__(self):\n\t\t${}', 'class'),
  makeSnippet('ifmain', 'if __name__ == "__main__":\n\t${}', 'main guard'),
  makeSnippet('for', 'for ${item} in ${items}:\n\t${}', 'loop'),
  makeSnippet('try', 'try:\n\t${}\nexcept ${Exception} as ${error}:\n\t${}', 'exception'),
]

const HTML_SNIPPETS = [
  makeSnippet('div', '<div>${}</div>', 'element'),
  makeSnippet('span', '<span>${}</span>', 'element'),
  makeSnippet('a', '<a href="${}">${}</a>', 'link'),
  makeSnippet('img', '<img src="${}" alt="${}">', 'image'),
  makeSnippet('button', '<button type="button">${}</button>', 'control'),
  makeSnippet('input', '<input type="${text}" name="${}">', 'control'),
  makeSnippet('ul', '<ul>\n\t<li>${}</li>\n</ul>', 'list'),
]

const CSS_SNIPPETS = [
  makeSnippet('display-flex', 'display: flex;', 'property'),
  makeSnippet('position-absolute', 'position: absolute;', 'property'),
  makeSnippet('media', '@media (max-width: ${}) {\n\t${}\n}', 'at-rule'),
  makeSnippet('root', ':root {\n\t${}\n}', 'at-rule'),
]

const MARKDOWN_SNIPPETS = [
  makeSnippet('heading', '# ${}', 'heading'),
  makeSnippet('item', '- ${}', 'list item'),
  makeSnippet('link', '[${}](${})', 'link'),
  makeSnippet('code', '```${lang}\n${}\n```', 'code fence'),
]

const JSON_SNIPPETS = [
  makeSnippet('key-value', '"${key}": ${value}', 'member'),
]

const YAML_SNIPPETS = [
  makeSnippet('mapping', '${key}: ${value}', 'mapping'),
  makeSnippet('item', '- ${item}', 'sequence item'),
]

const SQL_SNIPPETS = [
  makeSnippet('select', 'SELECT ${} FROM ${};', 'query'),
  makeSnippet('insert', 'INSERT INTO ${} (${}) VALUES (${});', 'statement'),
  makeSnippet('create-table', 'CREATE TABLE ${} (\n\t${}\n);', 'statement'),
]

const XML_SNIPPETS = [
  makeSnippet('element', '<${tag}>${}</${tag}>', 'element'),
]

const SQL_COMPLETION = keywordCompletionSource(StandardSQL)

/** Language-specific completion sources plus snippets and, for reasonable buffers, document words. */
function completionSourcesFor(path) {
  const ext = extensionOf(path)
  const sources = []
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'].includes(ext)) {
    sources.push(javascriptLocalCompletion)
  }
  if (ext === 'py') sources.push(pythonLocalCompletion, pythonGlobalCompletion)
  if (['css', 'scss', 'less'].includes(ext)) sources.push(cssCompletionSource)
  if (['html', 'htm', 'vue'].includes(ext)) sources.push(htmlCompletionSource)
  if (ext === 'sql') sources.push(SQL_COMPLETION)

  let snippets = []
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') snippets = javascriptSnippets
  else if (ext === 'ts' || ext === 'mts' || ext === 'cts' || ext === 'tsx') snippets = typescriptSnippets
  else if (ext === 'py') snippets = PYTHON_SNIPPETS
  else if (['html', 'htm', 'vue', 'xml'].includes(ext)) snippets = ext === 'xml' ? XML_SNIPPETS : HTML_SNIPPETS
  else if (['css', 'scss', 'less'].includes(ext)) snippets = CSS_SNIPPETS
  else if (['md', 'markdown', 'mdx'].includes(ext)) snippets = MARKDOWN_SNIPPETS
  else if (['json', 'jsonc', 'json5'].includes(ext)) snippets = JSON_SNIPPETS
  else if (['yaml', 'yml'].includes(ext)) snippets = YAML_SNIPPETS
  else if (ext === 'sql') snippets = SQL_SNIPPETS
  if (snippets.length > 0) sources.push(completeFromList(snippets))

  sources.push(context => context.state.doc.length > 400_000 ? null : completeAnyWord(context))
  return sources
}

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--dsw-alias-brand-primary)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--dsw-alias-state-success-primary)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--dsw-alias-state-warn-primary)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--dsw-alias-label-secondary)',
    fontStyle: 'italic',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--dsw-alias-brand-primary)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)],
    color: 'var(--dsw-alias-label-primary)',
  },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--dsw-alias-label-secondary)' },
  { tag: [tags.heading, tags.strong], color: 'var(--dsw-alias-brand-primary)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--dsw-alias-brand-primary)', textDecoration: 'underline' },
  { tag: [tags.invalid], color: 'var(--dsw-alias-state-error-primary)' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    lineHeight: '1.6',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--dsw-alias-label-primary)',
  },
  '.cm-line': { padding: '0 12px 0 4px' },
  '.cm-gutters': {
    paddingLeft: '4px',
    border: 'none',
    color: 'var(--dsw-alias-label-secondary)',
    backgroundColor: 'var(--dsw-alias-bg-base)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-bg-layer-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-bg-layer-2)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
  '.cm-foldPlaceholder': {
    border: 'none',
    color: 'var(--dsw-alias-label-secondary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
  },
  '.cm-tooltip': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-overlay)',
    border: '0.5px solid var(--dsw-alias-border-l1)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 48%, transparent)',
  },
  '.cm-panels': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-overlay)',
  },
  '.cm-panel.cm-search': { padding: '4px 6px' },
  '.cm-textfield, .cm-button': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    border: '0.5px solid var(--dsw-alias-border-l1)',
    backgroundImage: 'none',
  },
}, { dark: false })

function createEditorState(path, doc, ariaLabel, onUpdate) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      syntaxHighlighting(highlightStyle),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
      ]),
      keymap.of(snippetKeymap),
      autocompletion({ activateOnTyping: true, override: completionSourcesFor(path) }),
      languageSupportFor(path),
      EditorView.contentAttributes.of({
        'aria-label': ariaLabel,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      EditorView.updateListener.of(onUpdate),
      editorTheme,
    ],
  })
}

/** Mount a CodeMirror session and expose only the operations the React header needs. */
function createEditorSession({ parent, path, doc, ariaLabel, onUpdate }) {
  const view = new EditorView({
    state: createEditorState(path, doc, ariaLabel, onUpdate),
    parent,
  })
  return {
    view,
    getDoc: () => view.state.doc,
    getText: () => view.state.doc.toString(),
    docEquals: other => other !== undefined && view.state.doc.eq(other),
    canUndo: () => undoDepth(view.state) > 0,
    canRedo: () => redoDepth(view.state) > 0,
    focus: () => view.focus(),
    undo: () => { undo(view); view.focus() },
    redo: () => { redo(view); view.focus() },
    replaceAll(text) {
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      const column = head - line.from
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      const nextLine = view.state.doc.line(Math.min(line.number, view.state.doc.lines))
      const position = Math.min(nextLine.from + Math.min(column, nextLine.length), view.state.doc.length)
      view.dispatch({ selection: EditorSelection.cursor(position), scrollIntoView: true })
      view.focus()
    },
    destroy: () => view.destroy(),
  }
}


window.__ModuleLoader__.load({
  id: 'dsh-sidebar-file-editor',
  factory(require) {
    const React = require('react')
    const {
      useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React
    const h = React.createElement

    const ID = 'dsh-sidebar-file-editor'
    const KIND = 'sidebar-file-editor'
    const NS = 'sidebarFileEditor'
    const OPEN_PATH = '/api/sidebar-file-editor.open'
    const SAVE_PATH = '/api/sidebar-file-editor.save'
    const formatChunkPromises = new Map()
    /** Fetch one package-local formatter chunk exactly once; failure allows a retry. */
    function loadFormatChunk(name) {
      let pending = formatChunkPromises.get(name)
      if (pending === undefined) {
        pending = require.async(`./client.format-${name}.js`).catch(cause => {
          formatChunkPromises.delete(name)
          throw cause
        })
        formatChunkPromises.set(name, pending)
      }
      return pending
    }

    const DICTIONARIES = {
      en: {
        save: 'Save',
        saveHint: 'Save ({shortcut})',
        undo: 'Undo',
        undoHint: 'Undo ({shortcut})',
        redo: 'Redo',
        redoHint: 'Redo ({shortcut})',
        format: 'Format',
        formatHint: 'Format document ({shortcut})',
        formatUnsupportedHint: 'Prettier does not support this language',
        formatting: 'Formatting…',
        formatted: 'Formatted',
        formatFailed: 'Formatting failed',
        reload: 'Reload from disk',
        loading: 'Opening file…',
        retry: 'Retry',
        saved: 'Saved',
        saving: 'Saving…',
        unsaved: 'Unsaved changes',
        upToDate: 'Up to date',
        saveFailed: 'Not saved',
        conflict: 'File changed on disk',
        encoding: 'UTF-8',
        errorTitle: 'Cannot open this file',
        errorSession: 'This Session is no longer live.',
        errorNotFound: 'The file no longer exists.',
        errorNotRegular: 'This path is not a regular file.',
        errorOutside: 'This file is outside the Session workspace.',
        errorTooLarge: 'This file is too large for the editor (2 MiB limit).',
        errorNotText: 'This file is not UTF-8 text.',
        errorReadOnly: 'This Session is read-only.',
        errorPermission: 'The file cannot be written because of filesystem permissions.',
        errorStale: 'The file changed on disk since it was opened.',
        errorUnknown: 'The file operation failed.',
        errorFormatUnsupported: 'Prettier does not support this language.',
        errorFormatTooLarge: 'This file is too large to format (512 KB limit).',
        errorFormatChanged: 'The content changed while formatting; the result was not applied.',
        errorFormatFailed: 'Formatting failed.',
        conflictTitle: 'Save conflict',
        conflictBody: 'The file changed on disk. Reload to keep that version, or overwrite it with yours.',
        reloadAction: 'Reload',
        overwriteAction: 'Overwrite',
        confirmDiscard: 'Discard unsaved changes and reload from disk?',
        confirmOverwrite: 'Overwrite the file on disk with your version?',
        confirmClose: 'Close this editor and discard unsaved changes?',
        ariaDirty: 'Unsaved changes',
      },
      zh: {
        save: '保存',
        saveHint: '保存（{shortcut}）',
        undo: '撤销',
        undoHint: '撤销（{shortcut}）',
        redo: '重做',
        redoHint: '重做（{shortcut}）',
        format: '格式化',
        formatHint: '格式化文档（{shortcut}）',
        formatUnsupportedHint: 'Prettier 不支持该语言',
        formatting: '正在格式化…',
        formatted: '已格式化',
        formatFailed: '格式化失败',
        reload: '从磁盘重新加载',
        loading: '正在打开文件…',
        retry: '重试',
        saved: '已保存',
        saving: '正在保存…',
        unsaved: '有未保存的更改',
        upToDate: '已是最新',
        saveFailed: '未保存',
        conflict: '文件已在磁盘上更改',
        encoding: 'UTF-8',
        errorTitle: '无法打开此文件',
        errorSession: '此会话已不再运行。',
        errorNotFound: '文件已不存在。',
        errorNotRegular: '该路径不是常规文件。',
        errorOutside: '该文件不在当前会话的工作区内。',
        errorTooLarge: '文件过大，编辑器最多支持 2 MiB。',
        errorNotText: '该文件不是 UTF-8 文本。',
        errorReadOnly: '当前会话为只读模式。',
        errorPermission: '文件系统权限不允许写入该文件。',
        errorStale: '文件在打开后已在磁盘上更改。',
        errorUnknown: '文件操作失败。',
        errorFormatUnsupported: 'Prettier 不支持该语言。',
        errorFormatTooLarge: '文件过大，无法格式化（上限 512 KB）。',
        errorFormatChanged: '格式化期间内容已更改，结果未应用。',
        errorFormatFailed: '格式化失败。',
        conflictTitle: '保存冲突',
        conflictBody: '文件已在磁盘上更改。重新加载以保留磁盘版本，或用你的版本覆盖。',
        reloadAction: '重新加载',
        overwriteAction: '覆盖',
        confirmDiscard: '放弃未保存的更改并从磁盘重新加载？',
        confirmOverwrite: '用你的版本覆盖磁盘上的文件？',
        confirmClose: '关闭此编辑器并放弃未保存的更改？',
        ariaDirty: '有未保存的更改',
      },
    }

    const STYLE = `
.dsh-sfe-root {
  container-type: inline-size;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family, inherit);
}
.dsh-sfe-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: 38px;
  padding: 0 6px 0 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-sfe-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sfe-dirty-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-sfe-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.dsh-sfe-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  min-width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-sfe-button.primary { width: auto; padding: 0 8px; color: var(--dsw-alias-label-primary); }
.dsh-sfe-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-sfe-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-sfe-button:disabled { opacity: .4; cursor: default; }
.dsh-sfe-button.primary[data-dirty="true"] { color: var(--dsw-alias-brand-primary); }
.dsh-sfe-button svg { flex: none; }
.dsh-sfe-bar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-sfe-bar.error { color: var(--dsw-alias-state-error-primary); }
.dsh-sfe-bar .dsh-sfe-message { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
.dsh-sfe-bar .dsh-sfe-bar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-sfe-small-button {
  box-sizing: border-box;
  min-height: 24px;
  padding: 2px 9px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-sfe-small-button:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-sfe-small-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-sfe-body { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; }
.dsh-sfe-cm-host {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: visible;
}
.dsh-sfe-cm-host > .cm-editor { height: 100%; }
.dsh-sfe-button.format { width: auto; padding: 0 8px; }
.dsh-sfe-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  box-sizing: border-box;
  min-height: 0;
  padding: 24px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}
.dsh-sfe-empty-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.dsh-sfe-empty-message { max-width: 36ch; margin: 0; overflow-wrap: anywhere; }
.dsh-sfe-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: dsh-sfe-spin .8s linear infinite;
}
@keyframes dsh-sfe-spin { to { transform: rotate(360deg); } }
.dsh-sfe-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-sizing: border-box;
  height: 24px;
  padding: 0 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1;
}
.dsh-sfe-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sfe-status[data-tone="dirty"], .dsh-sfe-status[data-tone="conflict"] { color: var(--dsw-alias-state-warn-primary); }
.dsh-sfe-status[data-tone="saved"] { color: var(--dsw-alias-state-success-primary); }
.dsh-sfe-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsh-sfe-meta { flex: none; white-space: nowrap; }
.dsh-sfe-title { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.dsh-sfe-title-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sfe-title-dirty { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }
@container (max-width: 480px) {
  .dsh-sfe-button.format span { display: none; }
}
@container (max-width: 390px) {
  .dsh-sfe-button.primary span { display: none; }
  .dsh-sfe-header { padding-left: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-sfe-spinner { animation-duration: 2s; }
}
`

    const EDITABLE_EXTENSIONS = new Set([
      'adoc', 'asciidoc', 'asm', 'astro', 'bash', 'bat', 'bib', 'c', 'cc', 'cfg', 'cjs', 'clj',
      'cljs', 'cmake', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts', 'cxx', 'd', 'dart', 'diff',
      'dockerignore', 'edn', 'el', 'env', 'erl', 'ex', 'exs', 'fish', 'fs', 'fsx', 'gitattributes',
      'gitignore', 'go', 'gql', 'gradle', 'graphql', 'groovy', 'h', 'hbs', 'hpp', 'hrl', 'hs', 'htm',
      'html', 'hxx', 'ini', 'java', 'jl', 'js', 'json', 'json5', 'jsonc', 'jsx', 'kt', 'kts', 'less',
      'lhs', 'lisp', 'lock', 'log', 'lua', 'm', 'markdown', 'md', 'mdx', 'mjs', 'ml', 'mli', 'mm',
      'mts', 'nim', 'nix', 'npmrc', 'nvmrc', 'org', 'patch', 'php', 'pl', 'pm', 'properties', 'proto',
      'ps1', 'psm1', 'py', 'pyi', 'r', 'rb', 'rmd', 'rs', 'rst', 's', 'sass', 'scala', 'scss', 'sh',
      'sol', 'sql', 'svelte', 'sv', 'svg', 'svh', 'swift', 'tex', 'text', 'thrift', 'toml', 'ts',
      'tsv', 'tsx', 'txt', 'v', 'vb', 'vhd', 'vhdl', 'vim', 'vue', 'xml', 'yaml', 'yml', 'zig',
    ])

    const EDITABLE_NAMES = new Set([
      '.babelrc', '.browserslistrc', '.dockerignore', '.editorconfig', '.env', '.eslintignore',
      '.eslintrc', '.gitattributes', '.gitignore', '.gitmodules', '.htaccess', '.mailmap', '.npmignore',
      '.npmrc', '.nvmrc', '.prettierignore', '.prettierrc', '.stylelintrc', '.tool-versions', '.yarnrc',
      'authors', 'changelog', 'cmakelists.txt', 'codeowners', 'contributors', 'copying', 'dockerfile',
      'gemfile', 'go.mod', 'go.sum', 'justfile', 'license', 'licence', 'makefile', 'notice',
      'procfile', 'rakefile', 'readme',
    ])

    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

    /** Parse one file address without importing a Harness client package. */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      try {
        const end = address.search(/[?#]/)
        const raw = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
        const [scope, ...rest] = raw.split('/')
        if (scope === 'session') {
          const [id, ...segments] = rest
          if (id === undefined || id === '' || segments.length === 0) return undefined
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
          if (segments.length === 0 || segments[0] === '') return undefined
          return { scope, path: unc ? `//${segments.join('/')}` : `/${segments.join('/')}` }
        }
      } catch {
        return undefined
      }
      return undefined
    }

    function basenameOfAddress(address) {
      const file = parseFileAddress(address)
      const name = file?.path.slice(file.path.lastIndexOf('/') + 1) ?? ''
      return name === '' ? address : name
    }

    /** Whether the Files tree should route this address into the editor. */
    function canOpen(address) {
      const file = parseFileAddress(address)
      if (file === undefined || file.scope !== 'session' || file.path.length === 0) return false
      const name = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase()
      if (name === '') return false
      if (EDITABLE_NAMES.has(name) || name.startsWith('.env')) return true
      const dot = name.lastIndexOf('.')
      if (dot <= 0) return false
      return EDITABLE_EXTENSIONS.has(name.slice(dot + 1))
    }

    // One shared dirty set feeds the tab-title dot and the unload guard. The
    // body owns each entry for its mounted lifetime.
    const dirtyTabs = new Set()
    const dirtyListeners = new Set()
    function emitDirty() {
      for (const listener of dirtyListeners) listener()
    }
    function markDirty(tabId, dirty) {
      if (dirty) dirtyTabs.add(tabId)
      else dirtyTabs.delete(tabId)
      emitDirty()
    }
    function subscribeDirty(listener) {
      dirtyListeners.add(listener)
      return () => { dirtyListeners.delete(listener) }
    }
    function useDirtyTab(tabId) {
      return useSyncExternalStore(
        subscribeDirty,
        () => dirtyTabs.has(tabId),
        () => false,
      )
    }

    class EditorRequestError extends Error {
      constructor(code, message, status) {
        super(message)
        this.name = 'EditorRequestError'
        this.code = code
        this.status = status
      }
    }

    /** One JSON request to an authenticated editor route. */
    async function requestJson(path, body, signal) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const code = payload?.error?.code ?? 'editor/request-failed'
        const message = payload?.error?.message ?? `HTTP ${response.status}`
        throw new EditorRequestError(code, message, response.status)
      }
      return payload
    }

    function toEditorError(error) {
      if (error instanceof EditorRequestError) return { code: error.code, message: error.message }
      if (error instanceof DOMException && error.name === 'AbortError') return { code: 'editor/aborted', message: 'Aborted' }
      return { code: 'editor/network', message: error instanceof Error ? error.message : String(error) }
    }

    const ERROR_KEYS = {
      'editor/session-not-found': 'errorSession',
      'editor/not-found': 'errorNotFound',
      'editor/not-regular-file': 'errorNotRegular',
      'editor/outside-workspace': 'errorOutside',
      'editor/too-large': 'errorTooLarge',
      'editor/not-text': 'errorNotText',
      'editor/read-only': 'errorReadOnly',
      'editor/permission-denied': 'errorPermission',
      'editor/stale': 'errorStale',
      'editor/bad-request': 'errorUnknown',
      'editor/io-error': 'errorUnknown',
      'editor/network': 'errorUnknown',
      'editor/bad-address': 'errorUnknown',
      'editor/format-unsupported': 'errorFormatUnsupported',
      'editor/format-too-large': 'errorFormatTooLarge',
      'editor/format-changed': 'errorFormatChanged',
      'editor/format-failed': 'errorFormatFailed',
      'editor/editor-init': 'errorUnknown',
    }

    function errorText(t, error) {
      if (error === undefined || error === null) return ''
      const key = ERROR_KEYS[error.code]
      const base = key === undefined ? t('errorUnknown') : t(key)
      if (error.code !== 'editor/format-failed' || typeof error.message !== 'string') return base
      const detail = error.message.replace(/\s+/g, ' ').trim().slice(0, 360)
      return detail === '' ? base : `${base} ${detail}`
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    function isMac() {
      return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    }

    function Icon({ path, extra, size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: path }), extra === undefined ? null : h('path', { d: extra }))
    }

    const SAVE_ICON = 'M3.5 2.5h7l2 2v9h-9v-11Z'
    const SAVE_INNER = 'M5.5 2.5v4h5v-4M5.5 13.5v-4h5v4'
    const UNDO_ICON = 'M6 3.5 2.5 7 6 10.5'
    const UNDO_TAIL = 'M2.5 7h6a4 4 0 0 1 0 8H6.5'
    const REDO_ICON = 'm10 3.5 3.5 3.5-3.5 3.5'
    const REDO_TAIL = 'M13.5 7h-6a4 4 0 0 0 0 8h2'
    const RELOAD_ICON = 'M13 7.5A5 5 0 1 0 13.3 10'
    const RELOAD_TAIL = 'M13 3.5v4h-4'
    const FORMAT_ICON = 'M2.5 13.5 9 7l2.5 2.5-6.5 6.5h-3v-2.5Z'
    const FORMAT_EXTRA = 'M11.5 2.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z'

    function IconButton({ label, hint, disabled, onClick, path, extra }) {
      return h('button', {
        type: 'button',
        className: 'dsh-sfe-button',
        title: hint ?? label,
        'aria-label': label,
        disabled,
        onClick,
      }, h(Icon, { path, extra }))
    }

    function EditorTitle({ useTabInfo, t }) {
      const { tab } = useTabInfo()
      const dirty = useDirtyTab(tab.id)
      return h('span', {
        className: 'dsh-sfe-title',
        title: dirty ? t('ariaDirty') : undefined,
      },
      dirty ? h('span', { className: 'dsh-sfe-title-dirty', 'aria-hidden': true }) : null,
      h('span', { className: 'dsh-sfe-title-name' }, basenameOfAddress(tab.contentId)))
    }

    function EditorBody({ useTabInfo, t }) {
      const { tab } = useTabInfo()
      const file = useMemo(() => parseFileAddress(tab.contentId), [tab.contentId])
      const parser = useMemo(() => file === undefined ? undefined : formatParserForPath(file.path), [file])
      const [phase, setPhase] = useState('loading')
      const [absolutePath, setAbsolutePath] = useState(undefined)
      const [bytes, setBytes] = useState(undefined)
      const [dirty, setDirty] = useState(false)
      const [busyKind, setBusyKind] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [conflict, setConflict] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const [historyFlags, setHistoryFlags] = useState({ canUndo: false, canRedo: false })
      const [loadEpoch, setLoadEpoch] = useState(0)

      const editorHostRef = useRef(null)
      const editorRef = useRef(undefined)
      const loadedTextRef = useRef('')
      const savedDocRef = useRef(undefined)
      const versionRef = useRef(undefined)
      const eolRef = useRef('\n')
      const dirtyRef = useRef(false)
      const busyRef = useRef(false)
      const loadSeqRef = useRef(0)
      const mountedRef = useRef(true)
      const dirtyTabId = tab.id
      const busy = busyKind !== undefined

      useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      useEffect(() => () => { markDirty(dirtyTabId, false) }, [dirtyTabId])

      useEffect(() => {
        markDirty(dirtyTabId, phase === 'ready' && dirty)
      }, [dirtyTabId, dirty, phase])

      useEffect(() => {
        if (notice !== 'saved' && notice !== 'formatted') return undefined
        const timer = window.setTimeout(() => { setNotice(undefined) }, 2500)
        return () => { window.clearTimeout(timer) }
      }, [notice])

      const load = useCallback(async () => {
        const sequence = ++loadSeqRef.current
        setPhase('loading')
        setError(undefined)
        setConflict(false)
        setNotice(undefined)
        setBusyKind(undefined)
        setDirty(false)
        setHistoryFlags({ canUndo: false, canRedo: false })
        dirtyRef.current = false
        busyRef.current = false
        if (file === undefined) {
          setPhase('error')
          setError({ code: 'editor/bad-address' })
          return
        }
        try {
          const data = await requestJson(OPEN_PATH, {
            sessionId: file.sessionId,
            path: file.path,
          }, tab.signal)
          if (sequence !== loadSeqRef.current || tab.signal.aborted || !mountedRef.current) return
          loadedTextRef.current = data.text
          eolRef.current = lineEndingOf(data.text)
          savedDocRef.current = undefined
          versionRef.current = data.version
          setAbsolutePath(data.absolutePath)
          setBytes(data.bytes)
          setPhase('ready')
          setDirty(false)
          dirtyRef.current = false
          setError(undefined)
          setLoadEpoch(epoch => epoch + 1)
        } catch (cause) {
          if (sequence !== loadSeqRef.current || tab.signal.aborted || !mountedRef.current) return
          setPhase('error')
          setError(toEditorError(cause))
        }
      }, [file, tab.signal])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        if (phase !== 'ready' || file === undefined || editorHostRef.current === null) return undefined
        let session
        try {
          session = createEditorSession({
            parent: editorHostRef.current,
            path: file.path,
            doc: loadedTextRef.current,
            ariaLabel: basenameOfAddress(tab.contentId),
            onUpdate: (update) => {
              if (!mountedRef.current) return
              const saved = savedDocRef.current
              const nextDirty = saved === undefined ? true : !update.state.doc.eq(saved)
              if (nextDirty !== dirtyRef.current) {
                dirtyRef.current = nextDirty
                setDirty(nextDirty)
              }
              const canUndo = undoDepth(update.state) > 0
              const canRedo = redoDepth(update.state) > 0
              setHistoryFlags(previous => (
                previous.canUndo === canUndo && previous.canRedo === canRedo
                  ? previous
                  : { canUndo, canRedo }
              ))
              if (update.docChanged) {
                setNotice(undefined)
                setError(undefined)
              }
            },
          })
        } catch (cause) {
          setPhase('error')
          setError({ code: 'editor/editor-init', message: cause instanceof Error ? cause.message : String(cause) })
          return undefined
        }
        editorRef.current = session
        savedDocRef.current = session.getDoc()
        setHistoryFlags({ canUndo: false, canRedo: false })
        const frame = window.requestAnimationFrame(() => {
          if (editorRef.current === session) session.focus()
        })
        return () => {
          window.cancelAnimationFrame(frame)
          session.destroy()
          if (editorRef.current === session) editorRef.current = undefined
        }
      }, [file, phase, loadEpoch, tab.contentId])

      useEffect(() => {
        if (!tab.visible) return undefined
        const frame = window.requestAnimationFrame(() => {
          editorRef.current?.view.requestMeasure()
        })
        return () => { window.cancelAnimationFrame(frame) }
      }, [tab.visible, phase, loadEpoch])

      const undoAction = useCallback(() => { editorRef.current?.undo() }, [])
      const redoAction = useCallback(() => { editorRef.current?.redo() }, [])

      const save = useCallback(async (force = false) => {
        if (busyRef.current || phase !== 'ready' || file === undefined) return
        if (!force && !dirtyRef.current) return
        const session = editorRef.current
        if (session === undefined) return
        const contentDoc = session.getDoc()
        const content = session.getText().replace(/\n/g, eolRef.current)
        busyRef.current = true
        setBusyKind('saving')
        setError(undefined)
        setConflict(false)
        setNotice('saving')
        try {
          const payload = {
            content,
            path: file.path,
            sessionId: file.sessionId,
          }
          if (force) payload.force = true
          else payload.expectedVersion = versionRef.current
          const data = await requestJson(SAVE_PATH, payload, tab.signal)
          if (tab.signal.aborted || !mountedRef.current) return
          versionRef.current = data.version
          setBytes(data.bytes)
          savedDocRef.current = contentDoc
          const stillDirty = !session.docEquals(contentDoc)
          dirtyRef.current = stillDirty
          setDirty(stillDirty)
          setConflict(false)
          if (stillDirty) setNotice(undefined)
          else setNotice('saved')
        } catch (cause) {
          if (tab.signal.aborted || !mountedRef.current) return
          const next = toEditorError(cause)
          if (next.code === 'editor/stale') {
            setConflict(true)
            setNotice(undefined)
          } else {
            setError(next)
            setNotice(undefined)
          }
        } finally {
          busyRef.current = false
          if (mountedRef.current) setBusyKind(undefined)
        }
      }, [file, phase, tab.signal])

      const formatDocument = useCallback(async () => {
        if (busyRef.current || phase !== 'ready' || file === undefined) return
        const session = editorRef.current
        if (session === undefined) return
        if (parser === undefined) {
          setError({ code: 'editor/format-unsupported' })
          return
        }
        const source = session.getText()
        busyRef.current = true
        setBusyKind('formatting')
        setError(undefined)
        setNotice(undefined)
        try {
          const formatted = await formatText(file.path, source, loadFormatChunk)
          if (tab.signal.aborted || !mountedRef.current) return
          const current = editorRef.current
          if (current === undefined) return
          if (current !== session || current.getText() !== source) {
            setError({ code: 'editor/format-changed' })
            return
          }
          if (formatted !== source) current.replaceAll(formatted)
          setNotice('formatted')
        } catch (cause) {
          if (tab.signal.aborted || !mountedRef.current) return
          if (cause instanceof FormatIssue) setError({ code: cause.code, message: cause.message })
          else setError({ code: 'editor/format-failed', message: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          busyRef.current = false
          if (mountedRef.current) setBusyKind(undefined)
        }
      }, [file, parser, phase, tab.signal])

      const reload = useCallback(() => {
        if (busyRef.current) return
        if (dirtyRef.current && !window.confirm(t('confirmDiscard'))) return
        void load()
      }, [load, t])

      const overwrite = useCallback(() => {
        if (!window.confirm(t('confirmOverwrite'))) return
        void save(true)
      }, [save, t])

      const handleKeyDown = useCallback((event) => {
        if (event.isComposing) return
        const target = event.target
        const inEditor = target instanceof Element && target.closest('.cm-editor') !== null
        const mod = event.metaKey || event.ctrlKey
        const key = event.key.toLowerCase()
        if (event.shiftKey && event.altKey && !mod && key === 'f') {
          event.preventDefault()
          void formatDocument()
          return
        }
        if (!mod || event.altKey) return
        if (key === 's') {
          event.preventDefault()
          void save(false)
        } else if (key === 'z' || key === 'y') {
          // With editor focus, CodeMirror's keymap owns undo/redo. The header
          // buttons and other focus targets still get the same shortcuts here.
          if (inEditor) return
          event.preventDefault()
          if (key === 'y' || event.shiftKey) redoAction()
          else undoAction()
        }
      }, [formatDocument, redoAction, save, undoAction])

      const modLabel = isMac() ? '⌘' : 'Ctrl+'
      const redoLabel = isMac() ? '⇧⌘Z' : 'Ctrl+Shift+Z'
      const displayPath = absolutePath ?? file?.path ?? ''
      const sizeLabel = formatBytes(bytes)
      const formatHint = parser === undefined
        ? t('formatUnsupportedHint')
        : t('formatHint', { shortcut: 'Shift+Alt+F' })
      let statusKey = 'upToDate'
      let statusTone = 'idle'
      if (error !== undefined) {
        statusKey = error.code.startsWith('editor/format') ? 'formatFailed' : 'saveFailed'
        statusTone = 'error'
      } else if (conflict) {
        statusKey = 'conflict'
        statusTone = 'conflict'
      } else if (busyKind === 'saving') {
        statusKey = 'saving'
      } else if (busyKind === 'formatting') {
        statusKey = 'formatting'
      } else if (dirty) {
        statusKey = 'unsaved'
        statusTone = 'dirty'
      } else if (notice === 'saved') {
        statusKey = 'saved'
        statusTone = 'saved'
      } else if (notice === 'formatted') {
        statusKey = 'formatted'
        statusTone = 'saved'
      }

      return h('div', {
        className: 'dsh-sfe-root',
        onKeyDown: handleKeyDown,
      },
      h('div', { className: 'dsh-sfe-header' },
        dirty ? h('span', { className: 'dsh-sfe-dirty-dot', title: t('unsaved'), 'aria-label': t('ariaDirty') }) : null,
        h('span', {
          className: 'dsh-sfe-path',
          title: displayPath,
        }, displayPath),
        h('div', { className: 'dsh-sfe-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-sfe-button primary',
            title: t('saveHint', { shortcut: `${modLabel}S` }),
            'aria-label': t('saveHint', { shortcut: `${modLabel}S` }),
            'data-dirty': String(dirty),
            disabled: busy || phase !== 'ready' || !dirty,
            onClick: () => { void save(false) },
          }, h(Icon, { path: SAVE_ICON, extra: SAVE_INNER }), h('span', null, t('save'))),
          h('button', {
            type: 'button',
            className: 'dsh-sfe-button format',
            title: formatHint,
            'aria-label': formatHint,
            disabled: busy || phase !== 'ready',
            onClick: () => { void formatDocument() },
          }, h(Icon, { path: FORMAT_ICON, extra: FORMAT_EXTRA }), h('span', null, t('format'))),
          h(IconButton, {
            label: t('undo'),
            hint: t('undoHint', { shortcut: `${modLabel}Z` }),
            disabled: phase !== 'ready' || !historyFlags.canUndo,
            onClick: undoAction,
            path: UNDO_ICON,
            extra: UNDO_TAIL,
          }),
          h(IconButton, {
            label: t('redo'),
            hint: t('redoHint', { shortcut: redoLabel }),
            disabled: phase !== 'ready' || !historyFlags.canRedo,
            onClick: redoAction,
            path: REDO_ICON,
            extra: REDO_TAIL,
          }),
          h(IconButton, {
            label: t('reload'),
            disabled: busy || phase === 'loading',
            onClick: reload,
            path: RELOAD_ICON,
            extra: RELOAD_TAIL,
          }),
        ),
      ),
      conflict ? h('div', { className: 'dsh-sfe-bar', role: 'alert' },
        h('div', { className: 'dsh-sfe-message' },
          h('strong', null, t('conflictTitle')), ' ', t('conflictBody')),
        h('div', { className: 'dsh-sfe-bar-actions' },
          h('button', {
            type: 'button', className: 'dsh-sfe-small-button',
            onClick: reload,
          }, t('reloadAction')),
          h('button', {
            type: 'button', className: 'dsh-sfe-small-button',
            onClick: overwrite,
          }, t('overwriteAction')),
        ),
      ) : null,
      error !== undefined && phase === 'ready' ? h('div', {
        className: 'dsh-sfe-bar error', role: 'alert',
      }, h('div', { className: 'dsh-sfe-message' }, errorText(t, error))) : null,
      phase === 'loading' ? h('div', { className: 'dsh-sfe-empty', role: 'status' },
        h('div', { className: 'dsh-sfe-spinner', 'aria-hidden': true }),
        h('p', { className: 'dsh-sfe-empty-message' }, t('loading')),
      ) : phase === 'error' ? h('div', { className: 'dsh-sfe-empty', role: 'alert' },
        h('p', { className: 'dsh-sfe-empty-title' }, t('errorTitle')),
        h('p', { className: 'dsh-sfe-empty-message' }, errorText(t, error)),
        h('button', {
          type: 'button', className: 'dsh-sfe-small-button',
          onClick: () => { void load() },
        }, t('retry')),
      ) : h('div', { className: 'dsh-sfe-body' },
        h('div', { ref: editorHostRef, className: 'dsh-sfe-cm-host' }),
      ),
      phase === 'ready' ? h('div', { className: 'dsh-sfe-footer' },
        h('span', {
          className: 'dsh-sfe-status',
          'data-tone': statusTone,
          'aria-live': 'polite',
        }, t(statusKey)),
        h('span', { className: 'dsh-sfe-meta' },
          sizeLabel === '' || dirty ? '' : `${sizeLabel} · `,
          t('encoding')),
      ) : null)
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'sidebar-file-editor: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          multiple: true,
          keepMounted: true,
          priority: 'extension',
          patterns: ['dsh-resource://file/[\\s\\S]+'],
          canOpen,
          title: basenameOfAddress,
        }), 'sidebar-file-editor: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, EditorBody)), 'sidebar-file-editor: body')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: ID,
          locale: NS,
        }, EditorTitle)), 'sidebar-file-editor: title')
        ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (_sessionId, tab) => {
          if (!dirtyTabs.has(tab.id)) return
          if (!window.confirm(t('confirmClose'))) throw new Error('sidebar-file-editor: unsaved changes')
        }), 'sidebar-file-editor: close guard')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshSidebarFileEditor = ''
          style.textContent = STYLE
          document.head.append(style)
          const beforeUnload = (event) => {
            if (dirtyTabs.size === 0) return
            event.preventDefault()
            event.returnValue = ''
          }
          window.addEventListener('beforeunload', beforeUnload)
          return () => {
            window.removeEventListener('beforeunload', beforeUnload)
            style.remove()
            dirtyTabs.clear()
            emitDirty()
          }
        }, 'sidebar-file-editor: styles and unload guard')
      },
    }
  },
})
