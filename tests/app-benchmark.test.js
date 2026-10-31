'use strict';

// Regression floor for what the app SHOWS (Best engine → DSP.notateRegions),
// scored against Vocadito's human note annotations. Vocadito is not Hindustani:
// annotators do not mark murki touches, so the Clean preset scores below the
// plain-notes preset by design. The floors stop silent regressions; raise them
// when an improvement lands. See evaluation/README.md. Vocadito has no
// tonic: a better Sa for Hindustani music can move the grid on these Western
// songs by a few tenths of a point (re-baselined 2026-10-30 for the tonic
// cadence/tuning fix, which lifted the Hindustani benchmark substantially).
const test = require('node:test');
const assert = require('node:assert');
const DSP = require('../js/dsp.js');
const bench = require('../evaluation/app-benchmark.js');

const fixture = bench.loadFixture();
const SIMPLE = { ornaments: false, clean: true, ornMinMs: 45, minNoteMs: 170, onsetMinMs: 125 };

test('app benchmark: fixture reproduces the recorded GAME score', () => {
  const result = bench.score(DSP, { fixture });
  assert.ok(Math.abs(result.all.game.f1 - 0.7094) < 0.002, `GAME F1 ${result.all.game.f1}`);
});

test('app benchmark: Clean preset note F1 stays above its floor', () => {
  const result = bench.score(DSP, { fixture });
  assert.ok(result.all.app.f1 >= 0.575, `all-split F1 fell to ${result.all.app.f1.toFixed(4)}`);
  assert.ok(result.test.app.f1 >= 0.625, `held-out F1 fell to ${result.test.app.f1.toFixed(4)}`);
  assert.ok(result.all.appStrict.f1 >= 0.275, `strict F1 fell to ${result.all.appStrict.f1.toFixed(4)}`);
});

test('app benchmark: Main-notes preset note F1 stays above its floor', () => {
  const result = bench.score(DSP, { fixture, options: SIMPLE });
  assert.ok(result.all.app.f1 >= 0.605, `all-split F1 fell to ${result.all.app.f1.toFixed(4)}`);
});
