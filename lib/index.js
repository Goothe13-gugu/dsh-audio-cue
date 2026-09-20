/**
 * dsh-audio-cue — host half.
 *
 * This half owns the truth about "is DSH thinking or working right now" and
 * publishes it to the web GUI as a Server-Sent Events stream. The browser half
 * (`client/audio-cue.js`) is injected into the index response and only decides
 * how to turn that state into sound.
 *
 * Why the host owns it: the state lives in the session event log, which the
 * page cannot read. `session/event` fires for every live session — including
 * subagents — at append time, and the session package emits it inside
 * `append()` only, so historical events are never replayed through it. A fresh
 * host therefore starts idle, and no time-based watchdog is needed: `turn/end`
 * is appended from the agent loop's `finally` block, so an open turn always
 * closes unless the process dies — and a dead process takes this in-memory
 * state with it.
 *
 * @module dsh-audio-cue
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root: this file lives in `lib/`, so the root is one level up. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Every route this plugin owns lives under this prefix (route collisions throw). */
const ROUTE = '/dsh-audio-cue'
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client', 'audio-cue.js')
const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')

/**
 * The only files this plugin will ever serve, and their content types. A
 * whitelist rather than a directory handler: the route is a read of the network
 * surface, and an allowlist is the cheapest way to keep it exactly this small.
 */
const ASSETS = {
  'loop.ogg': 'audio/ogg',
  'loop.mp3': 'audio/mpeg',
  'needs-you.mp3': 'audio/mpeg',
  'needs-you.ogg': 'audio/ogg',
}

const name = 'dsh-audio-cue'
const inject = ['webServer']

/**
 * Register the state stream, the asset routes, and the page injection.
 * @param ctx - registrant context carrying the injected web server.
 */
function apply(ctx) {
  /** sessionId -> { open: boolean, waiting: boolean } */
  const sessions = new Map()
  /**
   * Live SSE responses, one per open page, each mapped to its heartbeat timer.
   * The timer is owned here rather than only cleared from the response's `close`
   * event: unmounting must not depend on the socket closing first.
   */
  const streams = new Map()
  let seq = 0
  const bootId = Math.random().toString(36).slice(2, 10)

  /** The full state every consumer is allowed to see. */
  function snapshot() {
    let working = 0
    let waiting = 0
    for (const state of sessions.values()) {
      if (!state.open) continue
      working += 1
      if (state.waiting) waiting += 1
    }
    return { bootId, seq, working, waiting }
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
   * Fold one live session event into that session's state, then broadcast.
   * Unknown event types are ignored on purpose: this plugin has to keep working
   * on harness versions that add events, and it needs four of them.
   * @param session - the session the event was appended to.
   * @param event - the appended session event.
   */
  function handleSessionEvent(session, event) {
    const id = typeof session?.id === 'string' ? session.id : 'default'
    const state = sessions.get(id)
    let next
    switch (event?.type) {
      case 'turn/start':
        next = { open: true, waiting: false }
        break
      case 'turn/end':
        next = { open: false, waiting: false }
        break
      case 'approval/asked':
        // Loading mid-turn means there is no `turn/start` in this host's memory;
        // an approval question still proves work is in flight.
        next = { open: state?.open ?? true, waiting: true }
        break
      case 'approval/decided':
        if (state === undefined) return
        next = { open: state.open, waiting: false }
        break
      default:
        return
    }
    sessions.set(id, next)
    broadcast()
  }

  const disposers = []

  disposers.push(ctx.on('session/event', handleSessionEvent))

  disposers.push(
    ctx.on('session/disposed', (session) => {
      const id = typeof session?.id === 'string' ? session.id : 'default'
      if (sessions.delete(id)) broadcast()
    }),
  )

  /**
   * Write one file, or a 404 that names what is missing.
   * @param res - the HTTP response to write.
   * @param abs - absolute path of the file to send.
   * @param type - its `Content-Type`.
   */
  function sendFile(res, abs, type) {
    let bytes
    try {
      bytes = fs.readFileSync(abs)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`dsh-audio-cue: missing ${path.basename(abs)}`)
      return
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      // Always fresh: the assets are the user's own files and may be replaced
      // in place while the host is running.
      'Cache-Control': 'no-store',
    })
    res.end(bytes)
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
        // Comment-only heartbeat: the page treats a silent stream as a dead
        // host and goes quiet, so this has to keep arriving.
        const beat = setInterval(() => {
          try {
            res.write(': ping\n\n')
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
      handler: (req, res) => {
        const body = JSON.stringify(snapshot())
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        })
        res.end(body)
      },
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
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('dsh-audio-cue: unknown asset')
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
