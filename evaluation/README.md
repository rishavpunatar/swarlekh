# SwarLekh accuracy evaluation

This directory keeps evaluation code and small result summaries in Git. Audio,
annotations, and generated feature caches stay local under ignored directories.

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

The evaluator mirrors the production local-vocal path: adaptive-floor Praat
cross-correlation at 4 ms, the server energy gate, gentle octave stabilization,
onset splitting, and the app's default Clean notation settings. Vocadito has no
Indian tonic labels, so its note score tests pitch and segmentation rather than
the spelling of `S r R ...`.

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

### 5. TONAS: ornamented-vocal boundary stress test

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
