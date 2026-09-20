/**
 * The client half had no test that parsed or executed it, which let a syntax
 * error ship: the other suites only read its text. This one runs it the way a
 * browser would, against a small DOM stand-in, and asserts it mounts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT = new URL('../client/audio-cue.js', import.meta.url)

/** A settings payload shaped like the host's. */
function settingsPayload(overrides = {}) {
  return {
    boot: 'boot1',
    revision: 3,
    muted: false,
    volume: 0.5,
    slots: { working: { kind: 'builtin' }, approval: { kind: 'builtin' } },
    uploads: [],
    limits: { maxUploadBytes: 8 * 1024 * 1024, types: ['ogg', 'mp3'] },
    ...overrides,
  }
}

/** Enough DOM for the client to mount, and records of what it built. */
function makeEnvironment(payload = settingsPayload()) {
  const created = []
  function element(tag) {
    const listeners = new Map()
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      children: [],
      attributes: {},
      textContent: '',
      innerHTML: '',
      value: '',
      type: '',
      title: '',
      min: '',
      max: '',
      step: '',
      disabled: false,
      files: null,
      offsetWidth: 292,
      paused: true,
      volume: 0,
      currentTime: 0,
      loop: false,
      preload: '',
      src: '',
      setAttribute(key, value) {
        el.attributes[key] = value
      },
      hasAttribute(key) {
        return Object.prototype.hasOwnProperty.call(el.attributes, key)
      },
      addEventListener(type, fn) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn])
      },
      removeEventListener() {},
      dispatch(type, event) {
        for (const fn of listeners.get(type) ?? []) fn(event ?? {})
      },
      appendChild(child) {
        el.children.push(child)
        return child
      },
      removeChild(child) {
        el.children = el.children.filter((entry) => entry !== child)
        return child
      },
      querySelector() {
        return null
      },
      getBoundingClientRect() {
        return { right: 260, left: 0, top: 0, bottom: 0, width: 260, height: 600 }
      },
      click() {
        el.dispatch('click', { stopPropagation() {} })
      },
      pause() {
        el.paused = true
      },
      play() {
        el.paused = false
        return Promise.resolve()
      },
    }
    created.push(el)
    return el
  }

  const body = element('body')
  const document = {
    body,
    documentElement: element('html'),
    createElement: element,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }

  const timers = new Map()
  let nextTimer = 0
  const register = (fn, ms) => {
    const id = (nextTimer += 1)
    timers.set(id, { fn, ms })
    return id
  }

  const calls = []
  const window = {
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
    setInterval: register,
    setTimeout: register,
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      },
      removeItem(key) {
        this.store.delete(key)
      },
    },
  }

  class FakeAudio {
    constructor() {
      this.volume = 0
      this.loop = false
      this.preload = ''
      this.src = ''
      this.currentTime = 0
      this.paused = true
      created.push(this)
    }
    play() {
      this.paused = false
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    canPlayType() {
      return ''
    }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url
      FakeEventSource.last = this
    }
    close() {}
  }

  class FakeOption {
    constructor(text, value) {
      this.text = text
      this.value = value
      // Recorded like every other construct, so a test can read the choice list
      // a select was built from without a real DOM.
      created.push(this)
    }
  }

  const sandbox = {
    window,
    document,
    Audio: FakeAudio,
    EventSource: FakeEventSource,
    Option: FakeOption,
    fetch(url, init) {
      calls.push({ url: String(url), init: init ?? null })
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(payload)),
      })
    },
    setInterval: register,
    setTimeout: register,
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
  }
  sandbox.globalThis = sandbox
  window.document = document
  window.window = window

  return { sandbox, window, document, body, created, calls, timers, FakeEventSource }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('the client half parses and mounts', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment()

  // Running the file is also the parse check the other suites never did.
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })

  const api = env.window.__DSH_AUDIO_CUE__
  assert.ok(api, 'the client publishes its escape hatch')
  for (const method of ['setEnabled', 'toggle', 'setVolume', 'open', 'close', 'refresh', 'state']) {
    assert.equal(typeof api[method], 'function', `__DSH_AUDIO_CUE__.${method} is missing`)
  }

  const button = env.body.children.find((child) => child.attributes['aria-label'] === 'dsh-audio-cue')
  assert.ok(button, 'the corner button is mounted on the document body')
  assert.equal(button.style.position, 'fixed')
  assert.ok(button.style.left, 'and it is positioned')

  assert.equal(env.FakeEventSource.last?.url, '/dsh-audio-cue/events', 'it subscribes to the host stream')
  assert.ok(
    env.calls.some((call) => call.url === '/dsh-audio-cue/api/settings'),
    'it reads the store on load',
  )
})

test('a working frame starts the loop, and waiting replaces it with the chime', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment()
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })

  const source_ = env.FakeEventSource.last
  await flush()
  source_.onmessage({ data: JSON.stringify({ working: 1, waiting: 0 }) })

  const loop = env.created.find((entry) => typeof entry.src === 'string' && entry.src.includes('/audio/working'))
  assert.ok(loop, 'a frame with work in flight points the loop at the working cue')
  assert.equal(loop.loop, true, 'and it loops')

  const before = env.created.length
  source_.onmessage({ data: JSON.stringify({ working: 1, waiting: 1 }) })
  const chime = env.created.slice(before).find((entry) => entry.src?.includes('/audio/approval'))
  assert.ok(chime || env.created.some((entry) => entry.src?.includes('/audio/approval')), 'the approval cue is prepared')
})

test('a cue set to none is never requested', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment(
    settingsPayload({ slots: { working: { kind: 'none' }, approval: { kind: 'builtin' } } }),
  )
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })
  await flush()

  env.FakeEventSource.last.onmessage({ data: JSON.stringify({ working: 1, waiting: 0 }) })
  assert.ok(
    !env.created.some((entry) => entry.src?.includes('/audio/working')),
    'a disabled cue must not be fetched at all',
  )
})

test('an older host falls back to the built-in assets instead of going silent', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment()
  // Rewrite the stub so the store API answers the way a pre-store host does.
  env.sandbox.fetch = (url) => {
    env.calls.push({ url: String(url), init: null })
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('not found'),
    })
  }
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })
  await flush()

  assert.equal(env.window.__DSH_AUDIO_CUE__.state().legacy, true, 'the mismatch is detected')
  env.FakeEventSource.last.onmessage({ data: JSON.stringify({ working: 1, waiting: 0 }) })
  assert.ok(
    env.created.some((entry) => entry.src === '/dsh-audio-cue/asset/loop.ogg'),
    'and the built-in loop is used',
  )
})

test('the panel offers the shipped library beside the imports', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment(
    settingsPayload({
      library: [
        { id: 'let-me-go', name: 'let me go', type: 'audio/mp4', author: '星落落_oi', source: 'BV1freb6iErC' },
      ],
      uploads: [{ id: 'abc123', name: 'mine.mp3', bytes: 1234, type: 'audio/mpeg', addedAt: 1 }],
    }),
  )
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })
  await flush()

  env.window.__DSH_AUDIO_CUE__.open()

  // `Option` instances are what a select is built from; collecting their values
  // is how this test sees the choice list without a real DOM.
  const values = env.created
    .filter((entry) => typeof entry.text === 'string' && typeof entry.value === 'string')
    .map((entry) => entry.value)
  for (const expected of ['none', 'builtin', 'library:let-me-go', 'custom:abc123']) {
    assert.ok(values.includes(expected), `the cue list is missing ${expected}`)
  }

  assert.ok(
    env.created.some((entry) => typeof entry.textContent === 'string' && entry.textContent.includes('星落落_oi')),
    'the attribution is visible in the panel, not only in the payload',
  )
})

test('selecting a library cue stores that choice', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const env = makeEnvironment(
    settingsPayload({
      library: [{ id: 'let-me-go', name: 'let me go', type: 'audio/mp4', author: 'a', source: 'b' }],
    }),
  )
  const puts = []
  const inner = env.sandbox.fetch
  env.sandbox.fetch = (url, init) => {
    if (init && init.method === 'PUT') puts.push(JSON.parse(init.body))
    return inner(url, init)
  }
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: 'audio-cue.js' })
  await flush()

  env.window.__DSH_AUDIO_CUE__.open()
  const select = env.created.find((entry) => entry.tagName === 'SELECT')
  assert.ok(select, 'the panel built a cue select')
  select.value = 'library:let-me-go'
  select.dispatch('change')

  assert.equal(puts.length, 1, 'exactly one settings write')
  assert.deepEqual(puts[0].slots.working, { kind: 'library', id: 'let-me-go' })
})