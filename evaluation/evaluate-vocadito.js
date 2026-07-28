#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DSP = require('../js/dsp.js');
const {
  addCounts,
  evaluateNotes,
  evaluatePitch,
  scoresFromNoteCounts,
  scoresFromPitchCounts,
} = require('./metrics.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(__dirname, 'data', 'vocadito');
const DEFAULT_CACHE = path.join(__dirname, 'cache', 'vocadito');
const EXTRACTOR = path.join(__dirname, 'extract_vocal_features.py');
const EXTRACTOR_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(EXTRACTOR))
  .digest('hex')
  .slice(0, 12);
const BASELINE = Object.freeze({
  clarityThresh: 0.5,
  minNoteMs: 130,
  ornMinMs: 25,
  onsetMinMs: 100,
  gateCentsPerSec: 900,
  quantizeHysteresisCents: 12,
});

function parseArgs(argv) {
  const args = {
    dataset: DEFAULT_DATASET,
    cache: DEFAULT_CACHE,
    python: process.env.SWARLEKH_PYTHON || path.join(ROOT, 'server', '.venv', 'bin', 'python'),
    split: 'all',
    output: null,
    tune: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tune') args.tune = true;
    else if (arg === '--dataset') args.dataset = path.resolve(argv[++i]);
    else if (arg === '--cache') args.cache = path.resolve(argv[++i]);
    else if (arg === '--python') args.python = path.resolve(argv[++i]);
    else if (arg === '--split') args.split = argv[++i];
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['all', 'development', 'test'].includes(args.split)) {
    throw new Error('--split must be all, development, or test');
  }
  return args;
}

function parseCsv(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(','));
}

function loadMetadata(dataset) {
  const rows = parseCsv(path.join(dataset, 'vocadito_metadata.csv'));
  const header = rows.shift();
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]])));
}

function splitForSinger(singerId) {
  const hash = crypto.createHash('sha256').update(`vocadito:${singerId}`).digest();
  return hash.readUInt32BE(0) % 3 === 0 ? 'test' : 'development';
}

function loadReferenceF0(file) {
  const rows = parseCsv(file);
  return {
    times: rows.map((row) => Number(row[0])),
    f0: rows.map((row) => Number(row[1])),
  };
}

function loadReferenceNotes(file) {
  return parseCsv(file).map((row) => {
    const onset = Number(row[0]);
    return {
      onset,
      frequency: Number(row[1]),
      offset: onset + Number(row[2]),
    };
  });
}

function resolvePython(requested) {
  if (fs.existsSync(requested)) return requested;
  const fallback = childProcess.spawnSync('which', ['python3'], { encoding: 'utf8' });
  if (fallback.status === 0) return fallback.stdout.trim();
  throw new Error(
    `Python not found at ${requested}. Set SWARLEKH_PYTHON to the local-server venv.`
  );
}

function extractFeatures(track, args, python) {
  fs.mkdirSync(args.cache, { recursive: true });
  const audio = path.join(args.dataset, 'Audio', `vocadito_${track.track_id}.wav`);
  const cacheFile = path.join(
    args.cache,
    `vocadito_${track.track_id}_${EXTRACTOR_HASH}.json`
  );
  if (!fs.existsSync(cacheFile)) {
    const result = childProcess.spawnSync(
      python,
      [EXTRACTOR, audio, cacheFile],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(`Feature extraction failed for track ${track.track_id}:\n${result.stderr}`);
    }
  }
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
}

function loadTracks(args) {
  if (!fs.existsSync(path.join(args.dataset, 'vocadito_metadata.csv'))) {
    throw new Error(
      `Vocadito not found at ${args.dataset}. Run npm run benchmark:download:vocadito first.`
    );
  }
  const python = resolvePython(args.python);
  return loadMetadata(args.dataset).map((metadata, index, all) => {
    const split = splitForSinger(metadata.singer_id);
    process.stdout.write(`\rExtracting vocal features ${index + 1}/${all.length}`);
    const features = extractFeatures(metadata, args, python);
    const prefix = `vocadito_${metadata.track_id}`;
    return {
      id: metadata.track_id,
      singer: metadata.singer_id,
      language: metadata.language,
      split,
      features,
      f0: loadReferenceF0(path.join(args.dataset, 'Annotations', 'F0', `${prefix}_f0.csv`)),
      notesA1: loadReferenceNotes(
        path.join(args.dataset, 'Annotations', 'Notes', `${prefix}_notesA1.csv`)
      ),
      notesA2: loadReferenceNotes(
        path.join(args.dataset, 'Annotations', 'Notes', `${prefix}_notesA2.csv`)
      ),
    };
  });
}

function estimatedNotes(track, config) {
  if (!track.productionAnalysis) {
    const features = track.features;
    const f0 = Float32Array.from(features.f0);
    const clarity = Float32Array.from(features.clarity);
    const rms = Float32Array.from(features.rms);
    const stabilized = DSP.stabilizeOctave(
      f0, clarity, rms, features.hopSec, 'gentle'
    ).f0;
    const onsets = features.onsets.map((time) => Math.round(time / features.hopSec));
    const tonicCandidates = DSP.detectTonic(stabilized, clarity, features.hopSec, rms);
    // Vocadito has no tonic annotation and its singers are not guaranteed to use
    // concert A=440. Any correctly detected swara anchor also recovers the clip's
    // tuning offset, which is what the production app uses for its semitone grid.
    const saHz = tonicCandidates.length ? tonicCandidates[0].hz : 440;
    track.productionAnalysis = {
      stabilized,
      clarity,
      rms,
      onsets,
      saHz,
      hopSec: features.hopSec,
    };
  }
  const analysis = track.productionAnalysis;
  const result = DSP.notate(
    analysis.stabilized,
    analysis.clarity,
    analysis.hopSec,
    analysis.saHz,
    {
      ...config,
      clean: true,
      ornaments: true,
      onsets: analysis.onsets,
      rms: analysis.rms,
    }
  );
  return {
    pitchTrack: {
      f0: analysis.stabilized,
      clarity: analysis.clarity,
      hopSec: analysis.hopSec,
    },
    notes: result.tokens.map((token) => ({
      onset: token.t0,
      offset: token.t1,
      frequency: analysis.saHz * Math.pow(2, token.k / 12),
    })),
  };
}

function emptyAggregate() {
  return {
    pitch: {},
    noteOnset: {},
    noteStrict: {},
    annotatorOnset: {},
    annotatorStrict: {},
    trackCount: 0,
    singerIds: new Set(),
  };
}

function evaluateConfiguration(tracks, config) {
  const aggregate = emptyAggregate();
  for (const track of tracks) {
    const estimated = estimatedNotes(track, config);
    const pitch = evaluatePitch(track.f0, estimated.pitchTrack, config.clarityThresh);
    addCounts(aggregate.pitch, pitch.counts);

    for (const reference of [track.notesA1, track.notesA2]) {
      addCounts(aggregate.noteOnset, evaluateNotes(reference, estimated.notes, false).counts);
      addCounts(aggregate.noteStrict, evaluateNotes(reference, estimated.notes, true).counts);
    }
    addCounts(
      aggregate.annotatorOnset,
      evaluateNotes(track.notesA1, track.notesA2, false).counts
    );
    addCounts(
      aggregate.annotatorStrict,
      evaluateNotes(track.notesA1, track.notesA2, true).counts
    );
    aggregate.trackCount++;
    aggregate.singerIds.add(track.singer);
  }
  return {
    tracks: aggregate.trackCount,
    singers: aggregate.singerIds.size,
    pitch: scoresFromPitchCounts(aggregate.pitch),
    notes: {
      onsetPitch: scoresFromNoteCounts(aggregate.noteOnset),
      onsetOffsetPitch: scoresFromNoteCounts(aggregate.noteStrict),
      annotatorAgreementOnsetPitch: scoresFromNoteCounts(aggregate.annotatorOnset),
      annotatorAgreementOnsetOffsetPitch: scoresFromNoteCounts(aggregate.annotatorStrict),
    },
    counts: {
      pitch: aggregate.pitch,
      noteOnset: aggregate.noteOnset,
      noteStrict: aggregate.noteStrict,
      annotatorOnset: aggregate.annotatorOnset,
      annotatorStrict: aggregate.annotatorStrict,
    },
  };
}

function tuningGrid() {
  const configs = [];
  for (const clarityThresh of [0.45, 0.5, 0.55]) {
    for (const minNoteMs of [90, 110, 130, 150]) {
      for (const ornMinMs of [20, 25, 30]) {
        for (const gateCentsPerSec of [700, 900, 1100]) {
          configs.push({
            ...BASELINE,
            clarityThresh,
            minNoteMs,
            ornMinMs,
            gateCentsPerSec,
          });
        }
      }
    }
  }
  return configs;
}

function tuningScore(result) {
  return (
    0.7 * result.notes.onsetPitch.f1 +
    0.2 * result.notes.onsetOffsetPitch.f1 +
    0.1 * result.pitch.rawPitchAccuracy
  );
}

function percent(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function printResult(label, config, result) {
  console.log(`\n${label} (${result.tracks} tracks, ${result.singers} singers)`);
  console.log(`  config                 ${JSON.stringify(config)}`);
  console.log(`  raw pitch accuracy     ${percent(result.pitch.rawPitchAccuracy)}`);
  console.log(`  raw chroma accuracy    ${percent(result.pitch.rawChromaAccuracy)}`);
  console.log(`  overall accuracy       ${percent(result.pitch.overallAccuracy)}`);
  console.log(`  voicing recall         ${percent(result.pitch.voicingRecall)}`);
  console.log(`  voicing false alarm    ${percent(result.pitch.voicingFalseAlarm)}`);
  console.log(`  note onset/pitch F1    ${percent(result.notes.onsetPitch.f1)}`);
  console.log(`  note + offset F1       ${percent(result.notes.onsetOffsetPitch.f1)}`);
  console.log(
    `  annotator agreement    ${percent(result.notes.annotatorAgreementOnsetPitch.f1)} onset, ` +
    `${percent(result.notes.annotatorAgreementOnsetOffsetPitch.f1)} strict`
  );
}

function run(args) {
  const allTracks = loadTracks(args);
  process.stdout.write('\n');
  const development = allTracks.filter((track) => track.split === 'development');
  const test = allTracks.filter((track) => track.split === 'test');
  const result = {
    dataset: 'Vocadito 1.0',
    generatedAt: new Date().toISOString(),
    splitPolicy: 'Singer-disjoint SHA-256 partition; hash modulo 3 equals 0 is held-out test.',
    baselineConfig: BASELINE,
  };

  if (args.tune) {
    const baselineDevelopment = evaluateConfiguration(development, BASELINE);
    const baselineTest = evaluateConfiguration(test, BASELINE);
    let best = null;
    const grid = tuningGrid();
    for (let i = 0; i < grid.length; i++) {
      process.stdout.write(`\rTuning on development singers ${i + 1}/${grid.length}`);
      const developmentResult = evaluateConfiguration(development, grid[i]);
      const score = tuningScore(developmentResult);
      if (!best || score > best.score) best = { config: grid[i], developmentResult, score };
    }
    process.stdout.write('\n');
    const tunedTest = evaluateConfiguration(test, best.config);
    printResult('Baseline development', BASELINE, baselineDevelopment);
    printResult('Baseline held-out test', BASELINE, baselineTest);
    printResult('Tuned development', best.config, best.developmentResult);
    printResult('Tuned held-out test', best.config, tunedTest);
    Object.assign(result, {
      mode: 'development-tuning-with-held-out-test',
      baselineDevelopment,
      baselineTest,
      tunedConfig: best.config,
      tunedDevelopment: best.developmentResult,
      tunedTest,
    });
  } else {
    const selected = args.split === 'all'
      ? allTracks
      : allTracks.filter((track) => track.split === args.split);
    const baseline = evaluateConfiguration(selected, BASELINE);
    printResult(`Baseline ${args.split}`, BASELINE, baseline);
    Object.assign(result, { mode: 'baseline', split: args.split, baseline });
  }

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote ${args.output}`);
  }
}

try {
  run(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
