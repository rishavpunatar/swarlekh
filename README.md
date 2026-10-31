# SwarLekh — स्वरलेख

**Sargam notation from your recordings.** Upload a Hindustani vocal recording and SwarLekh tracks the sung melody, finds Sa, and writes the song out as swara notation you can read, practise with, correct and export.

**Live: <https://rishavpunatar.github.io/swarlekh/>**

Everything runs on your device. The standard engines run in the browser; the optional **Best** engine sends audio only to a helper server on `127.0.0.1` (your own computer). There are no analytics and no third-party requests.

## What it does

- **Upload** MP3, M4A, WAV, FLAC or OGG by drag-and-drop.
- **Three pitch engines**
  - *Fast* — hand-written DSP in the browser (YIN + Viterbi), seconds per song.
  - *Accurate* — CREPE-tiny in the browser (TensorFlow.js, WASM), self-hosted.
  - *Best* — the local server isolates the voice with BS-RoFormer (Demucs as fallback), tracks pitch with RMVPE confirmed by Praat, and finds sung notes with GAME. See [`server/README.md`](server/README.md). Uploads go straight to it when it is running, with live progress and a working Cancel; without it the app falls back to the browser.
- **Finds Sa** from the tanpura itself (its steady drone lines are found in the mix and ring at Sa and Pa), the voice's pitch-class histogram, and where phrases begin and resolve. It places Sa in the octave the tanpura and the voice agree on, corrects slow tuning drift (measured on Sa and Pa), flags close calls, and lets you check by ear against a Sa–Pa drone or set Sa from a sung note at the playhead.
- **Pitch contour** — the melody line with every sung note named, meends drawn as curves, the song's scale highlighted, beat and sam ticks when a taal is detected, and a faint trace of the actual sung pitch underneath. **Hollow dots** mark notes to check by ear (sung between two swaras, or an inferred ornament). Click to seek, drag the ruler to loop, pinch or ⌘-scroll to zoom.
- **Sargam notation** — one numbered line per phrase, following playback, with ornaments written out: kan `(R)G`, murki `(GRG)m`, meend `P⌒D⌒S'`, andolan `≈g`. Latin or Devanagari (komal and teevra marks kept).
- **Correct it** — drag a note dot up or down, add a missing note, or shape the connector into and out of a note. Corrections are saved on this device for that recording and come back when you upload it again.
- **Export** — copy the text, download `.txt` or `.json` (notes, timings, your corrections and the analysis input), print or save a PDF sheet, or download the synthesized melody as WAV.
- **Hear the notation** — *Listen to → Original + notation* plays exactly what is written (your corrections included) alongside the recording, so a wrong swara is audible.
- **Practise** — loop a line with ⟨ ⟩, ramp a loop from 0.65× to full speed, slow down without changing pitch, and **sing along**: your own pitch draws over the contour live (microphone analysed in memory, never recorded).
- **Raag analysis** — swar-set with intonation, thaat, aaroh/avaroh, vadi/samvadi, nyas, jati, and a shortlist of likely ragas from a 42-raga knowledge base. Suggestions are calibrated: short clips and mixed scales never read as "likely".
- **Taal and tempo** (Best engine) — felt BPM, matra rate, likely cycle and sam.

## Notation legend

| Symbol | Meaning |
|---|---|
| `S r R g G m M P d D n N` | the 12 swaras — capitals shuddh, lowercase komal; `m` shuddh Ma, `M` teevra Ma |
| `.S` / `S'` | mandra / taar saptak |
| `(R)G` | kan — a grace touch of Re before Ga |
| `(GRG)m` | murki — a quick cluster into m |
| `P⌒D⌒S'` | meend — a glide through every swara it touches |
| `≈g(R–g)` | andolan — slow oscillation, with the swing range |
| `~G` | a note entered by a bend |
| `–` | sustain, about 0.3 s per dash |

The **Show** menu switches between *Main notes only*, *Clean + ornaments* (default) and *Every nuance*.

## How it works

```
upload ─┬─ Fast:     band-pass 70–1800 Hz → FFT YIN, multi-candidate Viterbi
        ├─ Accurate: CREPE-tiny (WASM) with Viterbi decoding
        └─ Best:     127.0.0.1 server → BS-RoFormer vocals → RMVPE + Praat
                     fusion → GAME note regions + vocal onsets + rhythm
      → octave check (restructured only on gross tracking errors)
      → Sa: tanpura drone lines in the mix + voice histogram + phrase cadences
      → slow tuning drift measured on Sa/Pa and removed
      → notation: GAME regions refined with the frame contour (js/dsp-regions.js)
        or contour segmentation (js/dsp.js) → phrases → raga analysis
```

Browser DSP is dependency-free JavaScript in a Web Worker (`js/dsp.js`, `js/dsp-regions.js`). The page enforces a strict Content-Security-Policy: no inline code, no third-party hosts, and network access only to its own origin and the local helper.

## Accuracy

Measured three ways; [`evaluation/README.md`](evaluation/README.md) has the protocols.

**Real Hindustani recordings — Saraga** (64 vocal concerts held out from all tuning, three 90 s excerpts each, the in-browser Fast engine on the full mix with tanpura and tabla):

| | Before (Oct 2026) | Now |
|---|---:|---:|
| Sa pitch class correct (±50¢) | 57% | **87%** |
| Sa and its octave correct | 26% | **72%** |
| Annotated sargam phrases found in the notation | 22% | **44%** |

Phrases found given the *annotated* Sa stay at ~51%: what remains is note-level tracking on a full concert mix, where the Best engine's vocal separation is the lever — on a small Best-engine sample (6 held-out excerpts; separation is slow) phrases found rise to 69%, with Sa right on all six (octave on four; two excerpts sit entirely in taar saptak).

**Known-answer synthetic performances** of all 42 ragas (raga intonation, meend, vibrato, drift; tanpura and tabla for the Fast engine): Sa 93–100% and swaras 88–100% across male and female voices, vibrato and up to 70¢ of drift. `npm test` holds floors on these.

**Vocadito** (Western solo singing, two human note annotations): what the app shows scores 58% note F1 against a 64% ceiling for any sargam-grid output; GAME's raw regions score 71% before snapping. Vocadito's annotators don't mark murki touches, so the Clean preset is penalised by design here.

## Honest limitations

- Without the Best engine, this is predominant-melody tracking on the full mix: a harmonium shadowing the voice, or a loud sarangi lead, can be picked up as the melody. A very loud tanpura is still the hardest case for the Fast engine.
- Sa is wrong on about one excerpt in eight even now. When it is, every swara name shifts — check Sa with the Drone first.
- Separation on the Best engine runs at roughly 2–3.5× real time on an M1 MacBook Air, so a 7-minute song takes 15–25 minutes the first time. The separated voice is cached on disk, so it never runs twice for the same file.
- The browser pitch shift (Pitch, beta) can sound processed on large shifts.
- Notation sustains are time-proportional; it does not force notes into a matra grid.

## Run locally

```sh
python3 -m http.server 4173
# open http://localhost:4173
```

No build step and no runtime dependencies. The optional local server is set up separately; see [`server/README.md`](server/README.md).

## Tests

```sh
npm test
```

This runs the DSP, notation, raga, client-contract and worker tests, plus the app-level accuracy benchmark from a committed fixture (no audio or Python needed). The same suite runs in GitHub Actions on every push and pull request. Server tests: `cd server && .venv/bin/python -m unittest discover -p 'test_*.py'`.

## Future path

- **Note-level Hindustani ground truth**: Saraga annotates motifs, not every note; corrected exports from real use would let the notation layer be scored note by note.
- **Faster separation**: a lighter vocal model, or chunked separation that streams notes as it goes.
- **Matra alignment**: snap notation to the detected taal grid, with avartan lines.
- **Bhatkhande-style PDF / MusicXML export.**

## License

MIT
