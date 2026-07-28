# SwarLekh — स्वरलेख

**Sargam notation from your recordings.** Upload an MP3 of a Hindustani vocal performance and SwarLekh tracks the sung melody, finds Sa, and writes the song out as swara notation you can read, play along with, and learn from.

**Live: <https://rishavpunatar.github.io/swarlekh/>**

The standard engine runs entirely in your browser. The Best engine sends audio
only to the optional server on `127.0.0.1`, where local vocal separation and
neural singing models run on your Mac. No recording or analysis leaves your
device, and there are no analytics.

## What it does

- **Upload** an MP3 (or WAV/M4A/OGG/FLAC) by drag-and-drop.
- **Isolates the voice** — the Best local engine uses BS-RoFormer or Demucs,
  then combines RMVPE with independent Praat voicing support.
- **Finds Sa** automatically using the perfect-fifth structure plus a phrase-cadence prior (Sa is where phrases begin and resolve), which avoids the classic Sa/Pa confusion; offers the top 3 candidates and flags low-confidence calls so you can verify. You can override with any note + fine-tune in cents, and check it by ear against a built-in Sa–Pa drone.
- **Writes sargam, ornaments included** — GAME's singing-specific neural
  segmenter separates discrete notes, repeated articulations and fast murkis;
  the continuous RMVPE contour retains meend and andolan character.
- **Analyses the raag** — distils the learner's worksheet from the recording: the swar-set (which swaras, sized by how much they're sung), the **thaat** (scale family), **aaroh/avaroh**, **vadi/samvadi**, **nyas** (resting notes), **jati**, and the **intonation** of each komal/teevra swara in cents (how it's actually pitched, not a prescriptive shruti). Tap any swara to spotlight every place it appears.
- **Names the raag** — suggests likely ragas from a built-in, fact-checked knowledge base of 36 common ragas, scoring the recording's scale, vadi/samvadi, aaroh/avaroh direction and **pakad** (catch-phrase) matches. Always a ranked shortlist with a plain rationale and honest confidence — never a single verdict (allied ragas that share a scale are flagged as such).
- **Suppresses percussion** — a harmonic/percussive separation pass (HPSS) attenuates tabla and transients before pitch tracking, so the voice is followed more cleanly on busy recordings.
- **Devanagari or Latin** — read the sargam as `S r G m P` or as `स रे ग म प ध नि`.
- **Merges octave-doubled voices** — when a second voice an octave away (or a tracking flip) muddies the register, it folds the line into one octave so the melody reads cleanly (auto / force / off).
- **Helps you learn**: a big live "Now singing" readout, a pitch-contour view with octave-band shading and the song's scale highlighted (held notes as labelled blocks, meends as glide ramps, andolan as swing-bands), the current line + swara highlighted as it plays, click-any-note-to-seek, A–B loop, 0.5×–1× speed (pitch preserved), and a synthesized "melody only" track.
- **Transposes to your Sa**: a ±12-semitone pitch shift (phase vocoder) lets you practise the same song in your own comfortable key without changing the tempo — and since sargam is relative to Sa, the notation stays identical.
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

The optional Best path instead runs local vocal separation, an RMVPE/Praat
pitch ensemble, and GAME singing-to-MIDI inference. See
[`server/README.md`](server/README.md) for its checksum-verified setup.

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
