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
  scoresFromNoteCounts,
} = require('./metrics.js');

const ROOT = path.resolve(__dirname, '..');
const GAME_EXTRACTOR = path.join(__dirname, 'extract_game_notes.py');
const FEATURE_EXTRACTOR = path.join(__dirname, 'extract_vocal_features.py');
const BASELINE = Object.freeze({
  clarityThresh: 0.5,
  minNoteMs: 130,
  ornMinMs: 25,
  onsetMinMs: 100,
  gateCentsPerSec: 900,
  quantizeHysteresisCents: 12,
});
const GAME_PARAMETERS = Object.freeze({
  steps: 2,
  boundaryThreshold: 0.2,
  presenceThreshold: 0.2,
  radius: 2,
  seed: 20260728,
});

function parseArgs(argv) {
  const args = {
    audioZip: null,
    annotationsZip: null,
    model: path.join(ROOT, 'server', 'models', 'GAME-1.0.3-small-onnx'),
    python: process.env.SWARLEKH_PYTHON ||
      path.join(ROOT, 'server', '.venv', 'bin', 'python'),
    cache: path.join(__dirname, 'cache', 'vocalset'),
    output: path.join(__dirname, 'results', 'vocalset-independent.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--audio-zip') args.audioZip = path.resolve(argv[++i]);
    else if (arg === '--annotations-zip') args.annotationsZip = path.resolve(argv[++i]);
    else if (arg === '--model') args.model = path.resolve(argv[++i]);
    else if (arg === '--python') args.python = path.resolve(argv[++i]);
    else if (arg === '--cache') args.cache = path.resolve(argv[++i]);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const [name, value] of [
    ['--audio-zip', args.audioZip],
    ['--annotations-zip', args.annotationsZip],
    ['--model', args.model],
    ['--python', args.python],
  ]) {
    if (!value || !fs.existsSync(value)) throw new Error(`${name} is missing: ${value || ''}`);
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = childProcess.spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}):\n${result.stderr || result.stdout || ''}`
    );
  }
  return result.stdout;
}

function zipEntries(zip) {
  return run('unzip', ['-Z1', zip]).trim().split(/\r?\n/).filter(Boolean);
}

function basenameWithoutExtension(entry) {
  return path.basename(entry).replace(/\.[^.]+$/, '');
}

function singerFromBasename(basename) {
  const match = /^([fm])(\d+)_/.exec(basename);
  return match ? `${match[1] === 'f' ? 'female' : 'male'}${Number(match[2])}` : null;
}

function kindFromBasename(basename) {
  if (basename.includes('_scales_')) return 'scales';
  if (basename.includes('_arpeggios_')) return 'arpeggios';
  return null;
}

function sampleRank(basename) {
  return crypto.createHash('sha256')
    .update(`swarlekh:vocalset-independent:v1:${basename}`)
    .digest('hex');
}

function selectSingerBalancedSample(audioZip, annotationsZip) {
  const audioByBasename = new Map();
  for (const entry of zipEntries(audioZip)) {
    if (!/\/(scales|arpeggios)\/.*\.wav$/i.test(entry)) continue;
    audioByBasename.set(basenameWithoutExtension(entry), entry);
  }

  const annotationByBasename = new Map();
  for (const entry of zipEntries(annotationsZip)) {
    if (!/^Annotated VocalSet\/extended 1\/with file header\/.*\.csv$/i.test(entry)) {
      continue;
    }
    annotationByBasename.set(basenameWithoutExtension(entry), entry);
  }

  const groups = new Map();
  for (const [basename, audioEntry] of audioByBasename) {
    const annotationEntry = annotationByBasename.get(basename);
    const singer = singerFromBasename(basename);
    const kind = kindFromBasename(basename);
    if (!annotationEntry || !singer || !kind) continue;
    const key = `${singer}:${kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      basename,
      singer,
      kind,
      audioEntry,
      annotationEntry,
      rank: sampleRank(basename),
    });
  }

  const singers = [...new Set(
    [...groups.keys()].map((key) => key.split(':')[0])
  )].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const selected = [];
  for (const singer of singers) {
    for (const kind of ['scales', 'arpeggios']) {
      const candidates = groups.get(`${singer}:${kind}`) || [];
      if (!candidates.length) {
        throw new Error(`No annotated ${kind} candidate for ${singer}`);
      }
      candidates.sort((a, b) => a.rank.localeCompare(b.rank));
      selected.push(candidates[0]);
    }
  }
  if (singers.length !== 20 || selected.length !== 40) {
    throw new Error(`Expected 20 singers and 40 tracks; found ${singers.length} and ${selected.length}`);
  }
  return selected;
}

function extractZipEntry(zip, entry, output) {
  if (fs.existsSync(output)) return;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const outputFd = fs.openSync(output, 'w');
  try {
    run('unzip', ['-p', zip, entry], {
      encoding: null,
      stdio: ['ignore', outputFd, 'pipe'],
    });
  } finally {
    fs.closeSync(outputFd);
  }
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadReferenceNotes(annotationsZip, entry) {
  const text = run('unzip', ['-p', annotationsZip, entry]);
  const rows = csvRows(text);
  const headerIndex = rows.findIndex((row) => row[0] === 'Sequence');
  if (headerIndex < 0) throw new Error(`Annotation header not found in ${entry}`);
  const header = rows[headerIndex];
  const index = Object.fromEntries(
    header.map((name, column) => [name.trim(), column])
  );
  return rows.slice(headerIndex + 1)
    .filter((row) => (row[index.Type] || '').trim() === 'Sound')
    .map((row) => ({
      onset: Number(row[index['Start time']]),
      offset: Number(row[index['End time']]),
      frequency: Number(row[index['Ground Truth Frequency']]),
    }))
    .filter((note) => note.frequency > 0 && note.offset > note.onset);
}

function cacheKey(prefix, basename) {
  const extractor = prefix === 'game' ? GAME_EXTRACTOR : FEATURE_EXTRACTOR;
  const extractorHash = crypto.createHash('sha256')
    .update(fs.readFileSync(extractor))
    .digest('hex')
    .slice(0, 12);
  return `${prefix}-${basename}-${extractorHash}`;
}

function modelFingerprint(model) {
  const files = ['config.json', 'encoder.onnx', 'segmenter.onnx', 'bd2dur.onnx', 'estimator.onnx'];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(model, file)));
  }
  return hash.digest('hex');
}

function extractGame(audio, track, args, fingerprint) {
  const parameters = Object.values(GAME_PARAMETERS).join('-');
  const output = path.join(
    args.cache,
    'predictions',
    `${cacheKey('game', track.basename)}-${fingerprint.slice(0, 12)}-${parameters}.json`
  );
  if (!fs.existsSync(output)) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    run(args.python, [
      GAME_EXTRACTOR,
      audio,
      args.model,
      output,
      '--steps', String(GAME_PARAMETERS.steps),
      '--boundary-threshold', String(GAME_PARAMETERS.boundaryThreshold),
      '--presence-threshold', String(GAME_PARAMETERS.presenceThreshold),
      '--radius', String(GAME_PARAMETERS.radius),
      '--seed', String(GAME_PARAMETERS.seed),
    ]);
  }
  return JSON.parse(fs.readFileSync(output, 'utf8')).notes.map((note) => ({
    onset: note.onset,
    offset: note.offset,
    frequency: 440 * Math.pow(2, (note.midi - 69) / 12),
  }));
}

function extractBaseline(audio, track, args) {
  const output = path.join(
    args.cache,
    'features',
    `${cacheKey('baseline', track.basename)}.json`
  );
  if (!fs.existsSync(output)) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    run(args.python, [FEATURE_EXTRACTOR, audio, output]);
  }
  const features = JSON.parse(fs.readFileSync(output, 'utf8'));
  const f0 = Float32Array.from(features.f0);
  const clarity = Float32Array.from(features.clarity);
  const rms = Float32Array.from(features.rms);
  const stabilized = DSP.stabilizeOctave(
    f0, clarity, rms, features.hopSec, 'gentle'
  ).f0;
  const candidates = DSP.detectTonic(stabilized, clarity, features.hopSec, rms);
  const saHz = candidates.length ? candidates[0].hz : 440;
  const notation = DSP.notate(stabilized, clarity, features.hopSec, saHz, {
    ...BASELINE,
    clean: true,
    ornaments: true,
    onsets: features.onsets.map((time) => Math.round(time / features.hopSec)),
    rms,
  });
  return notation.tokens.map((token) => ({
    onset: token.t0,
    offset: token.t1,
    frequency: saHz * Math.pow(2, token.k / 12),
  }));
}

function addEvaluation(aggregate, reference, estimated) {
  addCounts(aggregate.onset, evaluateNotes(reference, estimated, false).counts);
  addCounts(aggregate.strict, evaluateNotes(reference, estimated, true).counts);
}

function evaluate(args) {
  fs.mkdirSync(args.cache, { recursive: true });
  const selected = selectSingerBalancedSample(args.audioZip, args.annotationsZip);
  const fingerprint = modelFingerprint(args.model);
  const aggregate = {
    baseline: { onset: {}, strict: {} },
    game: { onset: {}, strict: {} },
  };
  const tracks = [];

  for (let i = 0; i < selected.length; i++) {
    const track = selected[i];
    process.stdout.write(`\rVocalSet ${i + 1}/${selected.length} ${track.basename}`);
    const audio = path.join(args.cache, 'audio', `${track.basename}.wav`);
    extractZipEntry(args.audioZip, track.audioEntry, audio);
    const reference = loadReferenceNotes(args.annotationsZip, track.annotationEntry);
    if (!reference.length) {
      throw new Error(`No corrected Sound notes found in ${track.annotationEntry}`);
    }
    const baseline = extractBaseline(audio, track, args);
    const game = extractGame(audio, track, args, fingerprint);
    addEvaluation(aggregate.baseline, reference, baseline);
    addEvaluation(aggregate.game, reference, game);
    tracks.push({
      basename: track.basename,
      singer: track.singer,
      kind: track.kind,
      sampleRank: track.rank,
      annotationEntry: track.annotationEntry,
      referenceNotes: reference.length,
      baseline: {
        notes: baseline.length,
        onsetPitch: evaluateNotes(reference, baseline, false),
        onsetOffsetPitch: evaluateNotes(reference, baseline, true),
      },
      game: {
        notes: game.length,
        onsetPitch: evaluateNotes(reference, game, false),
        onsetOffsetPitch: evaluateNotes(reference, game, true),
      },
    });
  }
  process.stdout.write('\n');
  if (aggregate.game.onset.reference !== aggregate.baseline.onset.reference) {
    throw new Error('Baseline and GAME reference counts diverged');
  }

  const result = {
    dataset: 'Annotated VocalSet (corrected annotations)',
    protocol: {
      frozenBeforeScoring: true,
      samplePolicy:
        'One scale and one arpeggio per singer, lowest SHA-256 rank over matching annotated filenames.',
      sampleSalt: 'swarlekh:vocalset-independent:v1',
      annotationTree: 'Annotated VocalSet/extended 1/with file header',
      singers: 20,
      tracks: 40,
    },
    baselineConfig: BASELINE,
    game: {
      model: path.basename(args.model),
      modelFingerprint: fingerprint,
      parameters: GAME_PARAMETERS,
    },
    results: {
      baseline: {
        onsetPitch: scoresFromNoteCounts(aggregate.baseline.onset),
        onsetOffsetPitch: scoresFromNoteCounts(aggregate.baseline.strict),
        counts: aggregate.baseline,
      },
      game: {
        onsetPitch: scoresFromNoteCounts(aggregate.game.onset),
        onsetOffsetPitch: scoresFromNoteCounts(aggregate.game.strict),
        counts: aggregate.game,
      },
    },
    tracks,
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.results, null, 2));
  return result;
}

try {
  evaluate(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
