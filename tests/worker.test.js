'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('worker: the server voice drives the notes; Sa comes from the mix and is fine-tuned on the voice', async () => {
  const calls = { tonicF0: null, yin: 0, refinedOn: null, posted: null };
  const DSP = {
    preFilter: (x) => x,
    yinTrack: () => {
      calls.yin++;
      return {
        f0: new Float32Array([999]),
        clarity: new Float32Array([0.9]),
        rms: new Float32Array([0.1]),
        hopSec: 0.016,
      };
    },
    stabilizeOctave: (f0) => ({ f0, doubled: false }),
    tonicWithDrift: (f0) => {
      calls.tonicF0 = Array.from(f0);
      return { tonic: [{ hz: 219, score: 1 }], drift: null, f0 };
    },
    refineSa: (hz, f0) => { calls.refinedOn = Array.from(f0); return 220; },
    driftAt: () => 0,
    correctDrift: (f0) => f0,
    detectOnsets: () => [],
    synthesize: () => new Float32Array(8),
  };
  const self = {
    location: { search: '' },
    postMessage: (message) => { calls.posted = message; },
  };
  const context = vm.createContext({
    self, DSP, Float32Array, Math, Promise, Array, Object, Number,
    importScripts: () => {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/worker.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'worker.js' });

  await self.onmessage({
    data: {
      samples: new Float32Array(32),
      sr: 16000,
      providedF0: [220, 222, 224],
      providedClarity: [0.9, 0.91, 0.92],
      providedRms: [0.2, 0.21, 0.22],
      providedHopSec: 0.004,
      providedOnsets: [],
      providedNoteRegions: [
        { onset: 0, offset: 0.1, frequency: 220 },
      ],
    },
  });

  // Saraga concerts: Sa from the mix (voice + tanpura strings) is the more
  // reliable reading; the separated voice only fine-tunes its cents.
  assert.strictEqual(calls.yin, 1, 'Sa is read from the mix');
  assert.deepStrictEqual(calls.tonicF0, [999]);
  assert.deepStrictEqual(calls.refinedOn, [220, 222, 224], 'Sa cents refined on the separated voice');
  assert.strictEqual(calls.posted.type, 'result', calls.posted.message);
  assert.strictEqual(calls.posted.tonic[0].hz, 220);
  assert.deepStrictEqual(Array.from(calls.posted.f0), [220, 222, 224], 'the notes come from the separated voice');
  assert.strictEqual(calls.posted.hopSec, 0.004);
  assert.deepStrictEqual(calls.posted.noteRegions, [
    { onset: 0, offset: 0.1, frequency: 220 },
  ]);
});

test('worker: tuning drift is removed from the notation pitch and note regions, not the synth', async () => {
  const calls = { posted: null, synthF0: null };
  const shift = Math.pow(2, 100 / 1200);
  const DSP = {
    preFilter: (x) => x,
    yinTrack: () => ({ f0: new Float32Array([233.08, 233.08]), clarity: new Float32Array([0.9, 0.9]), rms: new Float32Array([0.2, 0.2]), hopSec: 0.01 }),
    refineSa: (hz) => hz,
    stabilizeOctave: (f0) => ({ f0, doubled: false }),
    tonicWithDrift: (f0) => ({
      tonic: [{ hz: 220, score: 1 }],
      drift: { times: [0, 1], cents: [100, 100] },
      f0: Float32Array.from(f0, (v) => v / shift),
    }),
    driftAt: () => 100,
    correctDrift: (f0) => Float32Array.from(f0, (v) => (v > 0 ? v / shift : 0)),
    detectOnsets: () => [],
    synthesize: (f0) => { calls.synthF0 = Array.from(f0); return new Float32Array(8); },
  };
  const self = { location: { search: '' }, postMessage: (message) => { calls.posted = message; } };
  const context = vm.createContext({ self, DSP, Float32Array, Math, Promise, Array, Object, Number, importScripts: () => {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/worker.js'), 'utf8'), context, { filename: 'worker.js' });
  await self.onmessage({
    data: {
      samples: new Float32Array(32), sr: 16000,
      providedF0: [233.08, 233.08], providedClarity: [0.9, 0.9], providedRms: [0.2, 0.2],
      providedHopSec: 0.01, providedOnsets: [],
      providedNoteRegions: [{ onset: 0, offset: 0.02, frequency: 233.08, midi: 58 }],
    },
  });
  assert.strictEqual(calls.posted.type, 'result', calls.posted.message);
  assert.ok(Math.abs(calls.posted.f0[0] - 220) < 0.1, `notation pitch corrected: ${calls.posted.f0[0]}`);
  assert.ok(Math.abs(calls.synthF0[0] - 233.08) < 0.01, 'the melody synth keeps the real (drifted) pitch');
  assert.ok(Math.abs(calls.posted.noteRegions[0].frequency - 220) < 0.1, 'note regions corrected too');
  assert.deepStrictEqual(Array.from(calls.posted.drift.cents), [100, 100]);
});
