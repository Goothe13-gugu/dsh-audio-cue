# dsh-audio-cue

Ambient audio while DeepSeek Harness is **thinking or working** — and a short
chime the moment it **needs you**.

[中文说明](./README.zh.md) · Install · [How it decides](#how-it-decides) · [Troubleshooting](#troubleshooting)

<!-- Add a demo GIF here once you record one:
![demo](./docs/demo.gif)
-->

- **Working** — a soft 4-second ambient loop fades in and keeps playing while any
  session (including subagents) has an open turn.
- **Waiting for you** — the loop fades out and a two-note chime plays once when
  the agent asks for approval.
- **Idle** — the loop fades out on its own. Nothing keeps playing after the work
  stops.
- **One 22px toggle** docks to the right edge of the host sidebar and mutes it; the choice is
  remembered. No settings page, no configuration file.

## Install

```sh
dsh plugin --profile web add dsh-audio-cue
```

Then restart the profile so the host picks up the new plugin row.

Desktop app: the profile lives in the app's own harness home. Point the CLI at it
first, or install from the in-app plugin market once this package is listed:

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
dsh plugin --profile web add dsh-audio-cue
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-audio-cue
```

## How it decides

The host half subscribes to the session event log and reduces four events to one
number:

| Session event | Effect |
| --- | --- |
| `turn/start` | session becomes **working** |
| `turn/end` | session becomes idle |
| `approval/asked` | session becomes **waiting for you** |
| `approval/decided` | session resumes working |

The result is published as a Server-Sent Events stream at
`/dsh-audio-cue/events`, and the browser half turns it into sound:

```
working === 0               -> silence
working > 0, waiting === 0  -> ambient loop, faded in
waiting > 0                 -> silence + one chime per transition
```

A few properties fall out of this design:

- **Subagents count as work.** Any session with an open turn keeps the loop
  playing, so delegated work is not silent.
- **A page reload cannot inherit a stale state.** Every connection receives a
  full snapshot first, and the host keeps the state in memory only.
- **A dead host means silence.** The stream carries a heartbeat; if it stops, the
  page goes quiet instead of looping forever.

You can inspect the current state yourself:

```sh
curl http://127.0.0.1:8151/dsh-audio-cue/state.json
# {"bootId":"k3f9a1","seq":7,"working":1,"waiting":0}
```

## Settings

There is no config file. Everything lives in the page:

| What | How |
| --- | --- |
| Mute / unmute | Click the 🔇 button beside the sidebar |
| Move the button | `__DSH_AUDIO_CUE__.setPosition(px)`; `resetPosition()` returns it to the sidebar edge |
| Remembered across reloads | `localStorage["dsh-audio-cue.enabled"]` (`"on"` / `"off"`) |
| Scripting or debugging | `window.__DSH_AUDIO_CUE__` — `.toggle()`, `.setEnabled(bool)`, `.setPosition(px)`, `.state()` |
| Default for a fresh browser | **on**; set the storage key to `"off"` to change it |

Volume constants (`LOOP_VOLUME`, `CHIME_VOLUME`, `FADE_FACTOR`) are at the top of
`client/audio-cue.js`.

## Bring your own audio

Replace the files in `assets/` and restart the host. Keep the file names — the
client asks for them by name:

| File | Used for | Notes |
| --- | --- | --- |
| `loop.ogg` | working loop | Preferred: Ogg/Opus, loops seamlessly in Chromium |
| `loop.mp3` | working loop fallback | Used only where Ogg is unsupported |
| `needs-you.mp3` | attention chime | Played once per waiting transition |

Both loop files are tried in order using `canPlayType`, so you can ship only one
of them.

**The shipped audio is a placeholder**, synthesized with `ffmpeg` sine partials
(see the commands in `CHANGELOG.md`). Replace it with something you like — and
whatever you ship, make sure you have the rights to it. A loop that is not
seamless will click at every repeat; the shipped one measures a wrap
discontinuity of about −96 dBFS.

## Troubleshooting

**No sound at all.** Browsers refuse to start audio before a user gesture. Click
anywhere in the page once — the plugin listens for that first click or keypress
and starts the loop on the next transition. The desktop app loads its window over
HTTP from the local harness server (Electron's default autoplay policy normally
allows sound outright); a plain browser tab is the strict case.

**Sound but the button says muted.** The button reflects
`localStorage["dsh-audio-cue.enabled"]`; click it to turn the plugin back on.

**Two audio streams at once.** You have the page open in more than one tab; every
tab plays independently. Mute one.

**Nothing after installing.** The host has to be restarted for a new bundle row
to mount — restart the profile, not just the page.

**It never stops playing.** Check `state.json`: if `working` stays above 0 while
nothing is running, please open an issue with that response body.

## Development

```sh
git clone https://github.com/Goothe/dsh-audio-cue
cd dsh-audio-cue
dsh plugin --profile web add link:$PWD   # link: install, no publish needed
```

Then edit `lib/index.js` (host) or `client/audio-cue.js` (browser) and restart
the profile. The client script is served with `Cache-Control: no-store`, so a
plain page reload picks up browser-side edits once the host has been restarted
for host-side ones.

Tests mount the host half into a fake Cordis context and assert the state
machine, the routes, the asset whitelist, and the browser half's asset names —
no harness and no dependencies required:

```sh
npm test
```

Layout:

```
lib/index.js          host half: event state machine, SSE, asset routes, injection
client/audio-cue.js   browser half: state -> sound (classic script, no build step)
assets/               the audio itself
test/smoke.test.mjs   host-half tests, run with node:test
cordis.patch.yml      the mount declaration
```

## Compatibility

Verified against DeepSeek Harness `0.1.2-alpha.1` (DSH Desktop `0.7.1`). The
plugin depends on `webServer` and on four session event names; it imports nothing
from the harness, so it is not tied to a particular release line.

The injection uses the structured index-injection table
(`webserver/index-inject`), with a raw `tapIndex` fallback for hosts that do not
render it.

The browser half uses relative URLs only. The desktop window loads the harness
page over HTTP from the local server, so the event stream and the asset requests
take the same path in the desktop app and in a browser tab.

## License

MIT
