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
- **Finds Sa** from the perfect-fifth structure plus a phrase-cadence prior (Sa is where phrases begin and resolve), offers the top candidates, flags close calls, and lets you check by ear against a Sa–Pa drone or set Sa from a sung note at the playhead.
- **Pitch contour** — the melody line with every sung note named, meends drawn as curves, the song's scale highlighted, beat and sam ticks when a taal is detected. Click to seek, drag the ruler to loop, pinch or ⌘-scroll to zoom.
- **Sargam notation** — one numbered line per phrase, following playback, with ornaments written out: kan `(R)G`, murki `(GRG)m`, meend `P⌒D⌒S'`, andolan `≈g`. Latin or Devanagari (komal and teevra marks kept).
- **Correct it** — drag a note dot up or down, add a missing note, or shape the connector into and out of a note. Corrections are saved on this device for that recording and come back when you upload it again.
- **Export** — copy the text, download `.txt` or `.json` (notes, timings, your corrections and the analysis input), print or save a PDF sheet, or download the synthesized melody as WAV.
- **Practise** — loop a line with ⟨ ⟩, ramp a loop from 0.65× to full speed, slow down without changing pitch, hear the *melody synth* on its own, and **sing along**: your own pitch draws over the contour live (microphone analysed in memory, never recorded).
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
      → octave stabilisation → tonic (Sa) detection
      → notation: GAME regions refined with the frame contour (js/dsp-regions.js)
        or contour segmentation (js/dsp.js) → phrases → raga analysis
```

Browser DSP is dependency-free JavaScript in a Web Worker (`js/dsp.js`, `js/dsp-regions.js`). The page enforces a strict Content-Security-Policy: no inline code, no third-party hosts, and network access only to its own origin and the local helper.

## Accuracy

Measured on Vocadito's 40 solo-vocal excerpts against two human note annotations (onset within 50 ms and pitch within 50 cents), with a singer-disjoint development/held-out split. Details: [`evaluation/README.md`](evaluation/README.md).

| What is scored | Note F1 (all) | Held-out singers |
|---|---:|---:|
| GAME's raw note regions | 70.9% | 70.5% |
| The same regions snapped to the sargam grid | 64.1% | — |
| **What the app shows** (Best engine, Clean preset) | **57.9%** | 63.1% |
| What the app shows, *Main notes only* | 61.3% | 64.5% |

Snapping to the grid of a single Sa costs about 7 points on its own, because Vocadito's singers drift off any fixed tuning. The Clean preset scores lower again by design: it writes out murki and kan touches that Western annotators don't mark as notes. These figures check that changes don't make things worse (`npm test` enforces floors on them). They are not Hindustani ground truth. Exported correction sets (`.json`) are the way to build that.

## Honest limitations

- Without the Best engine, this is predominant-melody tracking on the full mix: a harmonium shadowing the voice, or a loud sarangi lead, can be picked up as the melody.
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

- **Hindustani ground truth**: collect corrected exports (or Saraga's sargam phrase annotations) and score the notation layer on Indian music rather than Vocadito.
- **Faster separation**: a lighter vocal model, or chunked separation that streams notes as it goes.
- **Matra alignment**: snap notation to the detected taal grid, with avartan lines.
- **Bhatkhande-style PDF / MusicXML export.**

## License

MIT
