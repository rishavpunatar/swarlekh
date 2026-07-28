'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('worker: external Praat track, not mix YIN, is used to detect Sa', async () => {
  const calls = { tonicF0: null, yin: 0, posted: null };
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
    detectTonic: (f0) => {
      calls.tonicF0 = Array.from(f0);
      return [{ hz: 220, score: 1 }];
    },
    detectOnsets: () => [],
    synthesize: () => new Float32Array(8),
  };
  const self = {
    location: { search: '' },
    postMessage: (message) => { calls.posted = message; },
  };
  const context = vm.createContext({
    self, DSP, Float32Array, Math, Promise,
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
    },
  });

  assert.strictEqual(calls.yin, 0, 'external analysis must not run tonic detection on mix YIN');
  assert.deepStrictEqual(calls.tonicF0, [220, 222, 224]);
  assert.strictEqual(calls.posted.type, 'result');
  assert.strictEqual(calls.posted.hopSec, 0.004);
});
