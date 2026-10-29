#!/usr/bin/env node
'use strict';

// App-level note benchmark: scores what the app actually SHOWS for the Best
// engine — the server's fused pitch and GAME regions, run through the same
// worker steps (gentle octave pass, tonic) and DSP.notateRegions with the
// Clean preset — against Vocadito's two human note annotations.
//
//   node evaluation/app-benchmark.js            # all splits
//   node evaluation/app-benchmark.js --json     # machine-readable
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { addCounts, evaluateNotes, scoresFromNoteCounts } = require('./metrics.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'vocadito-best.json.gz');
// The app's Clean preset (js/main.js detailSel 'clean').
const CLEAN = {
  clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45,
  onsetMinMs: 100, clean: true,
};

function loadFixture(file = FIXTURE) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const toNotes = (rows) => rows.map(([onset, frequency, duration]) => ({
  onset, frequency, offset: onset + duration,
}));

function appNotes(DSP, track, options = {}) {
  const hop = track.hopSec;
  const f0 = Float32Array.from(track.f0);
  const clarity = Float32Array.from(track.confidence);
  const rms = Float32Array.from(track.rms);
  const stable = DSP.stabilizeOctave(f0, clarity, rms, hop, 'gentle').f0;
  const tonic = DSP.detectTonic(stable, clarity, hop, rms);
  const saHz = tonic.length ? tonic[0].hz : 440;
  const regions = track.noteRegions.map(([onset, offset, midi]) => ({
    onset, offset, midi, frequency: 440 * Math.pow(2, (midi - 69) / 12),
  }));
  const opts = Object.assign({}, CLEAN, options, {
    onsets: track.onsets.map((time) => Math.round(time / hop)),
    rms,
  });
  const { tokens } = DSP.notateRegions(regions, stable, clarity, hop, saHz, opts);
  return tokens.map((token) => ({
    onset: token.t0,
    offset: token.t1,
    frequency: saHz * Math.pow(2, token.k / 12),
  }));
}

function score(DSP, { fixture = loadFixture(), options = {} } = {}) {
  const totals = {};
  const add = (split, name, counts) => {
    totals[split] = totals[split] || {};
    totals[split][name] = addCounts(totals[split][name] || {}, counts);
  };
  let appCount = 0;
  let gameCount = 0;
  for (const track of fixture.tracks) {
    const estimated = appNotes(DSP, track, options);
    const game = track.noteRegions.map(([onset, offset, midi]) => ({
      onset, offset, frequency: 440 * Math.pow(2, (midi - 69) / 12),
    }));
    appCount += estimated.length;
    gameCount += game.length;
    for (const reference of [toNotes(track.referenceA1), toNotes(track.referenceA2)]) {
      for (const split of ['all', track.split]) {
        add(split, 'app', evaluateNotes(reference, estimated, false).counts);
        add(split, 'appStrict', evaluateNotes(reference, estimated, true).counts);
        add(split, 'game', evaluateNotes(reference, game, false).counts);
        add(split, 'gameStrict', evaluateNotes(reference, game, true).counts);
      }
    }
  }
  const result = { notes: { app: appCount, game: gameCount } };
  for (const split of ['development', 'test', 'all']) {
    result[split] = {};
    for (const [name, counts] of Object.entries(totals[split])) {
      result[split][name] = scoresFromNoteCounts(counts);
    }
  }
  return result;
}

module.exports = { CLEAN, loadFixture, appNotes, score };

if (require.main === module) {
  const DSP = require(process.env.SWARLEKH_DSP
    ? path.resolve(process.env.SWARLEKH_DSP) : '../js/dsp.js');
  const result = score(DSP);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pct = (value) => `${(value * 100).toFixed(2)}%`;
    console.log(`notes: app ${result.notes.app}, GAME raw ${result.notes.game}`);
    for (const split of ['development', 'test', 'all']) {
      const s = result[split];
      console.log(`${split.padEnd(12)} app F1 ${pct(s.app.f1)} (P ${pct(s.app.precision)} R ${pct(s.app.recall)})` +
        ` · strict ${pct(s.appStrict.f1)} · GAME raw ${pct(s.game.f1)} / strict ${pct(s.gameStrict.f1)}`);
    }
  }
}
