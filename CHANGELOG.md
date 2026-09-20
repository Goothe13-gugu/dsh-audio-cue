# Changelog

## 0.1.0

First release.

- Host half: reduces `turn/start`, `turn/end`, `approval/asked`, and
  `approval/decided` from the session event stream into one `{ working, waiting }`
  snapshot, published over SSE at `/dsh-audio-cue/events` with a heartbeat and a
  full snapshot on connect.
- Browser half: fades a looping ambient track in while work is in flight, fades
  it out and plays one chime when the agent asks for approval, and goes silent
  when the host stops answering.
- Mute toggle docked to the right edge of the host sidebar, measured from the
  `data-dsh-sidebar-root` hook so it follows collapsing and resizing instead of
  covering the host's own footer controls. Persisted in `localStorage`, plus a
  `window.__DSH_AUDIO_CUE__` escape hatch (`.setPosition(px)` / `.resetPosition()`).
- The SSE keepalive now carries the state instead of an SSE comment. EventSource
  fires no event for a comment, so a long turn -- which transitions only at its
  start and end -- sent no frame for minutes and the browser half's liveness
  check faded a running turn to silence. The browser half also re-asserts
  playback whenever the state says work is in flight but the audio element is
  paused, repairs a stalled fade, and forces a fresh connection when the stream
  really does go quiet.
- Placeholder audio, synthesized with `ffmpeg` sine partials:

  ```sh
  # ambient loop: partials chosen so every one completes a whole number of
  # cycles in 4s (multiples of 0.25 Hz), which makes the loop point seamless
  ffmpeg -y \
    -f lavfi -i "sine=frequency=82.5:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=110:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=165:sample_rate=48000:duration=4" \
    -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=4" \
    -filter_complex "[0:a]volume=0.30[a0];[1:a]volume=0.24[a1];[2:a]volume=0.14[a2];[3:a]volume=0.08[a3];[a0][a1][a2][a3]amix=inputs=4:normalize=0[mix];[mix]tremolo=f=0.25:d=0.3,afade=t=in:st=0:d=0.12,afade=t=out:st=3.88:d=0.12[out]" \
    -map "[out]" -ac 1 -c:a libopus -b:a 64k assets/loop.ogg

  # attention chime: A5 then D6
  ffmpeg -y \
    -f lavfi -i "sine=frequency=880:sample_rate=44100:duration=0.30" \
    -f lavfi -i "sine=frequency=1174.66:sample_rate=44100:duration=0.80" \
    -filter_complex "[0:a]volume=0.45,afade=t=in:st=0:d=0.012,afade=t=out:st=0.06:d=0.24[a0];[1:a]volume=0.45,afade=t=in:st=0:d=0.012,afade=t=out:st=0.10:d=0.70,adelay=170:all=1[a1];[a0][a1]amix=inputs=2:normalize=0,volume=1.5[out]" \
    -map "[out]" -ac 1 -c:a libmp3lame -b:a 96k assets/needs-you.mp3
  ```

  The Ogg loop is the primary source; `loop.mp3` is the same content for
  browsers without Ogg support.
