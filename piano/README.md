# Piano Practice

A browser-based MIDI piano practice tool. Plug in a MIDI keyboard, pick a lesson
or load a `.mid` file, and play along with the on-screen staff while a
synthesized accompaniment scores your timing and accuracy.

Everything runs client-side — no build step, no dependencies. The page is
served as static files.

## Running

```sh
npm start
```

This starts `python3 -m http.server 8000`. Open http://localhost:8000 in a
browser that supports the Web MIDI API (Chrome, Edge, Opera).

A MIDI input device is required for scoring. Without one the app still renders
staves and plays back, but it can't read your input.

## Features

- **Web MIDI input** — auto-detects connected devices and shows their status.
- **Lessons mode** — eight built-in exercises that progress from steady quarter
  notes on middle C through C-major scales, left-hand bass progressions, and
  hands-together coordination.
- **Advanced mode** — drop in any standard `.mid` / `.midi` file and practice
  against it.
- **Staff renderer** — SVG grand-staff with ledger lines, sharps, hand-coloring,
  and a moving playhead.
- **Transport** — 3-beat count-in (the first note plays three times), optional
  metronome, and looping.
- **Synth** — built-in Web Audio polyphonic synth with seven patches: Piano,
  Electric Piano, Organ, Strings, Marimba, Synth Lead, and Sine.
- **Scoring** — tracks your hits against the score in real time and keeps a
  history panel of past attempts.

## Files

| File             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `index.html`     | Page layout and DOM structure                                        |
| `styles.css`     | All styling                                                          |
| `app.js`         | Entry point: MIDI I/O, staff rendering, scoring, UI wiring           |
| `lessons.js`     | Built-in lesson definitions and the `lessonToSong` adapter           |
| `midi-parser.js` | Standard MIDI File parser plus a note-extraction helper              |
| `playback.js`    | Transport — count-in, tempo-driven playhead, metronome               |
| `synth.js`       | Polyphonic Web Audio synth and instrument patches                    |

## Browser support

Requires the Web MIDI API and the Web Audio API. As of 2026, that means any
recent Chromium-based browser. Firefox does not yet ship Web MIDI by default.
