/**
 * Host half of the sidebar file editor bundle.
 *
 * The browser half renders a full-file editor in a right-sidebar tab. This
 * module owns the two authenticated endpoints it needs:
 *
 * - `POST /api/sidebar-file-editor.open` reads one existing regular text file
 *   inside the requesting Session's workspace and returns its exact version.
 * - `POST /api/sidebar-file-editor.save` writes the whole file back with an
 *   optimistic version guard, so an external change is reported instead of
 *   silently overwritten.
 *
 * Both routes use Connection's exact-Fetch registry. That carrier admits only
 * the authenticated owner peer and applies the Host/Origin fence before this
 * module sees a request. Beyond that, every request is scoped to one live
 * Session, confined to that Session's workspace through the canonical `fs`
 * targets, restricted to existing regular files, and capped in size.
 */

/** Exact API paths owned by this bundle. */
const OPEN_PATH = '/api/sidebar-file-editor.open'
const SAVE_PATH = '/api/sidebar-file-editor.save'

/** Text the editor will open or write, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Refuse an oversized JSON envelope before parsing it. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Services the routes need. All are present in the Web composition. */
export const inject = ['fs', 'sessions', 'sandboxPolicy', 'connection']

export const name = 'sidebar-file-editor'

/** A JSON response that is never cached by the browser or an intermediary. */
function sendJson(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** One stable error shape for both routes. */
function sendError(status, code, message) {
  return sendJson(status, { error: { code, message } })
}

/** Whether a thrown value carries one of the filesystem error codes. */
function codeOf(error) {
  return typeof error === 'object' && error !== null && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** Map one filesystem refusal onto an HTTP answer without leaking a stack. */
function fsError(error) {
  const message = error instanceof Error ? error.message : String(error)
  switch (codeOf(error)) {
    case 'FS_STALE_VERSION':
      return sendError(409, 'editor/stale', 'The file changed on disk since it was read.')
    case 'FS_SANDBOX_DENIED':
      return sendError(403, 'editor/read-only', message)
    case 'FS_PERMISSION_DENIED':
      return sendError(403, 'editor/permission-denied', message)
    case 'FS_NOT_TEXT':
      return sendError(415, 'editor/not-text', 'The file is not UTF-8 text.')
    case 'FS_TOO_LARGE':
      return sendError(413, 'editor/too-large', message)
    case 'FS_NOT_FOUND':
      return sendError(404, 'editor/not-found', 'The file no longer exists.')
    case 'FS_NOT_REGULAR_FILE':
      return sendError(400, 'editor/not-regular-file', 'The path is not a regular file.')
    case 'FS_ABORTED':
      return new Response(null, { status: 499 })
    default:
      return sendError(500, 'editor/io-error', message)
  }
}

/** Read a bounded JSON object; null means the caller already got the answer. */
async function readJson(request) {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { response: sendError(413, 'editor/too-large', 'Request body exceeds the editor limit.') }
  }
  const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return { response: sendError(415, 'editor/unsupported-media-type', 'content-type must be application/json.') }
  }
  let body
  try {
    body = await request.json()
  } catch {
    return { response: sendError(400, 'editor/bad-request', 'Request body is not valid JSON.') }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { response: sendError(400, 'editor/bad-request', 'Request body must be a JSON object.') }
  }
  return { body }
}

/** Validate the pair every route is scoped by. */
function readTarget(body) {
  const { sessionId, path } = body
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
    return { response: sendError(400, 'editor/bad-request', 'sessionId must be a non-empty string.') }
  }
  if (typeof path !== 'string' || path.length === 0 || path.length > 32_768 || path.includes('\0')) {
    return { response: sendError(400, 'editor/bad-request', 'path must be a non-empty file path.') }
  }
  return { sessionId, path }
}

/**
 * Resolve the Session and confine one existing regular file to its workspace.
 * The path is inspected before symlinks are followed, then the resolved target
 * is checked for canonical containment, then re-stat'ed for regular-file kind.
 * @returns `{ target, info }` or a response describing the refusal.
 */
async function locate(ctx, session, path, signal) {
  const workspaceRoot = session.header.cwd ?? ctx.sandboxPolicy.workspaceRoot
  let root
  let entry
  try {
    root = await ctx.fs.resolve(workspaceRoot, { signal })
    entry = await ctx.fs.lstat(path, { cwd: workspaceRoot }, signal)
  } catch (error) {
    return { response: fsError(error) }
  }
  if (entry === undefined) return { response: sendError(404, 'editor/not-found', 'The file does not exist.') }
  if (entry.type !== 'file') {
    return { response: sendError(400, 'editor/not-regular-file', 'The path is not a regular file.') }
  }
  let target
  try {
    target = await ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
  } catch (error) {
    return { response: fsError(error) }
  }
  if (!ctx.fs.contains(root, target)) {
    return { response: sendError(403, 'editor/outside-workspace', 'The file is outside the Session workspace.') }
  }
  let info
  try {
    info = await ctx.fs.stat(target, signal)
  } catch (error) {
    return { response: fsError(error) }
  }
  if (info === undefined) return { response: sendError(404, 'editor/not-found', 'The file does not exist.') }
  if (info.type !== 'file') {
    return { response: sendError(400, 'editor/not-regular-file', 'The path is not a regular file.') }
  }
  return { target, info }
}

/** Resolve one live Session, or answer 404 without touching the filesystem. */
function locateSession(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    return { response: sendError(404, 'editor/session-not-found', 'The Session is not live.') }
  }
  return { session }
}

/** `POST /api/sidebar-file-editor.open` */
async function openFile(ctx, request) {
  const parsed = await readJson(request)
  if (parsed.response !== undefined) return parsed.response
  const target = readTarget(parsed.body)
  if (target.response !== undefined) return target.response
  const located = locateSession(ctx, target.sessionId)
  if (located.response !== undefined) return located.response
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await locate(ctx, located.session, target.path, request.signal)
    if (found.response !== undefined) return found.response
    if (found.info.size !== undefined && found.info.size > MAX_TEXT_BYTES) {
      return sendError(413, 'editor/too-large', `The file exceeds the ${MAX_TEXT_BYTES}-byte editor limit.`)
    }
    let raw
    try {
      // Bound the read at the seam instead of trusting an optional stat size;
      // decoding keeps a BOM so a save round-trips the file unchanged.
      raw = await ctx.fs.readBytes(found.target, request.signal, MAX_TEXT_BYTES)
    } catch (error) {
      return fsError(error)
    }
    let after
    try {
      after = await ctx.fs.stat(found.target, request.signal)
    } catch (error) {
      return fsError(error)
    }
    if (after === undefined) return sendError(404, 'editor/not-found', 'The file does not exist.')
    if (after.type !== 'file') {
      return sendError(400, 'editor/not-regular-file', 'The path is not a regular file.')
    }
    // The bytes and the version must describe the same content. A concurrent
    // write during the read retries instead of pairing a stale version with
    // newer text, which would make the first save spuriously stale.
    if (after.version !== found.info.version) continue
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    } catch (error) {
      if (error instanceof TypeError) {
        return sendError(415, 'editor/not-text', 'The file is not UTF-8 text.')
      }
      return fsError(error)
    }
    if (text.includes('\0')) {
      return sendError(415, 'editor/not-text', 'The file is not UTF-8 text.')
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_TEXT_BYTES) {
      return sendError(413, 'editor/too-large', `The file exceeds the ${MAX_TEXT_BYTES}-byte editor limit.`)
    }
    return sendJson(200, {
      absolutePath: ctx.fs.processPath(found.target),
      bytes,
      text,
      version: after.version,
    })
  }
  return sendError(409, 'editor/stale', 'The file changed while it was being opened. Try again.')
}

/** `POST /api/sidebar-file-editor.save` */
async function saveFile(ctx, request) {
  const parsed = await readJson(request)
  if (parsed.response !== undefined) return parsed.response
  const body = parsed.body
  const target = readTarget(body)
  if (target.response !== undefined) return target.response
  if (typeof body.content !== 'string') {
    return sendError(400, 'editor/bad-request', 'content must be a string.')
  }
  if (Buffer.byteLength(body.content, 'utf8') > MAX_TEXT_BYTES) {
    return sendError(413, 'editor/too-large', `content exceeds the ${MAX_TEXT_BYTES}-byte editor limit.`)
  }
  if (body.content.includes('\0')) {
    return sendError(415, 'editor/not-text', 'content must not contain NUL bytes.')
  }
  if (body.force !== true && (typeof body.expectedVersion !== 'string' || body.expectedVersion.length === 0)) {
    return sendError(400, 'editor/bad-request', 'expectedVersion is required unless force is true.')
  }
  const located = locateSession(ctx, target.sessionId)
  if (located.response !== undefined) return located.response
  const found = await locate(ctx, located.session, target.path, request.signal)
  if (found.response !== undefined) return found.response
  const expected = body.force === true
    ? undefined
    : { kind: 'replaceIfVersion', version: body.expectedVersion }
  const policy = ctx.sandboxPolicy.resolve({ session: located.session })
  let outcome
  try {
    outcome = await ctx.fs.writeText(found.target, body.content, expected, request.signal, policy)
  } catch (error) {
    return fsError(error)
  }
  return sendJson(200, {
    bytes: Buffer.byteLength(body.content, 'utf8'),
    version: outcome.version,
  })
}

/**
 * Register the two owner-authenticated Fetch routes.
 * @param ctx - Host context carrying the filesystem, Sessions, sandbox policy, and Connection.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: OPEN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await openFile(ctx, request)
      } catch (error) {
        return fsError(error)
      }
    },
  }), 'sidebar-file-editor: open route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: SAVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await saveFile(ctx, request)
      } catch (error) {
        return fsError(error)
      }
    },
  }), 'sidebar-file-editor: save route')
}
