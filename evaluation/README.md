# SwarLekh accuracy evaluation

This directory keeps evaluation code and small result summaries in Git. Audio,
annotations, and generated feature caches stay local under ignored directories.

## App-level benchmark (runs in `npm test`)

The other scripts below score model outputs. This one scores **what the app
shows**: the Best engine's fused RMVPE/Praat pitch and GAME regions, passed
through the same steps as the browser (gentle octave pass, tonic detection,
`DSP.notateRegions` with the Clean preset). Those notes are compared with
Vocadito's two human annotations.

```sh
node evaluation/app-benchmark.js            # all splits, human-readable
node evaluation/app-benchmark.js --json
SWARLEKH_DSP=path/to/other/dsp.js node evaluation/app-benchmark.js   # A/B a variant
```

It reads `fixtures/vocadito-best.json.gz` (500 KB, committed): the cached
model outputs plus reference notes for all 40 tracks. No Python, audio or
model weights are needed, so it runs in CI. Rebuild the fixture after
re-extracting the caches with `node evaluation/build-app-fixture.js`.
`tests/app-benchmark.test.js` enforces floors so a change that lowers the
shown-note F1 fails the suite.

Reading the numbers (all 40 tracks, onset + pitch F1):

| Pipeline | F1 |
| --- | ---: |
| GAME raw regions (model only) | 70.94% |
| GAME regions snapped to the Sa grid (ceiling for sargam output) | 64.06% |
| App at `c04e5d4` (28 Jul, before the murki passes) | 64.32% |
| App before the vibrato gate (`3bc10e7`) | 57.64% |
| **App now, Clean preset** | **57.94%** |
| App now, Main-notes preset | 61.28% |

Vocadito is Western and multilingual solo singing. Its annotators don't mark
murki or kan touches as notes, so the Clean preset's ornament notes count as
false positives here by design. Ablation on the development split showed the
loss comes from the raw-contour recovery passes (`fuseTurningOrnaments`,
`fuseRawNeighborTurns`, `fuseRawMurkiClusters`). Their inserted notes match a
human note 26–45% of the time, against 73% for GAME's own. Vibrato was the one
failure that is wrong in any tradition, so those touches are now folded back
into the held note. The rest needs Hindustani ground truth to judge: the
app's `.json` export carries corrected notes alongside the analysis input,
which makes it the raw material for that set.

## Real Hindustani recordings: Saraga (`evaluate-saraga.js`)

Saraga 1.5 Hindustani (CC BY-NC-SA 4.0) has 108 concert recordings with the
singer's annotated tonic, and 53 with hand-annotated sargam motifs ("NrG",
"MGrS", …). The evaluator takes three 90 s excerpts per vocal recording (25,
50 and 75% through, as a user would upload a clip) and scores:

- **Sa**: pitch class within 50 cents of the annotated tonic, and the octave;
- **phrases**: each annotated motif inside an excerpt is looked for, in order,
  in the app's swaras over its span — with the app's Sa, and with the
  annotated Sa to separate note errors from tonic errors.

```sh
# one-time: ~4 GB from https://zenodo.org/records/4301737 into evaluation/data/saraga/
node evaluation/evaluate-saraga.js --split holdout            # Fast engine
node evaluation/evaluate-saraga.js --engine best --split holdout --every 5 --positions 0.5
```

Recordings are sorted by id; every third is the **tuning** split (used to set
the tanpura weight and octave gate), the other 64 are **held out**. Held-out
results, Fast engine (`results/saraga-holdout-fast.json`):

| | main @ 215523c | now |
| --- | ---: | ---: |
| Sa pitch class | 57.3% | 87.0% |
| Sa + octave | 25.5% | 71.9% |
| phrases found | 22.0% | 44.3% |
| phrases found with the annotated Sa | 51.1% | 51.5% |

What moved it, each measured here: tonic evidence from the tanpura's
persistent spectral lines (alone it names Sa in ~92% of excerpts); octave
restructuring only on gross errors (octave-sized frame jumps are everywhere
in real concert mixes — median 34 per 90 s — so they are not evidence); the
tanpura's absolute pitch choosing Sa's octave.

## Known answers: synthetic Hindustani (`synthetic-hindustani.js`)

Every raga in `js/ragas.js` rendered from its own aaroh, avaroh and pakads with
raga intonation (Bhairav's low komal re, Darbari's andolit ga), meends,
vibrato, breaths and optional drift; for the Fast engine, voice with formants
plus tanpura and tabla at fixed levels. Scores Sa, octave, every swara,
spurious notes, false splits of held notes, and re-sung repeats kept.
`tests/synthetic-hindustani.test.js` holds floors on a subset. Synthetic
voices are simpler than real ones, so this locates failure modes; Saraga
measures real accuracy.

## Quick benchmark

Vocadito is the small, manually annotated smoke test. It contains 40 isolated
solo-vocal excerpts, frame-level F0, and two independent note transcriptions.

```sh
npm run benchmark:download:vocadito

# Use the same Python environment as the local analysis server.
SWARLEKH_PYTHON=server/.venv/bin/python \
  npm run benchmark:vocadito -- --output evaluation/results/vocadito-baseline.json

# Tune only on development singers, then score once on held-out singers.
SWARLEKH_PYTHON=server/.venv/bin/python \
  npm run benchmark:tune:vocadito -- --output evaluation/results/vocadito-tuning.json
```

The fixed split is singer-disjoint. A singer is assigned to the held-out test
set when the first 32 bits of `SHA-256("vocadito:" + singer_id)` modulo 3 equal
zero. Do not choose parameters from the held-out result.

Metrics:

- raw pitch accuracy: reference-vocal frames within 50 cents, octave-sensitive
- raw chroma accuracy: the same measure with octave errors ignored
- overall accuracy: correct pitch plus correct unvoiced frames
- voicing recall and false-alarm rate
- note F1: one-to-one matches within 50 ms onset and 50 cents
- strict note F1: also requires offset within 50 ms or 20% of note duration
- annotator agreement: the same note metrics between the two human labels

The baseline evaluator freezes the previous local-vocal path: adaptive-floor
Praat cross-correlation at 4 ms, the server energy gate, gentle octave
stabilization, onset splitting, and the app's default Clean notation settings.
Vocadito has no Indian tonic labels, so its note score tests pitch and
segmentation rather than the spelling of `S r R ...`.

## Neural benchmarks

Install the local models, then extract RMVPE predictions once:

```sh
server/install-models.sh
server/.venv/bin/python evaluation/extract_rmvpe_features.py \
  evaluation/data/vocadito evaluation/cache/rmvpe-vocadito.json
```

Evaluate the frozen RMVPE/Praat fusion and GAME note model:

```sh
npm run benchmark:pitch -- \
  --predictions evaluation/cache/rmvpe-vocadito.json \
  --praat-cache evaluation/cache/vocadito \
  --baseline evaluation/results/vocadito-tuning.json \
  --split development

SWARLEKH_GAME_PYTHON=server/.venv/bin/python \
  npm run benchmark:game -- --split development
```

The independent VocalSet script requires the official 2.5 GB VocalSet archive
and corrected annotation archive. It selects one scale and one arpeggio per
singer by a fixed filename hash and pins the `extended 1` annotation tree:

```sh
SWARLEKH_PYTHON=server/.venv/bin/python \
  npm run benchmark:vocalset -- \
  --audio-zip /path/to/VocalSet.zip \
  --annotations-zip /path/to/Annotated-VocalSet.zip
```

## Dataset stack

### 1. Saraga Hindustani: primary Indian notation benchmark

- 108 Hindustani recordings with tonic labels
- 53 recordings with manually transcribed melodic phrase sequences using
  sargam symbols
- best source for Sa accuracy and phrase-level sargam edit distance
- limitation: phrase annotations give the interval and symbol sequence, not
  the boundary of every note; the supplied frame-pitch track is automatic
- download: approximately 4.1 GB
- license: CC BY-NC 4.0 for audio and annotations
- source: https://mtg.github.io/saraga/
- archive: https://zenodo.org/records/4301737

### 2. Saraga Carnatic: isolated Indian vocals

- 249 recordings with tonic labels
- 168 recordings with isolated lead-vocal stems and vocal pitch tracks
- 117 recordings with manually transcribed melodic phrases
- useful for testing vocal-only processing separately from accompaniment
- download: approximately 14.4 GB
- license: CC BY-NC 4.0 for audio and annotations
- source: https://mtg.github.io/saraga/

### 3. Saraga-Carnatic-Melody-Synth (SCMS): tuning pitch extraction

- 2,460 mostly 30-second clips
- aligned vocal F0, vocal activation, tonic, and singer-separated train/test
  metadata
- useful for training or tuning vocal melody extraction before an untouched
  artist test
- download: approximately 24 GB
- caveat: labels are generated through a Carnatic-aware analysis/synthesis
  process, not manually marked frame by frame
- source: https://zenodo.org/records/5553925
- license warning: Zenodo currently marks CC BY 4.0 while the `mirdata` loader
  records CC BY-NC-SA 4.0; use the more restrictive terms until clarified

### 4. Vocadito: small manual pitch and note benchmark

- 40 isolated monophonic vocal excerpts by 29 singers in seven languages
- manually corrected frame F0 and two note annotations
- 58.5 MB, CC BY 4.0
- source: https://zenodo.org/records/5578807

### 5. Annotated VocalSet: independent singer generalization

- 20 professional singers spanning male and female voices
- corrected note boundaries and nominal pitches for scales and arpeggios
- useful for cross-corpus testing across straight, breathy, belt, vibrato,
  lip-trill, fast, slow, loud, and quiet singing
- audio: https://zenodo.org/records/10200775
- corrected annotations: https://zenodo.org/records/7061507

### 6. TONAS: ornamented-vocal boundary stress test

- 72 a cappella flamenco excerpts with corrected F0 and note
  onset/duration/pitch envelopes
- useful as a secondary melisma and ornament boundary test
- internal, non-commercial research terms; do not redistribute
- source: https://www.upf.edu/web/mtg/tonas

## Evaluation policy

Use SCMS training singers and the Vocadito development partition for parameter
search. Keep the SCMS artist test, Vocadito held-out singers, and a fixed subset
of Saraga performances untouched until a candidate is frozen. Report separate
scores for:

1. Sa pitch class and octave placement on Saraga.
2. Frame F0 and voicing on isolated vocals.
3. Note onsets, offsets, and pitch on manual annotations.
4. Sargam phrase sequence edit distance on Saraga manual phrases.
5. The same measurements after mixing vocals with accompaniment, to isolate the
   effect of source separation.

Do not tune against Saraga's automatic Melodia pitch files as if they were
ground truth. They are useful as a baseline, not as a definitive label.
