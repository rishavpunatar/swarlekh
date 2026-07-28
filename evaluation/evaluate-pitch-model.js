#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  addCounts,
  evaluatePitch,
  scoresFromPitchCounts,
} = require('./metrics.js');

function parseArgs(argv) {
  const args = {
    dataset: path.join(__dirname, 'data', 'vocadito'),
    predictions: null,
    split: 'development',
    praatCache: null,
    baseline: null,
    lowConfidence: null,
    highConfidence: null,
    praatThreshold: null,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset') args.dataset = path.resolve(argv[++i]);
    else if (arg === '--predictions') args.predictions = path.resolve(argv[++i]);
    else if (arg === '--split') args.split = argv[++i];
    else if (arg === '--praat-cache') args.praatCache = path.resolve(argv[++i]);
    else if (arg === '--baseline') args.baseline = path.resolve(argv[++i]);
    else if (arg === '--low-confidence') args.lowConfidence = Number(argv[++i]);
    else if (arg === '--high-confidence') args.highConfidence = Number(argv[++i]);
    else if (arg === '--praat-threshold') args.praatThreshold = Number(argv[++i]);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.predictions) throw new Error('--predictions is required');
  if (!['development', 'test', 'all'].includes(args.split)) {
    throw new Error('--split must be development, test, or all');
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

function loadReferenceF0(file) {
  const rows = parseCsv(file);
  return {
    times: rows.map((row) => Number(row[0])),
    f0: rows.map((row) => Number(row[1])),
  };
}

function loadPraatSupport(metadata, args) {
  if (!args.praatCache) return null;
  const extractor = path.join(__dirname, 'extract_vocal_features.py');
  const extractorHash = crypto.createHash('sha256')
    .update(fs.readFileSync(extractor))
    .digest('hex')
    .slice(0, 12);
  return Object.fromEntries(metadata.map((track) => {
    const file = path.join(
      args.praatCache,
      `vocadito_${track.track_id}_${extractorHash}.json`
    );
    if (!fs.existsSync(file)) throw new Error(`Missing Praat support features: ${file}`);
    return [track.track_id, JSON.parse(fs.readFileSync(file, 'utf8'))];
  }));
}

function fusedConfidence(prediction, support, config) {
  if (!support) return prediction.confidence;
  const confidence = new Array(prediction.confidence.length).fill(0);
  for (let i = 0; i < confidence.length; i++) {
    const value = prediction.confidence[i];
    if (value >= config.highConfidence) {
      confidence[i] = value;
      continue;
    }
    if (value < config.lowConfidence) continue;
    const time = i * prediction.hopSec;
    const supportIndex = Math.max(
      0,
      Math.min(support.f0.length - 1, Math.round(time / support.hopSec))
    );
    if (support.f0[supportIndex] > 0 &&
        support.clarity[supportIndex] >= config.praatThreshold) {
      confidence[i] = value;
    }
  }
  return confidence;
}

function evaluateConfiguration(metadata, predictions, praatSupport, args, config) {
  const counts = {};
  let tracks = 0;
  const singers = new Set();
  for (const track of metadata) {
    const split = splitForSinger(track.singer_id);
    if (args.split !== 'all' && split !== args.split) continue;
    const reference = loadReferenceF0(
      path.join(
        args.dataset,
        'Annotations',
        'F0',
        `vocadito_${track.track_id}_f0.csv`
      )
    );
    const prediction = predictions.tracks[track.track_id];
    const estimated = {
      hopSec: prediction.hopSec,
      f0: prediction.f0,
      clarity: fusedConfidence(
        prediction,
        praatSupport ? praatSupport[track.track_id] : null,
        config
      ),
    };
    addCounts(counts, evaluatePitch(reference, estimated, config.lowConfidence).counts);
    tracks++;
    singers.add(track.singer_id);
  }
  return {
    config,
    tracks,
    singers: singers.size,
    pitch: scoresFromPitchCounts(counts),
    counts,
  };
}

function loadBaseline(args) {
  if (!args.baseline) return null;
  const document = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
  if (args.split === 'development') {
    return (document.baselineDevelopment || document.baseline || {}).pitch;
  }
  if (args.split === 'test') {
    return (document.baselineTest || document.baseline || {}).pitch;
  }
  return (document.baseline || {}).pitch;
}

function score(result, baseline) {
  const pitch = result.pitch;
  if (baseline) {
    return Math.min(
      pitch.rawPitchAccuracy - baseline.rawPitchAccuracy,
      pitch.rawChromaAccuracy - baseline.rawChromaAccuracy,
      pitch.overallAccuracy - baseline.overallAccuracy
    );
  }
  return Math.min(
    pitch.rawPitchAccuracy,
    pitch.rawChromaAccuracy,
    pitch.overallAccuracy
  );
}

function run(args) {
  const metadata = loadMetadata(args.dataset);
  const selectedMetadata = args.split === 'all'
    ? metadata
    : metadata.filter((track) => splitForSinger(track.singer_id) === args.split);
  const predictions = JSON.parse(fs.readFileSync(args.predictions, 'utf8'));
  const praatSupport = loadPraatSupport(selectedMetadata, args);
  const baseline = loadBaseline(args);
  let result;
  if (args.lowConfidence != null) {
    const config = {
      lowConfidence: args.lowConfidence,
      highConfidence: args.highConfidence == null
        ? args.lowConfidence
        : args.highConfidence,
      praatThreshold: args.praatThreshold == null ? 0.6 : args.praatThreshold,
    };
    const selected = evaluateConfiguration(
      metadata,
      predictions,
      praatSupport,
      args,
      config
    );
    result = {
      model: predictions.model,
      supportModel: praatSupport ? 'Praat cross-correlation' : null,
      split: args.split,
      baseline,
      selected,
    };
  } else {
    const lows = praatSupport ? [0.05, 0.1, 0.15, 0.2, 0.25, 0.3] : [
      0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5,
    ];
    const highs = praatSupport ? [0.4, 0.45, 0.5, 0.55, 0.6] : [null];
    const praatThresholds = praatSupport ? [0.4, 0.5, 0.6, 0.7, 0.8] : [0];
    const candidates = [];
    for (const lowConfidence of lows) {
      for (const highConfidence of highs) {
        if (highConfidence != null && highConfidence < lowConfidence) continue;
        for (const praatThreshold of praatThresholds) {
          candidates.push(evaluateConfiguration(
            metadata,
            predictions,
            praatSupport,
            args,
            {
              lowConfidence,
              highConfidence: highConfidence == null ? lowConfidence : highConfidence,
              praatThreshold,
            }
          ));
        }
      }
    }
    candidates.sort((a, b) => score(b, baseline) - score(a, baseline));
    result = {
      model: predictions.model,
      supportModel: praatSupport ? 'Praat cross-correlation' : null,
      split: args.split,
      baseline,
      selectionObjective: baseline
        ? 'maximize the minimum absolute gain over baseline across raw pitch, raw chroma, and overall accuracy'
        : 'maximize min(raw pitch, raw chroma, overall accuracy)',
      selected: candidates[0],
      candidates,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
}

try {
  run(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
