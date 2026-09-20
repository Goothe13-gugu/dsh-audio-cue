/**
 * Host-half smoke tests. No dependencies: the plugin mounts into a fake Cordis
 * context that records what a real one would receive, so the state machine, the
 * routes, and the asset whitelist are all exercised without a running harness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { apply, inject, name } from '../lib/index.js'

/** A stand-in for the Cordis context the plugin is mounted with. */
function fakeContext() {
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

/** Mount the plugin and hand back everything a test needs to poke at it. */
function mount() {
  const harness = fakeContext()
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
      ['exact', '/dsh-audio-cue/client.js'],
      ['exact', '/dsh-audio-cue/events'],
      ['exact', '/dsh-audio-cue/state.json'],
      ['prefix', '/dsh-audio-cue/asset'],
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

  assert.equal(routes.length, 4)
  assert.equal(cleanups.length, 1)
  cleanups[0]()

  assert.equal(routes.length, 0, 'routes are gone')
  assert.equal(taps.length, 0, 'the tap is gone')
  assert.equal(listeners.size, 0, 'listeners are gone')
  assert.equal(res.ended, true, 'the open stream is closed, not leaked')
})

test('the browser half and the host agree on routes and asset names', async () => {
  const source = await readFile(new URL('../client/audio-cue.js', import.meta.url), 'utf8')
  const { routes } = mount()

  // The two halves share no code, so the contract is a convention: whatever the
  // browser half asks for has to be something the host actually serves. This is
  // the test that catches a renamed asset or a drifted route.
  const route = /ROUTE = '([^']+)'/.exec(source)
  assert.ok(route, 'the browser half declares its route prefix')
  const prefix = route[1]
  assert.ok(
    routes.every((entry) => entry.path.startsWith(prefix)),
    `host routes do not live under ${prefix}`,
  )

  const assets = [...source.matchAll(/'\/asset\/([a-z0-9.-]+)'/g)].map((match) => match[1])
  assert.ok(assets.length >= 3, `expected the browser half to reference its assets, saw ${assets.length}`)
  for (const asset of assets) {
    const res = fakeResponse()
    routeFor(routes, `${prefix}/asset`).handler(fakeRequest(`${prefix}/asset/${asset}`), res)
    assert.equal(res.status, 200, `the browser half asks for ${asset}, which the host does not serve`)
    assert.match(res.headers['Content-Type'], /^audio\//, `${asset} is not served as audio`)
  }

  for (const endpoint of ['events', 'client.js']) {
    assert.ok(source.includes(`${prefix}/${endpoint}`) === false || routes.some((entry) => entry.path === `${prefix}/${endpoint}`))
  }
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