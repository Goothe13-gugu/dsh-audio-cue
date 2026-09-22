/**
 * Host-half smoke tests. No dependencies: the plugin mounts into a fake Cordis
 * context that records what a real one would receive, so the state machine, the
 * routes, and the asset whitelist are all exercised without a running harness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, inject, name } from '../lib/index.js'

/** A stand-in for the Cordis context the plugin is mounted with. */
function fakeContext(services = {}) {
  const routes = []
  const listeners = new Map()
  const taps = []
  const cleanups = []

  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(setup) {
      cleanups.push(setup())
    },
    inject(deps, callback) {
      // The real Cordis runs this when the services come and go; the tests hand
      // them over once, synchronously. When they are absent the callback never
      // fires, which is the no-registry fallback the other suites exercise.
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {}
      const provided = {}
      for (const dep of deps) provided[dep] = services[dep]
      cleanups.push(callback(provided))
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => {
          const at = taps.indexOf(transform)
          if (at !== -1) taps.splice(at, 1)
        }
      },
    },
  }

  return { ctx, routes, listeners, taps, cleanups }
}

/** A stand-in for an HTTP response, recording what would go on the wire. */
function fakeResponse() {
  const handlers = new Map()
  return {
    status: 0,
    headers: {},
    body: '',
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.body += this.chunks.join('')
      this.chunks = []
      this.ended = true
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    close() {
      const handler = handlers.get('close')
      if (handler) handler()
    },
  }
}

function fakeRequest(url, method = 'GET') {
  const handlers = new Map()
  return {
    url,
    method,
    on(event, handler) {
      handlers.set(event, handler)
    },
    close() {
      const handler = handlers.get('close')
      if (handler) handler()
    },
  }
}

function routeFor(routes, path) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route, `expected a route for ${path}`)
  return route
}

/**
 * Same, but for a path two kinds share. `/api/uploads` is deliberately both an
 * exact route (POST a file) and a prefix route (DELETE one by id), and the real
 * server resolves exact first — so a test that ignores the kind would exercise
 * the wrong handler.
 */
function routeForKind(routes, kind, path) {
  const route = routes.find((entry) => entry.kind === kind && entry.path === path)
  assert.ok(route, `expected a ${kind} route for ${path}`)
  return route
}

/** Mount the plugin and hand back everything a test needs to poke at it. */
function mount(services) {
  const harness = fakeContext(services)
  apply(harness.ctx)
  return harness
}

const snapshotOf = (res) => JSON.parse(res.body)

test('declares the plugin shape the loader reads', () => {
  assert.equal(name, 'dsh-audio-cue')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')
})

test('registers its routes and its page injection', () => {
  const { routes, taps, listeners } = mount()
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]).sort(),
    [
      ['exact', '/dsh-audio-cue/api/settings'],
      ['exact', '/dsh-audio-cue/api/uploads'],
      ['exact', '/dsh-audio-cue/client.js'],
      ['exact', '/dsh-audio-cue/events'],
      ['exact', '/dsh-audio-cue/state.json'],
      ['prefix', '/dsh-audio-cue/api/uploads'],
      ['prefix', '/dsh-audio-cue/asset'],
      ['prefix', '/dsh-audio-cue/audio'],
      ['prefix', '/dsh-audio-cue/uploads'],
    ].sort(),
  )
  assert.equal(taps.length, 1, 'the raw tap fallback is registered')
  assert.ok(listeners.has('session/event'), 'subscribes to the session event stream')
  assert.ok(listeners.has('session/disposed'), 'cleans up disposed sessions')
  assert.ok(listeners.has('webserver/index-inject'), 'contributes a structured index row')
})

test('reduces session events to the working/waiting snapshot', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (session, event) => listeners.get('session/event')(session, event)

  assert.deepEqual([read().working, read().waiting], [0, 0], 'starts idle')

  emit({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(read().working, 1, 'an open turn counts as work')

  emit({ id: 'b' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(read().working, 2, 'a second concurrent session counts too')

  emit({ id: 'a' }, { type: 'approval/asked', data: {} })
  const waiting = read()
  assert.equal(waiting.working, 2, 'waiting for approval is still work in flight')
  assert.equal(waiting.waiting, 1, 'the waiting session is reported separately')

  emit({ id: 'a' }, { type: 'approval/decided', data: {} })
  assert.equal(read().waiting, 0, 'a decision clears the waiting flag')

  emit({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  emit({ id: 'b' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(read().working, 0, 'closing every turn returns to idle')

  emit({ id: 'a' }, { type: 'something/else' })
  assert.equal(read().working, 0, 'unknown event types are ignored, never fatal')
})

test('pushes one frame per transition, and a full snapshot on connect', () => {
  const { routes, listeners } = mount()
  const events = routeFor(routes, '/dsh-audio-cue/events')
  const req = fakeRequest('/dsh-audio-cue/events')
  const res = fakeResponse()

  events.handler(req, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /text\/event-stream/)
  const opening = res.chunks.shift()
  assert.equal(JSON.parse(opening.replace('data: ', '')).working, 0, 'connecting yields a snapshot')

  listeners.get('session/event')({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(res.chunks.length, 1, 'a transition yields exactly one frame')
  assert.equal(JSON.parse(res.chunks[0].replace('data: ', '')).working, 1)

  listeners.get('session/disposed')({ id: 'a' })
  assert.equal(JSON.parse(res.chunks[1].replace('data: ', '')).working, 0, 'disposal clears the session')

  res.close() // clears the heartbeat, so the test process can exit
})

test('serves whitelisted assets and refuses everything else', () => {
  const { routes } = mount()
  const assets = routeFor(routes, '/dsh-audio-cue/asset')

  const ogg = fakeResponse()
  assets.handler(fakeRequest('/dsh-audio-cue/asset/loop.ogg'), ogg)
  assert.equal(ogg.status, 200)
  assert.equal(ogg.headers['Content-Type'], 'audio/ogg')
  assert.ok(Number(ogg.headers['Content-Length']) > 1000, 'sends the real file')

  const chime = fakeResponse()
  assets.handler(fakeRequest('/dsh-audio-cue/asset/needs-you.mp3'), chime)
  assert.equal(chime.headers['Content-Type'], 'audio/mpeg')

  for (const path of ['/dsh-audio-cue/asset/secret.txt', '/dsh-audio-cue/asset/..%2Fpackage.json']) {
    const denied = fakeResponse()
    assets.handler(fakeRequest(path), denied)
    assert.equal(denied.status, 404, `${path} is not served`)
  }
})

test('serves the browser half', () => {
  const { routes } = mount()
  const res = fakeResponse()
  routeFor(routes, '/dsh-audio-cue/client.js').handler(fakeRequest('/dsh-audio-cue/client.js'), res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /javascript/)
  assert.match(res.body, /__DSH_AUDIO_CUE__/)
})

test('injects the script exactly once across both injection paths', () => {
  const { listeners, taps } = mount()
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.deepEqual(table, [{ kind: 'script-src', placement: 'body', src: '/dsh-audio-cue/client.js' }])

  const tap = taps[0]
  const rendered = '<html><body><script src="/dsh-audio-cue/client.js"></script></body></html>'
  assert.equal(tap(rendered), rendered, 'the row already rendered, so the tap adds nothing')

  const bare = '<html><body><div id="app"></div></body></html>'
  const tapped = tap(bare)
  assert.match(tapped, /<script defer src="\/dsh-audio-cue\/client\.js"><\/script><\/body>/)
  assert.equal(tap(tapped), tapped, 'the tap is idempotent')
})

test('unmounting releases every route, listener, and open stream', () => {
  const { routes, listeners, taps, cleanups } = mount()
  const events = routeFor(routes, '/dsh-audio-cue/events')
  const res = fakeResponse()
  events.handler(fakeRequest('/dsh-audio-cue/events'), res)

  assert.equal(routes.length, 9)
  assert.equal(cleanups.length, 1)
  cleanups[0]()

  assert.equal(routes.length, 0, 'routes are gone')
  assert.equal(taps.length, 0, 'the tap is gone')
  assert.equal(listeners.size, 0, 'listeners are gone')
  assert.equal(res.ended, true, 'the open stream is closed, not leaked')
})

test('the browser half and the host agree on the store contract', async () => {
  const source = await readFile(new URL('../client/audio-cue.js', import.meta.url), 'utf8')

  // The two halves share no code, so every path and format is a convention. This
  // is the test that catches a drifted route, a renamed fallback asset, or a
  // format the browser would prefer and the host would refuse.
  const prefix = /ROUTE = '([^']+)'/.exec(source)?.[1]
  assert.ok(prefix, 'the browser half declares its route prefix')

  await withStore(async () => {
    const { routes } = mount()
    assert.ok(
      routes.every((entry) => entry.path.startsWith(prefix)),
      `host routes do not live under ${prefix}`,
    )

    for (const required of [
      `${prefix}/api/settings`,
      `${prefix}/api/uploads`,
      `${prefix}/audio`,
      `${prefix}/uploads`,
      `${prefix}/events`,
      `${prefix}/client.js`,
    ]) {
      assert.ok(
        routes.some((entry) => entry.path === required),
        `the browser half needs ${required}, which the host does not register`,
      )
    }

    // The sources used when the store API is unavailable must still be real
    // files, or a host/client version mismatch would mean silence.
    const assets = [...source.matchAll(/'\/asset\/([a-z0-9.-]+)'/g)].map((match) => match[1])
    assert.ok(assets.length >= 2, `expected fallback assets, saw ${assets.length}`)
    for (const asset of assets) {
      const res = fakeResponse()
      routeFor(routes, `${prefix}/asset`).handler(fakeRequest(`${prefix}/asset/${asset}`), res)
      assert.equal(res.status, 200, `the browser half falls back to ${asset}, which the host does not serve`)
      assert.match(res.headers['Content-Type'], /^audio\//, `${asset} is not served as audio`)
    }

    // Every format the browser might ask for has to be one the host accepts.
    const order = /var order = \[([^\]]+)\]/.exec(source)
    assert.ok(order, 'the browser half declares its format preference order')
    const preferred = [...order[1].matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1])
    assert.ok(preferred.length >= 3, `expected a preference list, saw ${preferred.length}`)

    const res = fakeResponse()
    await routeFor(routes, `${prefix}/api/settings`).handler(fakeRequest(`${prefix}/api/settings`), res)
    const accepted = JSON.parse(res.body).limits.types
    for (const type of preferred) {
      assert.ok(accepted.includes(type), `the browser prefers ${type}, which the host would refuse`)
    }

    // The host caches audio for a year, so the URL has to carry the boot id: a
    // restart can change what a slot resolves to, and a stale answer would
    // otherwise be served for the rest of that year.
    assert.ok(source.includes('settings.boot'), 'the audio URL must carry the host boot id')
  })
})

test('prefix routes survive the matcher the server actually uses', () => {
  // The regression this guards: a prefix registered with a trailing slash never
  // matches a real request, because the server compares against `prefix + '/'`.
  // Calling a handler directly (as the other tests do) cannot see that, so this
  // test reproduces the server's matching rule instead.
  const { routes } = mount()
  const match = (pathname) => {
    const exact = routes.find((entry) => entry.kind === 'exact' && entry.path === pathname)
    if (exact !== undefined) return exact
    let best
    for (const entry of routes) {
      if (entry.kind !== 'prefix') continue
      if (pathname !== entry.path && !pathname.startsWith(`${entry.path}/`)) continue
      if (best === undefined || entry.path.length > best.path.length) best = entry
    }
    return best
  }

  for (const pathname of [
    '/dsh-audio-cue/asset/loop.ogg',
    '/dsh-audio-cue/asset/loop.mp3',
    '/dsh-audio-cue/asset/needs-you.mp3',
  ]) {
    const entry = match(pathname)
    assert.ok(entry, `${pathname} matches no route at all`)
    assert.ok(
      !entry.path.endsWith('/'),
      `prefix ${entry.path} ends with a slash, so the real matcher can never select it`,
    )
  }

  assert.equal(match('/dsh-audio-cue/asset')?.path, '/dsh-audio-cue/asset')
  assert.equal(match('/dsh-audio-cue/state.json')?.kind, 'exact')
  assert.equal(match('/dsh-audio-cue/nope'), undefined, 'nothing claims an unknown path')
})
test('the keepalive is a data frame, not an SSE comment', () => {
  // The regression: a comment keepalive fires no EventSource event, so the
  // browser half measured liveness from frames that a long turn never sends and
  // silenced itself mid-turn. The heartbeat has to carry the snapshot.
  const { routes } = mount()
  const realSetInterval = globalThis.setInterval
  const beats = []
  globalThis.setInterval = (fn, ms) => {
    beats.push({ fn, ms })
    return 0
  }
  const res = fakeResponse()
  try {
    routeFor(routes, '/dsh-audio-cue/events').handler(fakeRequest('/dsh-audio-cue/events'), res)
    assert.equal(beats.length, 1, 'the stream owns exactly one timer')
    assert.ok(beats[0].ms > 0 && beats[0].ms <= 30000, 'and it beats often enough to matter')
    res.chunks.length = 0
    beats[0].fn()
    const frame = res.chunks[0]
    assert.ok(
      typeof frame === 'string' && frame.startsWith('data: '),
      `the keepalive must be a data frame, got ${JSON.stringify(frame)}`,
    )
    assert.equal(JSON.parse(frame.slice(6)).working, 0)
  } finally {
    globalThis.setInterval = realSetInterval
    res.close()
  }
})
test('activity opens a turn this host never saw start', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (session, event) => listeners.get('session/event')(session, event)

  // The host mounted mid-turn: `turn/start` happened in a previous process.
  assert.equal(read().working, 0, 'starts idle')
  emit({ id: 'a' }, { type: 'assistant/chunk', data: {} })
  assert.equal(read().working, 1, 'streamed output proves a turn is in flight')

  emit({ id: 'a' }, { type: 'tool/call', data: {} })
  emit({ id: 'a' }, { type: 'step/start', data: {} })
  assert.equal(read().working, 1, 'further activity does not double-count')

  emit({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(read().working, 0, 'only turn/end closes a session')

  // An event that can occur between turns must not open one.
  emit({ id: 'b' }, { type: 'compaction/start', data: {} })
  assert.equal(read().working, 0, 'compaction between turns leaves the sound off')
})

test('activity does not flood the stream', () => {
  const { routes, listeners } = mount()
  const res = fakeResponse()
  routeFor(routes, '/dsh-audio-cue/events').handler(fakeRequest('/dsh-audio-cue/events'), res)
  res.chunks.length = 0

  const emit = (session, event) => listeners.get('session/event')(session, event)
  emit({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(res.chunks.length, 1, 'the transition itself is one frame')

  for (let i = 0; i < 500; i += 1) emit({ id: 'a' }, { type: 'assistant/chunk', data: { i } })
  assert.equal(res.chunks.length, 1, '500 chunks of an already-open turn add no frames')

  emit({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(res.chunks.length, 2, 'closing is one more frame')
  res.close()
})
/** Mount the plugin against a throwaway store, then clean it up. */
async function withStore(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-audio-cue-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
}

/** A request that actually delivers a body, the way the webserver would. */
function bodyRequest(url, method, headers, body) {
  const handlers = new Map()
  const req = {
    url,
    method,
    headers,
    on(event, handler) {
      handlers.set(event, handler)
      // Registered in the order `readBody` uses, and delivered on a microtask so
      // both listeners exist before either fires.
      if (event === 'data') queueMicrotask(() => handler(body))
      if (event === 'end') queueMicrotask(() => handler())
      return req
    },
    destroy() {},
    close() {},
  }
  return req
}

async function readState(routes, path = '/dsh-audio-cue/api/settings') {
  const res = fakeResponse()
  await routeFor(routes, path).handler(fakeRequest(path), res)
  return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
}

test('reports defaults when nothing has been configured', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const { status, payload } = await readState(routes)
    assert.equal(status, 200)
    assert.equal(payload.muted, false, 'sound is on out of the box')
    assert.equal(payload.volume, 0.35)
    assert.deepEqual(payload.slots, {
      working: { kind: 'builtin', id: 'let-me-go' },
      approval: { kind: 'builtin', id: 'needs-you' },
    })
    assert.deepEqual(payload.uploads, [])
    assert.ok(payload.limits.maxUploadBytes > 0)
    assert.ok(payload.limits.types.includes('mp3'))
  })
})

test('persists a settings change for the next mount to read', async () => {
  await withStore(async () => {
    const first = mount()
    const put = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({
        muted: true,
        volume: 0.8,
        slots: { working: { kind: 'none' }, approval: { kind: 'builtin' } },
      })),
    )
    const res = fakeResponse()
    await routeFor(first.routes, '/dsh-audio-cue/api/settings').handler(put, res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).volume, 0.8)

    // A second mount reads the same store: that is what durable has to mean, and
    // it is also what makes the settings survive a browser cache wipe.
    const second = mount()
    const { payload } = await readState(second.routes)
    assert.equal(payload.muted, true)
    assert.equal(payload.volume, 0.8)
    assert.equal(payload.slots.working.kind, 'none')
  })
})

test('an unreadable store falls back instead of failing to mount', async () => {
  await withStore(async (home) => {
    mkdirSync(path.join(home, 'dsh-audio-cue'), { recursive: true })
    writeFileSync(path.join(home, 'dsh-audio-cue', 'settings.json'), '{ this is not json')
    const { routes } = mount()
    const { status, payload } = await readState(routes)
    assert.equal(status, 200, 'a corrupt file must not stop the plugin')
    assert.equal(payload.volume, 0.35, 'defaults are used instead')
  })
})

test('stores an import, selects it, and serves it back byte for byte', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const audio = Buffer.from('ID3fake-mp3-payload')
    const res = fakeResponse()
    await routeForKind(routes, 'exact', '/dsh-audio-cue/api/uploads').handler(
      bodyRequest(
        '/dsh-audio-cue/api/uploads?slot=working',
        'POST',
        {
          'content-type': 'audio/mpeg',
          'content-length': String(audio.length),
          'x-file-name': encodeURIComponent('my loop.mp3'),
        },
        audio,
      ),
      res,
    )
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.uploads.length, 1)
    assert.equal(payload.uploads[0].name, 'my loop.mp3')
    assert.equal(payload.uploads[0].bytes, audio.length)
    assert.equal(payload.slots.working.kind, 'custom', 'importing for a cue selects it')
    assert.equal(payload.slots.working.id, payload.uploads[0].id)

    // The cue resolves through the slot, not through the client.
    const served = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/working'), served)
    assert.equal(served.status, 200)
    assert.equal(served.headers['Content-Type'], 'audio/mpeg')
    assert.equal(served.body, audio.toString())

    // And the file itself is reachable for the panel's previews.
    const direct = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/uploads').handler(
      fakeRequest(`/dsh-audio-cue/uploads/${payload.uploads[0].id}`),
      direct,
    )
    assert.equal(direct.status, 200)
    assert.equal(direct.body, audio.toString())
  })
})

test('refuses an import that is not audio, or is too large', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const route = routeForKind(routes, 'exact', '/dsh-audio-cue/api/uploads')

    const wrongType = fakeResponse()
    await route.handler(
      bodyRequest('/dsh-audio-cue/api/uploads', 'POST', { 'content-type': 'application/pdf', 'x-file-name': 'x.pdf' }, Buffer.from('%PDF')),
      wrongType,
    )
    assert.equal(wrongType.status, 415)

    const tooBig = fakeResponse()
    await route.handler(
      bodyRequest('/dsh-audio-cue/api/uploads', 'POST', { 'content-type': 'audio/mpeg', 'content-length': String(9 * 1024 * 1024) }, Buffer.from('x')),
      tooBig,
    )
    assert.equal(tooBig.status, 413)

    // The file name is the fallback when the browser reports an opaque type,
    // which it does for several perfectly valid audio formats.
    const byName = fakeResponse()
    await route.handler(
      bodyRequest('/dsh-audio-cue/api/uploads', 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': 'loop.ogg' }, Buffer.from('OggS-data')),
      byName,
    )
    assert.equal(byName.status, 200)
    assert.equal(JSON.parse(byName.body).uploads[0].type, 'audio/ogg')
  })
})

test('deleting an import drops it and resets every cue that used it', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const up = fakeResponse()
    await routeForKind(routes, 'exact', '/dsh-audio-cue/api/uploads').handler(
      bodyRequest(
        '/dsh-audio-cue/api/uploads?slot=approval',
        'POST',
        { 'content-type': 'audio/ogg', 'x-file-name': 'chime.ogg' },
        Buffer.from('OggS-data'),
      ),
      up,
    )
    const id = JSON.parse(up.body).uploads[0].id

    const del = fakeResponse()
    await routeForKind(routes, 'prefix', '/dsh-audio-cue/api/uploads').handler(
      fakeRequest(`/dsh-audio-cue/api/uploads/${id}`, 'DELETE'),
      del,
    )
    assert.equal(del.status, 200)
    const payload = JSON.parse(del.body)
    assert.deepEqual(payload.uploads, [])
    assert.equal(payload.slots.approval.kind, 'builtin', 'the cue falls back instead of pointing at nothing')

    const gone = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/uploads').handler(fakeRequest(`/dsh-audio-cue/uploads/${id}`), gone)
    assert.equal(gone.status, 404)
  })
})

test('a cue set to none answers 404 rather than silence with no reason', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const put = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({
        muted: false,
        volume: 0.5,
        slots: { working: { kind: 'none' }, approval: { kind: 'builtin' } },
      })),
    )
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(put, fakeResponse())

    const off = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/working'), off)
    assert.equal(off.status, 404)
    assert.match(off.body, /turned off/)

    const on = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/approval?types=mp3'), on)
    assert.equal(on.status, 200)
    assert.equal(on.headers['Content-Type'], 'audio/mpeg')
  })
})
test('caches only what the URL pins, and never an unversioned answer', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const audio = routeFor(routes, '/dsh-audio-cue/audio')

    const bare = fakeResponse()
    audio.handler(fakeRequest('/dsh-audio-cue/audio/working'), bare)
    assert.match(bare.headers['Cache-Control'], /no-store/, 'an unversioned request must not be cached')

    const pinned = fakeResponse()
    audio.handler(fakeRequest('/dsh-audio-cue/audio/working?v=boot-builtin-'), pinned)
    assert.match(pinned.headers['Cache-Control'], /immutable/, 'a versioned request may be cached for a year')

    // An upload's id is never reused, so its bytes are pinned by construction.
    const up = fakeResponse()
    await routeForKind(routes, 'exact', '/dsh-audio-cue/api/uploads').handler(
      bodyRequest('/dsh-audio-cue/api/uploads', 'POST', { 'content-type': 'audio/ogg', 'x-file-name': 'x.ogg' }, Buffer.from('OggS')),
      up,
    )
    const id = JSON.parse(up.body).uploads[0].id

    const file = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/uploads').handler(fakeRequest(`/dsh-audio-cue/uploads/${id}`), file)
    assert.match(file.headers['Cache-Control'], /immutable/)

    const custom = fakeResponse()
    audio.handler(fakeRequest(`/dsh-audio-cue/audio/working?v=boot-custom-${id}`), custom)
    assert.match(custom.headers['Cache-Control'], /immutable/)

    // The built-in assets stay uncached: an author may replace one in place.
    const asset = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/asset').handler(fakeRequest('/dsh-audio-cue/asset/loop.ogg'), asset)
    assert.match(asset.headers['Cache-Control'], /no-store/)

    // The page cannot build a version token without the boot id.
    const { payload } = await readState(routes)
    assert.equal(typeof payload.boot, 'string')
    assert.ok(payload.boot.length > 0)
  })
})
test('the working cue ships as the bundled track, with a decoder fallback behind it', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const audio = routeFor(routes, '/dsh-audio-cue/audio')

    // A browser that decodes AAC gets the shipped track.
    const modern = fakeResponse()
    audio.handler(fakeRequest('/dsh-audio-cue/audio/working?types=ogg,mp3,wav,m4a'), modern)
    assert.equal(modern.status, 200)
    assert.equal(modern.headers['Content-Type'], 'audio/mp4')
    assert.ok(modern.body.length > 100000, `expected the real track, got ${modern.body.length} bytes`)

    // One that cannot still gets sound instead of a 404.
    const legacy = fakeResponse()
    audio.handler(fakeRequest('/dsh-audio-cue/audio/working?types=ogg,mp3'), legacy)
    assert.equal(legacy.status, 200)
    assert.equal(legacy.headers['Content-Type'], 'audio/ogg')

    // The approval cue is untouched by any of this.
    const chime = fakeResponse()
    audio.handler(fakeRequest('/dsh-audio-cue/audio/approval?types=mp3'), chime)
    assert.equal(chime.headers['Content-Type'], 'audio/mpeg')
  })
})

test('a question to a person is a wait state, exactly like an approval', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (event) => listeners.get('session/event')({ id: 'a' }, event)

  emit({ type: 'turn/start', data: { turn: 1 } })
  assert.deepEqual([read().working, read().waiting], [1, 0])

  emit({
    type: 'tool/call',
    seq: 42,
    data: { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: { questions: [{ id: 'q1' }] } },
  })
  assert.equal(read().waiting, 1, 'the model is blocked on a person')
  assert.equal(read().working, 1, 'and the turn is still open')

  // A result belonging to a different call must not be mistaken for the answer.
  emit({ type: 'tool/result', seq: 43, sourceEventSeqs: [7], data: { turn: 1, step: 1, message: {} } })
  assert.equal(read().waiting, 1, 'an unrelated tool result does not answer the question')

  emit({ type: 'tool/result', seq: 44, sourceEventSeqs: [42], data: { turn: 1, step: 1, message: {} } })
  assert.equal(read().waiting, 0, 'the answer resumes the work')
  assert.equal(read().working, 1)
})

test('an ordinary tool call is work, not a question', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (event) => listeners.get('session/event')({ id: 'a' }, event)

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: { command: 'ls' } } })
  assert.equal(read().waiting, 0, 'running a tool is not waiting for a person')

  // A renamed ask tool still counts, because its arguments carry the questions.
  emit({
    type: 'tool/call',
    seq: 2,
    data: { turn: 1, step: 1, callId: 'c2', name: 'ask_something_else', arguments: { questions: [{ id: 'q' }] } },
  })
  assert.equal(read().waiting, 1, 'the shape of the request is enough to recognise it')
})

test('ending the turn clears a question that was never answered', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (event) => listeners.get('session/event')({ id: 'a' }, event)

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'c', name: 'ask_user_question', arguments: {} } })
  assert.equal(read().waiting, 1)
  emit({ type: 'turn/end', data: { turn: 1, reason: 'cancelled' } })
  assert.deepEqual([read().working, read().waiting], [0, 0], 'a cancelled turn leaves nothing pending')
})
test('every shipped cue is listed, and the synthesized pad is a real choice', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const { payload } = await readState(routes)
    assert.deepEqual(
      payload.cues.working.map((cue) => cue.name),
      ['let me go', 'let me go SSR', '底噪'],
      'every shipped working cue is offered, default first',
    )
    assert.deepEqual(payload.cues.approval.map((cue) => cue.id), ['needs-you'])

    // Choosing the pad serves the synthesized file, not the track.
    const choosePad = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ slots: { working: { kind: 'builtin', id: 'loop' } } })),
    )
    const saved = fakeResponse()
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(choosePad, saved)
    assert.deepEqual(JSON.parse(saved.body).slots.working, { kind: 'builtin', id: 'loop' })

    const pad = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/working?types=ogg,mp3,m4a'), pad)
    assert.equal(pad.status, 200)
    assert.equal(pad.headers['Content-Type'], 'audio/ogg', 'the chosen cue wins over the other one')
    assert.ok(pad.body.length < 100000, `that is the short pad, not the track (${pad.body.length} bytes)`)

    // With the track chosen, a browser that cannot decode AAC still gets the pad.
    const chooseTrack = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ slots: { working: { kind: 'builtin', id: 'let-me-go' } } })),
    )
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(chooseTrack, fakeResponse())

    const modern = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/working?types=ogg,mp3,m4a'), modern)
    assert.equal(modern.headers['Content-Type'], 'audio/mp4')

    const noAac = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest('/dsh-audio-cue/audio/working?types=ogg,mp3'), noAac)
    assert.equal(noAac.headers['Content-Type'], 'audio/ogg', 'no AAC support degrades to the shipped pad')

    // A cue id that was never shipped heals to the slot default.
    const bogus = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ slots: { working: { kind: 'builtin', id: 'never-shipped' } } })),
    )
    const healed = fakeResponse()
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(bogus, healed)
    assert.deepEqual(JSON.parse(healed.body).slots.working, { kind: 'builtin', id: 'let-me-go' })
  })
})
test('the playback mode defaults to resuming, and restarting is remembered', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const before = await readState(routes)
    assert.equal(before.payload.playback, 'resume', 'out of the box the track picks up where it stopped')

    const put = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({
        muted: false,
        volume: 0.5,
        playback: 'restart',
        slots: { working: { kind: 'builtin' }, approval: { kind: 'builtin' } },
      })),
    )
    const saved = fakeResponse()
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(put, saved)
    assert.equal(JSON.parse(saved.body).playback, 'restart')

    // It has to survive a host restart, like every other setting.
    const second = mount()
    const after = await readState(second.routes)
    assert.equal(after.payload.playback, 'restart')

    // Nonsense falls back rather than being stored.
    const bogus = bodyRequest(
      '/dsh-audio-cue/api/settings',
      'PUT',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ playback: 'sideways' })),
    )
    const healed = fakeResponse()
    await routeFor(routes, '/dsh-audio-cue/api/settings').handler(bogus, healed)
    assert.equal(JSON.parse(healed.body).playback, 'resume')
  })
})
test('the snapshot names which sessions are keeping the sound on', () => {
  const { routes, listeners } = mount()
  const read = () => {
    const res = fakeResponse()
    routeFor(routes, '/dsh-audio-cue/state.json').handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (session, event) => listeners.get('session/event')(session, event)

  emit({ id: 'session-aaaa1111bbbb' }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: 'session-cccc2222dddd' }, { type: 'turn/start', data: { turn: 1 } })
  const both = read()
  assert.equal(both.working, 2)
  assert.equal(both.sessions.length, 2, 'both open sessions are named')
  assert.ok(both.sessions.every((entry) => entry.id.length === 8), 'and the ids are shortened')

  emit({ id: 'session-aaaa1111bbbb' }, { type: 'approval/asked', data: {} })
  assert.equal(read().sessions.filter((entry) => entry.waiting).length, 1, 'the waiting one is marked')

  emit({ id: 'session-aaaa1111bbbb' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(read().sessions.length, 1, 'a closed session drops out of the list')

  emit({ id: 'session-cccc2222dddd' }, { type: 'turn/end', data: { turn: 1 } })
  assert.deepEqual(read().sessions, [])
  assert.equal(read().working, 0)
})
test('the SSR clip is its own cue, and everything decodable ends at the pad', async () => {
  await withStore(async () => {
    const { routes } = mount()
    const choose = async (id) => {
      const put = bodyRequest(
        '/dsh-audio-cue/api/settings',
        'PUT',
        { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ slots: { working: { kind: 'builtin', id } } })),
      )
      await routeFor(routes, '/dsh-audio-cue/api/settings').handler(put, fakeResponse())
    }
    const serve = (types) => {
      const res = fakeResponse()
      routeFor(routes, '/dsh-audio-cue/audio').handler(fakeRequest(`/dsh-audio-cue/audio/working?types=${types}`), res)
      return res
    }

    await choose('let-me-go-ssr')
    const clip = serve('ogg,mp3,m4a')
    await choose('let-me-go')
    const track = serve('ogg,mp3,m4a')

    assert.equal(clip.status, 200)
    assert.equal(clip.headers['Content-Type'], 'audio/mp4')
    assert.equal(track.headers['Content-Type'], 'audio/mp4')
    assert.ok(
      clip.body.length < track.body.length / 4,
      `the clip must be far shorter than the full track (${clip.body.length} vs ${track.body.length})`,
    )

    // A browser that cannot decode AAC gets the pad, not a 404 and not the other
    // track: the pad is the only cue that ships in two formats.
    await choose('let-me-go-ssr')
    const noAac = serve('ogg,mp3')
    assert.equal(noAac.headers['Content-Type'], 'audio/ogg')
    assert.ok(noAac.body.length < clip.body.length, 'and it is the short synthesized pad')
  })
})
/** A stand-in for the agent registry, whose status the plugin treats as authoritative. */
function fakeAgents(statuses = {}) {
  const store = new Map(Object.entries(statuses))
  return {
    get(id) {
      const status = store.get(id)
      return status === undefined ? undefined : { id, status }
    },
    set(id, status) {
      store.set(id, status)
    },
    list() {
      return [...store].map(([id, status]) => ({ id, status }))
    },
  }
}

test('a turn the harness abandons stops the sound, even with no turn/end', () => {
  const realSetInterval = globalThis.setInterval
  const timers = []
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms })
    return 0
  }
  try {
    const registry = fakeAgents()
    const { routes, listeners } = mount({ agents: registry })
    const state = routeFor(routes, '/dsh-audio-cue/state.json')
    const read = () => {
      const res = fakeResponse()
      state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
      return snapshotOf(res)
    }
    const emit = (session, event) => listeners.get('session/event')(session, event)

    registry.set('a', 'running')
    emit({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
    assert.equal(read().working, 1, 'work in flight')

    // The observed harness behaviour: the user interrupts, no `turn/end` is ever
    // appended, and the agent simply goes idle.
    registry.set('a', 'idle')
    assert.equal(read().working, 0, 'the registry decides, so the sound stops')
    assert.deepEqual(read().sessions, [])

    // No event announced that, so the poll has to publish it.
    const before = read().seq
    for (const timer of timers) timer.fn()
    const afterFirst = read().seq
    assert.ok(afterFirst > before, 'the poll publishes a change no event announced')

    // And a poll with nothing to say stays quiet: the sequence number it bumps
    // must not read as a change to itself.
    for (const timer of timers) timer.fn()
    assert.equal(read().seq, afterFirst, 'a poll with no change must not broadcast')
  } finally {
    globalThis.setInterval = realSetInterval
  }
})

test('without a registry, turn boundaries still decide', () => {
  const { routes, listeners } = mount()
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (session, event) => listeners.get('session/event')(session, event)

  emit({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(read().working, 1)
  emit({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(read().working, 0, 'turn/end is the fallback signal')
})

test('a session the registry does not know keeps its event-derived state', () => {
  const registry = fakeAgents()
  const { routes, listeners } = mount({ agents: registry })
  const state = routeFor(routes, '/dsh-audio-cue/state.json')
  const read = () => {
    const res = fakeResponse()
    state.handler(fakeRequest('/dsh-audio-cue/state.json'), res)
    return snapshotOf(res)
  }
  const emit = (session, event) => listeners.get('session/event')(session, event)

  // A session restored from disk may have no live agent yet: fall back rather
  // than report silence while something is genuinely running.
  emit({ id: 'restored' }, { type: 'assistant/chunk', data: {} })
  assert.equal(read().working, 1, 'the fallback still counts it')
})