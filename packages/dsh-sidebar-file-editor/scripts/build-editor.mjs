/**
 * Build the browser factory and its lazily loaded formatter chunks.
 *
 * `client.js` carries CodeMirror plus the editor UI. Prettier is split into a
 * core chunk and one language chunk per parser family; the factory fetches
 * them through the DSH module loader's package-local `require.async` only when
 * the user formats a supported file.
 *
 * React stays external and comes from the loader's shared module table inside
 * the main factory. Formatter chunks are self-contained CJS exports wrapped in
 * the loader's chunk registration format.
 */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ID = 'dsh-sidebar-file-editor'
const CHUNKS = ['core', 'javascript', 'typescript', 'css', 'html', 'markdown', 'yaml', 'graphql']
const BANNER = '/*! Bundled CodeMirror 6, Lezer, and Prettier. See THIRD_PARTY_NOTICES.md for their MIT notices. */'

const common = {
  bundle: true,
  write: false,
  platform: 'browser',
  target: ['chrome120', 'firefox120', 'safari17'],
  minify: true,
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}

async function buildChunk(name) {
  const result = await build({
    ...common,
    entryPoints: [join(root, 'src/format', `${name}.js`)],
    format: 'cjs',
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error(`esbuild produced no output for formatter chunk ${name}`)
  const fileName = `client.format-${name}.js`
  const code = [
    BANNER,
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(ID)},`,
    `  chunk: ${JSON.stringify(fileName)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    output.text,
    '    return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
  await writeFile(join(root, fileName), code)
  return [fileName, Buffer.byteLength(code)]
}

const sizes = []
for (const name of CHUNKS) sizes.push(await buildChunk(name))

// Build the owner artifact last: its revision is what the loader appends to
// every sibling chunk URL, so a language-only rebuild must also move this rev.
const main = await build({
  ...common,
  entryPoints: [join(root, 'src/client.js')],
  format: 'iife',
  external: ['react'],
  banner: { js: BANNER },
})
const [entry] = main.outputFiles
if (entry === undefined) throw new Error('esbuild produced no client output')
await writeFile(join(root, 'client.js'), entry.text)

const mib = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`
console.log(`built client.js (${mib(Buffer.byteLength(entry.text))})`)
for (const [file, bytes] of sizes) console.log(`built ${file} (${mib(bytes)})`)
