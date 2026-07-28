#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  addCounts,
  evaluateNotes,
  scoresFromNoteCounts,
} = require('./metrics.js');

const EXTRACTOR = path.join(__dirname, 'extract_game_notes.py');
const EXTRACTOR_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(EXTRACTOR))
  .digest('hex')
  .slice(0, 12);
const DEFAULT_MODEL = path.resolve(
  __dirname,
  '..',
  'server',
  'models',
  'GAME-1.0.3-small-onnx'
);

function parseArgs(argv) {
  const args = {
    dataset: path.join(__dirname, 'data', 'vocadito'),
    cache: path.join(__dirname, 'cache', 'game'),
    python: process.env.SWARLEKH_GAME_PYTHON || 'python3',
    model: DEFAULT_MODEL,
    split: 'all',
    steps: 2,
    boundaryThreshold: 0.2,
    presenceThreshold: 0.2,
    radius: 2,
    seed: 20260728,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset') args.dataset = path.resolve(argv[++i]);
    else if (arg === '--cache') args.cache = path.resolve(argv[++i]);
    else if (arg === '--python') args.python = path.resolve(argv[++i]);
    else if (arg === '--model') args.model = path.resolve(argv[++i]);
    else if (arg === '--split') args.split = argv[++i];
    else if (arg === '--steps') args.steps = Number(argv[++i]);
    else if (arg === '--boundary-threshold') args.boundaryThreshold = Number(argv[++i]);
    else if (arg === '--presence-threshold') args.presenceThreshold = Number(argv[++i]);
    else if (arg === '--radius') args.radius = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!fs.existsSync(args.model)) {
    throw new Error(`GAME model not found at ${args.model}. Run server/install-models.sh first.`);
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

function splitForSinger(singerId) {
  const hash = crypto.createHash('sha256').update(`vocadito:${singerId}`).digest();
  return hash.readUInt32BE(0) % 3 === 0 ? 'test' : 'development';
}

function loadMetadata(dataset) {
  const rows = parseCsv(path.join(dataset, 'vocadito_metadata.csv'));
  const header = rows.shift();
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]])));
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

function modelFingerprint(model) {
  const files = [
    'config.json',
    'encoder.onnx',
    'segmenter.onnx',
    'bd2dur.onnx',
    'estimator.onnx',
  ];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(model, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

function extractPrediction(track, args, fingerprint) {
  fs.mkdirSync(args.cache, { recursive: true });
  const parameterKey = [
    path.basename(args.model),
    fingerprint,
    EXTRACTOR_HASH,
    `s${args.steps}`,
    `b${args.boundaryThreshold}`,
    `p${args.presenceThreshold}`,
    `r${args.radius}`,
    `seed${args.seed}`,
  ].join('-');
  const cacheFile = path.join(args.cache, `vocadito_${track.track_id}_${parameterKey}.json`);
  if (!fs.existsSync(cacheFile)) {
    const audio = path.join(args.dataset, 'Audio', `vocadito_${track.track_id}.wav`);
    const result = childProcess.spawnSync(
      args.python,
      [
        EXTRACTOR,
        audio,
        args.model,
        cacheFile,
        '--steps', String(args.steps),
        '--boundary-threshold', String(args.boundaryThreshold),
        '--presence-threshold', String(args.presenceThreshold),
        '--radius', String(args.radius),
        '--seed', String(args.seed),
      ],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(`GAME failed for track ${track.track_id}:\n${result.stderr}`);
    }
  }
  const prediction = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  return prediction.notes.map((note) => ({
    onset: note.onset,
    offset: note.offset,
    frequency: 440 * Math.pow(2, (note.midi - 69) / 12),
  }));
}

function evaluate(args) {
  const fingerprint = modelFingerprint(args.model);
  const metadata = loadMetadata(args.dataset);
  const aggregate = {
    onset: {},
    strict: {},
    annotatorOnset: {},
    annotatorStrict: {},
    tracks: 0,
    singers: new Set(),
  };

  for (let index = 0; index < metadata.length; index++) {
    const track = metadata[index];
    const split = splitForSinger(track.singer_id);
    if (args.split !== 'all' && split !== args.split) continue;
    process.stdout.write(`\rGAME ${args.split} ${aggregate.tracks + 1}`);
    const prefix = `vocadito_${track.track_id}`;
    const notesA1 = loadReferenceNotes(
      path.join(args.dataset, 'Annotations', 'Notes', `${prefix}_notesA1.csv`)
    );
    const notesA2 = loadReferenceNotes(
      path.join(args.dataset, 'Annotations', 'Notes', `${prefix}_notesA2.csv`)
    );
    const estimated = extractPrediction(track, args, fingerprint);
    for (const reference of [notesA1, notesA2]) {
      addCounts(aggregate.onset, evaluateNotes(reference, estimated, false).counts);
      addCounts(aggregate.strict, evaluateNotes(reference, estimated, true).counts);
    }
    addCounts(aggregate.annotatorOnset, evaluateNotes(notesA1, notesA2, false).counts);
    addCounts(aggregate.annotatorStrict, evaluateNotes(notesA1, notesA2, true).counts);
    aggregate.tracks++;
    aggregate.singers.add(track.singer_id);
  }
  process.stdout.write('\n');

  const result = {
    dataset: 'Vocadito 1.0',
    model: path.basename(args.model),
    modelFingerprint: fingerprint,
    split: args.split,
    tracks: aggregate.tracks,
    singers: aggregate.singers.size,
    parameters: {
      steps: args.steps,
      boundaryThreshold: args.boundaryThreshold,
      presenceThreshold: args.presenceThreshold,
      radius: args.radius,
      seed: args.seed,
    },
    notes: {
      onsetPitch: scoresFromNoteCounts(aggregate.onset),
      onsetOffsetPitch: scoresFromNoteCounts(aggregate.strict),
      annotatorAgreementOnsetPitch: scoresFromNoteCounts(aggregate.annotatorOnset),
      annotatorAgreementOnsetOffsetPitch: scoresFromNoteCounts(aggregate.annotatorStrict),
    },
    counts: {
      onset: aggregate.onset,
      strict: aggregate.strict,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

try {
  evaluate(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
