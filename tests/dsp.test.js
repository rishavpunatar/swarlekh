'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fft } = require('../js/fft.js');
const DSP = require('../js/dsp.js');

const SR = 16000;

/* ------------------------- synthesis helpers ------------------------- */

function sine(out, freq, t0, t1, amp, harmonics) {
  const h = harmonics || [1];
  const s0 = Math.round(t0 * SR), s1 = Math.min(out.length, Math.round(t1 * SR));
  for (let i = s0; i < s1; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < h.length; k++) v += h[k] * Math.sin(2 * Math.PI * freq * (k + 1) * t);
    // 10 ms fade at the edges to avoid clicks
    const edge = Math.min(1, (i - s0) / (0.01 * SR), (s1 - i) / (0.01 * SR));
    out[i] += amp * v * edge;
  }
}

const VOICE_H = [1, 0.5, 0.33, 0.25, 0.2];

/** "Voice": harmonic tone with 5.5 Hz vibrato (~±20 cents). */
function voiceNote(out, freq, t0, t1, amp) {
  const s0 = Math.round(t0 * SR), s1 = Math.min(out.length, Math.round(t1 * SR));
  let phases = [0, 0, 0, 0, 0];
  for (let i = s0; i < s1; i++) {
    const t = i / SR;
    const f = freq * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
    let v = 0;
    for (let k = 0; k < 5; k++) {
      phases[k] += 2 * Math.PI * f * (k + 1) / SR;
      v += VOICE_H[k] * Math.sin(phases[k]);
    }
    const edge = Math.min(1, (i - s0) / (0.015 * SR), (s1 - i) / (0.015 * SR));
    out[i] += amp * v * edge;
  }
}

/** Tanpura-ish drone: quiet steady Sa (low octaves) + mandra Pa. */
function addDrone(out, saHz) {
  sine(out, saHz / 2, 0, out.length / SR, 0.05, [1, 0.4, 0.25]);
  sine(out, saHz * 0.75, 0, out.length / SR, 0.03, [1, 0.3]); // Pa below Sa
  sine(out, saHz, 0, out.length / SR, 0.02, [1]);
}

/** Tabla-ish percussion: noise burst + decaying low thump every `period` s. */
function addPercussion(out, period) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let t = 0.15; t < out.length / SR; t += period) {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < Math.round(0.025 * SR); i++) {
      if (s0 + i < out.length) out[s0 + i] += 0.45 * rnd() * Math.exp(-i / (0.006 * SR));
    }
    for (let i = 0; i < Math.round(0.09 * SR); i++) {
      if (s0 + i < out.length) out[s0 + i] += 0.5 * Math.sin(2 * Math.PI * 85 * i / SR) * Math.exp(-i / (0.025 * SR));
    }
  }
}

const SA = 146.83; // D3
const st = (k) => SA * Math.pow(2, k / 12);

/* ------------------------------ FFT ------------------------------ */

test('fft: sine peaks at the right bin and roundtrips', () => {
  const n = 2048;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 64 * i / n);
  const orig = Float32Array.from(re);
  fft(re, im, false);
  let maxBin = 0, maxMag = 0;
  for (let k = 0; k < n / 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > maxMag) { maxMag = m; maxBin = k; }
  }
  assert.strictEqual(maxBin, 64);
  fft(re, im, true);
  for (let i = 0; i < n; i += 97) assert.ok(Math.abs(re[i] - orig[i]) < 1e-4, `roundtrip err at ${i}`);
});

/* ----------------------------- biquads ----------------------------- */

test('preFilter: passes 200 Hz, attenuates 50 Hz', () => {
  const dur = 1, n = dur * SR;
  const mk = (f) => {
    const x = new Float32Array(n);
    sine(x, f, 0, dur, 0.5);
    const y = DSP.preFilter(x, SR);
    let sum = 0;
    for (let i = Math.round(n / 4); i < n; i++) sum += y[i] * y[i];
    return Math.sqrt(sum / (n * 0.75));
  };
  const r50 = mk(50), r200 = mk(200);
  assert.ok(r50 < r200 * 0.35, `50 Hz should be attenuated: ${r50} vs ${r200}`);
});

/* ------------------------------ YIN ------------------------------ */

test('yinTrack: pure 220 Hz sine tracked within 10 cents', () => {
  const x = new Float32Array(2 * SR);
  sine(x, 220, 0.05, 1.95, 0.5, VOICE_H);
  const { f0 } = DSP.yinTrack(x, SR, {});
  const voiced = [];
  for (let i = 10; i < f0.length - 10; i++) if (f0[i] > 0) voiced.push(f0[i]);
  assert.ok(voiced.length > f0.length * 0.8, `mostly voiced: ${voiced.length}/${f0.length}`);
  const errs = voiced.map(f => Math.abs(1200 * Math.log2(f / 220))).sort((a, b) => a - b);
  assert.ok(errs[Math.floor(errs.length / 2)] < 10, `median cents err ${errs[Math.floor(errs.length / 2)]}`);
});

test('yinTrack: glide 200->400 Hz has no octave jumps', () => {
  const dur = 2, n = dur * SR;
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 200 * Math.pow(2, t / dur); // one octave over 2 s
    phase += 2 * Math.PI * f / SR;
    x[i] = 0.5 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
  }
  const { f0 } = DSP.yinTrack(x, SR, {});
  let prev = 0, maxJump = 0;
  for (let i = 5; i < f0.length - 5; i++) {
    if (f0[i] > 0 && prev > 0) {
      maxJump = Math.max(maxJump, Math.abs(1200 * Math.log2(f0[i] / prev)));
    }
    if (f0[i] > 0) prev = f0[i];
  }
  assert.ok(maxJump < 250, `max frame-to-frame jump ${maxJump} cents`);
});

/* ----------------------- end-to-end pipeline ----------------------- */

function buildMix() {
  // S R G m P P D N S' P G R S with a 1.5 s vocal rest in the middle.
  const degrees = [0, 2, 4, 5, 7, 7, 9, 11, 12, 7, 4, 2, 0];
  const noteDur = 0.45;
  const restAt = 6, restLen = 1.5;
  const total = degrees.length * noteDur + restLen + 0.4;
  const x = new Float32Array(Math.round(total * SR));
  const truth = []; // {t0, t1, hz, k}
  let t = 0.1;
  for (let i = 0; i < degrees.length; i++) {
    if (i === restAt) t += restLen;
    voiceNote(x, st(degrees[i]), t, t + noteDur, 0.32);
    truth.push({ t0: t, t1: t + noteDur, hz: st(degrees[i]), k: degrees[i] });
    t += noteDur;
  }
  addDrone(x, SA);
  addPercussion(x, 0.55);
  return { x, truth, restStart: 0.1 + restAt * noteDur, restLen };
}

test('pipeline: melody recovered from voice+drone+percussion mix', () => {
  const { x, truth, restStart, restLen } = buildMix();
  const filtered = DSP.preFilter(x, SR);
  const { f0, clarity, hopSec } = DSP.yinTrack(filtered, SR, {});

  // Frame accuracy on the interior of each true note.
  let ok = 0, tot = 0;
  for (const note of truth) {
    const i0 = Math.ceil((note.t0 + 0.08) / hopSec), i1 = Math.floor((note.t1 - 0.08) / hopSec);
    for (let i = i0; i <= i1 && i < f0.length; i++) {
      tot++;
      if (f0[i] > 0 && Math.abs(1200 * Math.log2(f0[i] / note.hz)) < 60) ok++;
    }
  }
  assert.ok(tot > 100, 'enough truth frames');
  assert.ok(ok / tot > 0.82, `voiced accuracy ${(ok / tot * 100).toFixed(1)}% (want >82%)`);

  // The vocal rest (drone + percussion only) should be mostly unvoiced.
  let restU = 0, restTot = 0;
  const r0 = Math.ceil((restStart + 0.15) / hopSec), r1 = Math.floor((restStart + restLen - 0.15) / hopSec);
  for (let i = r0; i <= r1; i++) { restTot++; if (f0[i] === 0 || clarity[i] < 0.5) restU++; }
  assert.ok(restU / restTot > 0.65, `rest unvoiced ${(restU / restTot * 100).toFixed(1)}% (want >65%)`);

  // Tonic detection: a top-3 candidate within 35 cents of true Sa.
  const tonic = DSP.detectTonic(f0, clarity, hopSec);
  const hit = tonic.some(c => Math.abs(1200 * Math.log2(c.hz / SA)) < 35);
  assert.ok(hit, `tonic candidates ${tonic.map(c => c.hz.toFixed(1)).join(', ')} should include ~${SA}`);

  // Notation: expected swara sequence appears in order.
  const { phrases } = DSP.notate(f0, clarity, hopSec, SA, {});
  const letters = [];
  for (const ph of phrases) for (const tk of ph.tokens) {
    const txt = DSP.tokenText(tk.k, false);
    if (letters[letters.length - 1] !== txt) letters.push(txt);
  }
  const expected = ['S', 'R', 'G', 'm', 'P', 'D', 'N', "S'", 'P', 'G', 'R', 'S'];
  let ei = 0;
  for (const l of letters) if (l === expected[ei]) ei++;
  assert.ok(ei >= expected.length - 1,
    `expected subsequence ${expected.join(' ')}, got ${letters.join(' ')} (matched ${ei})`);
});

/* --------------------------- sargam mapping --------------------------- */

test('swara mapping: letters, komal, octaves', () => {
  assert.strictEqual(DSP.tokenText(0), 'S');
  assert.strictEqual(DSP.tokenText(1), 'r');
  assert.strictEqual(DSP.tokenText(4), 'G');
  assert.strictEqual(DSP.tokenText(5), 'm');
  assert.strictEqual(DSP.tokenText(6), 'M');
  assert.strictEqual(DSP.tokenText(12), "S'");
  assert.strictEqual(DSP.tokenText(14), "R'");
  assert.strictEqual(DSP.tokenText(-1), '.N');
  assert.strictEqual(DSP.tokenText(-3), '.D');
  assert.strictEqual(DSP.tokenText(-12), '.S');
  assert.strictEqual(DSP.tokenText(-13), '..N');
  assert.strictEqual(DSP.tokenText(24), "S''");
  assert.strictEqual(DSP.tokenText(7, true), '~P');
  assert.ok(DSP.swaraInfo(3).komal && !DSP.swaraInfo(4).komal);
  assert.ok(DSP.swaraInfo(6).tivra);
});

test('notate: clean three-note track gives three tokens', () => {
  const hopSec = 0.016;
  const n = 120;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < 40; i++) f0[i] = SA;
  for (let i = 40; i < 80; i++) f0[i] = st(4);
  for (let i = 80; i < 120; i++) f0[i] = st(7);
  const { tokens } = DSP.notate(f0, clarity, hopSec, SA, {});
  assert.strictEqual(tokens.length, 3);
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4, 7]);
});

test('notateRegions: neural boundaries preserve every short murki note', () => {
  const hopSec = 0.01;
  const regions = [
    { onset: 0, offset: 0.3, frequency: st(0) },
    { onset: 0.3, offset: 0.335, frequency: st(4) },
    { onset: 0.335, offset: 0.37, frequency: st(2) },
    { onset: 0.37, offset: 0.405, frequency: st(4) },
    { onset: 0.405, offset: 0.8, frequency: st(5) },
  ];
  const f0 = new Float32Array(80);
  const clarity = new Float32Array(80).fill(0.9);
  for (const region of regions) {
    for (let i = Math.floor(region.onset / hopSec);
         i < Math.ceil(region.offset / hopSec); i++) {
      f0[i] = region.frequency;
    }
  }
  const { tokens } = DSP.notateRegions(
    regions,
    f0,
    clarity,
    hopSec,
    SA,
    { clean: true, ornaments: true }
  );
  assert.deepStrictEqual(tokens.map((token) => token.k), [0, 4, 2, 4, 5]);
  assert.ok(tokens.slice(1, 4).every((token) => token.t1 - token.t0 <= 0.036));
});

test('notateRegions: repeated same pitch remains one token per articulation', () => {
  const regions = [
    { onset: 0, offset: 0.2, frequency: st(7) },
    { onset: 0.2, offset: 0.4, frequency: st(7) },
    { onset: 0.4, offset: 0.6, frequency: st(7) },
  ];
  const { tokens } = DSP.notateRegions(
    regions,
    new Float32Array(60).fill(st(7)),
    new Float32Array(60).fill(0.9),
    0.01,
    SA,
    { clean: true }
  );
  assert.strictEqual(tokens.length, 3);
  assert.deepStrictEqual(tokens.map((token) => token.k), [7, 7, 7]);
});

test('practice contour: vibrato becomes a flat target hold', () => {
  const hopSec = 0.01;
  const cents = Float32Array.from(
    { length: 80 },
    (_, index) => 28 * Math.sin(2 * Math.PI * index / 9)
  );
  const segments = DSP.buildPracticeContour(
    [{ t0: 0, t1: 0.8, k: 0 }],
    cents,
    hopSec
  );
  assert.deepStrictEqual(segments, [
    { kind: 'hold', t0: 0, t1: 0.8, c0: 0, c1: 0, tokenIndex: 0 },
  ]);
});

test('practice contour: an abrupt note change is a clear step', () => {
  const hopSec = 0.01;
  const cents = new Float32Array(100);
  cents.fill(0, 0, 50);
  cents.fill(400, 50);
  const segments = DSP.buildPracticeContour(
    [
      { t0: 0, t1: 0.5, k: 0 },
      { t0: 0.5, t1: 1, k: 4 },
    ],
    cents,
    hopSec
  );
  assert.strictEqual(segments[1].kind, 'step');
  assert.deepStrictEqual(
    segments.filter((segment) => segment.kind === 'hold').map((segment) => segment.c0),
    [0, 400]
  );
});

test('practice contour: a sustained pitch traversal is a simplified slide', () => {
  const hopSec = 0.01;
  const cents = new Float32Array(100);
  for (let index = 0; index < cents.length; index++) {
    if (index < 40) cents[index] = 0;
    else if (index <= 60) cents[index] = (index - 40) / 20 * 700;
    else cents[index] = 700;
  }
  const segments = DSP.buildPracticeContour(
    [
      { t0: 0, t1: 0.5, k: 0 },
      { t0: 0.5, t1: 1, k: 7 },
    ],
    cents,
    hopSec
  );
  const slide = segments.find((segment) => segment.kind === 'slide');
  assert.ok(slide, 'continuous traversal should render as a slide');
  assert.ok(slide.t1 - slide.t0 >= 0.08);
  assert.strictEqual(slide.curve, 'meend');
  assert.strictEqual(slide.c0, 0);
  assert.strictEqual(slide.c1, 700);
});

test('practice contour: a short traversal becomes a compact bend', () => {
  const hopSec = 0.01;
  const cents = new Float32Array(100);
  for (let index = 0; index < cents.length; index++) {
    if (index < 44) cents[index] = 0;
    else if (index <= 56) cents[index] = (index - 44) / 12 * 400;
    else cents[index] = 400;
  }
  const segments = DSP.buildPracticeContour(
    [
      { t0: 0, t1: 0.5, k: 0 },
      { t0: 0.5, t1: 1, k: 4 },
    ],
    cents,
    hopSec
  );
  const bend = segments.find((segment) => segment.kind === 'slide');
  assert.ok(bend, 'short continuous traversal should remain curved');
  assert.strictEqual(bend.curve, 'bend');
  assert.ok(bend.t1 - bend.t0 >= 0.08);
  assert.ok(bend.t1 - bend.t0 < 0.15);
});

test('practice contour: a collapsed meend token remains one intentional slide', () => {
  const segments = DSP.buildPracticeContour(
    [{ t0: 0, t1: 1.4, k: 7, glide: true, via: [0, 1, 2, 3, 4, 5, 6, 7] }],
    new Float32Array(140),
    0.01
  );
  assert.deepStrictEqual(segments, [
    { kind: 'slide', curve: 'meend', t0: 0, t1: 1.4, c0: 0, c1: 700, tokenIndex: 0 },
  ]);
});

test('practice contour: a sparse glide path is restored as note steps', () => {
  const segments = DSP.buildPracticeContour(
    [{ t0: 0, t1: 2.4, k: 5, glide: true, via: [1, 3, 5] }],
    new Float32Array(240),
    0.01
  );
  assert.deepStrictEqual(
    segments.filter((segment) => segment.kind === 'hold').map((segment) => segment.c0),
    [100, 300, 500]
  );
  assert.strictEqual(
    segments.filter((segment) => segment.kind === 'step').length,
    2
  );
  assert.ok(!segments.some((segment) => segment.kind === 'slide'));
});

test('practice contour: a vocal pause never bridges two notes', () => {
  const segments = DSP.buildPracticeContour(
    [
      { t0: 0, t1: 0.4, k: 0 },
      { t0: 0.55, t1: 1, k: 4 },
    ],
    new Float32Array(100),
    0.01
  );
  assert.strictEqual(segments.length, 2);
  assert.ok(segments.every((segment) => segment.kind === 'hold'));
});

test('practice contour: a fast murki stays as distinct note targets', () => {
  const tokens = [0, 4, 2, 4, 5].map((k, index) => ({
    t0: index * 0.04,
    t1: (index + 1) * 0.04,
    k,
    murki: true,
  }));
  const cents = new Float32Array(24);
  tokens.forEach((token, index) => {
    cents.fill(token.k * 100, index * 4, (index + 1) * 4);
  });
  const segments = DSP.buildPracticeContour(tokens, cents, 0.01);
  assert.deepStrictEqual(
    segments.filter((segment) => segment.kind === 'hold').map((segment) => segment.c0),
    [0, 400, 200, 400, 500]
  );
  assert.strictEqual(
    segments.filter((segment) => segment.kind === 'step').length,
    4
  );
  assert.ok(!segments.some((segment) => segment.kind === 'slide'));
});

test('notationText: renders timestamps and sustain dashes', () => {
  const phrases = [{
    t0: 62.2, t1: 64,
    tokens: [{ t0: 62.2, t1: 63.5, k: 7, meend: false }, { t0: 63.5, t1: 64, k: 0, meend: false }],
  }];
  const txt = DSP.notationText(phrases);
  assert.match(txt, /1\. \[1:02\]/);
  assert.match(txt, /P( –)+/);
});

/* ----------------------------- ornaments ----------------------------- */

const HOP = 0.016;
function trackFromRuns(runs) {
  // runs: [k or null, frames, clarity=0.9]
  let n = 0;
  for (const [, fr] of runs) n += fr;
  const f0 = new Float32Array(n), clarity = new Float32Array(n);
  let i = 0;
  for (const [k, fr, cl] of runs) {
    for (let j = 0; j < fr; j++, i++) {
      if (k !== null) { f0[i] = st(k); clarity[i] = cl != null ? cl : 0.9; }
    }
  }
  return { f0, clarity };
}

test('granular: a brief note between stable notes is picked out as its own swara', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 2, 4], 'each note shown, not bundled as kan');
});

test('granular: a murki reads note-by-note (G R G), not a bundled cluster', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [4, 3], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4, 2, 4], 'every note of the murki is its own swara');
});

test('granular: a stepped run of distinct notes is shown note-by-note (not a meend)', () => {
  // On-pitch staircase S r R g G — each note is HIT, so show each, not a glide.
  const { f0, clarity } = trackFromRuns([[0, 30], [1, 3], [2, 3], [3, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 1, 2, 3, 4]);
  assert.ok(!tokens.some(t => t.meendFromPrev), 'stepped notes are not a meend');
});

test('ornaments: >4 fast short notes show note-by-note (taan)', () => {
  const seq = [0, 2, 4, 5, 7, 5, 4, 2];
  const { f0, clarity } = trackFromRuns(seq.map(k => [k, 4]));
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), seq);
});

test('granular: a trailing brief note is its own swara', () => {
  const { f0, clarity } = trackFromRuns([[4, 30], [2, 3]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [4, 2]);
});

test('ornaments: slow oscillation flagged as andolan', () => {
  const n = 80;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) {
    const c = 400 + 55 * Math.sin(2 * Math.PI * 3 * i * HOP); // ±55c at 3 Hz around G
    f0[i] = SA * Math.pow(2, c / 1200);
  }
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].k, 4);
  assert.ok(tokens[0].andolan, 'should be flagged andolan');
  assert.strictEqual(DSP.tokenFullText(tokens[0]), '≈G');
});

test('granular: a held note with two sparse grace touches keeps the touches', () => {
  // The 0:56 case: held R, a brief up-touch to g, back to a sustained R, then a
  // brief down-touch to r, landing on S. The two ±1 touches are far apart with a
  // real hold between them — NOT a fast oscillation, so they must NOT be folded
  // into one ≈R; each touch is a note the singer hits and must stay visible.
  const { f0, clarity } = trackFromRuns([[2, 51], [3, 5], [2, 18], [1, 3], [0, 10]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [2, 3, 2, 1, 0], 'both grace touches surface');
  assert.ok(!tokens.some(t => t.andolan), 'a held note with sparse touches is not andolan');
});

test('ornaments: slow WIDE andolan (Darbari komal-ga) is caught with its range', () => {
  // 1.4 Hz, ±110 cents around komal-ga (k=3) — a slow, wide oscillation.
  const n = 90;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) {
    const c = 300 + 110 * Math.sin(2 * Math.PI * 1.4 * i * HOP);
    f0[i] = SA * Math.pow(2, c / 1200);
  }
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: true });
  assert.strictEqual(tokens.length, 1, `slow wide swing must be ONE note, got ${tokens.length}`);
  assert.ok(tokens[0].andolan, 'should be flagged andolan, not shredded into a meend salad');
  assert.strictEqual(tokens[0].k, 3);
  assert.match(DSP.tokenFullText(tokens[0]), /≈g\(.*–.*\)/, `should show swing range: ${DSP.tokenFullText(tokens[0])}`);
});

test('ornaments: smooth mode suppresses ornament extraction', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, { ornaments: false });
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4]);
  assert.ok(!tokens[1].kan, 'no kan in smooth mode');
});

/* ----------------------------- clean mode ----------------------------- */

const CLEAN = { clean: true, ornaments: false, minNoteMs: 150 };

test('clean: keeps genuine short notes, drops only sub-100ms flicker', () => {
  // Every note the voice actually hits must survive — including a ~0.18s note
  // (k=4) and a ~0.14s note (k=2) between phrases. Only a 4-frame (~64ms),
  // barely-voiced flicker (k=9) is removed.
  const CLN = { clean: true, ornaments: true, minNoteMs: 90 };
  const { f0, clarity } = trackFromRuns([
    [0, 32], [null, 20], [4, 11, 0.62], [null, 20], [7, 32], [null, 20], [9, 4, 0.52], [null, 20], [2, 9, 0.62], [null, 20], [4, 32],
  ]);
  const ks = DSP.notate(f0, clarity, HOP, SA, CLN).tokens.map(t => t.k);
  assert.ok(ks.includes(4) && ks.includes(7) && ks.includes(2), `genuine short notes kept, got ${ks}`);
  assert.ok(!ks.includes(9), `sub-100ms flicker dropped, got ${ks}`);
});

test('clean: drops a sub-100ms isolated octave stray (tracking glitch)', () => {
  // A 5-frame (~80ms) spike an octave off both neighbours is a glitch, not a note.
  const CLN = { clean: true, ornaments: true, minNoteMs: 90 };
  const { f0, clarity } = trackFromRuns([[0, 32], [12, 5], [2, 32]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLN);
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 2]);
});

test('clean: same swara re-struck across a breath remains two sung notes', () => {
  const { f0, clarity } = trackFromRuns([[7, 28], [null, 12], [7, 28]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.deepStrictEqual(tokens.map(t => t.k), [7, 7]);
  assert.ok(tokens[1].t0 > tokens[0].t1, 'the breath remains a real boundary');
});

test('clean: note re-sung on syllables remains one note per vocalised start', () => {
  // P sung three times with articulation gaps must read as three P notes.
  const { f0, clarity } = trackFromRuns([
    [7, 25], [null, 28], [7, 25], [null, 30], [7, 25],
  ]);
  const { tokens, phrases } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.deepStrictEqual(tokens.map(t => t.k), [7, 7, 7]);
  const txt = DSP.notationText(phrases);
  assert.strictEqual((txt.match(/P/g) || []).length, 3, `P written for every re-strike: ${txt}`);
});

test('clean: a tiny confidence dropout inside a held swara is stitched', () => {
  const { f0, clarity } = trackFromRuns([[7, 28], [null, 2], [7, 28]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.deepStrictEqual(tokens.map(t => t.k), [7], 'a 32 ms tracker dropout is not a re-sung note');
});

test('clean: drifting held note carries no ~ or ≈ marks', () => {
  // One note whose pitch drifts -40c -> +45c (range > 70c) — still just "S".
  const n = 60;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) {
    const c = -40 + 85 * (i / (n - 1));
    f0[i] = SA * Math.pow(2, c / 1200);
  }
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.strictEqual(tokens.length, 1);
  assert.ok(!tokens[0].meend && !tokens[0].andolan);
  assert.strictEqual(DSP.tokenFullText(tokens[0]), 'S');
});

test('detailed mode keeps wobble marks and tight hold-merge', () => {
  const n = 80;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) {
    const c = 400 + 55 * Math.sin(2 * Math.PI * 3 * i * HOP);
    f0[i] = SA * Math.pow(2, c / 1200);
  }
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: true, minNoteMs: 90 });
  assert.strictEqual(tokens.length, 1);
  assert.ok(tokens[0].andolan, 'detailed keeps andolan');
});

test('clean: a confident brief chromatic swara is preserved exactly', () => {
  // Strong scale {S R G P D}, plus a clearly sung brief komal-ga touch.
  const { f0, clarity } = trackFromRuns([
    [0, 40], [2, 40], [4, 40], [7, 40], [9, 40], [4, 40], [3, 9], [2, 40], [0, 40],
  ]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.ok(tokens.some(t => t.k === 3), `komal ga must not be rewritten to fit an inferred scale: ${tokens.map(t => t.k)}`);
});

test('clean: lines split at >=1 s pauses, sections at >=4 s', () => {
  const { f0, clarity } = trackFromRuns([
    [0, 30], [2, 30], [4, 30],          // line 1
    [null, 80],                          // 1.28 s pause
    [7, 30], [9, 30],                    // line 2
    [null, 280],                         // 4.5 s interlude
    [12, 30], [9, 30],                   // line 3 (new section)
  ]);
  const { phrases } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.strictEqual(phrases.length, 3);
  assert.ok(!phrases[1].section, 'short pause is not a section');
  assert.ok(phrases[2].section, 'long gap starts a new section');
  const txt = DSP.notationText(phrases);
  assert.match(txt, /1\. \[0:00\]/);
  assert.match(txt, /3\. \[/);
  assert.match(txt, /\n\n 3\./, 'blank line before new section');
});

test('clean: tiny fragment line folds into its neighbor', () => {
  const { f0, clarity } = trackFromRuns([
    [0, 30], [2, 30],                    // line 1
    [null, 70],                          // 1.12 s
    [4, 14],                             // fragment (0.22 s)
    [null, 40],                          // 0.64 s
    [7, 30], [9, 30],                    // line 2 body
  ]);
  const { phrases } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.strictEqual(phrases.length, 2, `got ${phrases.length} lines`);
  assert.deepStrictEqual(phrases[1].tokens.map(t => t.k), [4, 7, 9]);
});

/* ----------------------------- synthesis ----------------------------- */

test('synthesize: produces audio where voiced, silence in gaps', () => {
  const n = 100, hopSec = 0.016;
  const f0 = new Float32Array(n), clarity = new Float32Array(n);
  for (let i = 20; i < 60; i++) { f0[i] = 220; clarity[i] = 0.9; }
  const out = DSP.synthesize(f0, clarity, hopSec, SR);
  assert.strictEqual(out.length, n * Math.round(hopSec * SR));
  let voicedE = 0, gapE = 0;
  for (let i = Math.round(30 * hopSec * SR); i < Math.round(50 * hopSec * SR); i++) voicedE += out[i] * out[i];
  for (let i = Math.round(80 * hopSec * SR); i < Math.round(95 * hopSec * SR); i++) gapE += out[i] * out[i];
  assert.ok(voicedE > 1, 'voiced region has energy');
  assert.ok(gapE < voicedE * 0.01, 'gap is quiet');
  for (let i = 0; i < out.length; i++) assert.ok(isFinite(out[i]));
});

/* ---- tonic robustness: Sa must not be confused with Pa/Ma (fifth symmetry) ---- */

function tonicTrack(saHz, notes) {
  let n = 0;
  for (const [, fr] of notes) n += fr;
  const f0 = new Float32Array(n), clarity = new Float32Array(n);
  let i = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (const [k, fr] of notes) {
    for (let j = 0; j < fr; j++, i++) {
      if (k === null) { clarity[i] = 0.2; continue; }
      const vib = 1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * i * 0.016);
      f0[i] = saHz * Math.pow(2, k / 12) * vib * (1 + 0.002 * rnd());
      clarity[i] = 0.88 + 0.05 * rnd();
    }
  }
  return { f0, clarity };
}
const tonicErrCents = (hz, saHz) => { let d = ((1200 * Math.log2(hz / saHz) % 1200) + 1200) % 1200; return Math.min(d, 1200 - d); };

test('detectTonic: Bhupali resolving on Sa picks Sa, not Pa', () => {
  const { f0, clarity } = tonicTrack(SA, [[0,40],[2,40],[4,40],[7,40],[9,40],[7,40],[4,40],[2,40],[0,60]]);
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(tonicErrCents(c[0].hz, SA) < 35 && Math.abs(1200 * Math.log2(c[0].hz / SA)) < 600,
    `expected Sa~${SA}, got ${c[0].hz.toFixed(1)} [${c.map(x => x.hz.toFixed(1)).join(',')}]`);
});

test('detectTonic: multi-phrase Pa-prominent song still resolves to Sa', () => {
  const ph1 = [[0,30],[2,40],[4,40],[7,80],[4,40],[2,40],[0,60]];
  const gap = [[null,40]];
  const ph2 = [[7,60],[9,50],[7,80],[5,40],[4,40],[2,40],[0,60]];
  const ph3 = [[7,90],[12,50],[9,50],[7,60],[5,40],[4,30],[2,40],[0,80]];
  const { f0, clarity } = tonicTrack(SA, [].concat(ph1, gap, ph2, gap, ph3, gap, ph1));
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(tonicErrCents(c[0].hz, SA) < 35 && Math.abs(1200 * Math.log2(c[0].hz / SA)) < 600,
    `expected Sa~${SA}, got ${c[0].hz.toFixed(1)} [${c.map(x => x.hz.toFixed(1)).join(',')}]`);
});

test('detectTonic: brief tracking dropouts do not invent false cadences', () => {
  const noisyIntro = [];
  for (let i = 0; i < 12; i++) noisyIntro.push([8, 30], [null, 2]);
  noisyIntro.push([null, 45]);
  const phrase = [[0,45],[3,35],[5,35],[8,70],[5,35],[3,35],[0,70],[null,45]];
  const { f0, clarity } = tonicTrack(
    SA,
    noisyIntro.concat(phrase, phrase, phrase, phrase)
  );
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(tonicErrCents(c[0].hz, SA) < 35,
    `dropouts promoted a non-Sa pitch: ${c.map(x => x.hz.toFixed(1)).join(',')}`);
});

test('detectTonic: delayed higher-register vocal entry can establish Sa', () => {
  const intro = [[-4, 2250], [null, 50]]; // 36 s low-register accompaniment
  const vocal = [
    [0,90],[3,45],[5,45],[8,80],[10,45],[12,70],
    [8,50],[5,45],[3,45],[0,80],
  ];
  const { f0, clarity } = tonicTrack(SA, intro.concat(vocal, vocal, vocal));
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(tonicErrCents(c[0].hz, SA) < 35,
    `delayed vocal Sa lost to the intro: ${c.map(x => x.hz.toFixed(1)).join(',')}`);
});

test('detectTonic: mandra-register melody keeps Sa in the right octave', () => {
  const { f0, clarity } = tonicTrack(SA, [[-5,60],[-3,60],[-1,60],[0,80],[2,40],[0,40],[-3,60],[-5,80]]);
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(Math.abs(1200 * Math.log2(c[0].hz / SA)) < 35,
    `expected ${SA}, got ${c[0].hz.toFixed(1)}`);
});

test('detectTonic: ambiguous Pa-centric fragment still surfaces Sa in top-3 + flags uncertain', () => {
  const { f0, clarity } = tonicTrack(SA, [[7,90],[9,40],[7,90],[5,30],[7,60],[4,30],[0,40],[7,80]]);
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(c.some(x => tonicErrCents(x.hz, SA) < 35), `Sa should be a candidate: ${c.map(x => x.hz.toFixed(1)).join(',')}`);
  assert.ok(c[0].uncertain, 'a close fifth-symmetry call should be flagged uncertain');
});

test('detectTonic: one Ma-centric phrase is marked uncertain even with a weak runner-up', () => {
  const { f0, clarity } = tonicTrack(SA, [[5,90],[7,40],[5,90],[4,30],[5,60],[2,30],[0,40],[5,80]]);
  const c = DSP.detectTonic(f0, clarity, 0.016);
  assert.ok(c.some(x => tonicErrCents(x.hz, SA) < 35), `Sa should remain available: ${c.map(x => x.hz.toFixed(1)).join(',')}`);
  assert.ok(c[0].uncertain, 'one phrase cannot establish Sa confidently from cadence alone');
});

/* ----------------------------- raga ID ----------------------------- */

const RAGAS = require('../js/ragas.js');
const RagaId = require('../js/ragaId.js');

// Build a fake analyzeRaga output from a swara-letter sequence.
function fakeAnalysis(seqLetters, vadi, samvadi) {
  const L = { S: 0, r: 1, R: 2, g: 3, G: 4, m: 5, M: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };
  const seq = seqLetters.map((x) => L[x]);
  const w = {}; seq.forEach((pc) => { w[pc] = (w[pc] || 0) + 1; });
  const swaras = Object.keys(w).map((pc) => ({ pc: +pc, weight: w[pc] / seq.length, devCents: 0 }));
  const up = new Set(), dn = new Set();
  for (let i = 1; i < seq.length; i++) { if (seq[i] > seq[i - 1]) { up.add(seq[i - 1]); up.add(seq[i]); } else if (seq[i] < seq[i - 1]) { dn.add(seq[i - 1]); dn.add(seq[i]); } }
  return { swaras, seq, vadi: L[vadi], samvadi: L[samvadi], aaroh: [...up], avaroh: [...dn], total: seq.length * 0.5 };
}

test('ragaId: the DB loads and is well-formed', () => {
  assert.ok(RAGAS.length >= 30, `expected 30+ ragas, got ${RAGAS.length}`);
  for (const r of RAGAS) {
    assert.ok(r.name && r.thaat && Array.isArray(r.scalePcs) && r.scalePcs.length, `bad raga ${r.name}`);
    assert.ok(Array.isArray(r.pakad), `${r.name} pakad`);
  }
  assert.ok(RAGAS.some((r) => r.name === 'Yaman') && RAGAS.some((r) => r.name === 'Bhairav'));
});

test('ragaId: identifies Yaman from its scale + pakad + vadi', () => {
  // teevra Ma scale, vadi G samvadi N, with the "N R G M D N S" ascent + pakad.
  const a = fakeAnalysis(['N', 'R', 'G', 'M', 'D', 'N', 'S', 'N', 'D', 'P', 'M', 'G', 'R', 'S', 'P', 'M', 'G', 'R', 'S'], 'G', 'N');
  const ranked = RagaId.rankRagas(a, RAGAS);
  assert.strictEqual(ranked[0].name, 'Yaman', `top=${ranked.slice(0, 3).map((x) => x.name)}`);
  assert.ok(ranked[0].confidence > 0.4);
});

test('ragaId: identifies Bhairav; a foreign note demotes a wrong-scale raga', () => {
  const a = fakeAnalysis(['S', 'r', 'G', 'm', 'P', 'd', 'N', 'S', 'N', 'd', 'P', 'm', 'G', 'r', 'S'], 'd', 'r');
  const ranked = RagaId.rankRagas(a, RAGAS);
  assert.strictEqual(ranked[0].name, 'Bhairav', `top=${ranked.slice(0, 3).map((x) => x.name)}`);
  // Yaman (teevra Ma, shuddh notes) must rank far below — its scale is foreign here.
  const yaman = ranked.find((x) => x.name === 'Yaman');
  assert.ok(yaman.score < ranked[0].score * 0.6, 'Yaman should be strongly demoted for Bhairav input');
});

test('ragaId: confidence never reaches 1 (suggestion, not verdict)', () => {
  const a = fakeAnalysis(['S', 'R', 'G', 'P', 'D', 'S', 'D', 'P', 'G', 'R', 'S'], 'G', 'D');
  const ranked = RagaId.rankRagas(a, RAGAS);
  for (const r of ranked) assert.ok(r.confidence <= 0.95, `${r.name} conf ${r.confidence}`);
});

/* ----------------------------- meend (glide) ----------------------------- */

test('meend: a slow continuous glide becomes ONE meend listing every swara', () => {
  // Smooth S->P glide over 1.4 s (sweeps between semitones).
  const N = Math.round(1.4 / HOP) + 40;
  const f0 = new Float32Array(N), clarity = new Float32Array(N);
  const gN = Math.round(1.4 / HOP);
  for (let i = 0; i < gN; i++) {
    const c = (i / (gN - 1)) * 700;            // 0 -> 700 cents (S -> P)
    f0[i] = SA * Math.pow(2, c / 1200); clarity[i] = 0.9;
  }
  const { tokens, phrases } = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: true });
  const glides = tokens.filter((t) => t.glide);
  assert.strictEqual(glides.length, 1, `expected one glide token, got ${tokens.length} tokens`);
  assert.ok(glides[0].via.length >= 5, `via should list the swaras crossed: ${glides[0].via}`);
  assert.strictEqual(glides[0].via[0], 0);
  assert.strictEqual(glides[0].via[glides[0].via.length - 1], 7);
  assert.match(DSP.notationText(phrases), /S⌒.*⌒P/, `text should show the path: ${DSP.notationText(phrases)}`);
});

test('meend: discrete held notes (a scale, not a glide) are NOT collapsed', () => {
  // S R G m P as DISTINCT held notes (each sits on its semitone) — not a meend.
  const { f0, clarity } = trackFromRuns([[0, 30], [2, 30], [4, 30], [5, 30], [7, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: true });
  assert.ok(!tokens.some((t) => t.glide), 'a stepwise scale of held notes must not become a glide');
  assert.ok(tokens.length >= 4, `held notes preserved: ${tokens.map((t) => t.k)}`);
});

/* ----------------------------- raga analysis ----------------------------- */

// Build tokens from [k, durSec, centsOverride?] triples.
function toks(list) {
  let t = 0;
  return list.map(([k, d, c]) => {
    const tk = { k, t0: t, t1: t + d, cents: c != null ? c : k * 100 };
    t += d;
    return tk;
  });
}

test('analyzeRaga: detects Bhairav thaat from its swar-set', () => {
  // S r G m P d N (asc) then back — Bhairav = {0,1,4,5,7,8,11}
  const seq = [0, 1, 4, 5, 7, 8, 11, 12, 11, 8, 7, 5, 4, 1, 0];
  const r = DSP.analyzeRaga(toks(seq.map((k) => [k, 0.5])), null);
  assert.strictEqual(r.thaat.name, 'Bhairav');
  assert.ok(r.thaat.confidence > 0.6, `confidence ${r.thaat.confidence}`);
  const used = r.swaras.map((s) => s.pc).sort((a, b) => a - b);
  assert.deepStrictEqual(used, [0, 1, 4, 5, 7, 8, 11]);
  // komal re and komal dha flagged komal; shuddh Ga/Ni not
  assert.ok(r.swaras.find((s) => s.pc === 1).komal);
  assert.ok(!r.swaras.find((s) => s.pc === 4).komal);
});

test('analyzeRaga: detects each thaat from its full swar-set', () => {
  const cases = {
    Bilawal: [0, 2, 4, 5, 7, 9, 11], Khamaj: [0, 2, 4, 5, 7, 9, 10],
    Kafi: [0, 2, 3, 5, 7, 9, 10], Asavari: [0, 2, 3, 5, 7, 8, 10],
    Bhairavi: [0, 1, 3, 5, 7, 8, 10], Purvi: [0, 1, 4, 6, 7, 8, 11],
    Marwa: [0, 1, 4, 6, 7, 9, 11], Todi: [0, 1, 3, 6, 7, 8, 11],
  };
  for (const [name, set] of Object.entries(cases)) {
    const seq = set.concat([12], set.slice().reverse());
    const r = DSP.analyzeRaga(toks(seq.map((k) => [k, 0.5])), null);
    assert.strictEqual(r.thaat.name, name, `${name}: got ${r.thaat.name}`);
  }
});

test('analyzeRaga: detects Yaman (Kalyan thaat, tivra Ma)', () => {
  const seq = [0, 2, 4, 6, 7, 9, 11, 12, 11, 9, 7, 6, 4, 2, 0];
  const r = DSP.analyzeRaga(toks(seq.map((k) => [k, 0.5])), null);
  assert.strictEqual(r.thaat.name, 'Kalyan');
  assert.ok(r.swaras.find((s) => s.pc === 6).tivra, 'tivra Ma present');
});

test('analyzeRaga: aaroh/avaroh + vadi + nyas + jati', () => {
  // Bhupali (audav, Kalyan-ish without ma/ni): S R G P D, vadi G, rest on S
  const seq = [0, 2, 4, 7, 9, 7, 4, 2, 0, 0, 0, 4, 4, 4, 4];
  const durs = seq.map((k, i) => [k, k === 4 ? 0.8 : 0.4]); // dwell on G
  const phrases = [{ t0: 0, t1: 9, tokens: toks(seq.map((k) => [k, 0.4])) }];
  const r = DSP.analyzeRaga(toks(durs), phrases);
  assert.ok(r.aaroh.includes(2) && r.aaroh.includes(7), `aaroh ${r.aaroh}`);
  assert.strictEqual(r.vadi, 4, `vadi ${r.vadi} should be G (most dwelt)`);
  assert.ok(r.jati && r.jati.startsWith('audav'), `jati ${r.jati}`);
});

test('analyzeRaga: per-swara intonation (komal ga sung flat)', () => {
  // komal ga consistently 30 cents flat of ET (Darbari-ish)
  const seq = [[0, 1], [3, 1, 270], [3, 1, 268], [2, 1], [0, 1]];
  const r = DSP.analyzeRaga(toks(seq), null);
  const ga = r.swaras.find((s) => s.pc === 3);
  assert.ok(ga.devCents <= -25 && ga.devCents >= -35, `komal ga deviation ${ga.devCents}¢`);
});

/* ------------------------ octave stabilization ------------------------ */

test('stabilizeOctave force: collapses an octave-doubled line to one register', () => {
  // Melody that flips octave on alternate notes (two voices an octave apart).
  const seq = [0, 12, 2, 14, 4, 16, 2, 14, 0, 12];
  const { f0, clarity } = trackFromRuns(seq.map((k) => [k, 18]));
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'force');
  const ks = [];
  for (let i = 0; i < res.f0.length; i++) if (res.f0[i] > 0) ks.push(Math.round(1200 * Math.log2(res.f0[i] / SA) / 100));
  const span = Math.max(...ks) - Math.min(...ks);
  assert.ok(span <= 12, `force-folded span ${span} should be <= 12 semitones`);
});

test('stabilizeOctave auto: fixes an isolated octave glitch but keeps a real leap', () => {
  // Held S, S' (a real octave leap), back to S — with one glitched frame an
  // octave below in the middle of the first S. Auto should fix the glitch and
  // leave the genuine S->S'->S leap intact.
  const seq = [[0, 25], [7, 25], [12, 25], [7, 25], [0, 25]];   // S P S' P S — spans an octave
  const { f0, clarity } = trackFromRuns(seq);
  f0[10] = SA * Math.pow(2, -12 / 12);   // glitch one frame an octave low
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'auto');
  // glitch fixed
  assert.ok(Math.abs(1200 * Math.log2(res.f0[10] / SA)) < 60, `glitch frame should snap to S, got ${(1200 * Math.log2(res.f0[10] / SA)).toFixed(0)}c`);
  // genuine leap preserved: S' frames stay at +1200
  let sPrime = 0;
  for (let i = 55; i < 70; i++) if (res.f0[i] > 0) sPrime = 1200 * Math.log2(res.f0[i] / SA);
  assert.ok(Math.abs(sPrime - 1200) < 60, `taar Sa must be kept at +1200, got ${sPrime.toFixed(0)}c`);
});

test('stabilizeOctave auto: lifts a sustained intra-phrase octave-down error', () => {
  // The real-world failure: inside one continuous phrase the tracker latches the
  // sub-octave for a sustained stretch (e.g. R' mis-tracked as R for ~1s) then
  // steps back up — no silence to mark the boundary. The true line +12,+14,+16
  // is stepwise; the middle is dragged an octave low to +2. Auto must lift the
  // middle back into the neighbours' register (a local-median glitch fix can't —
  // the error is longer than its window).
  const seq = [[12, 40], [2, 55], [16, 40], [12, 40]];   // S' [R-low] G' S'
  const { f0, clarity } = trackFromRuns(seq);
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'auto');
  const mid = [];
  for (let i = 45; i < 90; i++) if (res.f0[i] > 0) mid.push(1200 * Math.log2(res.f0[i] / SA) / 100);
  const medMid = mid.slice().sort((a, b) => a - b)[mid.length >> 1];
  assert.ok(medMid > 8, `sub-octave middle must be lifted into register, got ${medMid.toFixed(1)} semis`);
  // neighbours kept in the taar register (not dragged down to meet the error)
  let g = 0;
  for (let i = 95; i < 130; i++) if (res.f0[i] > 0) g = 1200 * Math.log2(res.f0[i] / SA) / 100;
  assert.ok(g > 12, `taar neighbour must stay high, got ${g.toFixed(1)} semis`);
});

test('stabilizeOctave auto: leaves a clean single-octave melody alone', () => {
  const seq = [0, 2, 4, 5, 7, 5, 4, 2, 0];   // step-wise, no octave jumps
  const { f0, clarity } = trackFromRuns(seq.map((k) => [k, 22]));
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'auto');
  assert.ok(!res.doubled, 'no glitches should be detected');
  for (let i = 0; i < f0.length; i++) assert.strictEqual(res.f0[i], f0[i], 'track unchanged');
});

test('stabilizeOctave gentle: snaps an isolated glitch but never shifts the register', () => {
  // For the octave-accurate neural (CREPE) track. A clean phrase sitting LOW in
  // the range, plus one isolated octave-down glitch. Gentle must (a) snap the
  // glitch back, and (b) leave every other frame exactly where it is — 'auto'
  // would pull the whole low phrase up into the singer's register, which shifts
  // CREPE's already-correct octaves and flips the detected Sa.
  const seq = [[-5, 25], [-3, 25], [-1, 25], [-3, 25], [-5, 25]];   // low, clean, stepwise
  const { f0, clarity } = trackFromRuns(seq);
  const before = f0.slice();
  f0[60] = before[60] / 2;                       // one frame an octave low
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'gentle');
  assert.ok(Math.abs(1200 * Math.log2(res.f0[60] / before[60])) < 60, 'glitch frame snapped back to its neighbours');
  let moved = 0;
  for (let i = 0; i < before.length; i++) {
    if (i === 60 || before[i] <= 0 || res.f0[i] <= 0) continue;
    if (Math.abs(1200 * Math.log2(res.f0[i] / before[i])) > 30) moved++;
  }
  assert.strictEqual(moved, 0, `gentle must keep CREPE's register, but moved ${moved} frames`);
  // sanity: 'auto' on the same low track DOES lift it (so gentle ≠ auto)
  const { f0: f0b, clarity: clb } = trackFromRuns(seq);
  const auto = DSP.stabilizeOctave(f0b, clb, null, HOP, 'auto');
  let lifted = 0;
  for (let i = 0; i < f0b.length; i++) if (f0b[i] > 0 && auto.f0[i] > 0 && auto.f0[i] > f0b[i] * 1.5) lifted++;
  assert.ok(lifted > 50, `auto should lift the low track, lifted ${lifted}`);
});

test('stabilizeOctave: off mode is a no-op', () => {
  const { f0, clarity } = trackFromRuns([[0, 18], [12, 18], [0, 18], [12, 18]]);
  const res = DSP.stabilizeOctave(f0, clarity, null, HOP, 'off');
  assert.ok(!res.doubled);
  for (let i = 0; i < f0.length; i++) assert.strictEqual(res.f0[i], f0[i]);
});

/* ----------------------------- HPSS ----------------------------- */

const rms = (a, s, e) => { let x = 0, n = 0; for (let i = s; i < e; i++) { x += a[i] * a[i]; n++; } return Math.sqrt(x / n); };

test('hpssHarmonic: preserves a sustained tone, suppresses broadband percussion', () => {
  // Sustained 300 Hz tone → harmonic component should survive.
  const tone = new Float32Array(Math.round(1.6 * SR));
  sine(tone, 300, 0.05, 1.55, 0.5, VOICE_H);
  const hTone = DSP.hpssHarmonic(tone, SR);
  const keep = rms(hTone, 4000, 20000) / rms(tone, 4000, 20000);
  assert.ok(keep > 0.7, `sustained tone should be preserved (kept ${keep.toFixed(2)})`);

  // Broadband noise (percussion-like) → should be attenuated.
  let seed = 99;
  const noise = new Float32Array(Math.round(1.6 * SR));
  for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x7fffffff - 0.5); }
  const hNoise = DSP.hpssHarmonic(noise, SR);
  const drop = rms(hNoise, 4000, 20000) / rms(noise, 4000, 20000);
  assert.ok(drop < 0.7, `broadband noise should be attenuated (kept ${drop.toFixed(2)})`);
});

test('hpssHarmonic: a tone hidden under percussion stays trackable', () => {
  // 220 Hz voice + periodic tabla-like noise bursts; HPSS then track.
  const x = new Float32Array(2 * SR);
  let ph = 0;
  for (let i = 0; i < x.length; i++) { ph += 2 * Math.PI * 220 / SR; x[i] = 0.4 * (Math.sin(ph) + 0.4 * Math.sin(2 * ph)); }
  let seed = 7;
  for (let t = 0.2; t < 2; t += 0.4) {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < Math.round(0.03 * SR); i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; if (s0 + i < x.length) x[s0 + i] += 0.8 * (seed / 0x7fffffff - 0.5) * Math.exp(-i / (0.008 * SR)); }
  }
  const h = DSP.hpssHarmonic(x, SR);
  const { f0 } = DSP.yinTrack(h, SR, {});
  let ok = 0, tot = 0;
  for (let i = 10; i < f0.length - 10; i++) if (f0[i] > 0) { tot++; if (Math.abs(1200 * Math.log2(f0[i] / 220)) < 40) ok++; }
  assert.ok(tot > 50 && ok / tot > 0.85, `voice under percussion tracked ${(ok / tot * 100).toFixed(0)}%`);
});

/* ----------------------------- onsets ----------------------------- */

test('detectOnsets: fires once per re-articulated syllable, not on a steady vowel', () => {
  // Four 300 Hz "syllables" with sharp attacks and short gaps.
  const x = new Float32Array(Math.round(2.2 * SR));
  let ph = 0;
  const seg = (t0, t1) => {
    const s0 = Math.round(t0 * SR), s1 = Math.round(t1 * SR);
    for (let i = s0; i < s1; i++) {
      ph += 2 * Math.PI * 300 / SR;
      const env = Math.min(1, (i - s0) / (0.004 * SR)) * Math.min(1, (s1 - i) / (0.02 * SR)); // sharp attack
      x[i] += 0.5 * env * (Math.sin(ph) + 0.4 * Math.sin(2 * ph));
    }
  };
  [[0.1, 0.5], [0.6, 1.0], [1.1, 1.5], [1.6, 2.0]].forEach(([a, b]) => seg(a, b));
  const onsets = DSP.detectOnsets(x, SR, 256);
  assert.ok(onsets.length >= 4 && onsets.length <= 6, `expected ~4 onsets, got ${onsets.length}`);

  // Steady vowel: one smooth note, no interior onsets.
  const steady = new Float32Array(Math.round(1.6 * SR));
  let p2 = 0;
  for (let i = 0; i < steady.length; i++) {
    p2 += 2 * Math.PI * 300 / SR;
    const env = Math.min(1, i / (0.02 * SR)) * Math.min(1, (steady.length - i) / (0.02 * SR));
    steady[i] = 0.5 * env * (Math.sin(p2) + 0.4 * Math.sin(2 * p2));
  }
  const so = DSP.detectOnsets(steady, SR, 256);
  const interior = so.filter((f) => f * 256 / SR > 0.2);
  assert.strictEqual(interior.length, 0, `steady vowel should have no interior onsets, got ${interior.length}`);
});

test('notate: a held pitch splits into a note per syllable onset', () => {
  const { f0, clarity } = trackFromRuns([[0, 200]]);   // one held S, ~3.2 s
  const noSplit = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: false });
  assert.strictEqual(noSplit.tokens.length, 1, 'no onsets -> single held note');

  const withSplit = DSP.notate(f0, clarity, HOP, SA, { clean: true, ornaments: false, onsets: [50, 120] });
  assert.strictEqual(withSplit.tokens.length, 3, `onsets -> one note per syllable, got ${withSplit.tokens.length}`);
  assert.ok(withSplit.tokens.every((t) => t.k === 0), 'all pieces keep the pitch');
  assert.ok(Math.abs(withSplit.tokens[1].t0 - 50 * HOP) < 0.05, 'split lands at the onset');
});

test('notate: fast 110ms syllables split a held pitch', () => {
  const n = 24;
  const f0 = new Float32Array(n).fill(SA * Math.pow(2, 7 / 12));
  const clarity = new Float32Array(n).fill(0.9);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {
    clean: true, ornaments: false, onsetMinMs: 100, onsets: [7, 14],
  });
  assert.deepStrictEqual(tokens.map(t => t.k), [7, 7, 7]);
  assert.ok(tokens[1].reart && tokens[2].reart, 'later syllables are marked re-articulations');
});

/* -------------------------- high-note octaves -------------------------- */

test('yinTrack: taar-saptak notes are not octave-halved', () => {
  for (const f of [587, 880, 990, 1050]) {
    const x = new Float32Array(Math.round(1.2 * SR));
    let ph = [0, 0, 0, 0, 0];
    for (let i = 0; i < x.length; i++) {
      const fr = f * (1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * i / SR));
      let v = 0;
      for (let h = 0; h < 5; h++) { ph[h] += 2 * Math.PI * fr * (h + 1) / SR; v += VOICE_H[h] * Math.sin(ph[h]); }
      const e = Math.min(1, i / 300, (x.length - i) / 300);
      x[i] = 0.4 * v * e;
    }
    const { f0 } = DSP.yinTrack(x, SR, {});
    const vv = [];
    for (let i = 10; i < f0.length - 10; i++) if (f0[i] > 0) vv.push(f0[i]);
    vv.sort((a, b) => a - b);
    const med = vv[vv.length >> 1] || 0;
    assert.ok(Math.abs(1200 * Math.log2(med / f)) < 35, `${f} Hz tracked as ${med.toFixed(1)} Hz (octave error)`);
  }
});

test('yinTrack: octave leaps Sa->Sa\'->Pa\' tracked without halving', () => {
  const parts = [293.66, 587.33, 880, 293.66];
  const x = new Float32Array(Math.round(parts.length * 0.6 * SR));
  let off = 0;
  for (const f of parts) {
    let ph = [0, 0, 0, 0, 0];
    const n = Math.round(0.55 * SR);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let h = 0; h < 5; h++) { ph[h] += 2 * Math.PI * f * (h + 1) / SR; v += VOICE_H[h] * Math.sin(ph[h]); }
      const e = Math.min(1, i / 300, (n - i) / 300);
      x[off + i] = 0.4 * v * e;
    }
    off += Math.round(0.6 * SR);
  }
  const { f0, hopSec } = DSP.yinTrack(x, SR, {});
  parts.forEach((f, s) => {
    const vv = [];
    for (let i = Math.round((s * 0.6 + 0.12) / hopSec); i < Math.round((s * 0.6 + 0.48) / hopSec); i++) if (f0[i] > 0) vv.push(f0[i]);
    vv.sort((a, b) => a - b);
    const med = vv[vv.length >> 1] || 0;
    assert.ok(Math.abs(1200 * Math.log2(med / f)) < 45, `segment ${s} (${f} Hz) tracked as ${med.toFixed(1)} Hz`);
  });
});

/* ----------------------------- pitch shift ----------------------------- */

function measureHz(x, sr) {
  const { f0 } = DSP.yinTrack(x, sr, {});
  const v = [];
  for (let i = 10; i < f0.length - 10; i++) if (f0[i] > 0) v.push(f0[i]);
  v.sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

test('pitchShift: +12 semitones doubles frequency, keeps duration', () => {
  const x = new Float32Array(2 * SR);
  sine(x, 220, 0.05, 1.95, 0.5, VOICE_H);
  const up = DSP.pitchShift(x, SR, 12);
  assert.ok(Math.abs(up.length - x.length) / x.length < 0.05, `duration kept: ${up.length} vs ${x.length}`);
  const hz = measureHz(up, SR);
  assert.ok(Math.abs(1200 * Math.log2(hz / 440)) < 25, `expected ~440 Hz, got ${hz.toFixed(1)}`);
});

test('pitchShift: -12 semitones halves frequency', () => {
  const x = new Float32Array(2 * SR);
  sine(x, 330, 0.05, 1.95, 0.5, VOICE_H);
  const down = DSP.pitchShift(x, SR, -12);
  const hz = measureHz(down, SR);
  assert.ok(Math.abs(1200 * Math.log2(hz / 165)) < 25, `expected ~165 Hz, got ${hz.toFixed(1)}`);
});

test('pitchShift: +2 semitones lands within 20 cents', () => {
  const x = new Float32Array(2 * SR);
  sine(x, 200, 0.05, 1.95, 0.5, VOICE_H);
  const up = DSP.pitchShift(x, SR, 2);
  const hz = measureHz(up, SR);
  const target = 200 * Math.pow(2, 2 / 12);
  assert.ok(Math.abs(1200 * Math.log2(hz / target)) < 20, `expected ~${target.toFixed(1)} Hz, got ${hz.toFixed(1)}`);
});

test('pitchShift: 0 semitones returns an unchanged copy', () => {
  const x = new Float32Array(1000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.1);
  const out = DSP.pitchShift(x, SR, 0);
  assert.notStrictEqual(out, x);
  for (let i = 0; i < x.length; i += 50) assert.strictEqual(out[i], x[i]);
});

test('detectTonic: places Sa in the singer octave', () => {
  // Melody centred above Sa=196 (G3): frames on S, R, G, P, D.
  const hopSec = 0.016;
  const seq = [0, 2, 4, 7, 9, 7, 4, 2, 0, 0];
  const n = seq.length * 50;
  const f0 = new Float32Array(n), clarity = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) f0[i] = 196 * Math.pow(2, seq[Math.floor(i / 50)] / 12);
  const tonic = DSP.detectTonic(f0, clarity, hopSec);
  assert.ok(tonic.length >= 1);
  const best = tonic[0];
  assert.ok(Math.abs(1200 * Math.log2(best.hz / 196)) < 30,
    `expected ~196 Hz, got ${best.hz.toFixed(1)} (cands: ${tonic.map(c => c.hz.toFixed(1)).join(', ')})`);
});

/* ------------------- passing-tone gate (fine-hop tracks) ------------------- */

// Build an f0 track from a list of [k_or_null, ms, glideToNextFrac] at a fine hop.
function fineTrack(notes, hop, sa) {
  const cents = [];
  for (let i = 0; i < notes.length; i++) {
    const [k, ms, gf] = notes[i];
    const nfr = Math.round(ms / 1000 / hop);
    const g = i < notes.length - 1 && gf ? Math.max(1, Math.round(nfr * gf)) : 0;
    for (let j = 0; j < nfr - g; j++) cents.push(k * 100);
    for (let j = 1; j <= g; j++) cents.push(k * 100 + (notes[i + 1][0] - k) * 100 * j / (g + 1));
  }
  const f0 = new Float32Array(cents.length), cl = new Float32Array(cents.length).fill(0.9);
  for (let i = 0; i < cents.length; i++) f0[i] = sa * Math.pow(2, cents[i] / 1200);
  return { f0, cl };
}

test('fine hop: 40ms sargam run resolves note-by-note (praat-track regime)', () => {
  const hop = 0.004, sa = 220;
  const seq = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0];
  const { f0, cl } = fineTrack(seq.map(k => [k, 40, 0.15]), hop, sa);
  const { tokens } = DSP.notate(f0, cl, hop, sa, { clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130, clarityThresh: 0.5 });
  assert.deepStrictEqual(tokens.map(t => t.k), seq, 'every 40ms note is its own swara');
});

test('fine hop: every pitch hit inside one fast melismatic word remains visible', () => {
  const hop = 0.004, sa = 220;
  const seq = [[0, 28, 0.1], [2, 28, 0.1], [4, 32, 0.1], [2, 28, 0.1], [0, 40, 0]];
  const { f0, cl } = fineTrack(seq, hop, sa);
  const { tokens } = DSP.notate(f0, cl, hop, sa, {
    clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130,
  });
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 2, 4, 2, 0]);
});

test('quantization: pitch jitter around an adjacent-swara boundary does not chatter', () => {
  const hop = 0.004, sa = 220;
  const cents = [];
  for (let block = 0; block < 10; block++) {
    const c = block % 2 ? 155 : 145; // around the r/R midpoint at 150 cents
    for (let j = 0; j < 10; j++) cents.push(c);
  }
  const f0 = new Float32Array(cents.length);
  const cl = new Float32Array(cents.length).fill(0.9);
  for (let i = 0; i < cents.length; i++) f0[i] = sa * Math.pow(2, cents[i] / 1200);
  const { tokens } = DSP.notate(f0, cl, hop, sa, {
    clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130,
  });
  assert.deepStrictEqual(tokens.map(t => t.k), [1], `boundary jitter must keep one label, got ${tokens.map(t => t.k)}`);
});

test('fine hop: andolan timing matches the 16ms browser-track decision', () => {
  const hop = 0.004, sa = 220;
  const n = Math.round(1.28 / hop);
  const f0 = new Float32Array(n), cl = new Float32Array(n).fill(0.9);
  for (let i = 0; i < n; i++) {
    const c = 400 + 55 * Math.sin(2 * Math.PI * 3 * i * hop);
    f0[i] = sa * Math.pow(2, c / 1200);
  }
  const { tokens } = DSP.notate(f0, cl, hop, sa, {
    clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130,
  });
  assert.strictEqual(tokens.length, 1);
  assert.ok(tokens[0].andolan, '4 ms timing must not make a 3 Hz andolan appear four times slower');
});

test('passing-tone gate: glide fragments do not become fake notes', () => {
  // Held S, one continuous fast glide up to G (passing r and R mid-glide with
  // no plateau), held G. The r/R fragments must NOT appear as sung notes.
  const hop = 0.004, sa = 220;
  const cents = [];
  const put = (v, ms) => { for (let j = 0; j < Math.round(ms / 1000 / hop); j++) cents.push(v); };
  put(0, 300);
  const gl = Math.round(0.06 / hop);                     // 60ms continuous sweep 0->400c
  for (let j = 1; j <= gl; j++) cents.push(400 * j / (gl + 1));
  put(400, 300);
  const f0 = new Float32Array(cents.length), cl = new Float32Array(cents.length).fill(0.9);
  for (let i = 0; i < cents.length; i++) f0[i] = sa * Math.pow(2, cents[i] / 1200);
  const { tokens } = DSP.notate(f0, cl, hop, sa, { clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130, clarityThresh: 0.5 });
  const ks = tokens.map(t => t.k);
  assert.ok(!ks.includes(1) && !ks.includes(2), `no fake passing notes, got ${ks.join(',')}`);
  assert.ok(ks.includes(0) && ks.includes(4), `S and G kept, got ${ks.join(',')}`);
});

test('passing-tone gate: fast murki (G R G) survives, glide fragment does not swallow it', () => {
  const hop = 0.004, sa = 220;
  const { f0, cl } = fineTrack([[0, 400, 0.1], [4, 40, 0.1], [2, 40, 0.1], [4, 40, 0.1], [5, 400, 0]], hop, sa);
  const { tokens } = DSP.notate(f0, cl, hop, sa, { clean: true, ornaments: true, ornMinMs: 25, minNoteMs: 130, clarityThresh: 0.5 });
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4, 2, 4, 5], 'murki notes all surface');
});
