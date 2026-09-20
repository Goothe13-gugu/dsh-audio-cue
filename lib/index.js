/**
 * dsh-audio-cue — host half.
 *
 * This half owns two kinds of truth:
 *
 * 1. "Is DSH thinking or working right now", published to the web GUI as a
 *    Server-Sent Events stream. That state lives in the session event log, which
 *    the page cannot read: `session/event` fires for every live session —
 *    including subagents — at append time, and the session package emits it
 *    inside `append()` only, so historical events are never replayed through it.
 *
 * 2. The durable cue store: which sound each slot uses, the volume, and any
 *    audio the user imported. It lives under `${DSH_HOME}/dsh-audio-cue/`, so it
 *    outlives a browser cache, a restart, and a different browser. The browser
 *    half is a view over it and never decides on its own where a cue comes from —
 *    it asks for `/audio/<slot>` and the host resolves it.
 *
 * @module dsh-audio-cue
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Package root: this file lives in `lib/`, so the root is one level up. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Every route this plugin owns lives under this prefix (route collisions throw). */
const ROUTE = '/dsh-audio-cue'
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client', 'audio-cue.js')
const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')

/**
 * The built-in files this plugin will serve, and their content types. A
 * whitelist rather than a directory handler: the route is a read of the network
 * surface, and an allowlist is the cheapest way to keep it exactly this small.
 */
const ASSETS = {
  // The working cue ships as AAC, which every browser decodes -- Safari included,
  // which is why it is not an Ogg. The synthesized pair below it is the decoder
  // fallback for a browser that cannot play AAC at all.
  'let-me-go.m4a': 'audio/mp4',
  'loop.ogg': 'audio/ogg',
  'loop.mp3': 'audio/mpeg',
  'needs-you.mp3': 'audio/mpeg',
  'needs-you.ogg': 'audio/ogg',
}

/** Extensions an import may use, and the type each is served back as. */
const UPLOAD_TYPES = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
}

/**
 * Tools whose call means a person has to answer before the work can continue.
 * The session log carries no `question/*` event -- the ask-user tool is an
 * ordinary tool call -- so the call itself is the signal, matched by name and,
 * so a renamed tool still counts, by the shape of its arguments.
 */
const HUMAN_INPUT_TOOLS = new Set(['ask_user_question'])

/** Ceiling for one imported file: ample for a loop, small enough to stay light. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** Ceiling for a settings body, which is only ever a few hundred bytes. */
const MAX_SETTINGS_BYTES = 64 * 1024
/**
 * Cache header for a URL whose bytes can never change again: an upload is
 * addressed by an id that is never reused, and an audio URL carries a version
 * token. Without it, a page reload re-transfers the user's whole file.
 */
const IMMUTABLE = 'private, max-age=31536000, immutable'/** Longest file name this plugin will remember for an import. */
const MAX_NAME_LENGTH = 120

/** The two cue slots. */
const SLOTS = ['working', 'approval']
/**
 * Built-in file stems per slot, most wanted first. The working cue ships as an
 * m4a, which every browser including Safari decodes; the synthesized Ogg and MP3
 * stay behind it as a decoder fallback. The client declares what it can play and
 * the first stem and format both sides agree on wins, so a browser without AAC
 * still gets sound instead of a 404.
 */
const BUILTIN_STEMS = { working: ['let-me-go', 'loop'], approval: ['needs-you'] }
/**
 * Display names for the defaults that deserve one. The panel says what a default
 * actually is instead of hiding a specific track behind a generic word; a slot
 * with no name here is simply shown as the plain default.
 */
const BUILTIN_LABELS = { working: 'let me go' }

/** The store's shape when nothing has been configured yet. */
const DEFAULT_SETTINGS = {
  muted: false,
  volume: 0.35,
  playback: 'resume',
  slots: { working: { kind: 'builtin' }, approval: { kind: 'builtin' } },
}

/** What a slot's playback does when the loop starts again after a pause. */
const PLAYBACK_MODES = ['resume', 'restart']

// ---------------------------------------------------------------------------
// The durable store
// ---------------------------------------------------------------------------

/** The directory this plugin owns, under the harness home. */
function storeDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-audio-cue')
}

const uploadsDir = () => path.join(storeDir(), 'uploads')
const settingsFile = () => path.join(storeDir(), 'settings.json')
const indexFile = () => path.join(uploadsDir(), 'index.json')

/**
 * Write a file so a crash can never leave a half-written one behind: a reader
 * either sees the previous contents or the new ones, never a truncated mix.
 * @param abs - absolute path to write.
 * @param text - the full contents.
 */
function writeAtomic(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, abs)
}

/** Read and parse JSON, falling back rather than throwing on anything unreadable. */
function readJson(abs, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Coerce whatever is on disk into a valid settings object. The store is user
 * editable and survives upgrades, so every field is treated as untrusted.
 * @param raw - the parsed settings file, or anything else.
 * @returns valid settings.
 */
function normalizeSettings(raw) {
  const slots = {}
  for (const slot of SLOTS) {
    const choice = raw?.slots?.[slot]
    if (choice?.kind === 'none') slots[slot] = { kind: 'none' }
    else if (choice?.kind === 'custom' && typeof choice.id === 'string') {
      slots[slot] = { kind: 'custom', id: choice.id }
    } else slots[slot] = { kind: 'builtin' }
  }
  const volume = Number.isFinite(raw?.volume)
    ? Math.min(1, Math.max(0, raw.volume))
    : DEFAULT_SETTINGS.volume
  return {
    muted: raw?.muted === true,
    volume,
    // 'restart' rewinds the track whenever the loop starts again; 'resume' picks
    // up where it stopped. Anything unrecognised means the default.
    playback: PLAYBACK_MODES.includes(raw?.playback) ? raw.playback : DEFAULT_SETTINGS.playback,
    slots,
  }
}

/**
 * Read the upload index, dropping entries whose file is gone. The directory is
 * the authority: a hand-deleted file must not leave a slot pointing at nothing.
 * @returns the surviving index entries.
 */
function loadUploads() {
  const listed = readJson(indexFile(), [])
  if (!Array.isArray(listed)) return []
  const dir = uploadsDir()
  return listed.filter((entry) => {
    if (typeof entry?.id !== 'string' || typeof entry?.file !== 'string') return false
    if (typeof entry?.type !== 'string' || typeof entry?.name !== 'string') return false
    try {
      return fs.statSync(path.join(dir, entry.file)).isFile()
    } catch {
      return false
    }
  })
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Read a request body, refusing anything over `limit`.
 * @param req - the request to drain.
 * @param limit - largest body accepted, in bytes.
 * @returns the body bytes.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        const error = new Error(`body is larger than ${Math.floor(limit / 1024 / 1024)} MB`)
        error.status = 413
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

/** Answer with JSON. */
function respondJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Answer with a short plain-text message. */
function respondText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** The extension to store a given content type under, if it is one we accept. */
function extensionFor(type) {
  for (const [ext, mime] of Object.entries(UPLOAD_TYPES)) {
    if (mime === type) return ext
  }
  return undefined
}

/** Whether this `tool/call` payload is the model asking a person something. */
function isHumanInputCall(data) {
  if (typeof data?.name === 'string' && HUMAN_INPUT_TOOLS.has(data.name)) return true
  return Array.isArray(data?.arguments?.questions)
}

/**
 * Whether this `tool/result` answers the question that was asked. Results link
 * back to their call through the surface metadata rather than a data field, so
 * the link is read from there; a result carrying no link is treated as the
 * answer, because the alternative is a session stuck waiting forever.
 * @param event - the appended result event.
 * @param callSeq - sequence of the `tool/call` it must answer.
 */
function resultAnswersPendingAsk(event, callSeq) {
  const links = event?.sourceEventSeqs
  if (!Array.isArray(links) || links.length === 0) return true
  return links.includes(callSeq)
}

/** The extension a file name claims, if we accept it. */
function extensionForName(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return Object.hasOwn(UPLOAD_TYPES, ext) ? ext : undefined
}

/**
 * Recover the original file name from the upload header. The browser sends it
 * percent-encoded because headers are not safe for arbitrary file names.
 * @param header - the raw `x-file-name` header value.
 * @param ext - the extension the file will be stored under.
 * @returns a display name, always non-empty and bounded.
 */
function decodeFileName(header, ext) {
  let name = ''
  try {
    name = decodeURIComponent(String(header ?? ''))
  } catch {
    name = String(header ?? '')
  }
  // Control characters would corrupt the panel's rendering; the name is only
  // ever displayed, so stripping them is enough.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name === '') return `imported.${ext}`
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name
}

const name = 'dsh-audio-cue'
const inject = ['webServer']

/**
 * Register the state stream, the cue store routes, and the page injection.
 * @param ctx - registrant context carrying the injected web server.
 */
function apply(ctx) {
  /** sessionId -> { open: boolean, waiting: boolean } */
  const sessions = new Map()
  /** sessionId -> sequence of the unanswered question, when one is open. */
  const pendingAsk = new Map()
  /**
   * Live SSE responses, one per open page, each mapped to its heartbeat timer.
   * The timer is owned here rather than only cleared from the response's `close`
   * event: unmounting must not depend on the socket closing first.
   */
  const streams = new Map()
  let seq = 0
  const bootId = Math.random().toString(36).slice(2, 10)

  // The store, loaded once per activation. A broken file must not stop the
  // plugin from mounting: it falls back to defaults and the next save repairs it.
  let settings = normalizeSettings(readJson(settingsFile(), DEFAULT_SETTINGS))
  let uploads = loadUploads()
  /** Bumped by every store change, so the page can tell when to reload a cue. */
  let revision = 1

  /**
   * The full state every consumer is allowed to see. `sessions` is the
   * breakdown, because work in *any* session keeps the sound on -- so when it
   * will not stop, "which one is still working" is the first question to answer,
   * and the count alone cannot answer it.
   */
  function snapshot() {
    let working = 0
    let waiting = 0
    const open = []
    for (const [id, state] of sessions) {
      if (!state.open) continue
      working += 1
      if (state.waiting) waiting += 1
      open.push({ id: id.slice(0, 8), waiting: state.waiting })
    }
    return { bootId, seq, working, waiting, sessions: open }
  }

  /** Push the current snapshot to every open page. */
  function broadcast() {
    seq += 1
    const frame = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const res of streams.keys()) {
      try {
        res.write(frame)
      } catch {
        // The page is going away; its own close handler removes it.
      }
    }
  }

  /**
   * Fold one live session event into that session's state, then broadcast — only
   * when the state actually changed, because `assistant/chunk` fires once per
   * streamed chunk and a frame per chunk would flood every open page.
   *
   * Work in flight is inferred from two kinds of evidence. The turn boundaries
   * are authoritative. Activity that can only happen *inside* a turn — streamed
   * output, tool calls, agent steps, approval questions — opens a turn by
   * itself, which is how a host that mounted mid-turn, or missed a frame, still
   * reports the work. Only `turn/end` ever closes a session, so an activity
   * event can never leave the sound stuck on.
   *
   * Unknown event types are ignored on purpose: this plugin has to keep working
   * on harness versions that add events.
   * @param session - the session the event was appended to.
   * @param event - the appended session event.
   */
  function handleSessionEvent(session, event) {
    const id = typeof session?.id === 'string' ? session.id : 'default'
    const state = sessions.get(id)
    const open = state?.open ?? false
    const waiting = state?.waiting ?? false
    let next
    switch (event?.type) {
      case 'turn/start':
        next = { open: true, waiting: false }
        break
      case 'turn/end':
        pendingAsk.delete(id)
        next = { open: false, waiting: false }
        break
      case 'approval/asked':
        // An approval question proves work is in flight even when this host
        // never saw the turn start.
        next = { open: true, waiting: true }
        break
      case 'approval/decided':
        if (state === undefined) return
        next = { open: state.open, waiting: false }
        break
      case 'tool/call':
        if (isHumanInputCall(event.data)) {
          // The model is blocked on a person. That is what the approval cue is
          // for, so it reports the same state: the loop stops and one chime plays.
          pendingAsk.set(id, event.seq)
          next = { open: true, waiting: true }
          break
        }
        if (open && !waiting) return
        next = { open: true, waiting }
        break
      case 'tool/result':
        if (waiting && pendingAsk.has(id) && resultAnswersPendingAsk(event, pendingAsk.get(id))) {
          pendingAsk.delete(id)
          next = { open: true, waiting: false }
          break
        }
        if (open) return
        next = { open: true, waiting }
        break
      // Events that only ever occur inside a turn. `compaction/*` is
      // deliberately absent: it can run between turns, and opening on it would
      // leave a session open with no `turn/end` left to close it.
      case 'assistant/chunk':
      case 'assistant/message':
      case 'step/start':
      case 'step/end':
        if (open) return
        next = { open: true, waiting }
        break
      default:
        return
    }
    if (open === next.open && waiting === next.waiting) return
    sessions.set(id, next)
    broadcast()
  }

  const disposers = []

  disposers.push(ctx.on('session/event', handleSessionEvent))

  disposers.push(
    ctx.on('session/disposed', (session) => {
      const id = typeof session?.id === 'string' ? session.id : 'default'
      pendingAsk.delete(id)
      if (sessions.delete(id)) broadcast()
    }),
  )

  // --- store plumbing ------------------------------------------------------

  /** Find an import by id. */
  function findUpload(id) {
    return uploads.find((entry) => entry.id === id)
  }

  /** Persist the upload index. */
  function persistUploads() {
    revision += 1
    writeAtomic(
      indexFile(),
      `${JSON.stringify(uploads, null, 2)}\n`,
    )
  }

  /** Persist the settings and let the page know something changed. */
  function persistSettings() {
    revision += 1
    writeAtomic(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`)
  }

  /** Everything the panel needs to render itself, in one payload. */
  function statePayload() {
    return {
      // The page's cache key includes this: a restart can change what a slot
      // resolves to, so an answer cached by the previous process must not be
      // reused.
      boot: bootId,
      revision,
      muted: settings.muted,
      volume: settings.volume,
      playback: settings.playback,
      slots: settings.slots,
      defaultNames: BUILTIN_LABELS,
      uploads: uploads.map((entry) => ({
        id: entry.id,
        name: entry.name,
        bytes: entry.bytes,
        type: entry.type,
        addedAt: entry.addedAt,
      })),
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES, types: Object.keys(UPLOAD_TYPES) },
    }
  }

  /** The caller's format preference, most wanted first. */
  function parseTypes(url) {
    const raw = url.searchParams.get('types')
    const wanted = raw === null ? ['ogg', 'mp3'] : raw.split(',')
    const types = []
    for (const value of wanted.slice(0, 8)) {
      const type = value.trim().toLowerCase()
      if (Object.hasOwn(UPLOAD_TYPES, type) && !types.includes(type)) types.push(type)
    }
    return types
  }

  /**
   * The best built-in variant for a slot, or null when none exists.
   * @param slot - which cue.
   * @param types - the caller's preference order.
   */
  function builtinFor(slot, types) {
    for (const stem of BUILTIN_STEMS[slot]) {
      for (const type of types) {
        const file = `${stem}.${type}`
        if (Object.hasOwn(ASSETS, file) && fs.existsSync(path.join(ASSET_DIR, file))) {
          return { abs: path.join(ASSET_DIR, file), type: ASSETS[file] }
        }
      }
    }
    return null
  }

  /**
   * Write one file, or a 404 that names what is missing.
   * @param res - the HTTP response to write.
   * @param abs - absolute path of the file to send.
   * @param type - its `Content-Type`.
   */
  function sendFile(res, abs, type, cache) {
    let bytes
    try {
      bytes = fs.readFileSync(abs)
    } catch {
      respondText(res, 404, `dsh-audio-cue: missing ${path.basename(abs)}`)
      return
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      // Fresh by default: the built-in assets are files an author may replace in
      // place, and a caller that cannot prove the bytes are pinned gets no cache.
      'Cache-Control': cache ?? 'no-store',
    })
    res.end(bytes)
  }

  // --- routes --------------------------------------------------------------

  /** `GET /audio/<slot>` — resolve the slot and serve whatever it points at. */
  function handleAudio(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const slot = url.pathname.slice(`${ROUTE}/audio`.length).replace(/^\/+/, '')
    // Only a versioned request may be cached. An unversioned one could be
    // bookmarked or hand-fetched, and would then never refresh.
    const cache = url.searchParams.has('v') ? IMMUTABLE : undefined
    if (!SLOTS.includes(slot)) {
      respondText(res, 404, `dsh-audio-cue: unknown cue "${slot}"`)
      return
    }
    const choice = settings.slots[slot]
    if (choice.kind === 'none') {
      respondText(res, 404, `dsh-audio-cue: the ${slot} cue is turned off`)
      return
    }
    if (choice.kind === 'custom') {
      const entry = findUpload(choice.id)
      if (entry !== undefined) {
        sendFile(res, path.join(uploadsDir(), entry.file), entry.type, cache)
        return
      }
      // The file is gone. The store is the authority, so heal it here rather
      // than keeping a slot that can never play again.
      settings.slots[slot] = { kind: 'builtin' }
      try {
        persistSettings()
      } catch {
        // Serving the built-in matters more than recording the repair.
      }
    }
    const builtin = builtinFor(slot, parseTypes(url))
    if (builtin === null) {
      respondText(res, 404, `dsh-audio-cue: no built-in ${slot} cue`)
      return
    }
    sendFile(res, builtin.abs, builtin.type, cache)
  }

  /**
   * `GET /uploads/<id>` — serve one imported file directly. The panel needs this
   * to audition a file that is not currently selected for any cue.
   */
  function handleUploadFile(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.pathname.slice(`${ROUTE}/uploads`.length).replace(/^\/+/, '')
    const entry = findUpload(id)
    if (entry === undefined) {
      respondText(res, 404, 'dsh-audio-cue: no such import')
      return
    }
    sendFile(res, path.join(uploadsDir(), entry.file), entry.type, IMMUTABLE)
  }

  /** `GET|PUT /api/settings` — read or replace the cue configuration. */
  async function handleSettings(req, res) {
    if (req.method === 'GET') {
      respondJson(res, 200, statePayload())
      return
    }
    if (req.method !== 'PUT') {
      respondJson(res, 405, { error: 'use GET or PUT' })
      return
    }
    let body
    try {
      body = await readBody(req, MAX_SETTINGS_BYTES)
    } catch (error) {
      respondJson(res, error?.status ?? 400, { error: String(error?.message ?? error) })
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      respondJson(res, 400, { error: 'body must be JSON' })
      return
    }
    settings = normalizeSettings(parsed)
    // A custom choice whose file no longer exists would serve nothing.
    for (const slot of SLOTS) {
      const choice = settings.slots[slot]
      if (choice.kind === 'custom' && findUpload(choice.id) === undefined) {
        settings.slots[slot] = { kind: 'builtin' }
      }
    }
    try {
      persistSettings()
    } catch (error) {
      respondJson(res, 500, { error: `could not save settings: ${String(error?.message ?? error)}` })
      return
    }
    respondJson(res, 200, statePayload())
  }

  /**
   * `POST /api/uploads` — store an imported file. The body is the raw audio and
   * `x-file-name` carries the display name, so no multipart parser is needed for
   * a single-file upload. With `?slot=`, the import also becomes that cue's
   * choice, which is the only thing a user ever wants next.
   */
  async function handleUpload(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'POST') {
      respondJson(res, 405, { error: 'use POST' })
      return
    }
    const slot = url.searchParams.get('slot')
    if (slot !== null && !SLOTS.includes(slot)) {
      respondJson(res, 400, { error: `unknown cue "${slot}"` })
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      respondJson(res, 413, { error: `file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` })
      return
    }
    const displayName = String(req.headers['x-file-name'] ?? '')
    const declaredType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    // Browsers report a useful type for common formats but fall back to an
    // opaque one for the rest, so the file name is an equally good source.
    const ext = extensionFor(declaredType) ?? extensionForName(decodeFileName(req.headers['x-file-name'], 'bin'))
    if (ext === undefined) {
      respondJson(res, 415, {
        error: `unsupported audio type "${declaredType || 'unknown'}"`,
        types: Object.keys(UPLOAD_TYPES),
      })
      return
    }
    let body
    try {
      body = await readBody(req, MAX_UPLOAD_BYTES)
    } catch (error) {
      respondJson(res, error?.status ?? 400, { error: String(error?.message ?? error) })
      return
    }
    if (body.length === 0) {
      respondJson(res, 400, { error: 'empty file' })
      return
    }
    const id = randomUUID().replaceAll('-', '').slice(0, 16)
    const entry = {
      id,
      file: `${id}.${ext}`,
      name: decodeFileName(displayName, ext),
      type: UPLOAD_TYPES[ext],
      bytes: body.length,
      addedAt: Date.now(),
    }
    try {
      fs.mkdirSync(uploadsDir(), { recursive: true })
      fs.writeFileSync(path.join(uploadsDir(), entry.file), body)
      uploads.push(entry)
      persistUploads()
      if (slot !== null) {
        settings.slots[slot] = { kind: 'custom', id }
        persistSettings()
      }
    } catch (error) {
      respondJson(res, 500, { error: `could not store the file: ${String(error?.message ?? error)}` })
      return
    }
    respondJson(res, 200, statePayload())
  }

  /**
   * `DELETE /api/uploads/<id>` — forget an import, and reset any slot using it.
   * The reference is dropped deliberately: a cue that points at a deleted file
   * would otherwise be silent with no explanation.
   */
  function handleUploadDelete(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'DELETE') {
      respondJson(res, 405, { error: 'use DELETE' })
      return
    }
    const id = url.pathname.slice(`${ROUTE}/api/uploads`.length).replace(/^\/+/, '')
    const at = uploads.findIndex((entry) => entry.id === id)
    if (!/^[a-f0-9]{16}$/.test(id) || at === -1) {
      respondJson(res, 404, { error: 'no such import' })
      return
    }
    try {
      fs.unlinkSync(path.join(uploadsDir(), uploads[at].file))
    } catch {
      // Already gone; dropping the index entry is still the right answer.
    }
    uploads.splice(at, 1)
    let reset = false
    for (const slot of SLOTS) {
      const choice = settings.slots[slot]
      if (choice.kind === 'custom' && choice.id === id) {
        settings.slots[slot] = { kind: 'builtin' }
        reset = true
      }
    }
    try {
      persistUploads()
      if (reset) persistSettings()
    } catch (error) {
      respondJson(res, 500, { error: `could not update the store: ${String(error?.message ?? error)}` })
      return
    }
    respondJson(res, 200, statePayload())
  }

  // Live state: one stream per page. A full snapshot on connect, then a frame
  // per transition — so a reload can never inherit a stale "working".
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/events`,
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
        // Snapshot heartbeat. It must be a `data:` frame rather than an SSE
        // comment: EventSource fires no event for a comment, so a client can
        // only measure liveness from real frames -- and because a turn
        // transitions only at its start and end, a long turn sends no frame for
        // minutes and would look exactly like a dead host. Repeating the
        // snapshot also resynchronizes a client that missed a frame.
        const beat = setInterval(() => {
          try {
            res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
          } catch {
            // Closing; the close handler cleans up.
          }
        }, 15000)
        streams.set(res, beat)
        const drop = () => {
          clearInterval(beat)
          streams.delete(res)
        }
        req.on('close', drop)
        res.on('close', drop)
      },
    }),
  )

  // The same snapshot as plain JSON, for debugging in a browser tab or curl.
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/state.json`,
      handler: (req, res) => respondJson(res, 200, snapshot()),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      // No trailing slash. The server matches a prefix as
      // `pathname === prefix || pathname.startsWith(prefix + '/')`, so it adds
      // the separator itself: a trailing slash here would require a doubled one
      // in the request and could never match.
      path: `${ROUTE}/asset`,
      handler: (req, res) => {
        const file = path.basename(new URL(req.url ?? '/', 'http://localhost').pathname)
        const type = Object.hasOwn(ASSETS, file) ? ASSETS[file] : undefined
        if (type === undefined) {
          respondText(res, 404, 'dsh-audio-cue: unknown asset')
          return
        }
        sendFile(res, path.join(ASSET_DIR, file), type)
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/client.js`,
      handler: (req, res) => sendFile(res, CLIENT_FILE, 'application/javascript; charset=utf-8'),
    }),
  )

  // `?v=<revision>` on an audio URL is the page's cue to reload its element; the
  // routes themselves stay cache-free, so the query is only a cache buster.
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/audio`,
      handler: handleAudio,
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/uploads`,
      handler: handleUploadFile,
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/api/settings`,
      handler: handleSettings,
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/api/uploads`,
      handler: handleUpload,
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/api/uploads`,
      handler: handleUploadDelete,
    }),
  )

  // Preferred injection: a structured row in the index-injection table, which
  // the SPA dist server renders into every index response.
  disposers.push(
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script-src', placement: 'body', src: `${ROUTE}/client.js` })
    }),
  )

  // Fallback injection for a host that never renders that table. The marker
  // check is what keeps the tag from being emitted twice when both paths are
  // live — the structured row is rendered before raw taps run, so the tap sees
  // it — and the client half guards against double execution as well.
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (html.includes(`${ROUTE}/client.js`)) return html
      const tag = `<script defer src="${ROUTE}/client.js"></script>`
      return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
    }),
  )

  // Everything above belongs to this fiber's lifetime: stop or update the
  // plugin and the routes, the listeners, and every open stream go with it.
  ctx.effect(() => () => {
    for (const [res, beat] of streams) {
      clearInterval(beat)
      try {
        res.end()
      } catch {
        // Already gone.
      }
    }
    streams.clear()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already disposed by its own fiber.
      }
    }
  })
}

export { name, inject, apply }
