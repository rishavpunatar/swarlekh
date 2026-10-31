'use strict';

// Known-answer Hindustani regression floors (evaluation/synthetic-hindustani.js):
// a subset of the 42 ragas rendered with raga intonation, meend, vibrato and
// drift, run through the real worker steps. Floors sit just below the
// 2026-10-30 results; raise them when an improvement lands. Synthetic voices
// are simpler than real ones — evaluation/evaluate-saraga.js measures real
// recordings.
const test = require('node:test');
const assert = require('node:assert');
const DSP = require('../js/dsp.js');
const S = require('../evaluation/synthetic-hindustani.js');

const suite = (engine, name) => S.SUITES[engine].find(([n]) => n === name)[1];

test('synthetic Hindustani, Best path: Sa and swaras across voices, vibrato and drift', () => {
  for (const [name, cfg] of S.SUITES.best) {
    const r = S.runBest(DSP, Object.assign({ step: 6 }, cfg));
    assert.ok(r.saOctave >= 0.95, `${name}: Sa ${r.saOctave.toFixed(3)} (${r.misses.join(' ')})`);
    assert.ok(r.swara >= 0.93, `${name}: swaras ${r.swara.toFixed(3)}`);
    assert.ok(r.spurious <= 0.02, `${name}: spurious ${r.spurious.toFixed(3)}`);
  }
});

test('synthetic Hindustani, Fast engine: tanpura + tabla do not move Sa, octaves or split notes', () => {
  for (const name of ['male, tanpura+tabla', 'female, tanpura+tabla']) {
    const r = S.runFast(DSP, Object.assign({}, suite('fast', name), { step: 7 }));
    assert.ok(r.saOctave >= 0.95, `${name}: Sa ${r.saOctave.toFixed(3)} (${r.misses.join(' ')})`);
    assert.ok(r.swara >= 0.92, `${name}: swaras ${r.swara.toFixed(3)}`);
    assert.ok(r.falseSplits <= 0.15, `${name}: false splits ${r.falseSplits.toFixed(3)}`);
    assert.ok(r.spurious <= 0.12, `${name}: spurious ${r.spurious.toFixed(3)}`);
  }
});
