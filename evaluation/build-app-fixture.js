#!/usr/bin/env node
'use strict';

// Packs the cached Best-engine model outputs for Vocadito into one small,
// committed fixture so the app-level note benchmark runs anywhere (CI included)
// without Python, audio or model weights. Rebuild after re-extracting caches:
//   node evaluation/build-app-fixture.js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = __dirname;
const DATASET = path.join(ROOT, 'data', 'vocadito');
const CACHE = path.join(ROOT, 'cache');
const OUTPUT = path.join(ROOT, 'fixtures', 'vocadito-best.json.gz');

const parseCsv = (file) => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  .filter(Boolean).map((line) => line.split(','));
const round = (value, digits) => Number(value.toFixed(digits));

function splitForSinger(singerId) {
  const hash = crypto.createHash('sha256').update(`vocadito:${singerId}`).digest();
  return hash.readUInt32BE(0) % 3 === 0 ? 'test' : 'development';
}

function referenceNotes(file) {
  return parseCsv(file).map((row) => [round(+row[0], 4), round(+row[1], 3), round(+row[2], 4)]);
}

// Mirrors server/singing_models.py fuse_rmvpe_with_praat with its defaults.
function fuse(rmvpe, praat) {
  const f0 = [];
  const confidence = [];
  for (let i = 0; i < rmvpe.f0.length; i++) {
    const time = i * rmvpe.hopSec;
    const index = Math.min(praat.f0.length - 1,
      Math.max(0, Math.floor(time / praat.hopSec + 0.5)));
    const supported = praat.f0[index] > 0 && praat.clarity[index] >= 0.6;
    const value = rmvpe.confidence[i];
    const keep = value >= 0.4 || (value >= 0.2 && supported);
    f0.push(keep ? round(rmvpe.f0[i], 2) : 0);
    confidence.push(keep ? round(0.5 + 0.5 * Math.min(1, Math.max(0, (value - 0.2) / 0.8)), 3) : 0);
  }
  return { f0, confidence };
}

function build() {
  const rows = parseCsv(path.join(DATASET, 'vocadito_metadata.csv'));
  const header = rows.shift();
  const metadata = rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]])));
  const rmvpe = JSON.parse(fs.readFileSync(path.join(CACHE, 'rmvpe-vocadito.json'), 'utf8')).tracks;
  const praatFiles = fs.readdirSync(path.join(CACHE, 'vocadito'));
  const gameFiles = fs.readdirSync(path.join(CACHE, 'game'));
  const tracks = metadata.map((track) => {
    const id = track.track_id;
    const prefix = `vocadito_${id}_`;
    const praat = JSON.parse(fs.readFileSync(
      path.join(CACHE, 'vocadito', praatFiles.find((file) => file.startsWith(prefix))), 'utf8'));
    const game = JSON.parse(fs.readFileSync(
      path.join(CACHE, 'game', gameFiles.find((file) => file.startsWith(prefix))), 'utf8'));
    const prediction = rmvpe[id];
    const fused = fuse(prediction, praat);
    // Server rms: 1024-sample window starting at each RMVPE frame.
    const rms = fused.f0.map((_, i) => round(praat.rms[Math.min(praat.rms.length - 1,
      Math.round(i * prediction.hopSec / praat.hopSec))] || 0, 5));
    const notes = path.join(DATASET, 'Annotations', 'Notes', `vocadito_${id}`);
    return {
      id,
      singer: track.singer_id,
      split: splitForSinger(track.singer_id),
      hopSec: prediction.hopSec,
      f0: fused.f0,
      confidence: fused.confidence,
      rms,
      onsets: praat.onsets,
      noteRegions: game.notes.map((note) => [note.onset, note.offset, round(note.midi, 4)]),
      referenceA1: referenceNotes(`${notes}_notesA1.csv`),
      referenceA2: referenceNotes(`${notes}_notesA2.csv`),
    };
  });
  const fixture = {
    dataset: 'Vocadito 1.0 (CC BY 4.0, https://zenodo.org/records/5578807)',
    pipeline: 'RMVPE + Praat fusion, GAME-1.0.3-small regions, server onsets',
    gameParameters: { steps: 2, boundaryThreshold: 0.2, presenceThreshold: 0.2, radius: 2 },
    tracks,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, zlib.gzipSync(JSON.stringify(fixture), { level: 9 }));
  console.log(`Wrote ${tracks.length} tracks to ${path.relative(process.cwd(), OUTPUT)} ` +
    `(${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB)`);
}

build();
