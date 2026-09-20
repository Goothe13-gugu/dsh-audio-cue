/**
 * dsh-audio-cue — browser half.
 *
 * Injected into the web GUI index by the host half (`lib/index.js`). It holds no
 * state of its own: it subscribes to `/dsh-audio-cue/events`, and turns
 * `{ working, waiting }` into sound.
 *
 *   working === 0                 -> silence (fade out)
 *   working > 0, waiting === 0    -> ambient loop (fade in)
 *   waiting > 0                   -> silence + one attention chime per transition
 *
 * It is a classic script — no imports, no JSX, no build step — because the host
 * serves this file verbatim. Everything it touches is its own: one fixed-position
 * toggle button and two Audio elements. It never reads or writes DSH's DOM.
 */
(function () {
  'use strict'

  // Both injection paths (structured row and raw tap) can fire on the same host;
  // the second execution must be a no-op rather than a second audio engine.
  if (window.__DSH_AUDIO_CUE__) return

  var ROUTE = '/dsh-audio-cue'
  var STORE_KEY = 'dsh-audio-cue.enabled'
  var LOOP_VOLUME = 0.35
  var CHIME_VOLUME = 0.9
  var FADE_STEP_MS = 60
  var FADE_FACTOR = 0.18
  var STALE_MS = 30000

  /** First source the browser can actually decode wins; the loop prefers Ogg. */
  function makeAudio(candidates, volume) {
    var audio = new Audio()
    for (var i = 0; i < candidates.length; i += 1) {
      if (audio.canPlayType(candidates[i].type) !== '') {
        audio.src = candidates[i].src
        break
      }
    }
    if (!audio.src && candidates.length > 0) audio.src = candidates[candidates.length - 1].src
    audio.preload = 'auto'
    audio.volume = volume
    return audio
  }

  var loop = makeAudio(
    [
      { src: ROUTE + '/asset/loop.ogg', type: 'audio/ogg; codecs=opus' },
      { src: ROUTE + '/asset/loop.mp3', type: 'audio/mpeg' },
    ],
    0,
  )
  loop.loop = true

  var chime = makeAudio([{ src: ROUTE + '/asset/needs-you.mp3', type: 'audio/mpeg' }], CHIME_VOLUME)

  var enabled = false
  try {
    enabled = window.localStorage.getItem(STORE_KEY) !== 'off'
  } catch (err) {
    enabled = true
  }

  var current = 0
  var target = 0
  var fadeTimer = null
  var lastState = { working: 0, waiting: 0 }
  var wasWaiting = false
  var lastFrameAt = Date.now()

  /** Ramp the loop toward `value`, pausing it once it reaches silence. */
  function fadeTo(value) {
    target = value
    if (fadeTimer !== null) return
    fadeTimer = window.setInterval(function () {
      var delta = target - current
      if (Math.abs(delta) < 0.02) {
        current = target
        loop.volume = Math.max(0, Math.min(1, current))
        if (current === 0) loop.pause()
        window.clearInterval(fadeTimer)
        fadeTimer = null
        return
      }
      current += delta * FADE_FACTOR
      loop.volume = Math.max(0, Math.min(1, current))
    }, FADE_STEP_MS)
  }

  /** Play the loop if the state calls for it, tolerating a blocked autoplay. */
  function startLoop() {
    var playing = loop.play()
    if (playing && typeof playing.catch === 'function') playing.catch(function () {})
  }

  function playChime() {
    try {
      chime.currentTime = 0
      var playing = chime.play()
      if (playing && typeof playing.catch === 'function') playing.catch(function () {})
    } catch (err) {
      // A decode or source error must never break the state machine.
    }
  }

  /** Turn one snapshot into sound. */
  function apply(state) {
    lastState = state
    if (!enabled || !state || !state.working) {
      wasWaiting = false
      fadeTo(0)
      return
    }
    if (state.waiting > 0) {
      fadeTo(0)
      if (!wasWaiting) playChime()
      wasWaiting = true
      return
    }
    wasWaiting = false
    startLoop()
    fadeTo(LOOP_VOLUME)
  }

  // Browsers refuse to start audio before a user gesture. The first click or
  // keypress anywhere settles both elements, so the loop can begin on the next
  // transition instead of staying silent for the rest of the session.
  function unlock() {
    var a = loop.play()
    if (a && typeof a.then === 'function') {
      a.then(function () {
        if (!enabled || !lastState.working || lastState.waiting > 0) loop.pause()
      }).catch(function () {})
    }
    try {
      var b = chime.play()
      if (b && typeof b.then === 'function') {
        b.then(function () {
          chime.pause()
          chime.currentTime = 0
        }).catch(function () {})
      }
    } catch (err) {
      // Same as above: unlocking is best-effort.
    }
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)

  /** Persist and apply the on/off switch. */
  function setEnabled(next) {
    enabled = !!next
    try {
      window.localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off')
    } catch (err) {
      // Private mode: the switch still works for this page load.
    }
    if (enabled) unlock()
    apply(lastState)
    renderButton()
  }

  // The only DOM this plugin adds: a 22px toggle, out of the way in the
  // bottom-left corner, so silencing it never requires uninstalling.
  var button = null
  function renderButton() {
    if (button === null) return
    button.textContent = enabled ? '🔊' : '🔇'
    button.title = enabled ? 'dsh-audio-cue: on (click to mute)' : 'dsh-audio-cue: muted (click to unmute)'
    button.style.opacity = enabled ? '0.35' : '0.25'
  }

  function mountButton() {
    if (button !== null || !document.body) return
    button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', 'dsh-audio-cue')
    var s = button.style
    s.position = 'fixed'
    s.left = '12px'
    s.bottom = '12px'
    s.zIndex = '2147483000'
    s.width = '22px'
    s.height = '22px'
    s.lineHeight = '20px'
    s.padding = '0'
    s.fontSize = '12px'
    s.cursor = 'pointer'
    s.color = 'inherit'
    s.background = 'transparent'
    s.border = '1px solid currentColor'
    s.borderRadius = '50%'
    s.transition = 'opacity 120ms linear'
    button.addEventListener('mouseenter', function () {
      s.opacity = '1'
    })
    button.addEventListener('mouseleave', renderButton)
    button.addEventListener('mouseout', renderButton)
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      setEnabled(!enabled)
    })
    renderButton()
    document.body.appendChild(button)
  }

  if (document.body) mountButton()
  else document.addEventListener('DOMContentLoaded', mountButton)

  // Live state. EventSource reconnects on its own; a stream that stops sending
  // for too long is treated as a dead host, which is also what covers a host
  // restart mid-turn.
  var source = new EventSource(ROUTE + '/events')
  source.onmessage = function (message) {
    lastFrameAt = Date.now()
    try {
      apply(JSON.parse(message.data))
    } catch (err) {
      // A malformed frame is not worth breaking the sound for.
    }
  }
  source.onerror = function () {
    fadeTo(0)
  }
  window.setInterval(function () {
    if (Date.now() - lastFrameAt > STALE_MS) fadeTo(0)
  }, 5000)

  window.addEventListener('beforeunload', function () {
    fadeTo(0)
  })

  // Small escape hatch for power users and for debugging from the console.
  window.__DSH_AUDIO_CUE__ = {
    get enabled() {
      return enabled
    },
    setEnabled: setEnabled,
    toggle: function () {
      setEnabled(!enabled)
      return enabled
    },
    state: function () {
      return { enabled: enabled, volume: current, last: lastState }
    },
  }
})()
