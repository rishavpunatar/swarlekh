'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  evaluateNotes,
  evaluatePitch,
  maximumMatches,
} = require('../evaluation/metrics.js');

test('pitch metrics distinguish octave-sensitive and octave-folded accuracy', () => {
  const reference = { times: [0, 0.01, 0.02], f0: [220, 0, 330] };
  const estimated = {
    hopSec: 0.01,
    f0: [440, 0, 330],
    clarity: [0.9, 0, 0.9],
  };
  const result = evaluatePitch(reference, estimated, 0.5);
  assert.strictEqual(result.rawPitchAccuracy, 0.5);
  assert.strictEqual(result.rawChromaAccuracy, 1);
  assert.strictEqual(result.voicingFalseAlarm, 0);
  assert.strictEqual(result.overallAccuracy, 2 / 3);
});

test('note matching is one-to-one even when several references fit one estimate', () => {
  const reference = [
    { onset: 0, offset: 0.2, frequency: 220 },
    { onset: 0.02, offset: 0.22, frequency: 220 },
  ];
  const estimated = [{ onset: 0.01, offset: 0.21, frequency: 220 }];
  assert.strictEqual(maximumMatches(reference, estimated, true), 1);
  const result = evaluateNotes(reference, estimated, true);
  assert.strictEqual(result.precision, 1);
  assert.strictEqual(result.recall, 0.5);
});

test('strict note score enforces duration while onset score does not', () => {
  const reference = [{ onset: 1, offset: 2, frequency: 220 }];
  const estimated = [{ onset: 1.03, offset: 2.5, frequency: 221 }];
  assert.strictEqual(evaluateNotes(reference, estimated, false).f1, 1);
  assert.strictEqual(evaluateNotes(reference, estimated, true).f1, 0);
});
