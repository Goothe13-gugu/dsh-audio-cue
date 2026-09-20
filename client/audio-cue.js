/**
 * dsh-audio-cue — browser half.
 *
 * Injected into the web GUI index by the host half (`lib/index.js`). It is a
 * classic script — no imports, no JSX, no build step — because the host serves
 * this file verbatim.
 *
 * Two responsibilities:
 *
 *   - Turn the host's `{ working, waiting }` stream into sound:
 *       working === 0               -> silence (fade out)
 *       working > 0, waiting === 0  -> ambient loop (fade in)
 *       waiting > 0                 -> silence + one chime per transition
 *   - Offer the panel behind the corner button: mute, volume, and which file
 *     each cue uses. The configuration lives on the host, so this half never
 *     decides where a cue comes from — it asks for `/audio/<slot>` and renders
 *     whatever the host reports.
 *
 * Everything it touches is its own: one button, one panel, and two Audio
 * elements. It never reads or writes DSH's DOM.
 */
(function () {
  'use strict'

  // Both injection paths (structured row and raw tap) can fire on the same host;
  // the second execution must be a no-op rather than a second audio engine.
  if (window.__DSH_AUDIO_CUE__) return

  var ROUTE = '/dsh-audio-cue'
  var FADE_STEP_MS = 60
  var FADE_FACTOR = 0.18
  var STALE_MS = 45000
  var PREVIEW_MS = 3000
  var SAVE_DEBOUNCE_MS = 400
  var BUTTON_SIZE = 22
  var BOTTOM = 12
  var POS_KEY = 'dsh-audio-cue.left'
  var DEFAULT_LEFT = 412
  var EDGE_GAP = 12

  var SLOTS = ['working', 'approval']
  var SLOT_LABELS = { working: '工作中音效', approval: '需审批音效' }
  var BUILTIN_SRC = { working: ROUTE + '/asset/loop.ogg', approval: ROUTE + '/asset/needs-you.mp3' }

  // --- settings ------------------------------------------------------------
  // `legacy` means the store API answered 404: an older host half is running, so
  // the built-in assets are used directly and the panel says so. This is what
  // keeps sound working while a host and a client are briefly out of step.
  var settings = {
    revision: 1,
    muted: false,
    volume: 0.35,
    playback: 'resume',
    slots: { working: { kind: 'builtin' }, approval: { kind: 'builtin' } },
    uploads: [],
    limits: { maxUploadBytes: 8 * 1024 * 1024, types: ['ogg', 'mp3', 'wav'] },
  }
  var legacy = false
  var loadError = ''

  /** The audio formats this browser can actually decode, most wanted first. */
  var TYPES = (function () {
    var probe = document.createElement('audio')
    var mimes = {
      ogg: 'audio/ogg; codecs=opus',
      opus: 'audio/ogg; codecs=opus',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      flac: 'audio/flac',
      webm: 'audio/webm',
    }
    var order = ['ogg', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'webm']
    var supported = []
    for (var i = 0; i < order.length; i += 1) {
      try {
        if (probe.canPlayType(mimes[order[i]]) !== '') supported.push(order[i])
      } catch (err) {
        // An exotic engine; the remaining candidates still get a turn.
      }
    }
    return supported.length > 0 ? supported : ['mp3']
  })()

  function readJson(response) {
    return response.text().then(function (text) {
      var parsed = null
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        parsed = null
      }
      if (!response.ok) {
        var failure = new Error(parsed && parsed.error ? parsed.error : 'HTTP ' + response.status)
        failure.status = response.status
        throw failure
      }
      return parsed
    })
  }

  function fetchSettings() {
    return fetch(ROUTE + '/api/settings', { cache: 'no-store' })
      .then(readJson)
      .then(function (payload) {
        legacy = false
        loadError = ''
        adoptSettings(payload)
      })
      .catch(function (error) {
        if (error && error.status === 404) {
          // Older host half: no store and no panel controls, but the built-in
          // assets are still served, so the sound keeps working.
          legacy = true
          loadError = '宿主版本较旧，配置不可用（重启宿主后生效）'
        } else {
          loadError = '读取配置失败：' + (error && error.message ? error.message : String(error))
        }
        adoptSettings(settings)
      })
  }

  function saveSettings() {
    if (legacy) return Promise.resolve()
    return fetch(ROUTE + '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        muted: settings.muted,
        volume: settings.volume,
        playback: settings.playback,
        slots: settings.slots,
      }),
    })
      .then(readJson)
      .then(function (payload) {
        legacy = false
        adoptSettings(payload)
      })
      .catch(function (error) {
        loadError = '保存失败：' + (error && error.message ? error.message : String(error))
        renderPanel()
      })
  }

  var saveTimer = null
  function saveSettingsSoon() {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(function () {
      saveTimer = null
      saveSettings()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Take a payload from the host, reloading the audio only if its sources moved. */
  function adoptSettings(payload) {
    var before = audioKey()
    settings = payload
    if (healStaleChoices()) saveSettings()
    // The first payload is also what supplies the version token, so no element
    // is built before one arrives.
    if (!built || before !== audioKey()) rebuildAudio()
    renderPanel()
    applyPosition()
    apply(lastState)
  }

  /** Cue choices already repaired, so a host that keeps reporting one cannot loop. */
  var healedChoices = {}

  /**
   * Point any cue whose file no longer exists back at the default. A stored
   * reference to a deleted file would leave that cue silent with no explanation,
   * and the panel offering a choice that cannot play.
   * @returns whether anything changed and should be saved.
   */
  function healStaleChoices() {
    var uploads = settings.uploads || []
    var changed = false
    for (var i = 0; i < SLOTS.length; i += 1) {
      var slot = SLOTS[i]
      var choice = settings.slots && settings.slots[slot]
      if (!choice || choice.kind !== 'custom') continue
      var key = slot + ':' + choice.id
      if (healedChoices[key]) continue
      var present = uploads.some(function (entry) { return entry.id === choice.id })
      if (present) continue
      healedChoices[key] = true
      settings.slots[slot] = { kind: 'builtin' }
      changed = true
    }
    return changed
  }

  /** Identity of everything that could change the bytes a slot serves. */
  function audioKey() {
    return (settings.boot || 'boot') + '|' + sourceKey()
  }

  /** Everything that decides an audio URL, so a reload happens only when needed. */
  function sourceKey() {
    var key = ''
    for (var i = 0; i < SLOTS.length; i += 1) {
      var slot = SLOTS[i]
      var choice = (settings.slots && settings.slots[slot]) || { kind: 'none' }
      key += slot + ':' + choice.kind + ':' + (choice.id || '') + '|'
    }
    return key
  }

  /** Whether a slot should make any sound at all. */
  function hasCue(slot) {
    if (legacy) return true
    var choice = settings.slots && settings.slots[slot]
    return !!choice && choice.kind !== 'none'
  }

  /**
   * The version token in an audio URL. Host answers are cacheable for a year, so
   * this has to change exactly when the bytes could: the host's boot id (a
   * restart can change what a slot resolves to) plus which file that slot uses.
   * The store revision is deliberately absent -- a volume change bumps it, and
   * rebuilding the element mid-playback would cut the sound for no reason.
   */
  function versionToken(slot) {
    var choice = (settings.slots && settings.slots[slot]) || { kind: 'none' }
    return (settings.boot || 'boot') + '-' + choice.kind + '-' + (choice.id || '')
  }

  /** The URL the host resolves for a slot. */
  function slotUrl(slot) {
    if (legacy) return BUILTIN_SRC[slot]
    return ROUTE + '/audio/' + slot + '?v=' + versionToken(slot) + '&types=' + TYPES.join(',')
  }

  // --- audio ---------------------------------------------------------------

  /** The ambient loop, or null when its cue is turned off. */
  var working = null
  /** The one-shot chime, or null when its cue is turned off. */
  var approval = null
  /** Whether the elements exist yet: none is built before the first payload. */
  var built = false
  /**
   * Whether the loop is supposed to be playing right now. Playback mode needs
   * the edge, not the state: a heartbeat repeats the same snapshot every fifteen
   * seconds, and rewinding the track on each one would be absurd.
   */
  var looping = false
  var current = 0
  var target = 0
  var fadeTimer = null
  var lastState = { working: 0, waiting: 0 }
  var wasWaiting = false
  var lastFrameAt = Date.now()

  function makeAudio(src, loop) {
    var audio = new Audio()
    audio.preload = 'auto'
    audio.loop = loop
    audio.volume = 0
    audio.src = src
    return audio
  }

  function rebuildAudio() {
    stopAudio()
    current = 0
    target = 0
    working = hasCue('working') ? makeAudio(slotUrl('working'), true) : null
    approval = hasCue('approval') ? makeAudio(slotUrl('approval'), false) : null
    built = true
  }

  function stopAudio() {
    var elements = [working, approval]
    for (var i = 0; i < elements.length; i += 1) {
      if (elements[i] === null) continue
      try {
        elements[i].pause()
      } catch (err) {
        // A detached element; nothing to stop.
      }
    }
  }

  function loopVolume() {
    if (working === null) return
    working.volume = Math.max(0, Math.min(1, current))
  }

  /** Ramp the loop toward `value`, pausing it once it reaches silence. */
  function fadeTo(value) {
    target = value
    if (fadeTimer !== null) return
    fadeTimer = window.setInterval(function () {
      var delta = target - current
      if (Math.abs(delta) < 0.02) {
        current = target
        loopVolume()
        if (current === 0 && working !== null) working.pause()
        window.clearInterval(fadeTimer)
        fadeTimer = null
        return
      }
      current += delta * FADE_FACTOR
      loopVolume()
    }, FADE_STEP_MS)
  }

  /** Play the loop if the state calls for it, tolerating a blocked autoplay. */
  function startLoop() {
    if (working === null) return
    var playing = working.play()
    if (playing && typeof playing.catch === 'function') playing.catch(function () {})
  }

  function playApproval() {
    if (approval === null) return
    try {
      approval.currentTime = 0
      approval.volume = settings.muted ? 0 : settings.volume
      var playing = approval.play()
      if (playing && typeof playing.catch === 'function') playing.catch(function () {})
    } catch (err) {
      // A decode or source error must never break the state machine.
    }
  }

  /**
   * The last state changes, and what the client did about each. A report of "it
   * would not stop" is only answerable from what the page actually received, and
   * a heartbeat repeats the same frame every fifteen seconds -- so only real
   * changes are kept, which is also what makes the list readable.
   */
  var history = []

  function note(previous, state, action) {
    if (previous && previous.working === state.working && previous.waiting === state.waiting) return
    history.push({
      at: new Date().toISOString().slice(11, 23),
      working: state.working,
      waiting: state.waiting,
      action: action,
      muted: settings.muted,
      volume: Math.round(current * 100),
    })
    if (history.length > 40) history.shift()
  }

  /** Turn one snapshot into sound. */
  function apply(state) {
    var previous = lastState
    lastState = state
    if (!state) return
    if (state.working > 0 && state.waiting > 0) {
      looping = false
      fadeTo(0)
      if (!wasWaiting && !settings.muted) playApproval()
      wasWaiting = true
      note(previous, state, 'chime')
      return
    }
    wasWaiting = false
    var wantLoop = !settings.muted && state.working > 0 && working !== null
    if (wantLoop && !looping && settings.playback === 'restart') {
      try {
        working.currentTime = 0
      } catch (err) {
        // A source that cannot seek is not worth breaking the sound for.
      }
    }
    looping = wantLoop
    if (!wantLoop) {
      fadeTo(0)
      note(previous, state, settings.muted ? 'silence (muted)' : state.working > 0 ? 'silence (cue off)' : 'silence (idle)')
      return
    }
    startLoop()
    fadeTo(settings.volume)
    note(previous, state, 'loop')
  }

  // Browsers refuse to start audio before a user gesture. The first click or
  // keypress anywhere settles both elements, so the loop can begin on the next
  // transition instead of staying silent for the rest of the session.
  function unlock() {
    var elements = [working, approval]
    for (var i = 0; i < elements.length; i += 1) {
      settle(elements[i])
    }
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }

  function settle(audio) {
    if (audio === null || audio === undefined) return
    try {
      var playing = audio.play()
      if (playing && typeof playing.then === 'function') {
        playing
          .then(function () {
            var wanted = audio === working && !settings.muted && lastState.working > 0 && lastState.waiting === 0
            if (!wanted) {
              audio.pause()
              audio.currentTime = 0
            }
          })
          .catch(function () {})
      }
    } catch (err) {
      // Unlocking is best effort.
    }
  }

  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)

  // --- live state ----------------------------------------------------------
  // EventSource reconnects by itself after a transport failure, but a half-open
  // socket stays OPEN and silent forever, so staleness forces a fresh connection
  // — and the host answers every connection with a full snapshot, which is how a
  // client resynchronizes.
  //
  // Liveness is measured from `data:` frames only. A comment fires no event,
  // which is why the host's heartbeat carries the snapshot.
  var source = null

  function bindSource() {
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
  }

  function connect() {
    source = new EventSource(ROUTE + '/events')
    lastFrameAt = Date.now()
    bindSource()
  }

  connect()

  window.setInterval(function () {
    if (Date.now() - lastFrameAt > STALE_MS) {
      fadeTo(0)
      try {
        source.close()
      } catch (err) {
        // Already closed.
      }
      connect()
      return
    }
    // Repair a fade that stalled: the ramp only stops itself by reaching the
    // target, so a timer lost some other way would leave the volume stuck.
    if (fadeTimer === null && current !== target) fadeTo(target)
    // Self-heal. Whatever paused the element without telling us -- an autoplay
    // suspension, an external pause, a play() that was rejected -- the state
    // still says work is in flight, so assert the sound here instead of staying
    // silent until the user happens to open the panel.
    if (
      !settings.muted &&
      lastState.working > 0 &&
      lastState.waiting === 0 &&
      working !== null &&
      working.paused
    ) {
      startLoop()
      fadeTo(settings.volume)
    }
  }, 5000)

  window.addEventListener('beforeunload', function () {
    fadeTo(0)
  })

  // --- corner button -------------------------------------------------------
  // It docks to the right edge of the host sidebar rather than to a screen
  // corner, because the host keeps its own controls in the sidebar footer and a
  // corner button lands on top of them.
  var button = null

  /**
   * Right edge of the host sidebar, or null when that hook is absent. DSH marks
   * the sidebar root with `data-dsh-sidebar-root` -- a stable semantic hook, not
   * a hashed CSS-module class -- and measuring it is what keeps the button clear
   * of the host's own controls at every sidebar width.
   */
  function sidebarRightEdge() {
    try {
      var root = document.querySelector('[data-dsh-sidebar-root]')
      if (!root) return null
      var rect = root.getBoundingClientRect()
      if (!rect || rect.width <= 0) return null
      return rect.right
    } catch (err) {
      return null
    }
  }

  /** A manually saved left offset, or null when the user never set one. */
  function savedLeft() {
    try {
      var raw = window.localStorage.getItem(POS_KEY)
      if (raw === null) return null
      var value = Number(raw)
      return isFinite(value) ? value : null
    } catch (err) {
      return null
    }
  }

  /**
   * Where the button wants to sit: a saved override wins, otherwise just right
   * of the sidebar, otherwise DEFAULT_LEFT (which clears a full-width sidebar on
   * a layout that offers no hook). Always clamped into the viewport.
   */
  function positionLeft() {
    var override = savedLeft()
    var edge = sidebarRightEdge()
    var left = override !== null ? override : edge === null ? DEFAULT_LEFT : edge + EDGE_GAP
    return Math.max(4, Math.min(left, window.innerWidth - 32))
  }

  /** Apply the position, skipping the style write when nothing moved. */
  function applyPosition() {
    if (button !== null) {
      var left = positionLeft() + 'px'
      if (button.style.left !== left) button.style.left = left
    }
    positionPanel()
  }

  /** Save a manual offset (null clears it) and re-apply it. */
  function setPosition(left) {
    try {
      if (left === null) window.localStorage.removeItem(POS_KEY)
      else window.localStorage.setItem(POS_KEY, String(left))
    } catch (err) {
      // Private mode: the offset still applies for this page load.
    }
    applyPosition()
  }

  /** Follow the sidebar as it collapses, widens, or animates. */
  var watching = false
  function watchSidebar() {
    if (watching || typeof MutationObserver === 'undefined') return
    var root = document.querySelector('[data-dsh-sidebar-root]')
    if (!root) return
    watching = true
    new MutationObserver(applyPosition).observe(root, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed', 'data-dsh-sidebar-wide', 'style'],
    })
  }

  function renderButton() {
    if (button === null) return
    button.textContent = settings.muted ? '🔇' : '🔊'
    button.title = 'dsh-audio-cue — 点击打开设置'
    button.style.opacity = settings.muted ? '0.25' : '0.35'
  }

  function mountButton() {
    if (button !== null || !document.body) return
    button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', 'dsh-audio-cue')
    var s = button.style
    s.position = 'fixed'
    s.bottom = BOTTOM + 'px'
    s.zIndex = '2147483000'
    s.width = BUTTON_SIZE + 'px'
    s.height = BUTTON_SIZE + 'px'
    s.lineHeight = BUTTON_SIZE - 2 + 'px'
    s.padding = '0'
    s.fontSize = '12px'
    s.cursor = 'pointer'
    s.color = 'inherit'
    s.background = 'transparent'
    s.border = '1px solid currentColor'
    s.borderRadius = '50%'
    s.transition = 'opacity 120ms linear, left 160ms ease'
    button.addEventListener('mouseenter', function () {
      s.opacity = '1'
    })
    button.addEventListener('mouseleave', renderButton)
    button.addEventListener('mouseout', renderButton)
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      togglePanel()
    })
    renderButton()
    document.body.appendChild(button)
    applyPosition()
    window.addEventListener('resize', applyPosition)
    watchSidebar()
  }

  // --- panel ---------------------------------------------------------------

  var panel = null
  var panelOpen = false
  var statusText = ''
  var fileInput = null
  var importSlot = 'working'
  var previewAudio = null
  var fields = {}
  var themeKey = ''

  /** Colors for the panel, following the host's own light/dark switch. */
  function palette() {
    var dark = false
    try {
      dark = document.body.hasAttribute('data-ds-dark-theme')
    } catch (err) {
      dark = false
    }
    return dark
      ? {
          key: 'dark',
          bg: 'rgba(30,30,32,0.98)',
          fg: '#e9e9ec',
          dim: '#9b9ba2',
          line: 'rgba(255,255,255,0.16)',
          field: 'rgba(255,255,255,0.08)',
        }
      : {
          key: 'light',
          bg: 'rgba(252,252,253,0.98)',
          fg: '#1b1b1e',
          dim: '#6a6a72',
          line: 'rgba(0,0,0,0.14)',
          field: 'rgba(0,0,0,0.05)',
        }
  }

  function el(tag, styles, text) {
    var node = document.createElement(tag)
    if (styles) {
      for (var key in styles) {
        if (Object.prototype.hasOwnProperty.call(styles, key)) node.style[key] = styles[key]
      }
    }
    if (text !== undefined) node.textContent = text
    return node
  }

  /**
   * One entry in a cue list. The colors go on the option as well as on the
   * select, because the popup is drawn by the platform rather than by the page:
   * without them the list renders white text on a white panel in dark mode.
   */
  function cueOption(label, value, p) {
    var option = new Option(label, value)
    option.style.background = p.bg
    option.style.color = p.fg
    return option
  }

  function fieldButton(label, onClick) {
    var node = el('button', {
      cursor: 'pointer',
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '6px',
      padding: '2px 8px',
      font: 'inherit',
      opacity: '0.85',
    }, label)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }

  function row(label) {
    var line = el('div', { display: 'flex', alignItems: 'center', gap: '6px', margin: '8px 0' })
    line.appendChild(el('span', { flex: '0 0 66px', color: 'inherit' }, label))
    return line
  }

  function buildPanel() {
    var p = palette()
    themeKey = p.key
    panel = el('div', {
      position: 'fixed',
      zIndex: '2147483001',
      width: '292px',
      maxHeight: '70vh',
      overflowY: 'auto',
      padding: '12px 14px 10px',
      borderRadius: '10px',
      border: '1px solid ' + p.line,
      background: p.bg,
      color: p.fg,
      // The platform draws select popups and range tracks, and picks its own
      // colors unless the scheme is declared.
      colorScheme: p.key === 'dark' ? 'dark' : 'light',
      font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
      display: 'none',
    })
    // Clicks inside the panel must not reach the document handler that closes it.
    panel.addEventListener('click', function (event) {
      event.stopPropagation()
    })

    var head = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' })
    head.appendChild(el('strong', { fontSize: '12px' }, 'dsh-audio-cue'))
    head.appendChild(fieldButton('×', function () {
      togglePanel(false)
    }))
    panel.appendChild(head)

    var enableRow = row('启用')
    fields.mute = fieldButton('', function () {
      settings.muted = !settings.muted
      renderPanel()
      saveSettings()
      apply(lastState)
    })
    enableRow.appendChild(fields.mute)
    panel.appendChild(enableRow)

    var volumeRow = row('音量')
    fields.volume = el('input', { flex: '1', minWidth: '0', accentColor: 'currentColor' })
    fields.volume.type = 'range'
    fields.volume.min = '0'
    fields.volume.max = '100'
    fields.volume.step = '1'
    fields.volume.addEventListener('input', function () {
      settings.volume = Number(fields.volume.value) / 100
      fields.volumeLabel.textContent = fields.volume.value + '%'
      apply(lastState)
      saveSettingsSoon()
    })
    volumeRow.appendChild(fields.volume)
    fields.volumeLabel = el('span', { flex: '0 0 32px', textAlign: 'right', color: p.dim }, '0%')
    volumeRow.appendChild(fields.volumeLabel)
    panel.appendChild(volumeRow)

    var playbackRow = row('播放方式')
    fields.playback = el('select', {
      flex: '1',
      minWidth: '0',
      padding: '2px 4px',
      borderRadius: '6px',
      border: '1px solid ' + p.line,
      background: p.field,
      color: p.fg,
      colorScheme: p.key === 'dark' ? 'dark' : 'light',
      font: 'inherit',
    })
    fields.playback.addEventListener('change', function () {
      settings.playback = fields.playback.value === 'restart' ? 'restart' : 'resume'
      adoptSettings(settings)
      saveSettings()
    })
    playbackRow.appendChild(fields.playback)
    panel.appendChild(playbackRow)

    fields.selects = {}
    for (var i = 0; i < SLOTS.length; i += 1) panel.appendChild(buildSlotRow(SLOTS[i], p))

    panel.appendChild(el('div', { marginTop: '10px', color: p.dim }, '已导入'))
    fields.list = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' })
    panel.appendChild(fields.list)

    fields.status = el('div', { marginTop: '8px', minHeight: '14px', color: p.dim, wordBreak: 'break-word' })
    panel.appendChild(fields.status)

    // One hidden input serves both rows: the row that opened it records which
    // cue the file is for.
    fileInput = el('input', { display: 'none' })
    fileInput.type = 'file'
    fileInput.accept = 'audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.flac,.webm'
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0]
      fileInput.value = ''
      if (file) upload(importSlot, file)
    })
    panel.appendChild(fileInput)

    document.body.appendChild(panel)
    document.addEventListener('click', function () {
      togglePanel(false)
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') togglePanel(false)
    })
  }

  function buildSlotRow(slot, p) {
    var line = row(SLOT_LABELS[slot])
    var select = el('select', {
      flex: '1',
      minWidth: '0',
      padding: '2px 4px',
      borderRadius: '6px',
      border: '1px solid ' + p.line,
      background: p.field,
      color: p.fg,
      colorScheme: p.key === 'dark' ? 'dark' : 'light',
      font: 'inherit',
    })
    select.addEventListener('change', function () {
      applySlotChoice(slot, select.value)
    })
    line.appendChild(select)
    fields.selects[slot] = select

    var preview = fieldButton('▶', function () {
      previewSlot(slot)
    })
    preview.title = '试听'
    line.appendChild(preview)

    var importButton = fieldButton('导入…', function () {
      importSlot = slot
      if (legacy) {
        setStatus('宿主版本较旧，无法导入（重启宿主后生效）')
        return
      }
      fileInput.click()
    })
    line.appendChild(importButton)
    return line
  }

  /** Apply a `<select>` value, which encodes kind and id together. */
  function applySlotChoice(slot, value) {
    if (value === 'none') settings.slots[slot] = { kind: 'none' }
    else if (value === 'builtin') settings.slots[slot] = { kind: 'builtin' }
    else if (value.indexOf('custom:') === 0) settings.slots[slot] = { kind: 'custom', id: value.slice(7) }
    else return
    setStatus('')
    adoptSettings(settings)
    saveSettings()
  }

  function setStatus(text) {
    statusText = text
    if (fields.status) fields.status.textContent = text
  }

  function formatBytes(bytes) {
    if (!isFinite(bytes)) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  /** Play a slot once, so a choice can be judged before living with it. */
  function previewSlot(slot) {
    if (!hasCue(slot)) {
      setStatus('该音效已设为「无」')
      return
    }
    stopPreview()
    var audio = new Audio(slotUrl(slot))
    // Preview stays audible even when the ambient sound is muted or turned down:
    // it exists to help choose, and a silent preview helps nobody.
    audio.volume = Math.max(0.35, settings.volume)
    previewAudio = audio
    var playing = audio.play()
    if (playing && typeof playing.catch === 'function') playing.catch(function () {})
    if (slot === 'working') {
      window.setTimeout(function () {
        if (previewAudio === audio) stopPreview()
      }, PREVIEW_MS)
    }
  }

  /** Preview one imported file directly, whatever the slots currently use. */
  function previewUpload(entry) {
    stopPreview()
    // The id is immutable, so no version token is needed and the browser may keep
    // the file after the first preview.
    var audio = new Audio(ROUTE + '/uploads/' + entry.id)
    audio.volume = Math.max(0.35, settings.volume)
    previewAudio = audio
    var playing = audio.play()
    if (playing && typeof playing.catch === 'function') {
      playing.catch(function () {
        setStatus('无法试听 ' + entry.name)
      })
    }
  }

  function stopPreview() {
    if (previewAudio === null) return
    try {
      previewAudio.pause()
    } catch (err) {
      // Already stopped.
    }
    previewAudio = null
  }

  function upload(slot, file) {
    if (legacy) {
      setStatus('宿主版本较旧，无法导入（重启宿主后生效）')
      return
    }
    if (file.size > settings.limits.maxUploadBytes) {
      setStatus(
        '文件过大：' + formatBytes(file.size) + '，上限 ' + formatBytes(settings.limits.maxUploadBytes),
      )
      return
    }
    setStatus('正在导入 ' + file.name + ' …')
    fetch(ROUTE + '/api/uploads?slot=' + slot, {
      method: 'POST',
      headers: {
        // The host also reads the name, because browsers report an opaque type
        // for some perfectly valid audio files.
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
      .then(readJson)
      .then(function (payload) {
        adoptSettings(payload)
        setStatus('已导入 ' + file.name)
      })
      .catch(function (error) {
        setStatus('导入失败：' + (error && error.message ? error.message : String(error)))
      })
  }

  function removeUpload(entry) {
    if (legacy) return
    setStatus('正在删除 ' + entry.name + ' …')
    fetch(ROUTE + '/api/uploads/' + entry.id, { method: 'DELETE' })
      .then(readJson)
      .then(function (payload) {
        adoptSettings(payload)
        setStatus('已删除 ' + entry.name)
      })
      .catch(function (error) {
        setStatus('删除失败：' + (error && error.message ? error.message : String(error)))
      })
  }

  /** Repaint the panel from the current settings. */
  function renderPanel() {
    if (panel === null) return
    var p = palette()
    if (p.key !== themeKey) {
      // The host switched theme: rebuilding is cheaper than restyling every child.
      var wasOpen = panelOpen
      document.body.removeChild(panel)
      panel = null
      fields = {}
      buildPanel()
      panelOpen = wasOpen
      panel.style.display = wasOpen ? 'block' : 'none'
    }

    renderButton()
    if (fields.mute) fields.mute.textContent = settings.muted ? '🔇 已静音' : '🔊 已开启'
    if (fields.volume) fields.volume.value = String(Math.round(settings.volume * 100))
    if (fields.volumeLabel) fields.volumeLabel.textContent = Math.round(settings.volume * 100) + '%'

    if (fields.playback) {
      fields.playback.textContent = ''
      fields.playback.appendChild(cueOption('继续播放', 'resume', p))
      fields.playback.appendChild(cueOption('从头开始', 'restart', p))
      fields.playback.value = settings.playback === 'restart' ? 'restart' : 'resume'
      fields.playback.disabled = legacy
    }

    var uploads = settings.uploads || []
    for (var i = 0; i < SLOTS.length; i += 1) {
      var slot = SLOTS[i]
      var select = fields.selects[slot]
      if (!select) continue
      var choice = (settings.slots && settings.slots[slot]) || { kind: 'none' }
      var wanted = choice.kind === 'custom' ? 'custom:' + choice.id : choice.kind
      var defaultName = (settings.defaultNames || {})[slot]
      select.textContent = ''
      select.appendChild(cueOption('无', 'none', p))
      select.appendChild(cueOption(defaultName ? defaultName + '（默认）' : '默认', 'builtin', p))
      for (var j = 0; j < uploads.length; j += 1) {
        select.appendChild(cueOption(uploads[j].name, 'custom:' + uploads[j].id, p))
      }
      // A choice whose file is gone is repaired in adoptSettings, so the list
      // never has to carry a phantom entry for it.
      select.value = wanted
      select.disabled = legacy
    }

    if (fields.list) {
      fields.list.textContent = ''
      if (uploads.length === 0) {
        fields.list.appendChild(el('span', { color: p.dim }, '还没有导入任何音频'))
      }
      for (var k = 0; k < uploads.length; k += 1) fields.list.appendChild(buildUploadRow(uploads[k], p))
    }

    setStatus(legacy ? loadError : statusText)
    positionPanel()
  }

  function buildUploadRow(entry, p) {
    var line = el('div', { display: 'flex', alignItems: 'center', gap: '6px' })
    line.appendChild(el('span', {
      flex: '1',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }, entry.name))
    line.appendChild(el('span', { flex: '0 0 auto', color: p.dim }, formatBytes(entry.bytes)))
    line.appendChild(fieldButton('▶', function () {
      previewUpload(entry)
    }))
    line.appendChild(fieldButton('删除', function () {
      removeUpload(entry)
    }))
    return line
  }

  function positionPanel() {
    if (panel === null || !panelOpen) return
    var width = panel.offsetWidth || 292
    var left = Math.max(8, Math.min(positionLeft(), window.innerWidth - width - 8))
    panel.style.left = left + 'px'
    panel.style.bottom = BOTTOM + BUTTON_SIZE + 8 + 'px'
  }

  function togglePanel(next) {
    var want = next === undefined ? !panelOpen : !!next
    if (want && panel === null && document.body) buildPanel()
    if (panel === null) return
    panelOpen = want
    panel.style.display = want ? 'block' : 'none'
    if (!want) {
      stopPreview()
      return
    }
    renderPanel()
    positionPanel()
    // Always read before showing: the store is shared, so another tab or a
    // hand-edited settings.json may have moved since this page loaded.
    fetchSettings()
  }

  // --- wiring --------------------------------------------------------------

  if (document.body) mountButton()
  else document.addEventListener('DOMContentLoaded', mountButton)

  // The sidebar is rendered by the shell after this script runs, and a layout
  // change can replace it, so the observer cannot be attached once and trusted.
  // The observer is the fast path; this slow poll re-attaches it and re-measures,
  // and it costs one selector, one rect, and a style write only when the button
  // actually has to move.
  window.setInterval(function () {
    watchSidebar()
    applyPosition()
  }, 2000)

  fetchSettings()

  // Small escape hatch for power users and for debugging from the console.
  window.__DSH_AUDIO_CUE__ = {
    get enabled() {
      return !settings.muted
    },
    setEnabled: function (next) {
      settings.muted = !next
      renderPanel()
      saveSettings()
      apply(lastState)
    },
    toggle: function () {
      settings.muted = !settings.muted
      renderPanel()
      saveSettings()
      apply(lastState)
      return !settings.muted
    },
    setVolume: function (value) {
      settings.volume = Math.max(0, Math.min(1, Number(value) || 0))
      renderPanel()
      saveSettings()
      apply(lastState)
      return settings.volume
    },
    open: function () {
      togglePanel(true)
    },
    close: function () {
      togglePanel(false)
    },
    refresh: fetchSettings,
    setPosition: setPosition,
    resetPosition: function () {
      setPosition(null)
      return positionLeft()
    },
    position: function () {
      return { left: positionLeft(), bottom: BOTTOM }
    },
    settings: function () {
      return settings
    },
    state: function () {
      return { enabled: !settings.muted, volume: current, last: lastState, legacy: legacy }
    },
    history: function () {
      return history.slice()
    },
  }
})()
