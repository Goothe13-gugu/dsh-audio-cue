# dsh-audio-cue

Ambient audio while DeepSeek Harness is **thinking or working** — and a chime the
moment it **needs you**.

[中文说明](./README.zh.md) · [Install](#install) · [The panel](#the-panel) · [How it decides](#how-it-decides) · [Troubleshooting](#troubleshooting)

<!-- Add a demo GIF here once you record one:
![demo](./docs/demo.gif)
-->

- **Working** — a soft track fades in and keeps playing while any session,
  subagents included, has an open turn.
- **Needs you** — the loop stops and one chime plays when the agent asks for
  approval **or asks you a question**.
- **Idle** — the loop fades out on its own. Nothing keeps playing after the work
  stops.
- **One small button** beside the sidebar opens the panel. No settings file to
  edit by hand.

## Install

```sh
dsh plugin --profile web add dsh-audio-cue
```

Then restart the profile, so the host mounts the new plugin row.

In the desktop app the profile lives in the app's own harness home, so point the
CLI at it first:

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
dsh plugin --profile web add dsh-audio-cue
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-audio-cue
```

### Let an agent install it

If you would rather not run any of this by hand, paste the following to the agent
you are already talking to. It is written to fail loudly rather than report
success it did not verify, because every step below has a quiet failure mode.

<details>
<summary>Prompt for an AI agent</summary>

```text
Install the DeepSeek Harness plugin `dsh-audio-cue` into the `web` profile, then
verify it. Do not publish anything and do not modify the plugin's repository.

Two things will send you down the wrong path unless you check them first:

1. DSH_HOME. A profile lives at `$DSH_HOME/profiles/<name>`, and the default home
   is `~/.dsh`. The desktop app uses its own (on Windows,
   `%APPDATA%\dsh-desktop\harness`). Installing into the wrong home quietly
   creates a second, empty profile that has no other plugins in it, so work out
   which home the running harness uses first, and set DSH_HOME for every command.
2. The CLI. `dsh` is not necessarily on PATH: the desktop app ships it inside its
   application resources, at
   `…/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js`, runnable with the
   Node bundled beside it at `…/resources/app/node_modules/node/bin/node`. Note
   that `dsh plugin` forwards its arguments to pnpm, so pnpm must be on PATH too.

Then:

1. Tell me which harness home you found and which profile you will install into.
2. Run: dsh plugin --profile web add dsh-audio-cue
3. Show me that the profile's package.json now lists `dsh-audio-cue` in both
   `dependencies` and `dsh.profile.bundles`.
4. Ask me to restart the host, and stop there until I confirm: the plugin row is
   only mounted when the host starts, and restarting it would end your own
   session, so it is my job, not yours.
5. After the restart, verify and show the actual output of each check:
   - GET http://127.0.0.1:<port>/dsh-audio-cue/state.json returns 200 with JSON
     containing `working` and `waiting`. <port> is the one the GUI is served on;
     on the desktop the current URL (including its token) is in the host log
     under `%APPDATA%\dsh-desktop\logs\harness.log`, on the `dsh web:` line.
   - The page HTML contains `<script src="/dsh-audio-cue/client.js">`.
   - `$DSH_HOME/dsh-audio-cue/settings.json` exists after the plugin has been used
     once.
6. Tell me plainly which checks passed and which did not, quoting the responses.
   If something failed, say so instead of summarising it as done.

To uninstall: dsh plugin --profile web remove dsh-audio-cue, then restart the host
again.
```

</details>

## The panel

Click the button beside the sidebar.

```
┌────────────────────────────────────────┐
│ dsh-audio-cue                      ×   │
│  启用      [🔊 已开启]                  │
│  音量      [======●=====]        65%   │
│  播放方式  [继续播放 ▾]                 │
│  工作中音效 [let me go（默认）▾] ▶ 导入…│
│  需审批音效 [默认 ▾]            ▶ 导入…│
│                                        │
│  已导入                                │
│    my-loop.mp3   1.2 MB   ▶   删除     │
└────────────────────────────────────────┘
```

| Control | What it does |
| --- | --- |
| 启用 | Mutes everything. The corner icon follows it. |
| 音量 | One volume for both the loop and the chime. |
| 播放方式 | **继续播放** picks up where the track stopped. **从头开始** rewinds it whenever the loop starts again. |
| 工作中音效 | **无** (silent), one of the shipped cues, or one of your imports. |
| 需审批音效 | The same choice for the chime. |
| 导入… | Uploads a file for that cue and selects it. |
| ▶ | Auditions the cue. The loop is auditioned for 3 seconds, the chime plays once. |
| 删除 | Removes an import and resets any cue that used it. |

The volume applies to the chime as well, so a volume of 0 is silent — the panel
says so by showing the icon muted, not just turned down.

### Where settings live

On the host, not in the browser:

```
$DSH_HOME/dsh-audio-cue/
  settings.json      mute, volume, playback mode, and which cue each slot uses
  uploads/           files you imported, plus their index
```

So the configuration follows the harness home: it survives a browser cache wipe,
a different browser, and a restart. A session pointed at a *different* home has
its own store, and no plugin.

The settings file is written through a temporary file and a rename, so a crash
cannot leave it half-written. A corrupt or unreadable one falls back to defaults
instead of refusing to load, and a cue whose file is gone is repaired back to the
default rather than left silent with no explanation.

### Console API

For scripting, and for when the panel is not enough:

```js
__DSH_AUDIO_CUE__.state()                       // { enabled, volume, last, legacy }
__DSH_AUDIO_CUE__.toggle()                      // returns the new on/off state
__DSH_AUDIO_CUE__.setVolume(0.4)
__DSH_AUDIO_CUE__.setEnabled(false)             // false = muted
__DSH_AUDIO_CUE__.open()                        // open or close the panel
__DSH_AUDIO_CUE__.settings()                    // the last payload from the host
__DSH_AUDIO_CUE__.refresh()                     // re-read the store
__DSH_AUDIO_CUE__.history()                     // the last state changes, and what each one did
__DSH_AUDIO_CUE__.setPosition(520)              // nudge the button; resetPosition() undoes it
```

## How it decides

The host subscribes to the session event log and reduces it to one number:

| Session event | Effect |
| --- | --- |
| `turn/start` | the session becomes **working** |
| `turn/end` | the session goes idle, and any open question is cleared |
| `approval/asked` | the session becomes **waiting for you** |
| `approval/decided` | back to working |
| `tool/call` that is asking you something | **waiting for you** |
| `tool/result` that answers it | back to working |
| `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `step/start`, `step/end` | **working**, if that session was not already open |

The result is published as a Server-Sent Events stream at
`/dsh-audio-cue/events`, with a full snapshot on connect and a snapshot every 15
seconds; the browser half turns it into sound:

```
working === 0               -> silence
working > 0, waiting === 0  -> ambient loop, faded in
waiting > 0                 -> silence + one chime per transition
```

A few properties fall out of that:

- **Subagents count as work.** Any session with an open turn keeps the loop
  playing, so delegated work is not silent.
- **A turn that started before this host did still counts.** Streamed output,
  tool calls, and agent steps can only happen inside a turn, so they open one by
  themselves. That covers a host that mounted mid-turn or missed a frame, and it
  cannot leave the sound stuck on, because only `turn/end` closes a session.
- **A question is not an approval, but it looks the same to you.** The session
  log has no question event — the ask-user tool is an ordinary tool call — so the
  call is recognised by name (`ask_user_question`, or any tool whose arguments
  carry `questions`), and the answer is matched back through the result's
  `sourceEventSeqs` so a parallel tool result cannot clear it early.
- **A page reload cannot inherit a stale state.** Every connection receives a
  full snapshot first, and the host keeps the state in memory only.
- **A dead host means silence.** The stream carries a heartbeat; if it stops, the
  page goes quiet and reconnects instead of looping forever.

The state is also available as plain JSON, which is the quickest way to debug it:

```sh
curl http://127.0.0.1:<port>/dsh-audio-cue/state.json
# {"bootId":"k3f9a1","seq":7,"working":1,"waiting":0,"sessions":[{"id":"27410d27","waiting":false}]}
```

Use the port your GUI is served on — it is in `DSH_WEB_URL`, and it changes
between launches. `sessions` is the breakdown behind the counts: work in *any*
session keeps the sound on, so it is what answers "why is it still playing?"

## Bring your own audio

Import a file in the panel, or replace the built-in cues in `assets/` and restart
the host. Imports are copied into the store, so the original can move or be
deleted afterwards.

| | |
| --- | --- |
| Accepted formats | `mp3`, `ogg`/`oga`/`opus`, `wav`, `m4a`, `aac`, `flac`, `webm` |
| Size limit | 8 MB per file |
| How the type is decided | the `Content-Type` header, or the file name when the browser reports an opaque type |

The shipped cues are real choices in the panel, not one option and one hidden
fallback:

- **`let me go`** — the default working cue. Third-party work, bundled with the
  author's permission: see [CREDITS.md](./CREDITS.md). It ships as AAC (`.m4a`)
  because every browser decodes it, Safari included.
- **`let me go SSR`** — a 20-second clip from the same work, bundled at the
  author's request. Short enough to loop without your noticing where it starts.
- **底噪** — a four-second synthesized pad, seamless at the loop point, for when
  any music is more than you want behind your work.
- **默认提示音** — the chime: a two-note synthesized placeholder, generated with
  `ffmpeg` (the command is in [CHANGELOG.md](./CHANGELOG.md)).

Whatever a slot is set to still has to be decodable: the pad ships in both Ogg and
MP3 and sits last in that order, so a browser that cannot play AAC ends up with it
rather than a 404.

A loop that is not seamless will click at every repeat. The synthesized
placeholder is measured at a wrap discontinuity of about −96 dBFS; a song will
not be, which is what the **从头开始 / 继续播放** choice is about.

## Routes

Everything the plugin serves lives under `/dsh-audio-cue/`. Useful when
diagnosing:

| Route | Purpose |
| --- | --- |
| `GET /events` | the state stream (SSE) |
| `GET /state.json` | the same snapshot as JSON |
| `GET /api/settings` | the store, in one payload |
| `PUT /api/settings` | replace it (validated) |
| `POST /api/uploads?slot=` | store an import; the body is the raw audio and `x-file-name` carries its name, so there is no multipart parser |
| `DELETE /api/uploads/<id>` | forget an import, and reset every cue that used it |
| `GET /uploads/<id>` | one import, for the panel's previews |
| `GET /audio/<slot>` | what a cue resolves to: 404 when off, the import, or the built-in |
| `GET /asset/<name>` | the shipped files |
| `GET /client.js` | the browser half |

Audio answers are **cached for a year** when the URL pins the bytes: `/audio/<slot>?v=…`
carries the host's boot id and the file the slot resolved to, and `/uploads/<id>`
is addressed by an id that is never reused. Unversioned requests, and the
built-in assets an author may replace in place, are never cached.

## Troubleshooting

**No sound at all.** A browser refuses to start audio before a user gesture:
click anywhere once (opening the panel counts) and the loop starts. The desktop
app loads its window over HTTP from the local server and normally allows sound
outright; a plain browser tab is the strict case. Also check the volume — 0 is
silent, and the panel will show the icon muted.

**No button on the page.** The browser half is injected into the index; if it is
missing, check the profile's `dsh.profile.bundles` really lists `dsh-audio-cue`,
then restart the host. (Plugins are only mounted at host start.)

**It worked, then the tab went dead.** The host restarted: both the port and the
token change on every launch, so an open tab and a bookmark both stop working.
The current URL is in the host log:

```powershell
Select-String -Path "$env:APPDATA\dsh-desktop\logs\harness.log" -Pattern 'dsh web:' | Select-Object -Last 1
```

**The plugin is missing from a browser session, along with every other plugin.**
That session is running against a different harness home — most often a `dsh web`
started without `DSH_HOME`, which falls back to `~/.dsh` and initialises a fresh
profile with no plugins at all.

**Two audio streams at once.** The page is open in more than one tab; each plays
independently. Mute one.

**It never stops playing.** Check `state.json`: if `working` stays above 0 while
nothing is running, please open an issue with that response body.

## Security

The plugin's routes are **not authenticated**, matching the rest of the plugin
ecosystem here. With the default loopback bind that is local-only. If the profile
binds `0.0.0.0`, these routes are reachable from the network — and
`POST /api/uploads` writes files under `$DSH_HOME` — so treat a LAN bind as
exposing them.

## Development

```sh
git clone https://github.com/Goothe/dsh-audio-cue
cd dsh-audio-cue
dsh plugin --profile web add link:$PWD   # a link: install needs no publish
npm test
```

Two halves, with different iteration costs:

| | File | A change needs |
| --- | --- | --- |
| host | `lib/index.js` | a host restart (the module is loaded at mount) |
| browser | `client/audio-cue.js` | only a page refresh (served `no-store` from disk) |

```
lib/index.js          host half: event state machine, the store, routes, injection
client/audio-cue.js   browser half: state -> sound, and the panel (no build step)
assets/               the shipped audio
test/smoke.test.mjs   host half, against a fake Cordis context
test/client-load.test.mjs  browser half, executed in a DOM stand-in
cordis.patch.yml      the mount declaration
```

`npm test` needs no dependencies and no harness: the host suite mounts the plugin
into a fake context and talks to its routes, while the browser suite actually
*runs* the client script against a small DOM so that a syntax error or a broken
mount fails the build rather than the user.

## Compatibility

Verified against DeepSeek Harness `0.1.2-alpha.1` (DSH Desktop `0.7.1`). The
plugin depends on the `webServer` service and on a handful of session event
names; it imports nothing from the harness, so it is not tied to a release line.

The desktop window loads the harness page over HTTP from the local server, so the
event stream and the asset requests take the same path in the desktop app and in
a browser tab.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a pull
request; the suites are the reason the last two regressions were caught before
release rather than after.

## License

MIT for the code. The bundled track is third-party and used with permission —
see [CREDITS.md](./CREDITS.md).
