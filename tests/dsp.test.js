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

test('ornaments: single short note before a stable note becomes kan', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4]);
  assert.deepStrictEqual(tokens[1].kan, [2]);
  assert.strictEqual(DSP.tokenFullText(tokens[1]), '(R)G');
});

test('ornaments: 2-4 short notes become a murki cluster', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [4, 3], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4]);
  assert.deepStrictEqual(tokens[1].murki, [4, 2]);
  assert.strictEqual(DSP.tokenFullText(tokens[1]), '(GR)G');
});

test('ornaments: monotonic chain becomes a meend connector', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [1, 3], [2, 3], [3, 3], [4, 30]]);
  const { tokens, phrases } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4]);
  assert.ok(tokens[1].meendFromPrev, 'second token should carry meend connector');
  assert.ok(!tokens[1].murki && !tokens[1].kan);
  assert.match(DSP.notationText(phrases), /S~G/);
});

test('ornaments: >4 fast short notes promote to real tokens (taan)', () => {
  const seq = [0, 2, 4, 5, 7, 5, 4, 2];
  const { f0, clarity } = trackFromRuns(seq.map(k => [k, 4]));
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.deepStrictEqual(tokens.map(t => t.k), seq);
});

test('ornaments: trailing short note becomes a grace after', () => {
  const { f0, clarity } = trackFromRuns([[4, 30], [2, 3]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, {});
  assert.strictEqual(tokens.length, 1);
  assert.deepStrictEqual(tokens[0].graceAfter, [2]);
  assert.strictEqual(DSP.tokenFullText(tokens[0]), 'G(R)');
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

test('ornaments: smooth mode suppresses ornament extraction', () => {
  const { f0, clarity } = trackFromRuns([[0, 30], [2, 3], [4, 30]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, { ornaments: false });
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 4]);
  assert.ok(!tokens[1].kan, 'no kan in smooth mode');
});

/* ----------------------------- clean mode ----------------------------- */

const CLEAN = { clean: true, ornaments: false, minNoteMs: 150 };

test('clean: weak short blips between phrases are dropped', () => {
  const { f0, clarity } = trackFromRuns([
    [0, 32], [null, 30], [4, 12, 0.56], [null, 30], [7, 32], [null, 20], [2, 8, 0.53], [null, 30], [4, 32],
  ]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 7, 4]);
});

test('clean: glitch jump far from both neighbors is dropped', () => {
  const { f0, clarity } = trackFromRuns([[0, 32], [12, 9], [2, 32]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.deepStrictEqual(tokens.map(t => t.k), [0, 2]);
});

test('clean: same swara re-struck across a breath merges into one note', () => {
  const { f0, clarity } = trackFromRuns([[7, 28], [null, 12], [7, 28]]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].k, 7);
  assert.ok(tokens[0].t1 - tokens[0].t0 > 1.0, 'merged duration spans the gap');
});

test('clean: note re-sung on syllables collapses into one held note', () => {
  // P sung three times with ~0.45 s articulation gaps = one held P.
  const { f0, clarity } = trackFromRuns([
    [7, 25], [null, 28], [7, 25], [null, 30], [7, 25],
  ]);
  const { tokens, phrases } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.strictEqual(tokens.length, 1, `expected one held note, got ${tokens.map(t => t.k)}`);
  assert.strictEqual(tokens[0].k, 7);
  const txt = DSP.notationText(phrases);
  assert.match(txt, /P( –){4,}/, `dashes should span the hold: ${txt}`);
  assert.strictEqual((txt.match(/P/g) || []).length, 1, `P written once: ${txt}`);
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

test('clean: rare off-scale short note snaps onto the scale', () => {
  // Strong scale {S R G P D}, one brief komal-ga stray.
  const { f0, clarity } = trackFromRuns([
    [0, 40], [2, 40], [4, 40], [7, 40], [9, 40], [4, 40], [3, 9], [2, 40], [0, 40],
  ]);
  const { tokens } = DSP.notate(f0, clarity, HOP, SA, CLEAN);
  assert.ok(!tokens.some(t => t.k === 3), `stray komal ga should snap: ${tokens.map(t => t.k)}`);
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
