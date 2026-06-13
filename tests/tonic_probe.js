'use strict';
/* Throwaway probe: how robust is detectTonic across realistic melodic shapes?
 * Builds f0/clarity tracks directly (one frame = 16 ms) with vibrato + noise. */
const DSP = require('../js/dsp.js');
const HOP = 0.016;

function buildTrack(saHz, notes, opts) {
  opts = opts || {};
  let n = 0;
  for (const [, fr] of notes) n += fr;
  const f0 = new Float32Array(n), clarity = new Float32Array(n);
  let i = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (const [k, fr] of notes) {
    for (let j = 0; j < fr; j++, i++) {
      if (k === null) { f0[i] = 0; clarity[i] = 0.2 + 0.1 * rnd(); continue; }
      const vib = 1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * i * HOP);
      const cents = k * 100 + (opts.detune ? opts.detune * 100 : 0);
      f0[i] = saHz * Math.pow(2, cents / 1200) * vib * (1 + 0.002 * rnd());
      clarity[i] = (opts.clar != null ? opts.clar : 0.88) + 0.05 * rnd();
    }
  }
  return { f0, clarity };
}

const cents = (a, b) => 1200 * Math.log2(a / b);

function run(name, saHz, notes, opts) {
  const { f0, clarity } = buildTrack(saHz, notes, opts);
  const cands = DSP.detectTonic(f0, clarity, HOP);
  const top = cands[0];
  const pcErr = (() => { let d = ((cents(top.hz, saHz) % 1200) + 1200) % 1200; return Math.min(d, 1200 - d); })();
  const octErr = Math.abs(cents(top.hz, saHz)) >= 600;
  const pcOK = pcErr < 35;
  const inTop3 = cands.some(c => { let d = ((cents(c.hz, saHz) % 1200) + 1200) % 1200; return Math.min(d, 1200 - d) < 35; });
  const verdict = (pcOK && !octErr) ? 'OK ' : (pcOK ? 'OCT' : (inTop3 ? 'T3 ' : 'BAD'));
  console.log(
    `${verdict} | ${name.padEnd(34)} true=${saHz.toFixed(1)}  ` +
    `top=${top.hz.toFixed(1)} (${cents(top.hz, saHz) >= 0 ? '+' : ''}${cents(top.hz, saHz).toFixed(0)}c)  ` +
    `cands=[${cands.map(c => c.hz.toFixed(1)).join(', ')}]`
  );
  return verdict;
}

/* Optional faint tanpura: real recordings drone Sa (and Pa) continuously, so
 * sprinkle low-clarity Sa/Pa frames under the melody to mimic leakage that
 * survives filtering. Tests both with (realistic) and without (hard mode). */
function withDrone(track, saHz, frac) {
  const { f0, clarity } = track;
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] === 0 && (i % 3 === 0)) {
      f0[i] = (i % 2 ? saHz : saHz * Math.pow(2, 7 / 12)) * (i % 5 ? 1 : 0.5);
      clarity[i] = 0.5 + 0.06 * Math.sin(i);
    }
  }
  return track;
}

const SA = 146.83; // D3
const results = [];
const drone = process.argv.includes('--drone');
const T = (name, notes, opts, sa) => {
  const trueSa = sa || SA;
  let track = buildTrack(trueSa, notes, opts || {});
  if (drone) track = withDrone(track, trueSa);
  const cands = DSP.detectTonic(track.f0, track.clarity, HOP);
  results.push(report(name, trueSa, cands));
};

function report(name, saHz, cands) {
  const top = cands[0];
  const pcErr = (() => { let d = ((cents(top.hz, saHz) % 1200) + 1200) % 1200; return Math.min(d, 1200 - d); })();
  const octErr = Math.abs(cents(top.hz, saHz)) >= 600;
  const pcOK = pcErr < 35;
  const inTop3 = cands.some(c => { let d = ((cents(c.hz, saHz) % 1200) + 1200) % 1200; return Math.min(d, 1200 - d) < 35; });
  const verdict = (pcOK && !octErr) ? 'OK ' : (pcOK ? 'OCT' : (inTop3 ? 'T3 ' : 'BAD'));
  console.log(
    `${verdict} | ${name.padEnd(34)} true=${saHz.toFixed(1)}  ` +
    `top=${top.hz.toFixed(1)} (${cents(top.hz, saHz) >= 0 ? '+' : ''}${cents(top.hz, saHz).toFixed(0)}c)  ` +
    `2nd@${cands[1] ? (cands[1].score).toFixed(2) : '—'}  ` +
    `cands=[${cands.map(c => c.hz.toFixed(1)).join(', ')}]`
  );
  return verdict;
}

// 1. Bhupali, Sa-rooted, resolves on Sa.
T('Bhupali, ends Sa', [[0,40],[2,40],[4,40],[7,40],[9,40],[7,40],[4,40],[2,40],[0,60]]);
// 2. Pa emphasis (P held a lot), some Sa.
T('Pa-heavy phrase', [[7,90],[9,40],[7,90],[5,30],[7,60],[4,30],[0,40],[7,80]]);
// 3. Ma-heavy.
T('Ma-heavy phrase', [[5,90],[7,40],[5,90],[4,30],[5,60],[2,30],[0,40],[5,80]]);
// 4. Mandra-register heavy (sings below Sa a lot).
T('Mandra-register heavy', [[-5,60],[-3,60],[-1,60],[0,80],[2,40],[0,40],[-3,60],[-5,80]]);
// 5. Ends on Pa, not Sa.
T('Ends on Pa', [[0,40],[2,40],[4,40],[5,40],[7,40],[9,40],[7,40],[5,40],[7,90]]);
// 6. Taar-heavy (upper octave).
T('Taar-register heavy', [[12,60],[14,40],[12,60],[11,40],[9,40],[12,60],[7,40],[12,60]]);
// 7. Komal-thaat (Bhairavi-ish): S r g m P d n, ends Sa.
T('Bhairavi (komal), ends Sa', [[0,40],[1,40],[3,40],[5,40],[7,40],[8,40],[10,40],[12,40],[10,30],[7,30],[3,30],[0,60]]);
// 8. Different tonic (F#3 ~185 Hz).
T('Yaman-ish @F#3, ends Sa', [[0,40],[4,40],[6,40],[7,40],[11,40],[7,40],[6,40],[4,40],[0,60]], {}, 185.0);
// 9. Sa rare in the melody (avroh emphasis), Pa+Ga prominent.
T('Sa rare, Pa/Ga prominent', [[7,80],[4,80],[7,80],[4,60],[2,30],[7,80],[4,60],[0,25]]);
// 10. Wide range, Sa moderate, ends Sa.
T('Wide range, ends Sa', [[-5,30],[0,50],[4,40],[7,40],[12,40],[9,40],[5,40],[0,70]]);

// 11. Full multi-phrase song: Pa-prominent but phrases resolve to Sa (realistic).
const G = []; // gap
const ph1 = [[0,30],[2,40],[4,40],[7,80],[4,40],[2,40],[0,60]];
const gap = [[null,40]];
const ph2 = [[7,60],[9,50],[7,80],[5,40],[4,40],[2,40],[0,60]];
const ph3 = [[7,90],[12,50],[9,50],[7,60],[5,40],[4,30],[2,40],[0,80]];
T('Multi-phrase, Pa-prominent->Sa', [].concat(ph1, gap, ph2, gap, ph3, gap, ph1));

console.log('\nSummary:', results.reduce((a, v) => (a[v] = (a[v] || 0) + 1, a), {}));
