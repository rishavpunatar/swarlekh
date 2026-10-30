#!/usr/bin/env node
'use strict';

// Known-answer Hindustani benchmark. Every raga in js/ragas.js is rendered as
// a short performance built from its own aaroh, avaroh and pakads, with
// raga-typical intonation (low komal re in Bhairav, Darbari's andolit ga),
// meends, vibrato, breaths and optional pitch drift. Each performance runs
// through the app's real code, and we score what matters to a learner:
//   Sa pitch class, Sa octave, every swara (with octave), absolute pitch,
//   and notes that were never sung.
//
// Two paths:
//   best — the local server's output (clean separated-voice f0 + GAME-like
//          note regions) through the worker steps and DSP.notateRegions.
//   fast — rendered audio (voice with formants + tanpura + tabla) through the
//          in-browser engine: preFilter → YIN → octave pass → tonic → notate.
//
//   node evaluation/synthetic-hindustani.js            # full report
//   node evaluation/synthetic-hindustani.js --quick    # every 3rd raga
//
// Synthetic voices are simpler than real ones: these numbers locate failure
// modes and catch regressions; real accuracy comes from evaluate-saraga.js.

const RAGAS = require('../js/ragas.js');

const LETTER = { S: 0, r: 1, R: 2, g: 3, G: 4, m: 5, M: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };
const CLEAN = { clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45, onsetMinMs: 100, clean: true };
const SR = 16000;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function parsePhrase(str) {
  const out = [];
  const re = /(\.*)([SrRgGmMPdDnN])('*)/g;
  let m;
  while ((m = re.exec(str))) out.push(LETTER[m[2]] - 12 * m[1].length + 12 * m[3].length);
  return out;
}
// Intonation commonly heard in these ragas (cents from equal temperament).
function intonation(raga, pc) {
  const name = raga.name;
  if (pc === 1 && /Bhairav|Todi|Marwa|Puriya|Lalit/.test(name)) return -18;
  if (pc === 3 && /Darbari/.test(name)) return -30;
  if (pc === 8 && /Darbari|Bhairav|Todi/.test(name)) return -15;
  if (pc === 6) return 12;
  return 0;
}
const andolit = (raga, pc) => /Darbari/.test(raga.name) && (pc === 3 || pc === 8);

function generate(raga, saHz, opts = {}) {
  const r = rng(opts.seed || 1);
  const hop = 0.01;
  const phrases = [parsePhrase(raga.aroha || ''), parsePhrase(raga.avaroha || '')];
  for (const p of raga.pakad || []) phrases.push(parsePhrase(p));
  phrases.push(parsePhrase(raga.avaroha || ''));
  for (const p of (raga.pakad || []).slice(0, 2)) phrases.push(parsePhrase(p));
  // Drift is a slow, long-performance effect: repeat the material to make a
  // performance long enough (~1.5 min) for it to show.
  if (opts.repeat > 1) phrases.push(...[].concat(...Array(opts.repeat - 1).fill(phrases.slice())));
  const notes = [];
  let t = 0.4;
  for (const phrase of phrases) {
    if (!phrase.length) continue;
    phrase.forEach((k, i) => {
      const last = i === phrase.length - 1;
      const dur = last ? 1.0 + r() * 0.9 : [0.22, 0.32, 0.45, 0.6, 0.85][Math.floor(r() * 5)];
      notes.push({ t0: t, t1: t + dur, k, glideIn: i > 0 && r() < 0.25 });
      t += dur;
    });
    t += 0.35 + r() * 0.5;                        // breath between phrases
  }
  const n = Math.ceil((t + 0.5) / hop);
  const f0 = new Float32Array(n), clarity = new Float32Array(n), rms = new Float32Array(n);
  const total = t;
  for (let ni = 0; ni < notes.length; ni++) {
    const note = notes[ni];
    const pc = ((note.k % 12) + 12) % 12;
    const base = note.k * 100 + intonation(raga, pc) + (r() - 0.5) * 16;
    note.cents = base;
    const prev = notes[ni - 1];
    const glide = note.glideIn && prev && Math.abs(prev.t1 - note.t0) < 1e-6 ? 0.08 + r() * 0.1 : 0;
    const vib = !andolit(raga, pc) && note.t1 - note.t0 > 0.6 && r() < (opts.vibrato != null ? opts.vibrato : 0.3);
    for (let i = Math.floor(note.t0 / hop); i < Math.min(n, Math.ceil(note.t1 / hop)); i++) {
      const tt = i * hop;
      let c = base;
      if (glide && tt < note.t0 + glide) {
        const x = (tt - note.t0) / glide, s = x * x * (3 - 2 * x);
        c = prev.cents + (base - prev.cents) * s;
      }
      if (andolit(raga, pc) && note.t1 - note.t0 > 0.4) c += 45 * Math.sin(2 * Math.PI * 0.9 * (tt - note.t0));
      if (vib) c += 22 * Math.sin(2 * Math.PI * 5.5 * tt);
      if (opts.driftCents) c += opts.driftCents * (tt / total);
      c += (r() - 0.5) * 6;                        // tracker jitter
      f0[i] = saHz * Math.pow(2, c / 1200);
      clarity[i] = 0.82 + r() * 0.16;
      const env = Math.min(1, (tt - note.t0) / 0.04, (note.t1 - tt) / 0.04 + 0.6);
      rms[i] = 0.08 * Math.max(0.3, env) * (1 + 0.06 * Math.sin(2 * Math.PI * 3 * tt));
    }
  }
  return { f0, clarity, rms, hop, notes, saHz, duration: total, raga: raga.name, driftCents: opts.driftCents || 0 };
}

// Voice (glottal source with vowel formants) + tanpura + tabla at fixed levels
// relative to the voice.
function render(perf, opts = {}) {
  const r = rng(7);
  const n = Math.ceil(perf.duration * SR) + SR;
  const voice = new Float32Array(n), drone = new Float32Array(n), tabla = new Float32Array(n);
  const formants = [[700, 110], [1150, 120], [2600, 160]];
  const gain = (f) => formants.reduce((a, [fc, bw]) => a + 4 / (1 + ((f - fc) / bw) ** 2), 1);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const fi = i / SR / perf.hop, i0 = Math.floor(fi);
    const a = perf.f0[i0] || 0, b = perf.f0[i0 + 1] || 0;
    const f = a > 0 && b > 0 ? a + (b - a) * (fi - i0) : (a || b);
    if (f > 0) {
      phase += 2 * Math.PI * f / SR;
      let s = 0;
      for (let h = 1; h * f < 3800; h++) s += gain(h * f) * Math.sin(h * phase) / h;
      voice[i] = s * (perf.rms[i0] / 0.08 || 0);
    }
  }
  if (opts.tanpura !== false) {
    const strings = [perf.saHz * 0.75, perf.saHz, perf.saHz, perf.saHz / 2];   // Pa, Sa, Sa, mandra Sa
    for (let k = 0; k * 0.9 < perf.duration; k++) {
      const f = strings[k % 4], i0 = Math.floor(k * 0.9 * SR);
      for (let j = 0; j < 3.2 * SR && i0 + j < n; j++) {
        let s = 0;
        for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f * h * j / SR) / h;
        drone[i0 + j] += Math.exp(-j / (1.6 * SR)) * s;
      }
    }
  }
  if (opts.tabla !== false) {
    for (let k = 0; k * 0.4 < perf.duration; k++) {
      const i0 = Math.floor(k * 0.4 * SR), bayan = k % 4 === 0;
      for (let j = 0; j < 0.12 * SR && i0 + j < n; j++) {
        const env = Math.exp(-j / ((bayan ? 0.05 : 0.015) * SR));
        tabla[i0 + j] += env * Math.sin(2 * Math.PI * (bayan ? 80 : perf.saHz * 2) * j / SR) + 0.2 * env * (r() - 0.5);
      }
    }
  }
  const level = (x) => { let e = 0, c = 0; for (const v of x) if (v) { e += v * v; c++; } return Math.sqrt(e / Math.max(c, 1)) || 1; };
  const v = level(voice);
  const dg = v / level(drone) * Math.pow(10, -(opts.droneDb != null ? opts.droneDb : 15) / 20);
  const tg = v / level(tabla) * Math.pow(10, -(opts.tablaDb != null ? opts.tablaDb : 10) / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.1 * (voice[i] + dg * drone[i] + tg * tabla[i]) / v;
  return out;
}

function regionsFor(perf, seed) {
  const r = rng(seed);
  return perf.notes.map((note) => {
    const i0 = Math.floor(note.t0 / perf.hop), i1 = Math.ceil(note.t1 / perf.hop);
    let s = 0, c = 0;
    for (let i = i0; i < i1; i++) if (perf.f0[i] > 0) { s += Math.log2(perf.f0[i]); c++; }
    const hz = Math.pow(2, s / Math.max(c, 1));
    return {
      onset: Math.max(0, note.t0 + (r() - 0.5) * 0.04), offset: note.t1 + (r() - 0.5) * 0.04,
      frequency: hz, midi: 69 + 12 * Math.log2(hz / 440),
    };
  });
}

function analyzeBest(DSP, perf) {
  const { clarity, rms, hop } = perf;
  let stable = DSP.stabilizeOctave(Float32Array.from(perf.f0), clarity, rms, hop, 'gentle').f0;
  let regions = regionsFor(perf, 99);
  let tonic;
  if (DSP.tonicWithDrift) {                       // same steps as js/worker.js
    const t = DSP.tonicWithDrift(stable, clarity, hop, rms);
    tonic = t.tonic; stable = t.f0;
    if (t.drift) {
      regions = regions.map((r) => {
        const f = r.frequency * Math.pow(2, -DSP.driftAt(t.drift, (r.onset + r.offset) / 2) / 1200);
        return Object.assign({}, r, { frequency: f, midi: 69 + 12 * Math.log2(f / 440) });
      });
    }
  } else {
    tonic = DSP.detectTonic(stable, clarity, hop, rms);
  }
  const sa = tonic[0].hz;
  const opts = Object.assign({}, CLEAN, { rms, onsets: perf.notes.map((n) => Math.round(n.t0 / hop)) });
  const { tokens } = DSP.notateRegions(regions, stable, clarity, hop, sa, opts);
  return { sa, tokens, uncertain: !!tonic[0].uncertain };
}

function analyzeFast(DSP, samples) {
  const filtered = DSP.preFilter(samples, SR);
  const track = DSP.yinTrack(filtered, SR, {});
  const stable = DSP.stabilizeOctave(track.f0, track.clarity, track.rms, track.hopSec, 'auto');
  let tonic;
  if (DSP.tonicWithDrift) {                       // same steps as js/worker.js
    const t = DSP.tonicWithDrift(stable.f0, track.clarity, track.hopSec, track.rms);
    tonic = t.tonic; stable.f0 = t.f0;
  } else {
    tonic = DSP.detectTonic(stable.f0, track.clarity, track.hopSec, track.rms);
  }
  const onsets = DSP.detectOnsets(filtered, SR, Math.round(track.hopSec * SR),
    DSP.voiceOnsetEvidence ? { track } : undefined);
  const sa = tonic[0].hz;
  const { tokens } = DSP.notate(stable.f0, track.clarity, track.hopSec, sa,
    Object.assign({}, CLEAN, { onsets, rms: track.rms }));
  return { sa, tokens, uncertain: !!tonic[0].uncertain };
}

const circular = (c) => { const d = ((c % 1200) + 1200) % 1200; return Math.min(d, 1200 - d); };

function scoreRun(perf, result, agg) {
  // With drift there is no single true Sa; judge against the average tuning.
  const refSa = perf.saHz * Math.pow(2, (perf.driftCents || 0) / 2 / 1200);
  const err = 1200 * Math.log2(result.sa / refSa);
  const pcOk = circular(err) < 30, octOk = pcOk && Math.abs(err) < 600;
  agg.runs++; agg.saPc += pcOk; agg.saOct += octOk;
  if (!octOk) agg.misses.push(`${perf.raga}@${perf.saHz}:${err.toFixed(0)}c`);
  agg.tokens += result.tokens.length;
  for (const note of perf.notes) {
    if (note.t1 - note.t0 < 0.12) continue;
    agg.truth++;
    let best = null, overlap = 0;
    for (const tk of result.tokens) {
      const o = Math.min(tk.t1, note.t1) - Math.max(tk.t0, note.t0);
      if (o > overlap) { overlap = o; best = tk; }
    }
    if (!best || overlap < 0.05) continue;
    if (best.k === note.k) agg.swara++;
    const predHz = result.sa * Math.pow(2, best.k / 12), trueHz = perf.saHz * Math.pow(2, note.k / 12);
    if (Math.abs(1200 * Math.log2(predHz / trueHz)) < 50) agg.pitch++;
  }
  for (const tk of result.tokens) {
    const sung = perf.notes.some((note) => Math.min(tk.t1, note.t1) - Math.max(tk.t0, note.t0) >= 0.5 * (tk.t1 - tk.t0));
    if (!sung) agg.spurious++;
  }
  // Same-swara splits inside one sung note (e.g. at tabla strokes).
  for (let i = 1; i < result.tokens.length; i++) {
    const a = result.tokens[i - 1], b = result.tokens[i];
    if (a.k === b.k && b.t0 - a.t1 < 0.03 && !perf.notes.some((note) => Math.abs(note.t0 - b.t0) < 0.06)) agg.splits++;
  }
}

function newAgg() {
  return { runs: 0, saPc: 0, saOct: 0, truth: 0, swara: 0, pitch: 0, tokens: 0, spurious: 0, splits: 0, misses: [] };
}
function summarize(agg) {
  const ratio = (a, b) => (b ? a / b : 0);
  return {
    runs: agg.runs, saPitchClass: ratio(agg.saPc, agg.runs), saOctave: ratio(agg.saOct, agg.runs),
    swara: ratio(agg.swara, agg.truth), pitch: ratio(agg.pitch, agg.truth),
    spurious: ratio(agg.spurious, agg.tokens), falseSplits: ratio(agg.splits, agg.truth), misses: agg.misses,
  };
}

function ragasFor(step) { return RAGAS.filter((_, i) => i % step === 0); }

function runBest(DSP, { sas, step = 1, gen = {} }) {
  const agg = newAgg();
  ragasFor(step).forEach((raga, ri) => {
    for (const saHz of sas) {
      const perf = generate(raga, saHz, Object.assign({ seed: ri * 31 + Math.round(saHz) }, gen));
      scoreRun(perf, analyzeBest(DSP, perf), agg);
    }
  });
  return summarize(agg);
}

function runFast(DSP, { sas, step = 1, gen = {}, mix = {} }) {
  const agg = newAgg();
  ragasFor(step).forEach((raga, ri) => {
    for (const saHz of sas) {
      const perf = generate(raga, saHz, Object.assign({ seed: ri * 17 + Math.round(saHz) }, gen));
      scoreRun(perf, analyzeFast(DSP, render(perf, mix)), agg);
    }
  });
  return summarize(agg);
}

const SUITES = {
  best: [
    ['male Sa', { sas: [110, 130.8, 146.8] }],
    ['female Sa', { sas: [196, 220, 261.6] }],
    ['vibrato', { sas: [146.8, 220], gen: { vibrato: 1 } }],
    ['+40c drift', { sas: [146.8, 220], gen: { driftCents: 40, repeat: 2 } }],
    ['+70c drift', { sas: [146.8, 220], gen: { driftCents: 70, repeat: 2 } }],
  ],
  fast: [
    ['male, tanpura+tabla', { sas: [130.8] }],
    ['female, tanpura+tabla', { sas: [220] }],
    ['vibrato, tanpura+tabla', { sas: [146.8], gen: { vibrato: 1 } }],
    ['female, loud tanpura', { sas: [220], mix: { droneDb: 6 } }],
  ],
};

module.exports = { generate, render, analyzeBest, analyzeFast, runBest, runFast, SUITES, parsePhrase };

if (require.main === module) {
  const DSP = require(process.env.SWARLEKH_DSP ? require('path').resolve(process.env.SWARLEKH_DSP) : '../js/dsp.js');
  const step = process.argv.includes('--quick') ? 3 : 1;
  const pct = (x) => (100 * x).toFixed(1).padStart(5) + '%';
  for (const [engine, suites] of Object.entries(SUITES)) {
    for (const [name, cfg] of suites) {
      const run = engine === 'best' ? runBest : runFast;
      const s = run(DSP, Object.assign({ step }, cfg));
      console.log(`${(engine + ': ' + name).padEnd(30)} Sa ${pct(s.saOctave)} (class ${pct(s.saPitchClass)}) · swara ${pct(s.swara)} · pitch ${pct(s.pitch)} · spurious ${pct(s.spurious)} · false splits ${pct(s.falseSplits)}`);
      if (process.argv.includes('--misses') && s.misses.length) console.log('   ', s.misses.slice(0, 12).join(' '));
    }
  }
}
