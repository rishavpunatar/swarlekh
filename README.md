# SwarLekh — स्वरलेख

**Sargam notation from your recordings.** Upload an MP3 of a Hindustani vocal performance and SwarLekh tracks the sung melody, finds Sa, and writes the song out as swara notation you can read, play along with, and learn from.

**Live: <https://rishavpunatar.github.io/swarlekh/>**

Everything runs in your browser. The audio is decoded, analyzed and notated entirely on your device — nothing is uploaded, there are no third-party assets, no analytics, and a strict Content-Security-Policy enforces it.

## What it does

- **Upload** an MP3 (or WAV/M4A/OGG/FLAC) by drag-and-drop.
- **Isolates the melody** — percussion is suppressed by band-limiting + spectral-flatness gating, and a Viterbi-smoothed pitch tracker follows the single predominant melodic line (the voice) rather than the accompaniment.
- **Finds Sa** automatically from a duration-weighted pitch-class histogram (with fifth/fourth reinforcement), and offers the top 3 candidates. You can override with any note + fine-tune in cents, and check it by ear against a built-in Sa–Pa drone.
- **Writes sargam, ornaments included** — quantized swaras with octave dots and komal/teevra marks, plus kan (grace notes), murki clusters, meend connectors, andolan/gamak oscillation marks, and fast taans written note-for-note. Three detail levels, from full alaap fidelity down to the bare melodic skeleton.
- **Helps you learn**: a scrolling pitch-contour view on a swara grid, click-any-note-to-seek, A–B loop, 0.5×–1× speed (pitch preserved), and a synthesized "melody only" track you can listen to instead of (or along with) the original.
- **Exports** the notation as text or JSON, and the extracted melody as a WAV.

## Notation legend

| Symbol | Meaning |
|---|---|
| `S r R g G m M P d D n N` | the 12 swaras — capitals shuddh, lowercase komal (re ga dha ni) |
| `m` / `M` | shuddh Ma / teevra Ma |
| `S'` or dot above | taar saptak (upper octave) |
| `.S` or dot below | mandra saptak (lower octave) |
| `(R)G` | kan — a grace-note touch of Re before Ga |
| `(GRG)m` | murki — a quick note cluster before the main swara |
| `R~G` | meend — a glide connecting two swaras |
| `≈G` | andolan / gamak — slow or heavy oscillation on the note |
| `~G` | unresolved glide within the note |
| `–` | sustain, ≈ 0.3 s per dash |

Ornament capture has three levels (Detailed / Balanced / Smooth). *Detailed* keeps every kan, murki, meend and andolan, and writes fast taans out note-for-note; *Smooth* keeps only the main melodic skeleton.

## How it works

```
mp3 → decode (Web Audio) → mono 16 kHz
    → band-pass 70–1800 Hz (kills tabla thumps & shimmer)
    → fast YIN (FFT-based difference function), 16 ms hop, multiple
      pitch candidates per frame + spectral-flatness percussion gate
    → Viterbi smoothing over candidates with an explicit unvoiced
      state (no octave jumps, drops out between phrases)
    → tonic detection: pitch-class histogram + perfect-fifth structure
      + phrase-cadence prior (Sa is where phrases begin & resolve) to
      avoid the classic Sa/Pa confusion → ranked Sa candidates
    → swara quantization with min-note merging → phrases → notation
```

All DSP is hand-rolled JavaScript (~no dependencies) running in a Web Worker; a 5-minute song takes roughly 5–10 s on a laptop.

## Honest limitations

- This is **predominant-melody extraction**, not studio-grade source separation. A harmonium shadowing the voice, or a loud sitar/sarangi lead, can be picked up as "the melody" — which is often still the line you want to learn, but worth knowing.
- Long instrumental intros will be notated too: use the A–B loop to focus on the sung sections, or raise *voicing strictness* if accompaniment leaks in.
- Notation is chromatic (any raga), but unmetered — there is no taal/beat alignment yet, so sustains are written in dashes of ~0.3 s rather than matras.
- Heavy reverb, duets, and very noisy recordings degrade tracking.

## Tips for best results

1. Choose recordings where the voice sits clearly above the accompaniment.
2. Confirm Sa first — toggle the drone against the recording, try the other candidates if it sounds off. Everything re-notates instantly.
3. Slow to 0.65× and loop one phrase at a time; switch "Listen to" → *Melody synth* to hear exactly what was transcribed.
4. If fast taans get smeared, shorten *min note length*; if ornaments clutter the notation, lengthen it.

## Run locally

```sh
python3 -m http.server 4173
# open http://localhost:4173
```

No build step, no dependencies.

## Tests

```sh
node --test tests/dsp.test.js
```

Covers the FFT, filters, YIN tracking (pure tones, glides), the full pipeline on a synthetic voice + tanpura + percussion mix, tonic detection, sargam mapping and notation rendering.

## Future path

- **True vocal separation, still on-device**: an opt-in neural model (e.g. Demucs/MDX via ONNX Runtime Web + WebGPU) downloaded on first use, for recordings where DSP isn't enough.
- **Raga-aware quantization**: constrain swaras to a chosen raga's scale and flag vivadi notes.
- **Taal alignment**: onset-based beat tracking so notation lands in matras with proper avartan lines.
- **Bhatkhande PDF / MusicXML export**, and a live microphone mode for practice feedback.

## License

MIT
