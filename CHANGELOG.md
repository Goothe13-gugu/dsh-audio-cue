# Changelog

## 0.1.0

First release: ambient audio while the agent works, and a chime the moment it
needs you.

### Working state

- The host subscribes to `session/event` and reduces `turn/start`, `turn/end`,
  `approval/asked`, and `approval/decided` into one `{ working, waiting }`
  snapshot, published over SSE at `/dsh-audio-cue/events` with a full snapshot on
  connect and one every 15 seconds.
- Work is also inferred from activity that can only happen inside a turn
  (streamed output, tool calls, agent steps), so a host that mounted mid-turn
  reports it instead of staying silent; only `turn/end` closes a session.
- A call to the ask-user tool counts as waiting for a person, the same way an
  approval does, and the answer is matched back through the result's
  `sourceEventSeqs` so a parallel tool result cannot clear it early.
- Broadcasting is deduplicated, because `assistant/chunk` fires once per
  streamed chunk and a frame per chunk would flood every open page.

### The browser half

- Fades a looping track in while work is in flight, fades it out and plays one
  chime when the agent needs you, and goes silent when the host stops answering.
- A panel behind the corner button: mute, volume, playback mode, one cue per
  slot, imports, previews, and deletion.
- The loop can **resume** where it stopped (the default) or **restart** from the
  beginning. The rewind happens on the edge only — a heartbeat repeats the same
  snapshot every fifteen seconds, and rewinding on every applied state would
  restart the track continuously.
- Repairs what it can rather than going quiet: a cue whose file is gone falls
  back to the default, a stalled fade is restarted, a paused element is started
  again, and a stream that stops sending is replaced with a fresh connection.
- Falls back to the built-in assets when the store API answers 404, so a client
  and a host that are briefly out of step keep working instead of going silent.

### The store

- Lives at `${DSH_HOME}/dsh-audio-cue/`: `settings.json` plus `uploads/`, so the
  configuration follows the harness home rather than a browser.
- Written through a temporary file and a rename; a corrupt or unreadable file
  falls back to defaults instead of refusing to mount; deleting an import resets
  every cue that used it.
- Imports are limited to 8 MB and to `mp3`, `ogg`/`oga`/`opus`, `wav`, `m4a`,
  `aac`, `flac`, and `webm`.
- Audio answers are cached for a year when the URL pins the bytes: an audio URL
  carries the host's boot id and the file the slot resolved to, and an upload is
  addressed by an id that is never reused.

### Bundled audio

- `let-me-go.m4a` — the default working cue. Third-party work, bundled with the
  author's permission; see [CREDITS.md](./CREDITS.md). It ships as AAC because
  every browser decodes it, Safari included. The original was a 4.4 MB
  second-generation encode, re-encoded once more at 96 kbps:

  ```sh
  ffmpeg -y -i source.m4a -c:a aac -b:a 96k -ar 44100 -ac 2 -movflags +faststart \
    -metadata title="let me go" \
    -metadata artist="星落落_oi" \
    -metadata comment="Bundled with the author's permission. Original video: https://www.bilibili.com/video/BV1freb6iErC" \
    assets/let-me-go.m4a
  ```

  The attribution is written into the file's own metadata as well as into
  `CREDITS.md`, because a note inside the file survives being extracted from the
  package.

- `loop.ogg` and `loop.mp3` — the synthesized fallback for a browser that cannot
  play AAC. Every partial completes a whole number of cycles in 4 seconds
  (multiples of 0.25 Hz) and the seam is faded, which makes the loop point
  seamless; the measured wrap discontinuity is about −96 dBFS.

  ```sh
  ffmpeg -y \
    -f lavfi -i "sine=frequency=82.5:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=110:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=165:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=4" \
    -filter_complex "[0:a]volume=0.30[a0];[1:a]volume=0.24[a1];[2:a]volume=0.14[a2];[3:a]volume=0.08[a3];[a0][a1][a2][a3]amix=inputs=4:normalize=0[mix];[mix]tremolo=f=0.25:d=0.3,afade=t=in:st=0:d=0.12,afade=t=out:st=3.88:d=0.12[out]" \
    -map "[out]" -ac 1 -c:a libopus -b:a 64k assets/loop.ogg
  ```

- `needs-you.mp3` — the chime, two notes (A5 then D6):

  ```sh
  ffmpeg -y \
    -f lavfi -i "sine=frequency=880:sample_rate=44100:duration=0.30" \
    -f lavfi -i "sine=frequency=1174.66:sample_rate=44100:duration=0.80" \
    -filter_complex "[0:a]volume=0.45,afade=t=in:st=0:d=0.012,afade=t=out:st=0.06:d=0.24[a0];[1:a]volume=0.45,afade=t=in:st=0:d=0.012,afade=t=out:st=0.10:d=0.70,adelay=170:all=1[a1];[a0][a1]amix=inputs=2:normalize=0,volume=1.5[out]" \
    -map "[out]" -ac 1 -c:a libmp3lame -b:a 96k assets/needs-you.mp3
  ```

### Development

- `npm test` runs two dependency-free suites: the host half against a fake Cordis
  context that talks to its real routes, and the browser half executed in a DOM
  stand-in.
- The browser suite exists because the other one only read the client's text: a
  syntax error once shipped with every test green, and the plugin was mounted and
  listed while nothing ran at all.
