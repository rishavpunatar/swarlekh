/* SwarLekh — DSP core: pitch tracking (fast YIN + Viterbi), tonic detection,
 * sargam quantization, melody synthesis. Pure functions, no DOM. UMD so the
 * same file runs in the browser (page + worker) and under Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./fft.js'));
  } else {
    root.DSP = factory(root.FFTMod);
  }
}(typeof self !== 'undefined' ? self : this, function (FFTMod) {
  'use strict';
  const fft = FFTMod.fft;

  /* ---------------------------------------------------------------- *
   * Pre-filtering: peak normalize + band-limit to the vocal range.
   * High-pass 70 Hz kills rumble/bayan thumps; low-pass 1800 Hz keeps
   * voice fundamentals + low harmonics while dropping jawari shimmer.
   * ---------------------------------------------------------------- */

  function biquadCoefs(type, fc, sr, Q) {
    const w = 2 * Math.PI * fc / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * Q);
    let b0, b1, b2;
    if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function applyBiquad(x, c) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = c.b0 * xi + s1;
      s1 = c.b1 * xi - c.a1 * y + s2;
      s2 = c.b2 * xi - c.a2 * y;
      x[i] = y;
    }
  }

  /** Returns a new band-limited, peak-normalized copy of the signal. */
  function preFilter(samples, sr) {
    const x = new Float32Array(samples);
    let peak = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    if (peak > 1e-6) {
      const g = 0.95 / peak;
      for (let i = 0; i < x.length; i++) x[i] *= g;
    }
    applyBiquad(x, biquadCoefs('hp', 70, sr, 0.707));
    applyBiquad(x, biquadCoefs('hp', 70, sr, 0.707));
    applyBiquad(x, biquadCoefs('lp', 1800, sr, 0.707));
    return x;
  }

  /* ---------------------------------------------------------------- *
   * Lightweight HPSS (Fitzgerald median-filtering). Returns a new
   * Float32Array with only the HARMONIC (sustained-pitch) component, so
   * tabla/percussion transients are suppressed before pitch tracking.
   * Original phase preserved; a mask floor guarantees the voice is never
   * fully removed. Runs in the worker before the band-pass.
   * ---------------------------------------------------------------- */
  function hpssHarmonic(samples, sr, opts) {
    opts = opts || {};
    const N = opts.N || 1024;       // 64 ms window @ 16 kHz
    const H = opts.H || 256;        // 16 ms hop (75% overlap)
    const Lh = opts.Lh || 17;       // horizontal (time) median length, odd
    const Lp = opts.Lp || 17;       // vertical (freq) median length, odd
    const beta = (opts.beta != null) ? opts.beta : 0.10; // mask floor
    const progress = opts.progress;
    const x = samples;
    const Nh = N >> 1;
    const nFrames = x.length >= N ? Math.floor((x.length - N) / H) + 1 : 0;
    if (nFrames <= 0) return new Float32Array(x);

    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const nBins = Nh + 1;
    const mag = new Float32Array(nFrames * nBins);
    const reS = new Float32Array(nFrames * nBins);
    const imS = new Float32Array(nFrames * nBins);
    const re = new Float32Array(N), im = new Float32Array(N);

    for (let f = 0; f < nFrames; f++) {
      const off = f * H, base = f * nBins;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k < nBins; k++) {
        const r = re[k], iq = im[k];
        reS[base + k] = r; imS[base + k] = iq; mag[base + k] = Math.sqrt(r * r + iq * iq);
      }
      if (progress && (f & 255) === 0) progress(0.45 * f / nFrames);
    }

    const halfH = Lh >> 1, halfP = Lp >> 1;
    const bufH = new Float32Array(Lh), bufP = new Float32Array(Lp);
    const medianOf = (buf, m) => {
      for (let i = 1; i < m; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
      return buf[m >> 1];
    };

    const outLen = (nFrames - 1) * H + N;
    const out = new Float32Array(outLen), norm = new Float32Array(outLen);

    for (let f = 0; f < nFrames; f++) {
      const base = f * nBins, t0 = Math.max(0, f - halfH), t1 = Math.min(nFrames - 1, f + halfH);
      for (let k = 0; k < nBins; k++) {
        let m = 0;
        for (let t = t0; t <= t1; t++) bufH[m++] = mag[t * nBins + k];
        const Hmag = medianOf(bufH, m);
        const k0 = Math.max(0, k - halfP), k1 = Math.min(nBins - 1, k + halfP);
        let mp = 0;
        for (let kk = k0; kk <= k1; kk++) bufP[mp++] = mag[base + kk];
        const Pmag = medianOf(bufP, mp);
        let Mh = Hmag / (Hmag + Pmag + 1e-12);
        if (Mh < beta) Mh = beta;
        re[k] = reS[base + k] * Mh; im[k] = imS[base + k] * Mh;
      }
      for (let k = 1; k < Nh; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      im[0] = 0; im[Nh] = 0;
      fft(re, im, true);
      const so = f * H;
      for (let i = 0; i < N; i++) { out[so + i] += re[i] * win[i]; norm[so + i] += win[i] * win[i]; }
      if (progress && (f & 255) === 0) progress(0.45 + 0.55 * f / nFrames);
    }
    for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
    if (out.length === x.length) return out;
    const fixed = new Float32Array(x.length);
    fixed.set(out.subarray(0, Math.min(out.length, x.length)));
    return fixed;
  }

  /* ---------------------------------------------------------------- *
   * Fast YIN: difference function via FFT cross-correlation, CMNDF,
   * multiple candidates per frame, then Viterbi over candidates for a
   * smooth melody line with an explicit unvoiced state.
   * ---------------------------------------------------------------- */

  const YIN = {
    W: 512,          // comparison window (32 ms @ 16 kHz)
    fmin: 80,
    fmax: 1200,      // up to ~D6 — covers taar saptak of higher voices
    hop: 256,        // 16 ms @ 16 kHz
    fftSize: 2048,
    candThresh: 0.75,
    firstThresh: 0.15,
  };

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[idx];
  }

  /**
   * Track pitch over a mono Float32Array.
   * Returns { f0 (Hz, 0 = unvoiced), clarity (0..1), rms, hopSec, nFrames }.
   * progress(frac) is called periodically with 0..1.
   */
  function yinTrack(x, sr, opts, progress) {
    opts = opts || {};
    const W = YIN.W;
    const tauMin = Math.max(2, Math.floor(sr / (opts.fmax || YIN.fmax)));
    const tauMax = Math.min(W - 2, Math.ceil(sr / (opts.fmin || YIN.fmin)));
    const hop = opts.hop || YIN.hop;
    const F = YIN.fftSize;
    const N0 = W + tauMax;
    const n = x.length;
    const nFrames = n >= N0 ? Math.floor((n - N0) / hop) + 1 : 0;
    const hopSec = hop / sr;

    const f0 = new Float32Array(nFrames);
    const clarity = new Float32Array(nFrames);
    const rmsArr = new Float32Array(nFrames);
    const flatArr = new Float32Array(nFrames);
    const frameCands = new Array(nFrames);

    const re = new Float32Array(F), im = new Float32Array(F);
    const re2 = new Float32Array(F), im2 = new Float32Array(F);
    const d = new Float32Array(tauMax + 1), c = new Float32Array(tauMax + 1);
    const ps = new Float64Array(N0 + 1);

    const kLo = Math.max(2, Math.round(100 * F / sr));
    const kHi = Math.min(F / 2 - 1, Math.round(4000 * F / sr));

    for (let fI = 0; fI < nFrames; fI++) {
      const off = fI * hop;
      re.fill(0); im.fill(0); re2.fill(0); im2.fill(0);
      for (let i = 0; i < N0; i++) re[i] = x[off + i];
      for (let i = 0; i < W; i++) re2[i] = x[off + i];
      ps[0] = 0;
      for (let i = 0; i < N0; i++) { const v = x[off + i]; ps[i + 1] = ps[i] + v * v; }

      fft(re, im, false);
      fft(re2, im2, false);

      // Spectral flatness of the analysis window: high = noisy/percussive.
      let logSum = 0, linSum = 0;
      for (let k = kLo; k <= kHi; k++) {
        const p = re2[k] * re2[k] + im2[k] * im2[k] + 1e-12;
        logSum += Math.log(p); linSum += p;
      }
      const m = kHi - kLo + 1;
      flatArr[fI] = Math.exp(logSum / m) / (linSum / m + 1e-12);

      // corr(tau) = IFFT(A * conj(B))[tau]
      for (let k = 0; k < F; k++) {
        const ar = re[k], ai = im[k], br = re2[k], bi = im2[k];
        re[k] = ar * br + ai * bi;
        im[k] = ai * br - ar * bi;
      }
      fft(re, im, true);

      const e0 = ps[W];
      rmsArr[fI] = Math.sqrt(e0 / W);
      c[0] = 1;
      let cum = 0;
      for (let t = 1; t <= tauMax; t++) {
        const et = ps[t + W] - ps[t];
        let dt = e0 + et - 2 * re[t];
        if (dt < 0) dt = 0;
        d[t] = dt; cum += dt;
        c[t] = cum > 1e-12 ? (dt * t) / cum : 1;
      }

      // Collect candidate minima of the CMNDF.
      const cands = [];
      for (let t = tauMin + 1; t < tauMax; t++) {
        if (c[t] < c[t - 1] && c[t] <= c[t + 1] && c[t] < YIN.candThresh) {
          const y0 = c[t - 1], y1 = c[t], y2 = c[t + 1];
          const denom = y0 - 2 * y1 + y2;
          let delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
          if (delta > 1) delta = 1; else if (delta < -1) delta = -1;
          const tau = t + delta;
          const cval = Math.max(0, y1 - 0.25 * (y0 - y2) * delta);
          cands.push({ tau, cval, pen: 0 });
          // Skip ahead past this dip's immediate neighborhood.
          while (t + 1 < tauMax && c[t + 1] <= c[t]) t++;
        }
      }
      // Subharmonic (octave-down) penalty: a dip at ~k× a stronger,
      // shorter-period dip is almost always its subharmonic — the cause of
      // "high notes drop an octave". Penalize the longer one so the true
      // (shorter, higher) period wins. Never penalizes the shorter dip, so
      // genuine low notes are unaffected.
      for (let a = 0; a < cands.length; a++) {
        for (let b = 0; b < cands.length; b++) {
          if (a === b || cands[b].tau >= cands[a].tau) continue;
          const ratio = cands[a].tau / cands[b].tau;
          for (let k = 2; k <= 4; k++) {
            if (Math.abs(ratio - k) < 0.08) {
              cands[a].pen += cands[b].cval < 0.35 ? 0.8 : (cands[b].cval < 0.6 ? 0.45 : 0.15);
              break;
            }
          }
        }
      }
      // Keep the 3 best by effective cost (Viterbi reads 3 slots).
      cands.sort((a, b) => (a.cval + 0.5 * a.pen) - (b.cval + 0.5 * b.pen));
      cands.length = Math.min(cands.length, 3);
      frameCands[fI] = cands;
      clarity[fI] = cands.length ? Math.max(0, 1 - cands[0].cval) : 0;

      if (progress && (fI & 255) === 0) progress(fI / nFrames);
    }

    viterbiSelect(frameCands, clarity, rmsArr, flatArr, sr, f0);
    postProcess(f0, clarity);

    return { f0, clarity, rms: rmsArr, hopSec, nFrames };
  }

  /* Viterbi over per-frame candidates + an explicit unvoiced state.
   * Picks the lowest-cost path through pitch candidates so the melody
   * stays continuous (no octave flips) and drops out when unvoiced. */
  const VIT = {
    emitCand: 2.1,
    emitFlatPen: 0.6,
    flatThresh: 0.45,
    emitUClarity: 1.45,
    emitURms: 0.55,
    transPerOct: 2.0,
    transCap: 1.2,
    switchCost: 0.55,
  };

  function viterbiSelect(frameCands, clarity, rmsArr, flatArr, sr, f0out) {
    const nFrames = frameCands.length;
    if (!nFrames) return;
    const K = 3;                       // candidate slots; index K = unvoiced
    const S = K + 1;
    const loud = [];
    for (let i = 0; i < nFrames; i++) if (rmsArr[i] > 1e-4) loud.push(rmsArr[i]);
    const p75 = percentile(loud, 0.75) || 1e-4;

    const cost = new Float64Array(S).fill(Infinity);
    const next = new Float64Array(S);
    const back = new Uint8Array(nFrames * S);
    const centsArr = new Float32Array(nFrames * K).fill(NaN);
    const emit = new Float64Array(S);

    for (let i = 0; i < nFrames; i++) {
      const cands = frameCands[i];
      const relRms = Math.min(1, rmsArr[i] / p75);
      const flatPen = flatArr[i] > VIT.flatThresh ? VIT.emitFlatPen : 0;
      for (let j = 0; j < K; j++) {
        if (j < cands.length) {
          emit[j] = VIT.emitCand * cands[j].cval + cands[j].pen + flatPen;
          centsArr[i * K + j] = 1200 * Math.log2((sr / cands[j].tau) / 27.5);
        } else {
          emit[j] = Infinity;
          centsArr[i * K + j] = NaN;
        }
      }
      emit[K] = VIT.emitUClarity * clarity[i] + VIT.emitURms * relRms;

      if (i === 0) {
        for (let j = 0; j < S; j++) { cost[j] = emit[j]; back[j] = j; }
        continue;
      }
      for (let j = 0; j < S; j++) {
        let best = Infinity, bestP = K;
        for (let p = 0; p < S; p++) {
          if (!isFinite(cost[p])) continue;
          let tr;
          if (p === K && j === K) tr = 0;
          else if (p === K || j === K) tr = VIT.switchCost;
          else {
            const dc = Math.abs(centsArr[i * K + j] - centsArr[(i - 1) * K + p]);
            tr = VIT.transPerOct * Math.min(VIT.transCap, dc / 1200);
          }
          const v = cost[p] + tr;
          if (v < best) { best = v; bestP = p; }
        }
        next[j] = best + emit[j];
        back[i * S + j] = bestP;
      }
      cost.set(next);
    }

    // Backtrack.
    let state = 0;
    let best = Infinity;
    for (let j = 0; j < S; j++) if (cost[j] < best) { best = cost[j]; state = j; }
    for (let i = nFrames - 1; i >= 0; i--) {
      if (state < K) {
        const cents = centsArr[i * K + state];
        f0out[i] = isNaN(cents) ? 0 : 27.5 * Math.pow(2, cents / 1200);
      } else {
        f0out[i] = 0;
      }
      state = back[i * S + state];
    }
  }

  /* Bridge 1-2 frame dropouts between similar pitches, median-smooth,
   * and unvoice runs shorter than 4 frames (~64 ms). */
  function postProcess(f0, clarity) {
    const n = f0.length;
    // Bridge short gaps.
    for (let i = 1; i < n - 1; i++) {
      if (f0[i] > 0) continue;
      let j = i;
      while (j < n && f0[j] === 0) j++;
      const gap = j - i;
      if (gap <= 2 && i > 0 && j < n && f0[i - 1] > 0 && f0[j] > 0) {
        const dc = Math.abs(1200 * Math.log2(f0[j] / f0[i - 1]));
        if (dc < 120) {
          for (let g = i; g < j; g++) {
            const t = (g - i + 1) / (gap + 1);
            f0[g] = f0[i - 1] * Math.pow(f0[j] / f0[i - 1], t);
            clarity[g] = Math.min(clarity[i - 1], clarity[j]) * 0.9;
          }
        }
      }
      i = j;
    }
    // Median-3 within voiced runs.
    const copy = new Float32Array(f0);
    for (let i = 1; i < n - 1; i++) {
      if (copy[i - 1] > 0 && copy[i] > 0 && copy[i + 1] > 0) {
        const a = copy[i - 1], b = copy[i], cc = copy[i + 1];
        f0[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), cc));
      }
    }
    // Kill voiced runs shorter than 4 frames.
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const v = i < n && f0[i] > 0;
      if (v && start < 0) start = i;
      if (!v && start >= 0) {
        if (i - start < 4) for (let g = start; g < i; g++) f0[g] = 0;
        start = -1;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Octave stabilization: when a recording carries a second voice an
   * octave away (a duet in octaves, a teacher+student) or the tracker
   * flips between them, the melody jumps octaves and the register reads
   * as confusing. Fold every voiced frame into the dominant one-octave
   * band so it reads as a single line ("just take one voice").
   *   mode 'auto'   — full register-aligning pass (for the noisy YIN track)
   *   mode 'gentle' — isolated-glitch snap only (for the octave-accurate CREPE track)
   *   mode 'force'  — always fold to one octave
   *   mode 'off'    — leave untouched
   * Returns { f0: newTrack, doubled }.
   * ---------------------------------------------------------------- */

  function stabilizeOctave(f0, clarity, rms, hopSec, mode) {
    const n = f0.length;
    const out = new Float32Array(f0);
    if (mode === 'off') return { f0: out, doubled: false };

    const idx = [], cents = [], wts = [];
    for (let i = 0; i < n; i++) {
      if (f0[i] > 0 && clarity[i] >= 0.5) {
        idx.push(i);
        cents.push(1200 * Math.log2(f0[i] / 55));
        wts.push(clarity[i] * clarity[i] * (rms ? Math.min(1, rms[i] || 0) + 0.05 : 1));
      }
    }
    if (idx.length < 20) return { f0: out, doubled: false };
    const sorted = cents.slice().sort((a, b) => a - b);

    // FORCE: collapse everything into one octave around the dominant register
    // (best when a second voice an octave away should be dropped entirely).
    if (mode === 'force') {
      const total = wts.reduce((a, b) => a + b, 0);
      let acc = 0, center = sorted[sorted.length >> 1];
      for (const j of cents.map((_, i) => i).sort((a, b) => cents[a] - cents[b])) {
        acc += wts[j]; if (acc >= total / 2) { center = cents[j]; break; }
      }
      for (let k = 0; k < idx.length; k++) {
        let c = cents[k];
        while (c < center - 600) c += 1200;
        while (c >= center + 600) c -= 1200;
        out[idx[k]] = 55 * Math.pow(2, c / 1200);
      }
      return { f0: out, doubled: true };
    }

    // AUTO corrects octave-tracking ERRORS while keeping genuine range/leaps.
    // 'gentle' (for the already octave-accurate neural/CREPE track) runs ONLY
    // the isolated-glitch snap below — the register pull + global shift were
    // built for YIN's noisy output and OVER-correct CREPE: they shift its
    // register up and flip the detected Sa. So steps 1–2 run only for 'auto'.
    const work = cents.slice();
    let totalFolded = 0;

    if (mode === 'auto') {
    // 1. SEGMENT continuity. Octave errors make a phrase jump ~an octave away
    // from its neighbours (e.g. YIN dropping to the sub-octave for one phrase).
    // Split the voiced track into phrases, then choose each phrase's octave so
    // the melody flows continuously across the gaps — a Viterbi that minimises
    // the pitch jump between the end of one phrase and the start of the next.
    // This works even when MOST frames are octave-wrong (no reliance on a
    // global median, which the errors corrupt). Genuine mandra/taar excursions
    // stay, because aligning them to neighbours keeps the small real interval.
    // A new phrase begins at a silence gap OR a sudden large pitch step. The
    // step split is essential: an octave error often sits INSIDE one continuous
    // phrase (the voice sustains the sub-octave then steps back up with no
    // breath between), so splitting only on silence would never separate the
    // wrong part from the right part. ~750¢ is above a clean perfect-fifth leap
    // (700¢) so genuine fifths don't fragment, but an octave-class jump does.
    const gapLim = Math.max(3, Math.round(0.16 / hopSec));
    const STEP = 750;
    const med3 = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    const segs = [];
    let segS = 0;
    for (let k = 1; k <= idx.length; k++) {
      const gap = k === idx.length || idx[k] - idx[k - 1] > gapLim;
      const step = k < idx.length && idx[k] - idx[k - 1] <= gapLim &&
                   Math.abs(cents[k] - cents[k - 1]) > STEP;
      if (gap || step) {
        const e = Math.min(3, k - segS);
        segs.push({
          a: segS, b: k,
          start: med3(cents.slice(segS, segS + e)),
          end: med3(cents.slice(k - e, k)),
          med: med3(cents.slice(segS, k)),
        });
        segS = k;
      }
    }
    if (segs.length >= 2) {
      // Octave-tracking errors are almost always octave-DOWN (YIN latching the
      // sub-harmonic); a genuine octave-UP error is rare. The octave term is
      // therefore ASYMMETRIC:
      //   • a segment sitting below the vocal FLOOR (~a sixth under the clean
      //     p70 register) is pulled UP — it's almost certainly a sub-octave slip;
      //   • folding a segment DOWN from its tracked octave is penalised — doing
      //     so assumes a rare up-error, and a symmetric "pull to centre" was
      //     dragging genuine taar (high) phrases down an octave (the 0:59 bug).
      // Continuity (the dominant term) still carries real mandra/taar that flows
      // smoothly from its neighbours.
      const REF = sorted[Math.floor(0.70 * (sorted.length - 1))];
      const FLOOR = REF - 900;
      const PULL = 0.6, DOWNPEN = 22;
      const OFFS = [-24, -12, 0, 12, 24];
      const reg = (i, o) => {
        const eff = segs[i].med + OFFS[o] * 100;
        return Math.max(0, FLOOR - eff) * PULL + (OFFS[o] < 0 ? -OFFS[o] * DOWNPEN : 0);
      };
      const cost = OFFS.map((_, o) => reg(0, o));
      const back = [];
      for (let i = 1; i < segs.length; i++) {
        const nc = OFFS.map(() => Infinity), bk = OFFS.map(() => 0);
        for (let o = 0; o < OFFS.length; o++) {
          const startEff = segs[i].start + OFFS[o] * 100;
          const rc = reg(i, o);
          for (let p = 0; p < OFFS.length; p++) {
            const endEff = segs[i - 1].end + OFFS[p] * 100;
            const v = cost[p] + Math.abs(endEff - startEff) + rc;
            if (v < nc[o]) { nc[o] = v; bk[o] = p; }
          }
        }
        for (let o = 0; o < OFFS.length; o++) cost[o] = nc[o];
        back.push(bk);
      }
      let st = 0;
      for (let o = 1; o < OFFS.length; o++) if (cost[o] < cost[st]) st = o;
      const chosen = new Array(segs.length);
      chosen[segs.length - 1] = st;
      for (let i = segs.length - 2; i >= 0; i--) { st = back[i][st]; chosen[i] = st; }
      for (let i = 0; i < segs.length; i++) {
        const sh = OFFS[chosen[i]] * 100;
        if (sh) { for (let j = segs[i].a; j < segs[i].b; j++) work[j] += sh; totalFolded += segs[i].b - segs[i].a; }
      }
    }

    // 2. GLOBAL register: shift the whole (now-continuous) line by octaves so
    // the median voiced pitch lands in a singer's range (~150–360 Hz), fixing a
    // line that's internally consistent but globally an octave off.
    {
      const wc = work.slice().sort((a, b) => a - b);
      let medAll = wc[wc.length >> 1];
      const LO = 1200 * Math.log2(150 / 55), HI = 1200 * Math.log2(360 / 55);
      let shift = 0;
      while (medAll + shift < LO) shift += 1200;
      while (medAll + shift > HI) shift -= 1200;
      if (shift) for (let j = 0; j < work.length; j++) work[j] += shift;
    }
    }  // end mode === 'auto' — 'gentle' falls straight through to the glitch snap

    // 3. FRAME-level glitch fix for isolated/brief octave jumps that remain.
    const half = Math.max(4, Math.round(0.25 / hopSec));
    const winBuf = [];
    for (let pass = 0; pass < 3; pass++) {
      const src = work.slice();
      let foldedThis = 0;
      for (let k = 0; k < idx.length; k++) {
        winBuf.length = 0;
        const a = Math.max(0, k - half), b = Math.min(idx.length - 1, k + half);
        for (let j = a; j <= b; j++) winBuf.push(src[j]);
        winBuf.sort((x, y) => x - y);
        const med = winBuf[winBuf.length >> 1];
        const d = work[k] - med;
        const oct = Math.round(d / 1200);
        if (oct !== 0 && Math.abs(d - oct * 1200) < 250) { work[k] -= oct * 1200; foldedThis++; }
      }
      totalFolded += foldedThis;
      if (foldedThis === 0) break;
    }
    for (let k = 0; k < idx.length; k++) out[idx[k]] = 55 * Math.pow(2, work[k] / 1200);
    return { f0: out, doubled: totalFolded > idx.length * 0.03 };
  }

  /* ---------------------------------------------------------------- *
   * Onset detection: spectral flux in the vocal band, with adaptive
   * peak picking. Each peak is a syllable/word articulation, so every
   * vocalised start can become its own note — even when the pitch
   * doesn't change. Frames use the same `hop` as the pitch track so the
   * indices line up. Run on the band-limited signal to suppress tabla.
   * ---------------------------------------------------------------- */

  function detectOnsets(x, sr, hop, opts) {
    opts = opts || {};
    const N = 1024;                                   // analysis window (power of two)
    const nFrames = x.length >= N ? Math.floor((x.length - N) / hop) + 1 : 0;
    if (nFrames < 3) return [];
    const H = N / 2;
    const kLo = Math.max(1, Math.round(150 * N / sr));   // vocal band ~150–1500 Hz
    const kHi = Math.min(H, Math.round(1500 * N / sr));
    const re = new Float32Array(N), im = new Float32Array(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const prev = new Float32Array(H + 1);
    const flux = new Float32Array(nFrames);

    for (let f = 0; f < nFrames; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      let sf = 0;
      for (let k = kLo; k <= kHi; k++) {
        const mag = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        const d = mag - prev[k];
        if (d > 0) sf += d;
        prev[k] = mag;
      }
      // (bins outside the band still need their history updated)
      for (let k = 0; k < kLo; k++) prev[k] = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      flux[f] = sf;
    }

    let mx = 0;
    for (let f = 0; f < nFrames; f++) if (flux[f] > mx) mx = flux[f];
    if (mx <= 1e-9) return [];
    for (let f = 0; f < nFrames; f++) flux[f] /= mx;

    const fps = sr / hop;
    const winF = Math.max(3, Math.round(0.14 * fps));     // local-mean window ~140 ms
    const minIOIMs = opts.minIOIMs != null ? opts.minIOIMs : 90;
    const minIOI = Math.max(2, Math.round(minIOIMs / 1000 * fps));
    const delta = opts.delta != null ? opts.delta : 0.10; // additive sensitivity floor
    const ratio = opts.ratio != null ? opts.ratio : 1.7;  // must clearly exceed local mean
    // A real syllable/word onset is a clear, prominent flux peak; vibrato,
    // tracking jitter and percussion residue make small bumps. Require the peak
    // to both rise well above the local mean AND be a strict local maximum, so
    // held notes don't get split into spurious repeats.
    const onsets = [];
    let last = -minIOI;
    for (let f = 1; f < nFrames - 1; f++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, f - winF); j <= Math.min(nFrames - 1, f + winF); j++) { s += flux[j]; c++; }
      const mean = s / c;
      const thr = Math.max(mean * ratio, mean + delta);
      if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1] && f - last >= minIOI) {
        onsets.push(f);
        last = f;
      }
    }
    return onsets;
  }

  /* ---------------------------------------------------------------- *
   * Tonic (Sa) detection: duration-weighted pitch-class histogram with
   * fifth/fourth reinforcement, then octave placement so the singer's
   * range sits mostly between mandra Pa and taar Ga.
   * ---------------------------------------------------------------- */

  function detectTonic(f0, clarity, hopSec, rms) {
    const BINS = 240; // 5-cent bins
    const hist = new Float64Array(BINS);
    // Loudness reference: the singer is louder than a tanpura. Weighting by
    // loudness keeps a quiet drone (even a clean, high-clarity one an octave
    // below Sa) from hijacking the pitch class or octave placement.
    let rmsRef = 0;
    if (rms) {
      const lv = [];
      for (let i = 0; i < f0.length; i++) if (f0[i] > 0 && clarity[i] >= 0.5) lv.push(rms[i]);
      rmsRef = percentile(lv, 0.9) || 0;
    }
    const rels = [];                 // { c: cents from 55 Hz, w: clarity^2 * loudness^2 }
    for (let i = 0; i < f0.length; i++) {
      if (f0[i] > 0 && clarity[i] >= 0.5) {
        const rel = 1200 * Math.log2(f0[i] / 55);
        const loud = rmsRef > 0 ? Math.min(1, rms[i] / rmsRef) : 1;
        const w = clarity[i] * clarity[i] * loud * loud;
        rels.push({ c: rel, w });
        const pc = ((rel % 1200) + 1200) % 1200;
        const bin = Math.round(pc / 5) % BINS;
        hist[bin] += w;
      }
    }
    if (rels.length < 50) {
      return [{ hz: 146.83, score: 0, uncertain: true }];
    }
    // Circular gaussian smoothing, sigma = 3 bins (15 cents).
    const smooth = new Float64Array(BINS);
    const kw = [];
    for (let k = -9; k <= 9; k++) kw.push(Math.exp(-(k * k) / (2 * 9)));
    for (let b = 0; b < BINS; b++) {
      let s = 0;
      for (let k = -9; k <= 9; k++) s += hist[(b + k + BINS) % BINS] * kw[k + 9];
      smooth[b] = s;
    }
    const at = (cents) => {
      const x = (((cents % 1200) + 1200) % 1200) / 5;
      const b0 = Math.floor(x) % BINS, b1 = (b0 + 1) % BINS, fr = x - Math.floor(x);
      return smooth[b0] * (1 - fr) + smooth[b1] * fr;
    };
    let maxH = 0;
    for (let b = 0; b < BINS; b++) if (smooth[b] > maxH) maxH = smooth[b];

    // Peak picking.
    const peaks = [];
    for (let b = 0; b < BINS; b++) {
      const prev = smooth[(b - 1 + BINS) % BINS], next = smooth[(b + 1) % BINS];
      if (smooth[b] > prev && smooth[b] >= next && smooth[b] > 0.08 * maxH) {
        peaks.push({ pc: b * 5, h: smooth[b] });
      }
    }
    peaks.sort((a, b) => b.h - a.h);
    peaks.length = Math.min(peaks.length, 8);

    // Cadence evidence: Hindustani phrases overwhelmingly begin and (more so)
    // resolve on Sa, which Pa/Ma almost never do — the strongest cue for
    // breaking Sa/Pa fifth-symmetry. Build a pitch-class histogram of the
    // first/last stable note of every voiced run (phrase).
    const cad = new Float64Array(BINS);
    const minRun = Math.max(3, Math.round(0.18 / hopSec));
    const phraseGap = Math.max(3, Math.round(0.32 / hopSec));
    const edge = Math.max(2, Math.round(0.12 / hopSec));
    const medPc = (i0, i1) => {
      const a = [];
      for (let j = i0; j < i1; j++) if (f0[j] > 0) a.push(((1200 * Math.log2(f0[j] / 55)) % 1200 + 1200) % 1200);
      if (!a.length) return null;
      a.sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    const addCad = (pc, w) => {
      if (pc == null) return;
      const b = Math.round(pc / 5) % BINS;
      for (let k = -2; k <= 2; k++) cad[(b + k + BINS) % BINS] += w * Math.exp(-(k * k) / 4);
    };
    let runStart = -1, lastVoiced = -1, nPhrases = 0;
    const N = f0.length;
    for (let i = 0; i <= N; i++) {
      const v = i < N && f0[i] > 0 && clarity[i] >= 0.5;
      if (v) {
        if (runStart < 0) runStart = i;
        lastVoiced = i;
      }
      if (runStart >= 0 && (i === N || i - lastVoiced >= phraseGap)) {
        const runEnd = lastVoiced + 1;
        if (runEnd - runStart >= minRun) {
          addCad(medPc(runStart, Math.min(runEnd, runStart + edge)), 1.0);      // phrase onset
          addCad(medPc(Math.max(runStart, runEnd - edge), runEnd), 1.4);       // phrase resolution
          nPhrases++;
        }
        runStart = -1;
        lastVoiced = -1;
      }
    }
    // Cadence is most reliable across many phrases, but even one phrase's
    // start/resolution notes are real evidence — keep a floor so Sa still
    // resolves on short clips (full trust at >= 6 phrases).
    const cadConf = Math.max(0.3, Math.min(1, nPhrases / 6));
    let cadMax = 0;
    for (let b = 0; b < BINS; b++) if (cad[b] > cadMax) cadMax = cad[b];
    const cadAt = (cents) => {
      if (cadMax <= 0) return 0;
      const b = Math.round((((cents % 1200) + 1200) % 1200) / 5) % BINS;
      return cad[b] / cadMax;
    };

    // A long instrumental introduction can make a prominent accompaniment
    // swara look like Sa. When a clearly higher melodic register enters later
    // and persists, use its first stable note as additional tonic evidence.
    // This stays inactive for short clips and songs without a strong register
    // change, so it does not turn every opening note into Sa.
    let delayedEntryPc = null;
    const durationSec = N * hopSec;
    if (durationSec >= 55) {
      const medianCents = (t0, t1) => {
        const values = [];
        const i0 = Math.max(0, Math.round(t0 / hopSec));
        const i1 = Math.min(N, Math.round(t1 / hopSec));
        for (let i = i0; i < i1; i++) {
          if (f0[i] > 0 && clarity[i] >= 0.5) values.push(1200 * Math.log2(f0[i] / 55));
        }
        if (values.length < Math.max(20, Math.round(0.5 / hopSec))) return null;
        values.sort((a, b) => a - b);
        return values[values.length >> 1];
      };
      let entrySearchSec = null;
      let entryBaselineCents = null;
      const searchEnd = Math.min(120, durationSec - 32);
      for (let t = 20; t <= searchEnd; t += 2) {
        const before = medianCents(t - 12, t);
        const after = medianCents(t, t + 12);
        const sustained = medianCents(t + 12, t + 32);
        if (before != null && after != null && sustained != null &&
            Math.min(after - before, sustained - before) >= 350) {
          entrySearchSec = t;
          entryBaselineCents = before;
          break;
        }
      }
      if (entrySearchSec != null) {
        const i0 = Math.max(0, Math.round(entrySearchSec / hopSec));
        const i1 = Math.min(N, Math.round((entrySearchSec + 14) / hopSec));
        const minStable = Math.max(3, Math.round(0.75 / hopSec));
        let runK = null, runStart = i0;
        for (let i = i0; i <= i1; i++) {
          const k = i < i1 && f0[i] > 0 && clarity[i] >= 0.5
            ? Math.round(12 * Math.log2(f0[i] / 55))
            : null;
          if (k === runK) continue;
          const enteredHigherRegister = runK != null &&
            runK * 100 >= entryBaselineCents + 300;
          if (enteredHigherRegister && i - runStart >= minStable) {
            let loudEnough = true;
            if (rms && rmsRef > 0) {
              const levels = [];
              for (let j = runStart; j < i; j++) levels.push(rms[j]);
              levels.sort((a, b) => a - b);
              loudEnough = levels[levels.length >> 1] >= 0.45 * rmsRef;
            }
            if (loudEnough) {
              delayedEntryPc = ((runK * 100 % 1200) + 1200) % 1200;
              break;
            }
          }
          runK = k;
          runStart = i;
        }
      }
    }
    const entryAt = (cents) => {
      if (delayedEntryPc == null) return 0;
      let distance = Math.abs((((cents - delayedEntryPc) % 1200) + 1200) % 1200);
      distance = Math.min(distance, 1200 - distance);
      return Math.exp(-(distance * distance) / (2 * 30 * 30));
    };

    // Score each candidate Sa. Terms (all normalized to [0,1]):
    //   + self      : the tonic is itself prominent (drone + dwelling)
    //   + fifth     : a strong Pa sits +702c above a true Sa
    //   + cadence   : phrases start/resolve here  (breaks Sa/Pa symmetry)
    //   + entry     : first stable vocal-register note after a long intro
    //   - asPa      : a strong note +498c above means *we* are likely its Pa
    // No credit for the fourth-above (the old bug: it let Pa borrow Sa).
    for (const p of peaks) {
      const self = at(p.pc) / maxH;
      const fifth = at(p.pc + 702) / maxH;
      const asPa = at(p.pc + 498) / maxH;
      p.score = 0.50 * self + 0.42 * fifth + 1.30 * cadConf * cadAt(p.pc) +
        1.70 * entryAt(p.pc) - 0.30 * Math.min(asPa, 1.2 * self);
    }
    peaks.sort((a, b) => b.score - a.score);

    // Octave placement: put Sa in the singer's register, not on a tanpura
    // drone an octave below. Maximize clarity-weighted coverage of the voice
    // sitting from a little below Sa up through the madhya saptak. The window
    // excludes a drone an octave down (rc ≈ -1200) and discourages pushing the
    // singer's range too high (Sa placed too low).
    let totalW = 0;
    for (const r of rels) totalW += r.w;
    // The voice is essentially never sung below Sa-by-much: don't place Sa
    // more than ~a tone below the lowest frequently-sung pitch.
    const cByVal = rels.map((r) => r.c).sort((a, b) => a - b);
    const lowCents = cByVal[Math.floor(cByVal.length * 0.05)];
    const minSaCents = lowCents - 250;
    // Weighted median of the voiced pitch — the centre of the tessitura. A real
    // Sa sits at or just below it (singers dwell on Sa and explore upward more
    // than downward), so placements that put the median in the madhya saptak
    // [Sa, Sa+~600] read naturally; ones that bury everything in mandra/taar do not.
    let wAcc = 0, medC = cByVal[cByVal.length >> 1];
    {
      const byC = rels.slice().sort((a, b) => a.c - b.c);
      for (const r of byC) { wAcc += r.w; if (wAcc >= totalW / 2) { medC = r.c; break; } }
    }
    const naturalness = (saCents) => {
      const m = medC - saCents;                 // where the median sits, relative to Sa
      // Median anywhere from Sa up to ~Pa is natural (covers Sa-centric and
      // Pa/Ma-centric ragas). Median BELOW Sa means the voice is mostly mandra
      // (Sa orphaned high) — penalised hard, since that's an octave misplacement.
      if (m >= 0 && m <= 750) return 1;
      const d = m < 0 ? -m * 1.6 : m - 750;
      return Math.max(0.1, 1 - d / 500);
    };
    const placed = [];
    for (const p of peaks.slice(0, 3)) {
      let bestHz = 0, bestScore = -1, bestCov = 0, bestSa = 0;
      for (let oct = 0; oct <= 4; oct++) {
        const hz = 55 * Math.pow(2, (p.pc / 1200)) * Math.pow(2, oct);
        if (hz < 80 || hz > 400) continue;
        const saCents = 1200 * Math.log2(hz / 55);
        if (saCents < minSaCents) continue;            // Sa not below the sung range
        let cov = 0;
        for (const r of rels) {
          const rc = r.c - saCents;
          if (rc >= -500 && rc < 1500) cov += r.w;
          else if (rc >= 1500 && rc < 2100) cov += r.w * 0.25;
        }
        const sc = cov * (0.3 + naturalness(saCents));   // octave that reads naturally
        if (sc > bestScore) { bestScore = sc; bestHz = hz; bestCov = cov; bestSa = saCents; }
      }
      // Combine the pitch-class score with how naturally its best octave sits,
      // so a strong class buried in mandra can't beat a clean madhya placement.
      if (bestHz > 0) placed.push({ hz: bestHz, score: p.score * (0.4 + 0.6 * naturalness(bestSa)), coverage: totalW ? bestCov / totalW : 0 });
    }
    placed.sort((a, b) => b.score - a.score);
    // Normalize scores to [0,1] relative to the best candidate. When the
    // runner-up is nearly as strong, Sa is a close call — flag it so the UI
    // nudges the user to verify against the drone.
    if (placed.length) {
      const top = Math.max(...placed.map(p => p.score), 1e-6);
      for (const p of placed) p.score = Math.max(0, p.score / top);
      // A lone uninterrupted phrase does not provide enough independent cadence
      // evidence to distinguish Sa reliably from a prominent Ma/Pa. Be honest
      // about that ambiguity even when the numeric runner-up is weak.
      if (nPhrases < 2 || (placed.length > 1 && placed[1].score >= 0.82)) placed[0].uncertain = true;
    }
    return placed.length ? placed : [{ hz: 146.83, score: 0, uncertain: true }];
  }

  /* ---------------------------------------------------------------- *
   * Sargam quantization. 12-letter convention:
   *   S r R g G m M P d D n N   (lowercase = komal; m = shuddha Ma,
   *   M = tivra Ma). Octaves: k is semitones from madhya Sa.
   * ---------------------------------------------------------------- */

  const SWARA_LETTERS = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];
  const KOMAL_IDX = new Set([1, 3, 8, 10]);

  function swaraInfo(k) {
    const idx = ((k % 12) + 12) % 12;
    const octave = Math.floor(k / 12);
    return {
      letter: SWARA_LETTERS[idx],
      octave,
      komal: KOMAL_IDX.has(idx),
      tivra: idx === 6,
    };
  }

  /** Plain-text token: octave marked with leading dots (mandra) or trailing apostrophes (taar). */
  function tokenText(k, meend) {
    const s = swaraInfo(k);
    let t = s.letter;
    if (s.octave > 0) t += "'".repeat(s.octave);
    else if (s.octave < 0) t = '.'.repeat(-s.octave) + t;
    if (meend) t = '~' + t;
    return t;
  }

  /* Merge runs shorter than minFrames into their closer-pitched neighbor. */
  function mergeShortRuns(runs, minFrames) {
    for (let guard = 0; guard < 400; guard++) {
      let idx = -1, len = Infinity;
      for (let r = 0; r < runs.length; r++) {
        const l = runs[r].end - runs[r].start;
        if (l < minFrames && l < len) { len = l; idx = r; }
      }
      if (idx < 0 || runs.length === 1) break;
      const cur = runs[idx];
      const left = idx > 0 ? runs[idx - 1] : null;
      const right = idx < runs.length - 1 ? runs[idx + 1] : null;
      let into;
      if (left && right) into = Math.abs(left.k - cur.k) <= Math.abs(right.k - cur.k) ? left : right;
      else into = left || right;
      if (into === left) { left.end = cur.end; }
      else { right.start = cur.start; }
      runs.splice(idx, 1);
      for (let r = runs.length - 2; r >= 0; r--) {
        if (runs[r].k === runs[r + 1].k && runs[r].end === runs[r + 1].start) {
          runs[r].end = runs[r + 1].end;
          runs.splice(r + 1, 1);
        }
      }
    }
    return runs;
  }

  /* Fold repeated brief ±1-semitone excursions back into their anchor note,
   * so andolan/gamak reads as one oscillating swara instead of fragmenting.
   * Only a genuinely fast oscillation is folded (see the excursion-rate gate
   * below); a single excursion, or a held swara with a couple of sparse grace
   * touches, is left alone so those touches stay visible as distinct notes. */
  function absorbOscillations(runs, stableFrames, isReal, hopSec) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        // Passing-tone anchor gate: a mid-glide fragment must not seed an
        // absorption — anchored on it, a real murki (G-R-G) gets swallowed
        // into one bogus in-between swara.
        if (isReal && (runs[i].end - runs[i].start) < stableFrames && !isReal(runs[i])) continue;
        const k0 = runs[i].k;
        let j = i, nExc = 0;
        while (j < runs.length) {
          const r = runs[j];
          if (r.k === k0) { j++; continue; }
          if (Math.abs(r.k - k0) <= 1 && (r.end - r.start) < stableFrames) { nExc++; j++; continue; }
          break;
        }
        // Collapse only a genuinely fast oscillation (andolan/gamak): the ±1
        // touches must recur often enough across the span (≳2 per second).
        // Express this in real time so 4 ms Praat and 16 ms browser tracks make
        // the same decision. A held swara with a couple of sparse grace
        // touches has a low excursion rate — leave those touches as their own
        // notes so they stay visible. (A slower continuous swing is still folded
        // downstream by collapseAndolan from the token stream, where over-
        // collapsing here would have destroyed the touches irreversibly.)
        const spanFrames = j > i ? runs[j - 1].end - runs[i].start : 0;
        const excursionRate = spanFrames > 0 ? nExc / (spanFrames * hopSec) : 0;
        if (nExc >= 2 && j - i >= 4 && excursionRate >= 2.1) {
          runs.splice(i, j - i, { start: runs[i].start, end: runs[j - 1].end, k: k0 });
          changed = true;
        }
      }
    }
    return runs;
  }

  /* Is this transient group a quantized glide from k=a to k=b?
   * Strictly monotonic toward b, every step 1-2 semitones, all strictly between. */
  function isMeendChain(a, ks, b) {
    const dir = Math.sign(b - a);
    if (dir === 0) return false;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let prev = a;
    for (const k of ks) {
      if (k <= lo || k >= hi) return false;
      const step = (k - prev) * dir;
      if (step < 1 || step > 2) return false;
      prev = k;
    }
    return (b - prev) * dir >= 1 && (b - prev) * dir <= 2;
  }

  /* Within-note character: andolan (slow oscillation) vs meend (directional glide). */
  function analyzeToken(cents, start, end, hopSec) {
    let cMin = Infinity, cMax = -Infinity, cSum = 0;
    for (let j = start; j < end; j++) {
      const cv = cents[j];
      if (cv < cMin) cMin = cv;
      if (cv > cMax) cMax = cv;
      cSum += cv;
    }
    const mean = cSum / (end - start);
    const range = cMax - cMin;
    let andolan = false, meend = false, andolanLo = 0, andolanHi = 0;
    // Count swings across the mean (each ±20¢ excursion).
    let cross = 0, st = 0;
    for (let j = start; j < end; j++) {
      const dv = cents[j] - mean;
      if (dv > 20 && st <= 0) { cross++; st = 1; }
      else if (dv < -20 && st >= 0) { cross++; st = -1; }
    }
    // Net drift start→end distinguishes a one-way glide (meend) from an
    // oscillation that returns (andolan).
    const q = Math.max(1, Math.floor((end - start) / 4));
    let a = 0, b = 0;
    for (let j = start; j < start + q; j++) a += cents[j];
    for (let j = end - q; j < end; j++) b += cents[j];
    const drift = Math.abs(b / q - a / q);
    const durSec = (end - start) * hopSec;
    const freq = durSec > 0 ? cross / (2 * durSec) : 0;
    // A true andolan keeps MOVING between two swaras, so few frames sit at the
    // centre; a held note with a couple of brief touches sits MOSTLY at centre.
    // Reject the latter so it reads as a held note (and its touches aren't
    // hidden inside a bogus ≈).
    let nearC = 0;
    for (let j = start; j < end; j++) if (Math.abs(cents[j] - mean) < 35) nearC++;
    const fracCentre = nearC / (end - start);
    // Andolan: a slow (≈1–3.5 Hz), wide (≥~70¢) oscillation that returns to
    // centre over a real span (Darbari/Todi komal-ga, Bhairav re). Stricter than
    // before so ordinary vibrato and quick murkis are not mislabelled ≈.
    if (cross >= 3 && freq >= 0.8 && freq <= 3.5 && range >= 70 && range <= 320 &&
        drift < range * 0.5 && durSec >= 0.4 && fracCentre < 0.55) {
      andolan = true;
      // Only expose neighbour swaras when the swing is wide enough to truly
      // reach them (≥~1.5 semitones); a narrow shake is just ≈X.
      if (range >= 150) { andolanLo = Math.round(cMin / 100); andolanHi = Math.round(cMax / 100); }
      else { andolanLo = andolanHi = Math.round(mean / 100); }
    } else if (range > 110 && drift > 90) {
      // Only a clear, directional glide within the note earns a ~ mark; plain
      // vibrato/drift on a held note should read as a clean note.
      meend = true;
    }
    return { mean, andolan, meend, andolanLo, andolanHi };
  }

  /* Mean distance (cents) of a span's voiced frames to the nearest semitone.
   * High ⇒ the pitch is sweeping *between* swaras (a glide/andolan); low ⇒ it
   * sits *on* them (discrete notes). The key glide/andolan vs. notes test. */
  function meanDistToSemitone(cents, voiced, t0, t1, hopSec) {
    const f0 = Math.round(t0 / hopSec), f1 = Math.round(t1 / hopSec);
    let s = 0, c = 0;
    for (let f = f0; f < f1 && f < cents.length; f++) {
      if (voiced[f]) { s += Math.abs(cents[f] - Math.round(cents[f] / 100) * 100); c++; }
    }
    return c ? s / c : 0;
  }

  /* Collapse a slow, wide oscillation (andolan/gamak — the soul of Darbari,
   * Todi, Bhairav) that otherwise shreds into a staircase of notes, into one
   * token flagged andolan with the neighbour swaras it swings between. */
  function collapseAndolan(tokens, cents, voiced, hopSec) {
    if (tokens.length < 3) return tokens;
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let j = i, lo = tokens[i].k, hi = tokens[i].k;
      while (j + 1 < tokens.length) {
        if (tokens[j + 1].glide || tokens[j].glide) break;
        if (tokens[j + 1].t0 - tokens[j].t1 > 0.12) break;
        const nlo = Math.min(lo, tokens[j + 1].k), nhi = Math.max(hi, tokens[j + 1].k);
        if (nhi - nlo > 2) break;                 // a real andolan shakes within ~2 semitones
        lo = nlo; hi = nhi; j++;
      }
      // Andolan is a NARROW, repeated shake between ~2 adjacent swaras, sustained
      // but bounded (~0.45–1.5 s). A fast TAAN that sweeps through many notes
      // over several seconds is NOT andolan — bundling it hides the very notes
      // the ear hears, so cap the duration and require a genuine repeated
      // oscillation (≥3 reversals) over ≤3 distinct pitches.
      const dur = tokens[j].t1 - tokens[i].t0;
      const distinct = new Set();
      for (let m = i; m <= j; m++) distinct.add(tokens[m].k);
      if (j - i >= 2 && hi - lo >= 1 && dur >= 0.45 && dur <= 1.5 && distinct.size <= 3) {
        let changes = 0, prevDir = 0;
        for (let m = i + 1; m <= j; m++) {
          const d = Math.sign(tokens[m].k - tokens[m - 1].k);
          if (d) { if (prevDir && d !== prevDir) changes++; prevDir = d; }
        }
        if (changes >= 3 && meanDistToSemitone(cents, voiced, tokens[i].t0, tokens[j].t1, hopSec) > 16) {
          const ks = [];
          for (let m = i; m <= j; m++) ks.push(tokens[m].k);
          ks.sort((a, b) => a - b);
          const anchor = ks[Math.floor(ks.length / 2)];
          out.push({ t0: tokens[i].t0, t1: tokens[j].t1, k: anchor, cents: anchor * 100, andolan: true, andolanLo: lo, andolanHi: hi });
          i = j + 1;
          continue;
        }
      }
      out.push(tokens[i]);
      i++;
    }
    return out;
  }

  /* Collapse a continuous monotonic pitch sweep (a meend) into one token whose
   * via[] lists every swara it touches, instead of a staircase of notes. */
  function collapseGlides(tokens, cents, voiced, hopSec) {
    if (tokens.length < 3) return tokens;
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let j = i, dir = 0;
      while (j + 1 < tokens.length) {
        const step = tokens[j + 1].k - tokens[j].k;
        if (step === 0 || Math.abs(step) > 2) break;
        if (tokens[j + 1].t0 - tokens[j].t1 > 0.12) break;     // must be continuous
        if (tokens[j + 1].glide || tokens[j].glide) break;
        const sd = Math.sign(step);
        if (dir === 0) dir = sd; else if (sd !== dir) break;
        j++;
      }
      const span = Math.abs(tokens[j].k - tokens[i].k);
      if (j - i >= 2 && span >= 3) {
        // Is the pitch sweeping between semitones (glide) or sitting on them
        // (discrete notes)? Measure mean distance to the nearest semitone over
        // the INNER span (first token's end → last token's start) so held
        // departure/arrival notes don't dilute a genuine sweep between them.
        const inT0 = tokens[i].t1, inT1 = tokens[j].t0;
        const md = inT1 > inT0
          ? meanDistToSemitone(cents, voiced, inT0, inT1, hopSec)
          : meanDistToSemitone(cents, voiced, tokens[i].t0, tokens[j].t1, hopSec);
        if (md > 20) {
          const via = [];
          for (let m = i; m <= j; m++) if (!via.length || via[via.length - 1] !== tokens[m].k) via.push(tokens[m].k);
          out.push({ t0: tokens[i].t0, t1: tokens[j].t1, k: tokens[j].k, cents: tokens[j].cents, glide: true, via });
          i = j + 1;
          continue;
        }
      }
      out.push(tokens[i]);
      i++;
    }
    return out;
  }

  function groupPhrases(tokens, lineGapSec, clean) {
    const phrases = [];
    let cur = null;
    for (const tk of tokens) {
      if (!cur || tk.t0 - cur.t1 >= lineGapSec) {
        cur = { t0: tk.t0, t1: tk.t1, tokens: [tk] };
        phrases.push(cur);
      } else {
        cur.tokens.push(tk);
        cur.t1 = tk.t1;
      }
    }
    // Fold fragments (a split breath, a stray syllable) into the closer line.
    if (clean) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = phrases.length - 1; i >= 0; i--) {
          const ph = phrases[i];
          if (ph.t1 - ph.t0 >= 0.7 || ph.tokens.length > 2) continue;
          const prev = phrases[i - 1], next = phrases[i + 1];
          const gp = prev ? ph.t0 - prev.t1 : Infinity;
          const gn = next ? next.t0 - ph.t1 : Infinity;
          if (Math.min(gp, gn) > 2.2) continue;
          if (gp <= gn) {
            prev.tokens.push(...ph.tokens);
            prev.t1 = ph.t1;
          } else {
            next.tokens.unshift(...ph.tokens);
            next.t0 = ph.t0;
          }
          phrases.splice(i, 1);
        }
      }
    }
    let prevEnd = 0;
    for (const ph of phrases) {
      ph.section = ph.t0 - prevEnd >= 4;
      prevEnd = ph.t1;
    }
    return phrases;
  }

  /**
   * Quantize an f0 track to swara tokens relative to saHz.
   *
   * opts: clarityThresh (0..1), minNoteMs (stable-note threshold),
   *       ornaments (default true), ornMinMs (shortest ornament, default 30).
   *
   * With ornaments on, runs shorter than minNoteMs become first-class
   * ornaments instead of being smoothed away:
   *   - 1 short note before a stable note      -> kan (grace)
   *   - 2-4 short notes, non-gliding           -> murki cluster
   *   - monotonic 1-2 semitone chain           -> meend connector (X~Y)
   *   - >4 short notes in a row (fast taan)    -> promoted to real tokens
   *   - trailing 1-2 short notes               -> grace after the note
   * Stable notes additionally get andolan (slow oscillation) / meend
   * (internal glide) flags from the raw cents contour.
   *
   * Returns { tokens, phrases }; tokens = [{t0,t1,k,cents,meend,andolan,
   * meendFromPrev,kan,murki,graceAfter,orn:[{k,t0,t1,type}]}]; phrases
   * group tokens separated by gaps >= 0.6 s.
   */
  function notate(f0, clarity, hopSec, saHz, opts) {
    opts = opts || {};
    const thresh = opts.clarityThresh != null ? opts.clarityThresh : 0.5;
    const minNoteMs = opts.minNoteMs != null ? opts.minNoteMs : 90;
    const ornaments = opts.ornaments !== false;
    const ornMinMs = opts.ornMinMs != null ? opts.ornMinMs : 30;
    const clean = opts.clean === true;
    const lineGapSec = opts.lineGapSec != null ? opts.lineGapSec : (clean ? 1.0 : 0.6);
    // Onset times (seconds) of syllable/word articulations — note boundaries.
    const onsetT = (opts.onsets || []).map((f) => f * hopSec).sort((a, b) => a - b);
    const onsetBetween = (a, b) => {
      for (const t of onsetT) { if (t > a + 0.02 && t < b - 0.001) return true; if (t >= b) break; }
      return false;
    };
    const onsetNear = (t, before, after) => {
      for (const o of onsetT) {
        if (o >= t - before && o <= t + after) return true;
        if (o > t + after) break;
      }
      return false;
    };
    const stableFrames = Math.max(2, Math.round(minNoteMs / 1000 / hopSec));
    const ornFrames = Math.max(2, Math.round(ornMinMs / 1000 / hopSec));
    const minFrames = ornaments ? Math.min(ornFrames, stableFrames) : stableFrames;
    const medHalf = ornaments ? 1 : 2;   // median-3 keeps short ornaments; median-5 smooths
    const n = f0.length;

    const cents = new Float32Array(n);
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (f0[i] > 0 && clarity[i] >= thresh) {
        voiced[i] = 1;
        cents[i] = 1200 * Math.log2(f0[i] / saHz);
      }
    }
    // Repair one missing pitch frame between matching voiced neighbours. Neural
    // trackers commonly lose a single 4-10 ms frame on a fast consonant; leaving
    // that hole in place splits a genuine 60-90 ms murki landing into two pieces
    // that each fall below the ornament-duration gate.
    for (let i = 1; i + 1 < n; i++) {
      if (voiced[i] || !voiced[i - 1] || !voiced[i + 1] ||
          Math.abs(cents[i + 1] - cents[i - 1]) > 110) {
        continue;
      }
      voiced[i] = 1;
      cents[i] = (cents[i - 1] + cents[i + 1]) / 2;
    }

    const kArr = new Int16Array(n);
    for (let i = 0; i < n; i++) if (voiced[i]) kArr[i] = Math.round(cents[i] / 100);
    const kSm = new Int16Array(kArr);
    const win = [];
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      win.length = 0;
      for (let j = Math.max(0, i - medHalf); j <= Math.min(n - 1, i + medHalf); j++) {
        if (voiced[j]) win.push(kArr[j]);
      }
      win.sort((a, b) => a - b);
      kSm[i] = win[Math.floor(win.length / 2)];
    }
    // Schmitt-trigger quantization: once a swara is active, pitch must cross
    // slightly beyond the 50-cent midpoint before the label changes. This stops
    // boundary jitter from alternating r/R (or any adjacent pair) while still
    // switching immediately for clear leaps. Reset after silence and at detected
    // articulations so a genuinely re-sung adjacent note is not delayed.
    const hyst = opts.quantizeHysteresisCents != null ? opts.quantizeHysteresisCents : 12;
    const onsetFrames = new Set((opts.onsets || []).map((f) => Math.max(0, Math.min(n - 1, Math.round(f)))));
    let heldK = null;
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) { heldK = null; continue; }
      const reset = onsetFrames.has(i) || onsetFrames.has(i - 1) || onsetFrames.has(i + 1);
      if (heldK == null || reset || Math.abs(kSm[i] - heldK) > 1) {
        heldK = kSm[i];
      } else {
        while (cents[i] > (heldK + 0.5) * 100 + hyst) heldK++;
        while (cents[i] < (heldK - 0.5) * 100 - hyst) heldK--;
      }
      kSm[i] = heldK;
    }

    const makeToken = (r) => {
      const a = analyzeToken(cents, r.start, r.end, hopSec);
      const tk = {
        t0: r.start * hopSec, t1: r.end * hopSec, k: r.k,
        cents: a.mean, meend: a.meend, andolan: a.andolan,
      };
      if (a.andolan) { tk.andolanLo = a.andolanLo; tk.andolanHi = a.andolanHi; }
      return tk;
    };
    const ornOf = (r, type) => ({ k: r.k, t0: r.start * hopSec, t1: r.end * hopSec, type });

    // Passing-tone gate: a short run is a REAL sung note only if the pitch
    // briefly settles near that swara. Requiring a small centered window keeps
    // genuine fast murki notes, but a duplicate/noisy tracker frame inside a
    // continuous glide can no longer invent a landing.
    const gateDisabled = opts.gateCentsPerSec === 0;
    const landingFrames = Math.max(2, Math.min(
      ornFrames,
      Math.max(3, Math.round(0.024 / hopSec))
    ));
    const landingRange = opts.landingRangeCents != null ? opts.landingRangeCents : 24;
    const landingCenter = opts.landingCenterCents != null ? opts.landingCenterCents : 38;
    const hasPlateau = (r) => {
      if (gateDisabled) return true;
      if (r.end - r.start < landingFrames) return false;
      const target = r.k * 100;
      for (let j = r.start; j + landingFrames <= r.end; j++) {
        let lo = Infinity, hi = -Infinity, sum = 0;
        for (let q = j; q < j + landingFrames; q++) {
          const c = cents[q];
          if (c < lo) lo = c;
          if (c > hi) hi = c;
          sum += c;
        }
        const mean = sum / landingFrames;
        if (hi - lo <= landingRange && Math.abs(mean - target) <= landingCenter) return true;
      }
      return false;
    };

    let tokens = [];
    let segStart = -1;
    for (let i = 0; i <= n; i++) {
      const v = i < n && voiced[i];
      if (v && segStart < 0) segStart = i;
      if (!v && segStart >= 0) {
        const segEnd = i;
        let runs = [];
        let rs = segStart;
        for (let j = segStart + 1; j <= segEnd; j++) {
          if (j === segEnd || kSm[j] !== kSm[rs]) {
            runs.push({ start: rs, end: j, k: kSm[rs] });
            rs = j;
          }
        }
        mergeShortRuns(runs, minFrames);
        if (ornaments) absorbOscillations(runs, stableFrames, hasPlateau, hopSec);
        if (runs.length === 1 && runs[0].end - runs[0].start < stableFrames && !ornaments) runs = [];

        if (!ornaments) {
          mergeShortRuns(runs, stableFrames);
          for (const r of runs) tokens.push(makeToken(r));
        } else {
          // Pick out EVERY note the voice hits. Short runs around a stable note
          // are promoted to their own swara (so a murki, a melisma on one word,
          // or an alaap figure reads note-by-note), EXCEPT a smooth quantized
          // glide into the next note, which stays a meend path. (Sustained
          // oscillation and continuous sweeps are folded later by
          // collapseAndolan/collapseGlides via the mean-distance test.)
          let pending = [];
          let lastStable = null;
          const flush = (cur) => {
            if (pending.length) {
              const ks = pending.map(r => r.k);
              if (cur && lastStable && pending.length >= 2 && isMeendChain(lastStable.k, ks, cur.k) &&
                  meanDistToSemitone(cents, voiced, pending[0].start * hopSec, pending[pending.length - 1].end * hopSec, hopSec) > 22) {
                cur.meendFromPrev = true;
                cur.via = [lastStable.k].concat(ks, cur.k);
                cur.orn = (cur.orn || []).concat(pending.map(r => ornOf(r, 'meend')));
              } else {
                // Keep only the runs where the voice actually LANDED; pure
                // passing tones either fold into a meend path or drop.
                const real = pending.filter(hasPlateau);
                if (real.length) {
                  for (const r of real) tokens.push(makeToken(r));   // each sung note, distinct
                } else if (cur && lastStable && isMeendChain(lastStable.k, ks, cur.k)) {
                  cur.meendFromPrev = true;
                  cur.via = [lastStable.k].concat(ks, cur.k);
                  cur.orn = (cur.orn || []).concat(pending.map(r => ornOf(r, 'meend')));
                }
                // else: mid-glide transients with nowhere to attach — drop.
              }
              pending = [];
            }
            if (cur) { tokens.push(cur); lastStable = cur; }
          };
          for (const r of runs) {
            if (r.end - r.start >= stableFrames) flush(makeToken(r));
            else pending.push(r);
          }
          flush(null);
        }
        segStart = -1;
      }
    }

    // Capture continuous gestures the run-segmenter would otherwise shred:
    // first slow/wide andolan (oscillation), then monotonic meend (glide).
    // Both keep the swaras they touch so an alaap reads as the path it travels.
    if (ornaments) {
      tokens = collapseAndolan(tokens, cents, voiced, hopSec);
      tokens = collapseGlides(tokens, cents, voiced, hopSec);
    }

    /* Clean mode: keep confident, singable notes while preserving what the
     * singer actually sang. Drops weak/short blips and implausible glitch jumps;
     * it never changes a valid note merely because that swara is rare. */
    if (clean && tokens.length) {
      const n2 = clarity.length;
      const rms = opts.rms;
      for (const tk of tokens) {
        const i0 = Math.round(tk.t0 / hopSec);
        const i1 = Math.max(i0 + 1, Math.round(tk.t1 / hopSec));
        let s = 0, c = 0, rs = 0;
        for (let j = i0; j < i1 && j < n2; j++) { s += clarity[j]; if (rms) rs += rms[j]; c++; }
        tk.conf = c ? s / c : 0;
        tk.loud = c ? rs / c : 0;
      }
      // 0. Loudness gate: a quiet *sustained* tone under the singing is usually
      // tanpura/instrument bleed, not the voice — drop it. Only gate long quiet
      // tones (a held drone); a soft, quick vocal note in an alaap/murki is a
      // real note the learner needs to see, so it's kept regardless of level.
      if (rms) {
        const lv = tokens.map((t) => t.loud).filter((x) => x > 0).sort((a, b) => a - b);
        const medLoud = lv.length ? lv[lv.length >> 1] : 0;
        if (medLoud > 0) tokens = tokens.filter((tk) => tk.loud >= 0.16 * medLoud || (tk.t1 - tk.t0) < 0.4);
      }
      // 1. Weak-short blips out. We want EVERY note the voice actually hits, so
      // only a sub-100 ms run that is *also* barely above the voicing threshold
      // (a tracking flicker, not a sung note) is removed — a clearly-voiced fast
      // note in a taan/murki survives even when very short.
      let out = tokens.filter((tk) => {
        const dur = tk.t1 - tk.t0;
        if (dur < 0.10 && tk.conf < thresh + 0.06) return false;
        return true;
      });
      // 2. Glitch jumps and far-out-of-tessitura strays.
      let wSum = 0, wk = 0;
      for (const tk of out) { const w = tk.t1 - tk.t0; wSum += w; wk += w * tk.k; }
      const centerK = wSum ? wk / wSum : 0;
      out = out.filter((tk, i) => {
        const dur = tk.t1 - tk.t0;
        if (dur >= 0.22) return true;
        if (Math.abs(tk.k - centerK) > 16) return false;       // outside any plausible tessitura
        const pv = out[i - 1], nx = out[i + 1];
        const dp = pv ? Math.abs(tk.k - pv.k) : 99;
        const dn = nx ? Math.abs(tk.k - nx.k) : 99;
        return !(Math.min(dp, dn) > 7 && dur < 0.12);          // only a truly isolated micro-stray
      });
      // 3. Join only tiny confidence dropouts inside one continuous note. A
      // breath, consonant or deliberate re-strike is a new sung note even when
      // its pitch is unchanged.
      const holdGap = Math.max(0.045, 3 * hopSec);
      const merged = [];
      for (const tk of out) {
        if (!ornaments) { tk.meend = false; tk.andolan = false; }
        const last = merged[merged.length - 1];
        const boundaryOnset = onsetBetween(last ? last.t1 : 0, tk.t0) || onsetNear(tk.t0, 0.06, 0.08);
        if (last && !last.glide && !tk.glide && !last.andolan && !tk.andolan &&
            last.k === tk.k && tk.t0 - last.t1 <= holdGap && !boundaryOnset) {
          last.t1 = tk.t1;
          last.meend = last.meend || tk.meend;
          last.andolan = last.andolan || tk.andolan;
          if (tk.orn) last.orn = (last.orn || []).concat(tk.orn);
          if (tk.graceAfter) last.graceAfter = tk.graceAfter;
        } else merged.push(tk);
      }
      // 4. Clear meend connectors whose left side was dropped.
      for (let i = 0; i < merged.length; i++) {
        if (merged[i].meendFromPrev && (i === 0 || merged[i].t0 - merged[i - 1].t1 > 0.3)) {
          merged[i].meendFromPrev = false;
        }
      }
      tokens = merged;
    }

    // Split a note wherever a syllable is re-articulated inside it (an onset
    // with no pitch change), so each vocalised start gets its own note. The
    // pieces share the pitch; later pieces are flagged re-articulations and
    // shed the leading ornament so they read as clean note starts.
    if (onsetT.length) {
      const split = [];
      for (const tk of tokens) {
        if (tk.glide || tk.andolan) { split.push(tk); continue; }   // one gesture, never split
        // Keep a conservative floor, but allow fast syllables: 180 ms hid real
        // 100–150 ms re-articulations in taans and words with several notes.
        const onsetMinSec = (opts.onsetMinMs != null ? opts.onsetMinMs : (clean ? 105 : 85)) / 1000;
        const cuts = [];
        let prevCut = tk.t0;
        for (const t of onsetT) {
          if (t > prevCut + onsetMinSec && t < tk.t1 - onsetMinSec) { cuts.push(t); prevCut = t; }
        }
        if (!cuts.length) { split.push(tk); continue; }
        let prev = tk.t0;
        const bounds = cuts.concat(tk.t1);
        for (let i = 0; i < bounds.length; i++) {
          const seg = Object.assign({}, tk, { t0: prev, t1: bounds[i] });
          if (i > 0) { delete seg.kan; delete seg.murki; seg.meendFromPrev = false; seg.reart = true; }
          if (i < bounds.length - 1) delete seg.graceAfter;
          split.push(seg);
          prev = bounds[i];
        }
      }
      tokens = split;
    }

    return { tokens, phrases: groupPhrases(tokens, lineGapSec, clean) };
  }

  /**
   * Restore short, clearly landed turning notes that sit inside a broader GAME
   * region. Each recovery is limited to the local three-note gesture around the
   * turn. This keeps a real murki visible without allowing one frame-level turn
   * to replace the neural model's boundaries across an entire alaap phrase.
   */
  function fuseTurningOrnaments(neuralTokens, frameTokens, suppressedTurns) {
    if (neuralTokens.length < 1 || frameTokens.length < 3) {
      return neuralTokens;
    }
    const refinedTokens = neuralTokens.map((token) => Object.assign({}, token));
    const recoveredEntries = [];
    for (let tokenIndex = 0; tokenIndex < refinedTokens.length; tokenIndex++) {
      const token = refinedTokens[tokenIndex];
      for (let frameIndex = 1; frameIndex < frameTokens.length; frameIndex++) {
        let lead = frameTokens[frameIndex - 1];
        const landing = frameTokens[frameIndex];
        if (lead.t1 - lead.t0 <= 0.055 && frameIndex >= 2) {
          const earlier = frameTokens[frameIndex - 2];
          if (landing.t0 - earlier.t1 <= 0.12) lead = earlier;
        }
        const overlapInside = landing.t0 >= token.t0 + 0.07 &&
          landing.t0 <= token.t1 - 0.025;
        const leadCrossesOnset = lead.t0 <= token.t0 + 0.02 &&
          lead.t1 >= token.t0 + 0.07;
        const connected = landing.t0 - lead.t1 <= 0.12;
        const closeStart = token.t0 - lead.t0 <= 0.30;
        const materiallyEarlier = token.t0 - lead.t0 >= 0.08;
        if (landing.k !== token.k || lead.k === token.k ||
            lead.t1 - lead.t0 < 0.07 || !overlapInside ||
            !leadCrossesOnset || !connected || !closeStart ||
            !materiallyEarlier) {
          continue;
        }
        const previous = refinedTokens[tokenIndex - 1];
        const start = previous ? Math.max(lead.t0, previous.t1) : lead.t0;
        if (landing.t0 - start < 0.06) continue;
        recoveredEntries.push(Object.assign({}, lead, {
          t0: start,
          t1: landing.t0,
          hybridOrnament: true,
          recoveredEntry: true,
        }));
        token.t0 = landing.t0;
        break;
      }
    }
    if (recoveredEntries.length) {
      refinedTokens.push(...recoveredEntries);
      refinedTokens.sort((a, b) => a.t0 - b.t0);
    }
    const missingTurns = [];
    const maxTurnSec = 0.16;
    const maxNeighborGapSec = 0.06;
    const wasSuppressed = (candidate) => (suppressedTurns || []).some((turn) => {
      if (turn.k !== candidate.k) return false;
      return Math.min(turn.t1, candidate.t1) -
        Math.max(turn.t0, candidate.t0) >= 0.02;
    });
    const existingHit = (candidate) => refinedTokens.some((token) => {
      if (token.k !== candidate.k) return false;
      const overlap = Math.min(token.t1, candidate.t1) -
        Math.max(token.t0, candidate.t0);
      return overlap >= Math.min(0.025, (candidate.t1 - candidate.t0) * 0.4);
    });

    for (let i = 1; i + 1 < frameTokens.length; i++) {
      const previous = frameTokens[i - 1];
      const token = frameTokens[i];
      const next = frameTokens[i + 1];
      const duration = token.t1 - token.t0;
      const leftGap = token.t0 - previous.t1;
      const rightGap = next.t0 - token.t1;
      const reverses = (token.k - previous.k) * (next.k - token.k) < 0;
      const totalLeap = Math.abs(token.k - previous.k) +
        Math.abs(next.k - token.k);
      const neighborSpan = Math.abs(next.k - previous.k);
      const outside = Math.max(
        Math.min(previous.k, next.k) - token.k,
        token.k - Math.max(previous.k, next.k),
        0
      );
      // RMVPE can briefly jump an octave-like distance during a consonant. A
      // real sub-100 ms murki turn is compact; these very large rebounds are
      // tracker glitches. A one-semitone hook just outside two adjacent targets
      // is transition geometry, so it belongs in the bend rather than as a note.
      const implausibleSpike = duration <= 0.10 && totalLeap >= 7;
      const classicNeighborTurn = previous.k === next.k && duration >= 0.065;
      const adjacentHook = duration <= 0.14 && neighborSpan <= 2 &&
        outside === 1 && !classicNeighborTurn;
      if (duration >= 0.025 && duration <= maxTurnSec &&
          leftGap <= maxNeighborGapSec && rightGap <= maxNeighborGapSec &&
          reverses && !implausibleSpike && !adjacentHook &&
          !existingHit(token) && !wasSuppressed(token)) {
        missingTurns.push(i);
      }
    }
    if (!missingTurns.length) return refinedTokens;

    // Limit each missing turn to its immediate anchors. Merge only overlapping
    // three-note windows, never every connected frame token in the phrase.
    const components = [];
    for (const index of missingTurns) {
      const first = index - 1;
      const last = index + 1;
      const previous = components[components.length - 1];
      if (previous && first <= previous.last + 1) {
        previous.last = Math.max(previous.last, last);
      } else {
        components.push({ first, last });
      }
    }

    let result = refinedTokens.slice();
    for (const component of components) {
      const replacements = frameTokens
        .slice(component.first, component.last + 1)
        .map((token) => Object.assign({}, token, { hybridOrnament: true }));
      const start = replacements[0].t0;
      const end = replacements[replacements.length - 1].t1;
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= start || token.t0 >= end) {
          preserved.push(token);
          continue;
        }
        // A broad neural region can straddle a recovered turn. Keep its useful
        // outer portions so local frame evidence cannot erase the rest of it.
        if (token.t0 < start - 0.025) {
          preserved.push(Object.assign({}, token, { t1: start }));
        }
        if (token.t1 > end + 0.025) {
          preserved.push(Object.assign({}, token, { t0: end }));
        }
      }
      result = preserved;
      result.push(...replacements);
    }
    result.sort((a, b) => a.t0 - b.t0);
    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.hybridOrnament || token.hybridOrnament)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.hybridOrnament = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  function rawPitchRuns(f0, clarity, hopSec, saHz, thresh) {
    const runs = [];
    for (let frame = 0; frame < f0.length; frame++) {
      if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
      const cents = 1200 * Math.log2(f0[frame] / saHz);
      const k = Math.round(cents / 100);
      const previous = runs[runs.length - 1];
      if (previous && previous.k === k && frame - previous.end <= 2) {
        previous.end = frame + 1;
        previous.values.push(cents);
        previous.confidences.push(clarity[frame]);
      } else {
        runs.push({
          k,
          start: frame,
          end: frame + 1,
          values: [cents],
          confidences: [clarity[frame]],
        });
      }
    }
    return runs;
  }

  /**
   * Recover a very short adjacent-neighbour turn (for example D-n-D) directly
   * from the raw contour when neural hysteresis has merged it into two same-note
   * regions. A nearby neural boundary is required as independent evidence, which
   * keeps ordinary vibrato from becoming a stream of one-semitone murki labels.
   */
  function fuseRawNeighborTurns(tokens, f0, clarity, hopSec, saHz, thresh,
    suppressedTurns) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const wasSuppressed = (candidate) => (suppressedTurns || []).some((turn) =>
      turn.k === candidate.k &&
      Math.min(turn.t1, candidate.t1) - Math.max(turn.t0, candidate.t0) >= 0.02
    );
    let result = tokens.slice();
    const insertTurn = (previous, candidate, next, flags) => {
      const start = Math.max(previous.start * hopSec, candidate.t0 - 0.14);
      const end = Math.min(next.end * hopSec, candidate.t1 + 0.14);
      const replacements = [
        { t0: start, t1: candidate.t0, k: previous.k },
        candidate,
        { t0: candidate.t1, t1: end, k: next.k },
      ].map((token) => Object.assign({}, token, {
        cents: token.k * 100,
        hybridOrnament: true,
        rawLandmark: true,
      }, flags || {}));
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= start || token.t0 >= end) {
          preserved.push(token);
          continue;
        }
        if (token.t0 < start - 0.025) {
          preserved.push(Object.assign({}, token, { t1: start }));
        }
        if (token.t1 > end + 0.025) {
          preserved.push(Object.assign({}, token, { t0: end }));
        }
      }
      result = preserved.concat(replacements).sort((a, b) => a.t0 - b.t0);
    };
    for (let index = 1; index + 1 < runs.length; index++) {
      const previous = runs[index - 1];
      const run = runs[index];
      const next = runs[index + 1];
      const duration = (run.end - run.start) * hopSec;
      if (previous.k !== next.k || run.k === previous.k ||
          Math.abs(run.k - previous.k) > 2 ||
          duration < 0.045 || duration > 0.16 ||
          (run.start - previous.end) * hopSec > 0.02 ||
          (next.start - run.end) * hopSec > 0.02) {
        continue;
      }
      let plateau = 0, bestPlateau = 0;
      for (const cents of run.values) {
        if (Math.abs(cents - run.k * 100) <= 32) {
          plateau++;
          bestPlateau = Math.max(bestPlateau, plateau);
        } else {
          plateau = 0;
        }
      }
      if (bestPlateau * hopSec < 0.025) continue;
      const sortedValues = run.values.slice().sort((a, b) => a - b);
      const landingMedian = sortedValues[sortedValues.length >> 1];
      const candidate = {
        t0: run.start * hopSec,
        t1: run.end * hopSec,
        k: run.k,
      };
      const center = (candidate.t0 + candidate.t1) / 2;
      const neuralBoundary = result.some((token, tokenIndex) => {
        const following = result[tokenIndex + 1];
        if (!following || token.k !== previous.k ||
            following.k !== previous.k) {
          return false;
        }
        return Math.abs((token.t1 + following.t0) / 2 - center) <= 0.12;
      });
      // GAME sometimes keeps a nuanced return turn inside one broad anchor
      // note, so there is no neural boundary to confirm it. Accept containment
      // as the independent evidence only when the raw target is tightly
      // centred, both anchor sides are sustained, and the gesture is isolated
      // rather than one cycle of recurring vibrato/andolan.
      const anchorDuration = (
        previous.end - previous.start +
        next.end - next.start
      ) * hopSec;
      const leftAnchorDuration = (previous.end - previous.start) * hopSec;
      const rightAnchorDuration = (next.end - next.start) * hopSec;
      const containingAnchor = result.some((token) =>
        !token.glide && !token.andolan && token.k === previous.k &&
        token.t0 <= candidate.t0 - 0.04 &&
        token.t1 >= candidate.t1 + 0.04
      );
      let nearbyMatchingTurns = 0;
      for (let otherIndex = 1; otherIndex + 1 < runs.length; otherIndex++) {
        const other = runs[otherIndex];
        if (other.k !== run.k ||
            runs[otherIndex - 1].k !== previous.k ||
            runs[otherIndex + 1].k !== previous.k) {
          continue;
        }
        const otherCenter = (other.start + other.end) * hopSec / 2;
        if (Math.abs(otherCenter - center) <= 0.45) nearbyMatchingTurns++;
      }
      const containedPlateau = containingAnchor &&
        duration >= 0.055 &&
        duration <= 0.09 &&
        Math.abs(run.k - previous.k) === 1 &&
        bestPlateau * hopSec >= 0.045 &&
        Math.abs(landingMedian - run.k * 100) <= 22 &&
        anchorDuration >= 0.16 &&
        leftAnchorDuration >= 0.08 &&
        rightAnchorDuration >= 0.08 &&
        nearbyMatchingTurns <= 1;
      const existingHit = result.some((token) =>
        token.k === candidate.k &&
        Math.min(token.t1, candidate.t1) -
          Math.max(token.t0, candidate.t0) >= 0.025
      );
      if ((!neuralBoundary && !containedPlateau) ||
          existingHit || wasSuppressed(candidate)) {
        continue;
      }
      insertTurn(previous, candidate, next);
    }
    // A nuanced turn can contain one still-smaller traversal, for example
    // S-N-n-N-S. The 20 ms inner n is transition geometry, but the two N
    // plateaus together form one clearly reached target. Recover only this
    // symmetric nested shape inside a broad neural anchor; arbitrary multi-run
    // movement remains untouched.
    for (let first = 1; first + 3 < runs.length; first++) {
      const previous = runs[first - 1];
      for (let last = first + 2;
        last <= Math.min(first + 3, runs.length - 2);
        last++) {
        const next = runs[last + 1];
        const excursion = runs.slice(first, last + 1);
        const targetK = excursion[0].k;
        if (previous.k !== next.k || targetK !== excursion[excursion.length - 1].k ||
            targetK === previous.k || Math.abs(targetK - previous.k) > 2) {
          continue;
        }
        const direction = Math.sign(targetK - previous.k);
        const sameSide = excursion.every((part) =>
          part.k !== previous.k &&
          Math.sign(part.k - previous.k) === direction &&
          Math.abs(part.k - previous.k) <= 2
        );
        let connected = true;
        for (let part = 1; part < excursion.length; part++) {
          if ((excursion[part].start - excursion[part - 1].end) * hopSec > 0.02) {
            connected = false;
            break;
          }
        }
        if (!sameSide || !connected) continue;

        const candidate = {
          t0: excursion[0].start * hopSec,
          t1: excursion[excursion.length - 1].end * hopSec,
          k: targetK,
        };
        const duration = candidate.t1 - candidate.t0;
        const targetValues = excursion
          .filter((part) => part.k === targetK)
          .flatMap((part) => part.values);
        const targetFrames = excursion
          .filter((part) => part.k === targetK)
          .reduce((sum, part) => sum + part.end - part.start, 0);
        const targetEntryFrames = excursion[0].end - excursion[0].start;
        const targetReturnFrames =
          excursion[excursion.length - 1].end -
          excursion[excursion.length - 1].start;
        const sortedValues = targetValues.slice().sort((a, b) => a - b);
        const landingMedian = sortedValues[sortedValues.length >> 1];
        const leftAnchor = (previous.end - previous.start) * hopSec;
        const rightAnchor = (next.end - next.start) * hopSec;
        const containingAnchor = result.some((token) =>
          !token.glide && !token.andolan && token.k === previous.k &&
          token.t0 <= candidate.t0 - 0.04 &&
          token.t1 >= candidate.t1 + 0.04
        );
        const existingHit = result.some((token) =>
          token.k === candidate.k &&
          Math.min(token.t1, candidate.t1) -
            Math.max(token.t0, candidate.t0) >= 0.025
        );
        if (!containingAnchor || duration < 0.09 || duration > 0.18 ||
            targetFrames * hopSec < 0.07 ||
            targetEntryFrames * hopSec < 0.04 ||
            targetReturnFrames * hopSec < 0.04 ||
            Math.abs(landingMedian - targetK * 100) > 24 ||
            leftAnchor < 0.055 || rightAnchor < 0.055 ||
            existingHit || wasSuppressed(candidate)) {
          continue;
        }
        insertTurn(previous, candidate, next, { nestedTurn: true });
        break;
      }
    }
    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.rawLandmark || token.rawLandmark)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.rawLandmark = true;
        previous.hybridOrnament = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  /**
   * Recover a compact sequence of stable pitch landings when GAME compresses a
   * whole fast murki into one or two broad regions. Quantized crossing frames
   * are deliberately excluded: a candidate must spend at least 30 ms centred
   * on the swara and must not drift straight through it. The sequence also
   * needs either multiple varied reversals or one compact return, plus a broad
   * non-andolan neural region that independently proves model compression.
   */
  function fuseRawMurkiClusters(tokens, f0, clarity, hopSec, saHz, thresh,
    suppressedTurns) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const wasSuppressed = (candidate) => (suppressedTurns || []).some((turn) =>
      turn.k === candidate.k &&
      Math.min(turn.t1, candidate.t1) - Math.max(turn.t0, candidate.t0) >= 0.02
    );
    const landings = [];
    for (const run of runs) {
      const duration = (run.end - run.start) * hopSec;
      if (duration < 0.045 || duration > 0.32) continue;
      const sorted = run.values.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      if (Math.abs(median - run.k * 100) > 34) continue;
      let centeredFrames = 0;
      for (const cents of run.values) {
        if (Math.abs(cents - run.k * 100) <= 35) centeredFrames++;
      }
      if (centeredFrames * hopSec <
          Math.max(0.03, duration * 0.55) - 1e-9) {
        continue;
      }
      // A run that enters one side and leaves the other is a crossing even if
      // its median happens to sit on the swara.
      if (Math.abs(run.values[run.values.length - 1] - run.values[0]) > 65) {
        continue;
      }
      const candidate = {
        t0: run.start * hopSec,
        t1: run.end * hopSec,
        k: run.k,
        minClarity: Math.min(...run.confidences),
      };
      candidate.suppressed = wasSuppressed(candidate);
      landings.push(candidate);
    }
    if (landings.length < 3) return tokens;

    const chains = [];
    for (const landing of landings) {
      const chain = chains[chains.length - 1];
      const previous = chain && chain[chain.length - 1];
      if (previous &&
          landing.t0 - previous.t1 <= 0.10 &&
          Math.abs(landing.k - previous.k) <= 6) {
        chain.push(landing);
      } else {
        chains.push([landing]);
      }
    }

    const recoveries = [];
    for (const chain of chains) {
      if (chain.length < 3) continue;
      const turns = [];
      for (let index = 1; index + 1 < chain.length; index++) {
        const incoming = chain[index].k - chain[index - 1].k;
        const outgoing = chain[index + 1].k - chain[index].k;
        if (incoming * outgoing < 0 &&
            Math.abs(incoming) <= 5 &&
            Math.abs(outgoing) <= 5) {
          turns.push(index);
        }
      }
      const components = [];
      for (const turn of turns) {
        const first = turn - 1;
        const last = turn + 1;
        const previous = components[components.length - 1];
        if (previous && first <= previous.last + 1) {
          previous.last = Math.max(previous.last, last);
          previous.turns++;
        } else {
          components.push({ first, last, turns: 1 });
        }
      }

      for (const component of components) {
        const sequence = chain.slice(component.first, component.last + 1);
        const classicReturn = sequence.length === 3 &&
          component.turns === 1 &&
          sequence[0].k === sequence[2].k &&
          Math.abs(sequence[1].k - sequence[0].k) <= 2 &&
          sequence.every((landing) => landing.t1 - landing.t0 <= 0.14);
        const variedCluster = sequence.length >= 4 &&
          component.turns >= 2 &&
          new Set(sequence.map((landing) => landing.k)).size >= 3;
        if (!classicReturn && !variedCluster) continue;
        // A cluster replaces several learned neural boundaries at once, so
        // every proposed target must have unusually strong frame-level pitch
        // evidence. One uncertain landing rejects the whole sequence.
        const highConfidenceFloor = Math.max(0.90, thresh);
        if (sequence.some((landing) =>
          landing.minClarity < highConfidenceFloor)) {
          continue;
        }
        if (classicReturn &&
            sequence.some((landing) => landing.suppressed)) {
          continue;
        }
        const centers = sequence.map((landing) =>
          (landing.t0 + landing.t1) / 2
        );
        if (centers[centers.length - 1] - centers[0] > 0.90) continue;
        if (classicReturn &&
            centers[centers.length - 1] - centers[0] > 0.24) {
          continue;
        }
        const intervals = [];
        for (let index = 1; index < centers.length; index++) {
          intervals.push(centers[index] - centers[index - 1]);
        }
        intervals.sort((a, b) => a - b);
        if (intervals[intervals.length >> 1] > 0.18) continue;

        const start = sequence[0].t0;
        const end = sequence[sequence.length - 1].t1;
        const overlapping = tokens.filter((token) =>
          token.t1 > start && token.t0 < end
        );
        if (!overlapping.length ||
            overlapping.some((token) => token.andolan)) {
          continue;
        }
        const compressed = overlapping.some((token) => {
          if (token.t1 - token.t0 < 0.16) return false;
          let coveredLandings = 0;
          for (const landing of sequence) {
            const center = (landing.t0 + landing.t1) / 2;
            if (center >= token.t0 && center <= token.t1) coveredLandings++;
          }
          return coveredLandings >= 2;
        });
        if (!compressed) continue;
        const missing = sequence.filter((landing) => !tokens.some((token) => {
          if (token.k !== landing.k) return false;
          const overlap = Math.min(token.t1, landing.t1) -
            Math.max(token.t0, landing.t0);
          return overlap >= Math.min(
            0.025,
            (landing.t1 - landing.t0) * 0.4
          );
        }));
        if (!missing.length || (classicReturn && missing.length < 2)) continue;
        recoveries.push(sequence);
      }
    }
    if (!recoveries.length) return tokens;

    let result = tokens.slice();
    for (const sequence of recoveries) {
      const rawStart = sequence[0].t0;
      const rawEnd = sequence[sequence.length - 1].t1;
      const replacements = sequence.map((landing) => ({
        t0: landing.t0,
        t1: landing.t1,
        k: landing.k,
        cents: landing.k * 100,
        hybridOrnament: true,
        rawLandmark: true,
        rawMurkiCluster: true,
      }));
      for (let index = 1; index < replacements.length; index++) {
        const boundary = (
          sequence[index - 1].t1 + sequence[index].t0
        ) / 2;
        replacements[index - 1].t1 = boundary;
        replacements[index].t0 = boundary;
      }
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= rawStart || token.t0 >= rawEnd) {
          preserved.push(token);
          continue;
        }
        if (token.t0 < rawStart - 0.025) {
          preserved.push(Object.assign({}, token, { t1: rawStart }));
        }
        if (token.t1 > rawEnd + 0.025) {
          preserved.push(Object.assign({}, token, { t0: rawEnd }));
        }
      }
      result = preserved.concat(replacements).sort((a, b) => a.t0 - b.t0);
    }

    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.rawMurkiCluster || token.rawMurkiCluster)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.rawLandmark = true;
        previous.hybridOrnament = true;
        previous.rawMurkiCluster = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  /**
   * Convert singing-specific neural note regions to swara tokens. GAME already
   * supplies the primary boundaries. A conservative frame-level fusion restores
   * only stable turning notes that GAME hid inside a broad ornament region.
   */
  function notateRegions(regions, f0, clarity, hopSec, saHz, opts) {
    opts = opts || {};
    const clean = opts.clean === true;
    const ornaments = opts.ornaments !== false;
    const thresh = opts.clarityThresh != null ? opts.clarityThresh : 0.5;
    const lineGapSec = opts.lineGapSec != null ? opts.lineGapSec : (clean ? 1.0 : 0.6);
    const rms = opts.rms;
    let tokens = [];
    const suppressedTurns = [];

    for (const region of regions || []) {
      const t0 = Number(region.onset != null ? region.onset : region.t0);
      const t1 = Number(region.offset != null ? region.offset : region.t1);
      const frequency = region.frequency > 0
        ? Number(region.frequency)
        : 440 * Math.pow(2, (Number(region.midi) - 69) / 12);
      if (!(t0 >= 0) || !(t1 > t0) || !(frequency > 0)) continue;

      const noteCents = 1200 * Math.log2(frequency / saHz);
      const contour = [];
      let confidenceSum = 0, loudnessSum = 0, frameCount = 0;
      const i0 = Math.max(0, Math.floor(t0 / hopSec));
      const i1 = Math.min(f0 ? f0.length : 0, Math.ceil(t1 / hopSec));
      for (let i = i0; i < i1; i++) {
        if (f0[i] > 0 && (!clarity || clarity[i] >= thresh)) {
          contour.push(1200 * Math.log2(f0[i] / saHz));
        }
        if (clarity) confidenceSum += clarity[i] || 0;
        if (rms) loudnessSum += rms[i] || 0;
        frameCount++;
      }

      const character = ornaments && contour.length >= 2
        ? analyzeToken(contour, 0, contour.length, hopSec)
        : { mean: noteCents, meend: false, andolan: false };
      const token = {
        t0,
        t1,
        k: Math.round(noteCents / 100),
        cents: contour.length ? character.mean : noteCents,
        meend: !!character.meend,
        andolan: !!character.andolan,
        neural: true,
        _contour: contour,
      };
      if (character.andolan) {
        token.andolanLo = character.andolanLo;
        token.andolanHi = character.andolanHi;
      }
      if (frameCount) {
        token.conf = confidenceSum / frameCount;
        token.loud = loudnessSum / frameCount;
      }
      tokens.push(token);
    }

    tokens.sort((a, b) => a.t0 - b.t0);
    let frameTokens = [];
    if (ornaments && f0 && clarity && hopSec > 0) {
      const frameOpts = Object.assign({}, opts, {
        ornaments: true,
        ornMinMs: Math.min(
          opts.ornMinMs != null ? opts.ornMinMs : 30,
          25
        ),
        landingCenterCents: opts.landingCenterCents != null
          ? opts.landingCenterCents
          : 45,
      });
      frameTokens = notate(
        f0,
        clarity,
        hopSec,
        saHz,
        frameOpts
      ).tokens;
    }
    if (clean) {
      // GAME can average a stable entry note together with its outgoing glide
      // and place the whole region one semitone toward the destination. When a
      // frame-level plateau begins with the region and lasts long enough to be
      // sung deliberately, use that landed pitch for the singer-facing label.
      for (const token of tokens) {
        let entry = null;
        for (const frameToken of frameTokens) {
          const duration = frameToken.t1 - frameToken.t0;
          const overlap = Math.min(token.t1, frameToken.t1) -
            Math.max(token.t0, frameToken.t0);
          if (Math.abs(frameToken.k - token.k) !== 1 ||
              duration < 0.075 || overlap < 0.07 ||
              frameToken.t0 < token.t0 - 0.035 ||
              frameToken.t0 > token.t0 + 0.06) {
            continue;
          }
          if (!entry || overlap > entry.overlap) {
            entry = { frameToken, overlap };
          }
        }
        if (entry) {
          // A short overshoot at the region entrance can look like an adjacent
          // plateau even though GAME correctly labelled the longer pitch it
          // resolves onto. Keep that neural target when frame evidence returns
          // to it and remains there materially longer than the entry touch.
          const entryOverlap = entry.overlap;
          const returnPlateau = frameTokens.some((frameToken) => {
            if (frameToken.k !== token.k ||
                frameToken.t0 < entry.frameToken.t1 - 0.025) {
              return false;
            }
            const overlap = Math.min(token.t1, frameToken.t1) -
              Math.max(token.t0, frameToken.t0);
            return overlap >= 0.09 &&
              overlap >= entryOverlap + 0.025;
          });
          if (returnPlateau) continue;
          token.k = entry.frameToken.k;
          token.entryPlateauSnap = true;
          continue;
        }
        const startFrame = Math.max(0, Math.floor(token.t0 / hopSec));
        const endFrame = Math.min(
          f0 ? f0.length : 0,
          Math.ceil(Math.min(token.t1, token.t0 + 0.14) / hopSec)
        );
        const counts = new Map();
        for (let frame = startFrame; frame < endFrame; frame++) {
          if (!(f0[frame] > 0) || (clarity && clarity[frame] < thresh)) continue;
          const k = Math.round(12 * Math.log2(f0[frame] / saHz));
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        let landedK = token.k, landedFrames = 0;
        for (const [k, count] of counts) {
          if (count > landedFrames) {
            landedK = k;
            landedFrames = count;
          }
        }
        if (Math.abs(landedK - token.k) === 1 &&
            landedFrames * hopSec >= 0.075 &&
            token.t1 - token.t0 >= 0.20) {
          token.k = landedK;
          token.entryPlateauSnap = true;
        }
      }

      // GAME occasionally inserts a boundary inside one held note. Merge it
      // only when the source track stays voiced, close to the shared swara and
      // energetic across the boundary. Re-articulations with a pitch/energy
      // break remain separate notes.
      if (rms && f0 && clarity && hopSec > 0) {
        const merged = [];
        const median = (values) => {
          if (!values.length) return 0;
          values.sort((a, b) => a - b);
          return values[values.length >> 1];
        };
        const continuousBoundary = (left, right) => {
          if (left.k !== right.k || right.t0 - left.t1 > 0.03) return false;
          const boundary = (left.t1 + right.t0) / 2;
          const boundaryOnset = (opts.onsets || []).some((frame) =>
            Math.abs(frame * hopSec - boundary) <= Math.max(0.06, 3 * hopSec)
          );
          // Server v4 onsets come from the isolated vocal articulation detector,
          // independently of GAME. A nearby onset therefore means the singer
          // re-struck the note even when GAME placed its boundary a few frames
          // later.
          if (boundaryOnset) return false;
          const spanningFrame = frameTokens.some((frameToken) =>
            frameToken.k === left.k &&
            frameToken.t0 <= boundary - 0.02 &&
            frameToken.t1 >= boundary + 0.02
          );
          if (!spanningFrame) return false;
          const center = Math.round(boundary / hopSec);
          const radius = Math.max(2, Math.round(0.025 / hopSec));
          let leftVoiced = 0, rightVoiced = 0, silentRun = 0, maxSilentRun = 0;
          const leftRms = [], rightRms = [];
          for (let frame = center - radius; frame <= center + radius; frame++) {
            if (frame < 0 || frame >= f0.length) continue;
            const voiced = f0[frame] > 0 &&
              (!clarity || clarity[frame] >= thresh);
            if (voiced) {
              const cents = 1200 * Math.log2(f0[frame] / saHz);
              if (Math.abs(cents - left.k * 100) > 70) return false;
              if (frame < center) leftVoiced++;
              else rightVoiced++;
              silentRun = 0;
            } else {
              silentRun++;
              maxSilentRun = Math.max(maxSilentRun, silentRun);
            }
            const level = Number(rms[frame]);
            if (Number.isFinite(level) && level >= 0) {
              (frame < center ? leftRms : rightRms).push(level);
            }
          }
          if (leftVoiced < 2 || rightVoiced < 2 || maxSilentRun > 1) {
            return false;
          }
          const sideLevel = Math.min(median(leftRms), median(rightRms));
          const centerLevel = (
            Number(rms[Math.max(0, center - 1)]) +
            Number(rms[Math.min(rms.length - 1, center)])
          ) / 2;
          return sideLevel <= 0 ||
            (Number.isFinite(centerLevel) && centerLevel >= sideLevel * 0.45);
        };

        for (const token of tokens) {
          const previous = merged[merged.length - 1];
          if (!previous || !continuousBoundary(previous, token)) {
            merged.push(token);
            continue;
          }
          const previousDuration = previous.t1 - previous.t0;
          const tokenDuration = token.t1 - token.t0;
          const totalDuration = previousDuration + tokenDuration;
          previous.t1 = token.t1;
          previous.cents = totalDuration > 0
            ? (previous.cents * previousDuration +
              token.cents * tokenDuration) / totalDuration
            : previous.cents;
          previous.meend = previous.meend || token.meend;
          previous.andolan = previous.andolan || token.andolan;
          previous._contour = (previous._contour || [])
            .concat(token._contour || []);
          if (Number.isFinite(previous.conf) && Number.isFinite(token.conf)) {
            previous.conf = (previous.conf * previousDuration +
              token.conf * tokenDuration) / totalDuration;
          }
          if (Number.isFinite(previous.loud) && Number.isFinite(token.loud)) {
            previous.loud = (previous.loud * previousDuration +
              token.loud * tokenDuration) / totalDuration;
          }
        }
        tokens = merged;
      }

      // Fold a short one-semitone hook into the following target when its raw
      // contour enters from the previous note, turns, and leaves toward the
      // target. This is sung transition geometry, not a separate note landing.
      // The same rule handles a leading dip after a pause when it immediately
      // rebounds into a stronger adjacent target.
      for (let i = 0; i + 1 < tokens.length; i++) {
        const previous = i > 0 ? tokens[i - 1] : null;
        const token = tokens[i];
        const next = tokens[i + 1];
        const path = token._contour || [];
        const duration = token.t1 - token.t0;
        const previousConnected = !!previous &&
          token.t0 - previous.t1 <= 0.035;
        const nextConnected = next.t0 - token.t1 <= 0.035;
        if (!nextConnected || duration > 0.24 || path.length < 5) continue;

        let pathMin = path[0], pathMax = path[0];
        let extremeIndex = 0;
        const hookHigh = token.k > next.k;
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((hookHigh && path[p] > path[extremeIndex]) ||
              (!hookHigh && path[p] < path[extremeIndex])) {
            extremeIndex = p;
          }
        }
        const range = pathMax - pathMin;
        const endNearTarget = Math.abs(path[path.length - 1] - next.k * 100) <= 75;
        const turnsInside = extremeIndex > 0 &&
          extremeIndex < path.length - 2;
        const oneStepIntoTarget = Math.abs(token.k - next.k) === 1;
        const leadingBend = !previousConnected && oneStepIntoTarget &&
          range >= 75 && turnsInside && endNearTarget;

        let connectedHook = false;
        if (previousConnected) {
          const lo = Math.min(previous.k, next.k);
          const hi = Math.max(previous.k, next.k);
          const outside = Math.max(lo - token.k, token.k - hi, 0);
          const neighborSpan = Math.abs(next.k - previous.k);
          const startsAtPrevious = Math.abs(path[0] - previous.k * 100) <= 85;
          const approachesTarget =
            Math.abs(path[path.length - 1] - next.k * 100) + 35 <
            Math.abs(path[0] - next.k * 100);
          connectedHook = outside === 1 && neighborSpan <= 2 &&
            duration <= 0.16 && range >= 70 && turnsInside &&
            startsAtPrevious && approachesTarget;
        }
        if (!leadingBend && !connectedHook) continue;

        suppressedTurns.push({ t0: token.t0, t1: token.t1, k: token.k });
        next.t0 = token.t0;
        next.meendFromPrev = previousConnected;
        tokens.splice(i, 1);
        i--;
      }

      // GAME can split the bottom of one continuous rebound into a separate
      // note (for example G -> [dip to S] -> R). In Clean mode, fold that
      // overshoot into the target only when the robust contour enters from the
      // target side, turns inside the short region, and leaves the extreme
      // again. A flat short note and a G-R-G murki do not match this geometry.
      for (let i = 1; i + 1 < tokens.length; i++) {
        const previous = tokens[i - 1];
        const token = tokens[i];
        const next = tokens[i + 1];
        const path = token._contour || [];
        const nextStrictlyBetween = (
          token.k < next.k && next.k < previous.k
        ) || (
          previous.k < next.k && next.k < token.k
        );
        const connected = token.t0 - previous.t1 <= 0.035 &&
          next.t0 - token.t1 <= 0.035;
        if (!nextStrictlyBetween || !connected ||
            token.t1 - token.t0 > 0.18 || path.length < 5) {
          continue;
        }

        let extreme = path[0], extremeIndex = 0;
        let pathMin = path[0], pathMax = path[0];
        const lowOvershoot = token.k < next.k;
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((lowOvershoot && path[p] < extreme) ||
              (!lowOvershoot && path[p] > extreme)) {
            extreme = path[p];
            extremeIndex = p;
          }
        }
        const entered = Math.abs(path[0] - extreme);
        const recovered = Math.abs(path[path.length - 1] - extreme);
        const excursion = pathMax - pathMin;
        const requiredExcursion = Math.max(
          90,
          Math.abs(next.k - token.k) * 55
        );
        if (extremeIndex > 0 && extremeIndex < path.length - 2 &&
            entered >= 70 && recovered >= 35 &&
            excursion >= requiredExcursion) {
          suppressedTurns.push({
            t0: token.t0,
            t1: token.t1,
            k: token.k,
          });
          next.t0 = token.t0;
          tokens.splice(i, 1);
          i--;
        }
      }

      // A short neural region can also be a pitch crossed during a one-way
      // meend rather than a note the singer landed on. Fold that region into
      // the destination only when its contour travels strongly in the same
      // direction as both neighbours and the frame segmenter found no matching
      // stable note. The geometry remains visible as a bend into the next note.
      for (let i = 1; i + 1 < tokens.length; i++) {
        const previous = tokens[i - 1];
        const token = tokens[i];
        const next = tokens[i + 1];
        const direction = Math.sign(next.k - previous.k);
        const strictlyBetween = direction !== 0 &&
          (token.k - previous.k) * direction > 0 &&
          (next.k - token.k) * direction > 0;
        const connected = token.t0 - previous.t1 <= 0.035 &&
          next.t0 - token.t1 <= 0.035;
        const path = token._contour || [];
        if (!strictlyBetween || !connected ||
            token.t1 - token.t0 > 0.16 || path.length < 5) {
          continue;
        }

        const matchingLanding = frameTokens.some((frameToken) => {
          // GAME and frame f0 can disagree by one semitone when a fast landing
          // sits close to a komal/shuddh boundary. The presence of a stable
          // adjacent plateau still proves this is a note, not a monotonic pass.
          const pitchDistance = Math.abs(frameToken.k - token.k);
          if (pitchDistance > 1 ||
              (pitchDistance === 1 && frameToken.t1 - frameToken.t0 > 0.22)) {
            return false;
          }
          const overlap = Math.min(frameToken.t1, token.t1) -
            Math.max(frameToken.t0, token.t0);
          return overlap >= Math.min(0.04, (token.t1 - token.t0) * 0.35);
        });
        if (matchingLanding) continue;

        let orderedSteps = 0, pathMin = path[0], pathMax = path[0];
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((path[p] - path[p - 1]) * direction >= -18) orderedSteps++;
        }
        const netTravel = (path[path.length - 1] - path[0]) * direction;
        const orderedRatio = orderedSteps / (path.length - 1);
        if (netTravel < 80 || pathMax - pathMin < 90 ||
            orderedRatio < 0.68) {
          continue;
        }

        suppressedTurns.push({
          t0: token.t0,
          t1: token.t1,
          k: token.k,
        });
        next.t0 = token.t0;
        next.meendFromPrev = true;
        tokens.splice(i, 1);
        i--;
      }
    }
    if (clean && f0 && clarity && hopSec > 0) {
      // A compact U-shaped bend can overshoot below Sa/Pa (or above it) for a
      // few frames even though the singer enters and returns through that fixed
      // swara. GAME may isolate only the extreme and label it as a separate
      // note. Keep the invariant Sa/Pa anchor when the extreme has no sustained
      // plateau and the following contour completes the return.
      for (let index = 0; index + 1 < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        const duration = token.t1 - token.t0;
        const direction = Math.sign(next.k - token.k);
        if (duration < 0.055 || duration > 0.12 ||
            direction === 0 || Math.abs(next.k - token.k) < 2 ||
            (Number.isFinite(token.conf) && token.conf < 0.84) ||
            next.t0 - token.t1 > 0.035) {
          continue;
        }

        const lo = Math.min(token.k, next.k);
        const hi = Math.max(token.k, next.k);
        const fixedAnchors = [];
        for (let k = Math.floor((lo - 12) / 12) * 12;
          k <= Math.ceil((hi + 12) / 12) * 12;
          k++) {
          const pc = ((k % 12) + 12) % 12;
          if ((pc === 0 || pc === 7) && k > lo && k < hi) {
            fixedAnchors.push(k);
          }
        }
        if (!fixedAnchors.length) continue;

        const frameStart = Math.max(0, Math.floor(token.t0 / hopSec));
        const frameEnd = Math.min(
          f0.length,
          Math.ceil(Math.min(next.t1, token.t1 + 0.12) / hopSec)
        );
        const path = [];
        for (let frame = frameStart; frame < frameEnd; frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          path.push(1200 * Math.log2(f0[frame] / saHz));
        }
        if (path.length < 8) continue;

        const entryCents = path[0];
        fixedAnchors.sort((a, b) =>
          Math.abs(entryCents - a * 100) -
          Math.abs(entryCents - b * 100)
        );
        const anchorK = fixedAnchors[0];
        const anchorCents = anchorK * 100;
        if (Math.abs(entryCents - anchorCents) > 100) continue;

        let extremeIndex = 0;
        for (let point = 1; point < path.length; point++) {
          if ((direction > 0 && path[point] < path[extremeIndex]) ||
              (direction < 0 && path[point] > path[extremeIndex])) {
            extremeIndex = point;
          }
        }
        const excursion = Math.abs(path[extremeIndex] - anchorCents);
        const returned = path.slice(extremeIndex + 1).some((cents) =>
          Math.abs(cents - anchorCents) <= 85
        );
        let centeredFrames = 0;
        for (let frame = frameStart;
          frame < Math.min(frameEnd, Math.ceil(token.t1 / hopSec));
          frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          const cents = 1200 * Math.log2(f0[frame] / saHz);
          if (Math.abs(cents - token.k * 100) <= 45) centeredFrames++;
        }
        if (extremeIndex === 0 || !returned || excursion < 160 ||
            centeredFrames * hopSec >
              Math.min(0.05, duration * 0.60) + 1e-9) {
          continue;
        }

        suppressedTurns.push({ t0: token.t0, t1: token.t1, k: token.k });
        token.k = anchorK;
        token.cents = anchorCents;
        token.meend = true;
        token.andolan = false;
        token.fixedAnchorBend = true;
      }
    }
    if (clean && frameTokens.length >= 3) {
      // Frame segmentation can read a compact overshoot at a neural boundary
      // as a return murki: R -> [brief G-m-G] where the learned target is G.
      // When the first target touch is brief, the excursion continues in the
      // direction of arrival, and the return dominates, keep the whole shape
      // as a bend into the target rather than inventing the outside swara.
      for (let frameIndex = 1; frameIndex + 1 < frameTokens.length; frameIndex++) {
        const lead = frameTokens[frameIndex - 1];
        const excursion = frameTokens[frameIndex];
        const returned = frameTokens[frameIndex + 1];
        const leadDuration = lead.t1 - lead.t0;
        const excursionDuration = excursion.t1 - excursion.t0;
        const returnDuration = returned.t1 - returned.t0;
        if (lead.k !== returned.k ||
            Math.abs(excursion.k - lead.k) !== 1 ||
            leadDuration > 0.055 ||
            excursionDuration > 0.10 ||
            returnDuration < 0.09 ||
            excursion.t0 - lead.t1 > 0.025 ||
            returned.t0 - excursion.t1 > 0.025) {
          continue;
        }
        const targetIndex = tokens.findIndex((token) =>
          token.k === lead.k &&
          Math.abs(token.t0 - excursion.t0) <= 0.035 &&
          token.t1 >= returned.t0 + 0.08
        );
        if (targetIndex < 1) continue;
        const approach = tokens[targetIndex - 1];
        const target = tokens[targetIndex];
        const arrivalDirection = Math.sign(target.k - approach.k);
        const overshootDirection = Math.sign(excursion.k - target.k);
        if (arrivalDirection === 0 ||
            arrivalDirection !== overshootDirection ||
            target.t0 - approach.t1 > 0.035) {
          continue;
        }
        suppressedTurns.push({
          t0: excursion.t0,
          t1: excursion.t1,
          k: excursion.k,
        });
      }
    }
    if (frameTokens.length) {
      tokens = fuseTurningOrnaments(tokens, frameTokens, suppressedTurns);
    }
    if (ornaments) {
      tokens = fuseRawNeighborTurns(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh,
        suppressedTurns
      );
      tokens = fuseRawMurkiClusters(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh,
        suppressedTurns
      );
    }

    // If a phrase audibly fades onto a new swara, keep the last stable target
    // reached before the tracker follows the dying tail below it. This recovers
    // singer-facing arrivals such as R -> S without labeling every pitch crossed
    // after the voice has already faded away.
    if (clean && f0 && clarity && rms && hopSec > 0) {
      const withFadeLandings = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        const isolatedEnd = !next || next.t0 - token.t1 >= 0.12;
        const frameEnd = Math.min(f0.length, Math.ceil(token.t1 / hopSec));
        const frameStart = Math.max(
          Math.floor(token.t0 / hopSec),
          frameEnd - Math.max(4, Math.round(0.18 / hopSec))
        );
        const runs = [];
        for (let frame = frameStart; frame < frameEnd; frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          const k = Math.round(12 * Math.log2(f0[frame] / saHz));
          const previousRun = runs[runs.length - 1];
          if (previousRun && previousRun.k === k &&
              frame - previousRun.end <= 2) {
            previousRun.end = frame + 1;
          } else {
            runs.push({ k, start: frame, end: frame + 1 });
          }
        }
        // A fade endpoint needs a perceptible landing, not merely two or three
        // quantized frames crossed while the pitch disappears.
        const minLandingFrames = Math.max(3, Math.round(0.055 / hopSec));
        let landing = null;
        for (const run of runs) {
          if (run.k !== token.k && run.end - run.start >= minLandingFrames &&
              run.end >= frameEnd - Math.max(2, Math.round(0.04 / hopSec))) {
            landing = run;
          }
        }

        let recovered = null;
        if (isolatedEnd && landing && Math.abs(landing.k - token.k) <= 4) {
          let beforeLevel = 0, beforeCount = 0, landingLevel = 0, landingCount = 0;
          const beforeStart = Math.max(
            Math.floor(token.t0 / hopSec),
            landing.start - Math.max(3, Math.round(0.12 / hopSec))
          );
          for (let frame = beforeStart; frame < landing.start; frame++) {
            if (Number.isFinite(rms[frame])) {
              beforeLevel += rms[frame];
              beforeCount++;
            }
          }
          for (let frame = landing.start; frame < frameEnd; frame++) {
            if (Number.isFinite(rms[frame])) {
              landingLevel += rms[frame];
              landingCount++;
            }
          }
          beforeLevel = beforeCount ? beforeLevel / beforeCount : 0;
          landingLevel = landingCount ? landingLevel / landingCount : 0;
          const splitTime = landing.start * hopSec;
          if (beforeLevel > 0 && landingLevel <= beforeLevel * 0.62 &&
              splitTime >= token.t0 + 0.04 &&
              token.t1 - splitTime >= minLandingFrames * hopSec) {
            token.t1 = splitTime;
            recovered = {
              t0: splitTime,
              t1: frameEnd * hopSec,
              k: landing.k,
              cents: landing.k * 100,
              meend: false,
              andolan: false,
              meendFromPrev: true,
              neural: true,
              fadeLanding: true,
            };
          }
        }
        withFadeLandings.push(token);
        if (recovered) withFadeLandings.push(recovered);
      }
      tokens = withFadeLandings;
    }
    for (const token of tokens) delete token._contour;
    return { tokens, phrases: groupPhrases(tokens, lineGapSec, clean) };
  }

  /**
   * Build a singer-facing contour from notation tokens. Stable notes sit
   * exactly on their swara targets; only a sustained, continuous traversal of
   * the interval becomes a slide. Analysis keeps the full pitch contour, but
   * the visual guide should not turn vibrato or tracker jitter into instructions.
   */
  function buildPracticeContour(tokens, cents, hopSec, opts) {
    opts = opts || {};
    const maxGapSec = opts.maxGapSec != null ? opts.maxGapSec : 0.04;
    const minSlideSec = opts.minSlideSec != null ? opts.minSlideSec : 0.08;
    const meendSec = opts.meendSec != null ? opts.meendSec : 0.15;
    const source = Array.from(tokens || [])
      .filter((token) => Number.isFinite(token.t0) && token.t1 > token.t0 &&
        Number.isFinite(token.k))
      .sort((a, b) => a.t0 - b.t0);
    if (!source.length) return [];

    const transitions = new Array(Math.max(0, source.length - 1)).fill(null);
    const contour = cents || [];
    const validHop = hopSec > 0 ? hopSec : 0.01;
    const glidePath = (token) => token.glide && Array.isArray(token.via) &&
      token.via.length > 1 ? token.via.filter(Number.isFinite) : [];
    const entryCents = (token) => {
      const path = glidePath(token);
      return Math.round(path.length ? path[0] : token.k) * 100;
    };
    const exitCents = (token) => {
      const path = glidePath(token);
      return Math.round(path.length ? path[path.length - 1] : token.k) * 100;
    };

    for (let index = 0; index + 1 < source.length; index++) {
      const left = source[index];
      const right = source[index + 1];
      const gap = right.t0 - left.t1;
      if (gap > maxGapSec) continue;

      const c0 = exitCents(left);
      const c1 = entryCents(right);
      const boundary = (left.t1 + right.t0) / 2;
      const delta = Math.abs(c1 - c0);
      if (delta < 50) {
        if (gap > 0) {
          transitions[index] = {
            kind: 'hold',
            t0: left.t1,
            t1: right.t0,
            c0,
            c1,
          };
        }
        continue;
      }

      const leftArm = Math.min(0.28, (left.t1 - left.t0) * 0.55);
      // Overshooting bends often settle late inside the destination region.
      // Inspect enough of that region to see the return without spanning more
      // than a compact 280 ms transition.
      const rightArm = Math.min(0.28, (right.t1 - right.t0) * 0.75);
      const searchStart = Math.max(left.t0, boundary - leftArm);
      const searchEnd = Math.min(right.t1, boundary + rightArm);
      const frameStart = Math.max(0, Math.floor(searchStart / validHop));
      const frameEnd = Math.min(contour.length - 1, Math.ceil(searchEnd / validHop));
      const tolerance = Math.min(45, Math.max(25, delta * 0.16));
      const explicitSlide = !!right.meendFromPrev;

      let firstTarget = -1;
      const targetHoldFrames = Math.max(2, Math.round(0.025 / validHop));
      for (let frame = frameStart; frame <= frameEnd; frame++) {
        const value = contour[frame];
        if (!Number.isFinite(value) || Math.abs(value - c1) > tolerance) continue;
        let settled = frame + targetHoldFrames - 1 <= frameEnd;
        for (let lookahead = 1; settled && lookahead < targetHoldFrames; lookahead++) {
          const next = contour[frame + lookahead];
          settled = Number.isFinite(next) &&
            Math.abs(next - c1) <= tolerance * 1.35;
        }
        if (settled) {
          firstTarget = frame;
          break;
        }
      }

      let lastSource = -1;
      if (firstTarget >= 0) {
        for (let frame = frameStart; frame < firstTarget; frame++) {
          const value = contour[frame];
          if (Number.isFinite(value) && Math.abs(value - c0) <= tolerance) {
            lastSource = frame;
          }
        }
      }

      let detectedSlide = false;
      let detectedMeend = false;
      if (lastSource >= 0 && firstTarget > lastSource) {
        const duration = (firstTarget - lastSource) * validHop;
        let intermediate = 0;
        let ordered = 0;
        let comparisons = 0;
        let maxMissing = 0;
        let missing = 0;
        let previous = null;
        const direction = Math.sign(c1 - c0);
        for (let frame = lastSource; frame <= firstTarget; frame++) {
          const value = contour[frame];
          if (!Number.isFinite(value)) {
            missing++;
            maxMissing = Math.max(maxMissing, missing);
            continue;
          }
          missing = 0;
          const progress = (value - c0) / (c1 - c0);
          if (progress > 0.12 && progress < 0.88) intermediate++;
          if (previous != null) {
            comparisons++;
            if (direction * (value - previous) >= -20) ordered++;
          }
          previous = value;
        }
        const orderedRatio = comparisons ? ordered / comparisons : 1;
        const enoughIntermediate = intermediate >= Math.max(
          2,
          Math.round((firstTarget - lastSource) * 0.2)
        );
        const continuous = maxMissing * validHop <= 0.05;
        detectedMeend = duration >= minSlideSec && enoughIntermediate &&
          continuous && orderedRatio >= 0.65;
        // A short sung bend often overshoots and returns, so it is not strictly
        // monotonic. It still needs a continuous traversal through intermediate
        // pitch frames; an abrupt note change has none and remains a clear step.
        const detectedBend = duration >= Math.max(0.055, minSlideSec * 0.65) &&
          enoughIntermediate && continuous;
        detectedSlide = detectedMeend || detectedBend;
      }
      if (!detectedSlide &&
          (left.meend || right.meend ||
            left.hybridOrnament || right.hybridOrnament)) {
        let intermediate = 0, missing = 0, maxMissing = 0, voicedFrames = 0;
        for (let frame = frameStart; frame <= frameEnd; frame++) {
          const value = contour[frame];
          if (!Number.isFinite(value)) {
            missing++;
            maxMissing = Math.max(maxMissing, missing);
            continue;
          }
          missing = 0;
          voicedFrames++;
          const progress = (value - c0) / (c1 - c0);
          if (progress > 0.1 && progress < 0.9) intermediate++;
        }
        // Fast ornament regions may be too short to hold the destination for
        // the normal 25 ms landing test. Their neural/frame gesture flags are
        // still allowed to request a compact bend when the contour visibly
        // traverses the interval and contains no real vocal pause.
        detectedSlide = voicedFrames >= 4 && intermediate >= 2 &&
          maxMissing * validHop <= 0.05;
      }

      if (explicitSlide || detectedSlide) {
        let t0 = lastSource >= 0 ? lastSource * validHop : boundary - Math.min(0.12, leftArm);
        let t1 = firstTarget >= 0 ? firstTarget * validHop : boundary + Math.min(0.12, rightArm);
        t0 = Math.max(left.t0, Math.min(boundary, t0));
        t1 = Math.min(right.t1, Math.max(boundary, t1));
        if (t1 - t0 < minSlideSec) {
          const half = Math.min(0.12, leftArm, rightArm);
          t0 = Math.max(left.t0, boundary - half);
          t1 = Math.min(right.t1, boundary + half);
        }
        transitions[index] = {
          kind: 'slide',
          curve: explicitSlide ||
            (detectedMeend && t1 - t0 >= meendSec) ? 'meend' : 'bend',
          t0,
          t1,
          c0,
          c1,
        };
      } else {
        transitions[index] = {
          kind: 'step',
          t0: boundary,
          t1: boundary,
          c0,
          c1,
        };
      }
    }

    // Bends around a fast ornament can consume most of the note target between
    // them. Plateau-confirmed hybrid notes are analysis landmarks, not merely
    // transition geometry, so reserve a readable flat landing even when the
    // curves do not technically overlap. Ordinary bends keep the smaller
    // overlap-only reservation.
    for (let index = 1; index + 1 < source.length; index++) {
      const previous = transitions[index - 1];
      const next = transitions[index];
      const token = source[index];
      const duration = token.t1 - token.t0;
      const left = source[index - 1];
      const right = source[index + 1];
      const connected = token.t0 - left.t1 <= maxGapSec &&
        right.t0 - token.t1 <= maxGapSec;
      const distinctTarget = token.k !== left.k && token.k !== right.k;
      const confirmedFastTarget = connected && distinctTarget &&
        duration <= 0.24 &&
        !!(token.hybridOrnament || token.rawLandmark || token.murki);
      const hasTwoSlides = previous && next &&
        previous.kind === 'slide' && next.kind === 'slide';
      const overlappingSlides = hasTwoSlides && previous.t1 > next.t0;
      if (!confirmedFastTarget && !overlappingSlides) continue;

      const hold = confirmedFastTarget
        ? Math.min(duration * 0.72, Math.max(0.06, duration * 0.55))
        : Math.min(0.035, duration * 0.35);
      const center = (token.t0 + token.t1) / 2;
      const holdStart = Math.max(token.t0, center - hold / 2);
      const holdEnd = Math.min(token.t1, center + hold / 2);
      if (previous && previous.kind === 'slide') {
        previous.t1 = Math.max(previous.t0, Math.min(previous.t1, holdStart));
      }
      if (next && next.kind === 'slide') {
        next.t0 = Math.min(next.t1, Math.max(next.t0, holdEnd));
      }
    }

    const segments = [];
    for (let index = 0; index < source.length; index++) {
      const token = source[index];
      const previous = transitions[index - 1];
      const next = transitions[index];
      let t0 = token.t0;
      let t1 = token.t1;
      if (previous) {
        if (previous.kind === 'slide') t0 = Math.max(t0, previous.t1);
        else if (previous.kind === 'step') t0 = Math.max(t0, previous.t0);
      }
      if (next) {
        if (next.kind === 'slide') t1 = Math.min(t1, next.t0);
        else if (next.kind === 'step') t1 = Math.min(t1, next.t0);
      }
      if (t1 < t0) {
        const midpoint = (t0 + t1) / 2;
        t0 = midpoint;
        t1 = midpoint;
      }
      const path = glidePath(token);
      const continuousPath = path.length > 1 && path.every((k, pathIndex) =>
        pathIndex === 0 || Math.abs(k - path[pathIndex - 1]) <= 1);
      if (path.length > 1 && !continuousPath) {
        // A collapsed "glide" that skips directly between swaras is usually a
        // scale or articulated run whose vibrato confused the glide detector.
        // Restore its targets as a readable staircase instead of drawing one
        // broad diagonal across several notes.
        const slot = (t1 - t0) / path.length;
        for (let pathIndex = 0; pathIndex < path.length; pathIndex++) {
          const target = Math.round(path[pathIndex]) * 100;
          const holdStart = t0 + slot * pathIndex;
          const holdEnd = t0 + slot * (pathIndex + 1);
          segments.push({
            kind: 'hold',
            t0: holdStart,
            t1: holdEnd,
            c0: target,
            c1: target,
            tokenIndex: index,
          });
          if (pathIndex + 1 < path.length) {
            const nextTarget = Math.round(path[pathIndex + 1]) * 100;
            segments.push({
              kind: 'step',
              t0: holdEnd,
              t1: holdEnd,
              c0: target,
              c1: nextTarget,
              tokenIndex: index,
            });
          }
        }
      } else {
        segments.push({
          kind: path.length > 1 ? 'slide' : 'hold',
          ...(path.length > 1 ? { curve: 'meend' } : {}),
          t0,
          t1,
          c0: entryCents(token),
          c1: exitCents(token),
          tokenIndex: index,
        });
      }
      if (next) segments.push({ ...next, tokenIndex: index });
    }
    return segments;
  }

  /** Keep a glide's endpoints plus the in-scale swaras it passes through, so a
   *  smooth meend reads as its raga notes, not every chromatic step. */
  function viaPath(via, scaleSet) {
    if (!scaleSet || via.length <= 2) return via;
    return via.filter((k, i) => i === 0 || i === via.length - 1 || scaleSet.has(((k % 12) + 12) % 12));
  }

  /** Full token text incl. ornaments: (R)G kan, (RGR)G murki, ≈G andolan,
   *  G(R) grace, and a meend glide as S⌒R⌒G⌒m⌒P (every swara it touches).
   *  Pass a scaleSet (pitch classes) to trim a glide to in-scale swaras. */
  function tokenFullText(tk, scaleSet) {
    if (tk.glide && tk.via && tk.via.length > 1) {
      return viaPath(tk.via, scaleSet).map((k) => tokenText(k, false)).join('⌒');
    }
    let t = tokenText(tk.k, tk.meend);
    if (tk.andolan) {
      t = '≈' + t;
      // Show the neighbour swaras a wide andolan swings between, e.g. ≈g(R–g).
      if (tk.andolanLo != null && (tk.andolanHi > tk.k || tk.andolanLo < tk.k)) {
        t += '(' + tokenText(tk.andolanLo, false) + '–' + tokenText(tk.andolanHi, false) + ')';
      }
    }
    const pre = tk.kan || tk.murki;
    if (pre) t = '(' + pre.map((k) => tokenText(k, false)).join('') + ')' + t;
    if (tk.graceAfter) t += '(' + tk.graceAfter.map((k) => tokenText(k, false)).join('') + ')';
    return t;
  }

  /** Render notation as numbered lines of plain text, with ~0.3 s sustain
   * dashes, X~Y meend connectors and blank lines between sections. */
  function notationText(phrases, scaleSet) {
    const lines = [];
    phrases.forEach((ph, idx) => {
      const mm = Math.floor(ph.t0 / 60);
      const ss = Math.floor(ph.t0 % 60).toString().padStart(2, '0');
      const parts = [];
      for (const tk of ph.tokens) {
        let body = tokenFullText(tk, scaleSet);
        const sustained = Math.min(12, Math.max(0, Math.round((tk.t1 - tk.t0 - 0.35) / 0.3)));
        for (let d2 = 0; d2 < sustained; d2++) body += ' –';
        if (tk.meendFromPrev && parts.length) {
          // Show the swaras the glide passes through, not just the endpoints.
          const v = tk.via ? viaPath(tk.via, scaleSet) : [];
          const mid = v.length > 2 ? v.slice(1, -1).map((k) => tokenText(k, false)).join('⌒') + '⌒' : '';
          parts[parts.length - 1] += '⌒' + mid + body;
        } else parts.push(body);
      }
      if (ph.section && lines.length) lines.push('');
      lines.push(String(idx + 1).padStart(2) + '. [' + mm + ':' + ss + ']  ' + parts.join('  '));
    });
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- *
   * Raga analysis: from the transcribed notes, distil the grammar a
   * learner writes down — the swar-set (which swaras, with emphasis and
   * intonation), the thaat (scale family), aaroh/avaroh, vadi/samvadi,
   * nyas (resting notes) and jati. All from existing token data; nothing
   * here asserts a definitive raga (thaat ≠ raga, intonation is fluid).
   * ---------------------------------------------------------------- */

  // The 10 thaats as pitch-class sets relative to Sa.
  const THAATS = [
    { name: 'Bilawal', set: [0, 2, 4, 5, 7, 9, 11] },
    { name: 'Kalyan', set: [0, 2, 4, 6, 7, 9, 11] },
    { name: 'Khamaj', set: [0, 2, 4, 5, 7, 9, 10] },
    { name: 'Kafi', set: [0, 2, 3, 5, 7, 9, 10] },
    { name: 'Asavari', set: [0, 2, 3, 5, 7, 8, 10] },
    { name: 'Bhairavi', set: [0, 1, 3, 5, 7, 8, 10] },
    { name: 'Bhairav', set: [0, 1, 4, 5, 7, 8, 11] },
    { name: 'Purvi', set: [0, 1, 4, 6, 7, 8, 11] },
    { name: 'Marwa', set: [0, 1, 4, 6, 7, 9, 11] },
    { name: 'Todi', set: [0, 1, 3, 6, 7, 8, 11] },
  ];

  const pcOf = (k) => ((k % 12) + 12) % 12;

  function analyzeRaga(tokens, phrases) {
    const wt = new Float64Array(12);          // duration weight per pitch class
    const devSum = new Float64Array(12);      // cents deviation accumulation
    const devW = new Float64Array(12);
    let total = 0;
    for (const t of tokens) {
      const d = Math.max(0.001, t.t1 - t.t0);
      const pc = pcOf(t.k);
      wt[pc] += d; total += d;
      if (typeof t.cents === 'number') { devSum[pc] += (t.cents - t.k * 100) * d; devW[pc] += d; }
    }
    if (total <= 0) return null;

    // Swaras actually used (≥3% of sung time), with emphasis + intonation.
    const swaras = [];
    for (let pc = 0; pc < 12; pc++) {
      const share = wt[pc] / total;
      if (share >= 0.03 || pc === 0) {
        const info = swaraInfo(pc);
        swaras.push({
          pc, letter: info.letter, komal: info.komal, tivra: info.tivra,
          weight: share,
          devCents: devW[pc] > 0 ? Math.round(devSum[pc] / devW[pc]) : 0,
        });
      }
    }
    const used = new Set(swaras.map((s) => s.pc));

    // Thaat: the family that best covers the used swaras. Out-of-thaat notes
    // (by weight) penalise; among clean covers, prefer the tightest fit.
    let best = null;
    for (const th of THAATS) {
      const tset = new Set(th.set);
      let outW = 0, coverW = 0, missing = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (used.has(pc) && !tset.has(pc)) outW += wt[pc] / total;
        if (tset.has(pc) && used.has(pc)) coverW += wt[pc] / total;
      }
      for (const pc of th.set) if (!used.has(pc)) missing++;
      const score = coverW - 2.2 * outW - 0.02 * missing;
      if (!best || score > best.score) best = { name: th.name, score, outW, missing };
    }
    const thaat = best ? {
      name: best.name,
      // Confident when nothing sits outside the family and most of it is used.
      confidence: Math.max(0, Math.min(1, 1 - best.outW * 3 - best.missing * 0.12)),
      mixed: best.outW > 0.04,
    } : null;

    // Aaroh / avaroh: which swaras appear in ascending vs descending motion.
    const upSet = new Set(), downSet = new Set();
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].t0 - tokens[i - 1].t1 > 1.0) continue; // not a connected move
      const a = tokens[i - 1].k, b = tokens[i].k;
      if (b > a) { upSet.add(pcOf(a)); upSet.add(pcOf(b)); }
      else if (b < a) { downSet.add(pcOf(a)); downSet.add(pcOf(b)); }
    }
    const ascOrder = (set) => Array.from(set).sort((x, y) => x - y);
    const aaroh = ascOrder(upSet), avaroh = ascOrder(downSet);

    // Vadi / samvadi: most-dwelt swaras. Sa is the ground note, not the vadi by
    // convention, so prefer a non-Sa swara as vadi (fall back to Sa only if
    // nothing else carries weight).
    const byAll = swaras.slice().sort((a, b) => b.weight - a.weight);
    const byW = byAll.filter((s) => s.pc !== 0);
    if (!byW.length) byW.push(...byAll);
    const vadi = byW.length ? byW[0].pc : null;
    let samvadi = null;
    if (vadi != null) {
      for (const s of byW.slice(1)) {
        const iv = ((s.pc - vadi) % 12 + 12) % 12;
        if (iv === 5 || iv === 7) { samvadi = s.pc; break; }
      }
      if (samvadi == null && byW.length > 1) samvadi = byW[1].pc;
    }

    // Nyas (resting notes): pitch classes that phrases resolve onto, plus the
    // longest-held notes.
    const restW = new Float64Array(12);
    if (phrases) {
      for (const ph of phrases) {
        const last = ph.tokens[ph.tokens.length - 1];
        if (last) restW[pcOf(last.k)] += (last.t1 - last.t0) + 0.3;
      }
    }
    const durs = tokens.map((t) => t.t1 - t.t0).sort((a, b) => a - b);
    const longThresh = durs.length ? durs[Math.floor(durs.length * 0.8)] : 0;
    for (const t of tokens) if ((t.t1 - t.t0) >= longThresh) restW[pcOf(t.k)] += (t.t1 - t.t0);
    const nyas = Array.from({ length: 12 }, (_, pc) => pc)
      .filter((pc) => used.has(pc) && restW[pc] > 0)
      .sort((a, b) => restW[b] - restW[a]).slice(0, 4)
      .sort((a, b) => a - b);

    const jatiName = (n) => (n <= 5 ? 'audav' : n === 6 ? 'shadav' : 'sampurna');
    const jati = aaroh.length && avaroh.length
      ? `${jatiName(aaroh.length)}–${jatiName(avaroh.length)}` : null;

    // Ordered pitch-class sequence (octave-agnostic) for pakad/phrase matching.
    const seq = tokens.map((t) => pcOf(t.k));

    return { swaras, thaat, aaroh, avaroh, vadi, samvadi, nyas, jati, seq, total };
  }

  /* ---------------------------------------------------------------- *
   * Melody synthesis: a warm sine following the f0 track, for ear-
   * checking the transcription and practicing along.
   * ---------------------------------------------------------------- */

  function synthesize(f0, clarity, hopSec, sr) {
    const hop = Math.round(hopSec * sr);
    const len = f0.length * hop;
    const out = new Float32Array(len);
    if (!len) return out;
    const attack = 1 - Math.exp(-1 / (0.012 * sr));
    const release = 1 - Math.exp(-1 / (0.05 * sr));
    let phase = 0, amp = 0, lastF = 0;
    for (let i = 0; i < len; i++) {
      const fi = i / hop;
      const i0 = Math.min(f0.length - 1, Math.floor(fi));
      const i1 = Math.min(f0.length - 1, i0 + 1);
      const frac = fi - i0;
      const fA = f0[i0], fB = f0[i1];
      let target = 0, f = lastF;
      if (fA > 0 && clarity[i0] > 0.45) {
        target = Math.min(1, 0.35 + clarity[i0]);
        f = fB > 0 ? fA * Math.pow(fB / fA, frac) : fA;
        lastF = f;
      }
      amp += (target - amp) * (target > amp ? attack : release);
      if (f > 0 && amp > 1e-4) {
        phase += 2 * Math.PI * f / sr;
        if (phase > 1e8) phase %= 2 * Math.PI;
        out[i] = amp * 0.6 * (Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase));
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    if (peak > 0.85) {
      const g = 0.85 / peak;
      for (let i = 0; i < len; i++) out[i] *= g;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Pitch shifting (phase vocoder): transpose audio by N semitones
   * while keeping the duration, so a learner can practise the same
   * song in their own Sa. shift = time-stretch by r, then resample by
   * r. Tempo is untouched (independent of the playbackRate control).
   * Mono in, mono out.
   * ---------------------------------------------------------------- */

  const princarg = (p) => p - 2 * Math.PI * Math.round(p / (2 * Math.PI));

  /** Phase-vocoder time-stretch by factor s (s>1 = longer/slower). */
  function timeStretch(x, s, progress) {
    if (Math.abs(s - 1) < 1e-4) return new Float32Array(x);
    const N = 2048, Ha = 512, H = N / 2;
    const Hs = Math.max(1, Math.round(Ha * s));
    const nFrames = x.length >= N ? Math.floor((x.length - N) / Ha) + 1 : 0;
    if (nFrames <= 0) return new Float32Array(x);
    const outLen = (nFrames - 1) * Hs + N;
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const mag = new Float32Array(H + 1), phi = new Float32Array(H + 1);
    const prevPhi = new Float32Array(H + 1), sumPhi = new Float32Array(H + 1);
    const synPhi = new Float32Array(H + 1);
    const omega = new Float32Array(H + 1);
    for (let k = 0; k <= H; k++) omega[k] = 2 * Math.PI * Ha * k / N;
    const ratio = Hs / Ha;
    const peaks = [];

    for (let m = 0; m < nFrames; m++) {
      const off = m * Ha;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k <= H; k++) {
        const r = re[k], iq = im[k];
        mag[k] = Math.sqrt(r * r + iq * iq);
        phi[k] = Math.atan2(iq, r);
      }
      if (m === 0) {
        for (let k = 0; k <= H; k++) { sumPhi[k] = phi[k]; prevPhi[k] = phi[k]; synPhi[k] = phi[k]; }
      } else {
        // Standard phase-vocoder phase propagation (free-running accumulator).
        for (let k = 0; k <= H; k++) {
          const dphi = princarg(phi[k] - prevPhi[k] - omega[k]);
          sumPhi[k] += (omega[k] + dphi) * ratio;
          prevPhi[k] = phi[k];
        }
        // Identity phase locking (Laroche & Dolson 1999): without it every bin's
        // phase drifts independently, so the harmonics of the voice lose their
        // relative alignment — the hollow, reverberant "phasiness" that makes a
        // shifted voice sound robotic/zombie-like. Lock each bin to its nearest
        // spectral peak: reuse the peak's propagated phase plus the bin's
        // ORIGINAL offset from that peak, keeping each harmonic group coherent.
        peaks.length = 0;
        for (let k = 2; k < H - 1; k++) {
          const mk = mag[k];
          if (mk > mag[k - 1] && mk >= mag[k + 1] && mk > mag[k - 2] && mk >= mag[k + 2]) peaks.push(k);
        }
        if (peaks.length === 0) {
          for (let k = 0; k <= H; k++) synPhi[k] = sumPhi[k];
        } else {
          let pi = 0;
          for (let k = 0; k <= H; k++) {
            while (pi < peaks.length - 1 && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
            const p = peaks[pi];
            synPhi[k] = sumPhi[p] + (phi[k] - phi[p]);
          }
        }
      }
      for (let k = 0; k <= H; k++) {
        re[k] = mag[k] * Math.cos(synPhi[k]);
        im[k] = mag[k] * Math.sin(synPhi[k]);
      }
      for (let k = 1; k < H; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      im[0] = 0; im[H] = 0;
      fft(re, im, true);
      const so = m * Hs;
      for (let i = 0; i < N; i++) {
        out[so + i] += re[i] * win[i];
        norm[so + i] += win[i] * win[i];
      }
      if (progress && (m & 511) === 0) progress(m / nFrames);
    }
    for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
    return out;
  }

  /** Linear resample so the output plays `ratio`x faster (ratio>1 = shorter/higher). */
  function resampleLinear(x, ratio) {
    if (Math.abs(ratio - 1) < 1e-6) return new Float32Array(x);
    const outLen = Math.max(1, Math.round(x.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), fr = pos - i0;
      const a = x[i0] || 0, b = x[i0 + 1] || 0;
      out[i] = a + (b - a) * fr;
    }
    return out;
  }

  /** Transpose by `semitones`, preserving duration. */
  /* Re-impose the ORIGINAL spectral envelope (the formants — what makes a voice
   * sound like itself) onto the pitch-shifted signal, so only the pitch moves
   * and the timbre stays natural (no "chipmunk"/"monster"). Per STFT frame:
   * estimate the original's smooth envelope via cepstral liftering, then scale
   * the shifted spectrum by env(f)/env(f/r) — which undoes the envelope
   * (formant) scaling that the resample-based shift introduced. */
  function formantCorrect(orig, shifted, sr, r, progress, qOverride) {
    const N = 1024, H = 256, Nh = N >> 1, nBins = Nh + 1;
    const len = Math.min(orig.length, shifted.length);
    const nFrames = len >= N ? Math.floor((len - N) / H) + 1 : 0;
    if (nFrames <= 0) return shifted;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    // Cepstral lifter cutoff: high enough to capture the FORMANT PEAKS (so the
    // gain can relocate them), but below the pitch-period quefrency so harmonics
    // aren't baked into the envelope. ≈ sr/(2·f0_max≈350).
    // Cepstral lifter cutoff: must stay BELOW the harmonic-spacing quefrency
    // (≈sr/f0) or the "envelope" captures harmonics and the correction re-imposes
    // the original pitch (undoing the shift). ~sr/700 captures formants at music
    // rates (~63 @44.1k) while staying safely below harmonics; a low floor keeps
    // low-sample-rate signals safe too.
    const Q = qOverride || Math.max(12, Math.min(90, Math.round(sr / 700)));
    const reO = new Float32Array(N), imO = new Float32Array(N);
    const reS = new Float32Array(N), imS = new Float32Array(N);
    const env = new Float32Array(nBins);
    const out = new Float32Array(shifted.length), norm = new Float32Array(shifted.length);
    for (let f = 0; f < nFrames; f++) {
      const off = f * H;
      // --- original frame → cepstral spectral envelope ---
      for (let i = 0; i < N; i++) { reO[i] = (orig[off + i] || 0) * win[i]; imO[i] = 0; }
      fft(reO, imO, false);
      for (let k = 0; k <= Nh; k++) reO[k] = Math.log(Math.hypot(reO[k], imO[k]) + 1e-6);
      for (let k = 1; k < Nh; k++) reO[N - k] = reO[k];
      for (let i = 0; i < N; i++) imO[i] = 0;
      fft(reO, imO, true);                                // real cepstrum in reO
      for (let q = Q + 1; q < N - Q; q++) reO[q] = 0;     // lifter: keep low quefrency (envelope)
      for (let i = 0; i < N; i++) imO[i] = 0;
      fft(reO, imO, false);                               // smoothed log-spectrum
      for (let k = 0; k <= Nh; k++) env[k] = Math.exp(reO[k]);
      // --- shifted frame → scale by env(f)/env(f/r), resynthesize ---
      for (let i = 0; i < N; i++) { reS[i] = (shifted[off + i] || 0) * win[i]; imS[i] = 0; }
      fft(reS, imS, false);
      for (let k = 0; k <= Nh; k++) {
        const idx = k / r;
        let e2;
        if (idx <= 0) e2 = env[0];
        else if (idx >= Nh) e2 = env[Nh];
        else { const i0 = idx | 0, fr = idx - i0; e2 = env[i0] * (1 - fr) + env[i0 + 1] * fr; }
        let g = e2 > 1e-9 ? env[k] / e2 : 1;
        if (g < 0.3) g = 0.3; else if (g > 3.3) g = 3.3;
        reS[k] *= g; imS[k] *= g;
      }
      for (let k = 1; k < Nh; k++) { reS[N - k] = reS[k]; imS[N - k] = -imS[k]; }
      imS[0] = 0; imS[Nh] = 0;
      fft(reS, imS, true);
      for (let i = 0; i < N; i++) { out[off + i] += reS[i] * win[i]; norm[off + i] += win[i] * win[i]; }
      if (progress && (f & 255) === 0) progress(f / nFrames);
    }
    for (let i = 0; i < out.length; i++) {
      let v = norm[i] > 1e-6 ? out[i] / norm[i] : shifted[i];
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;   // clamp (guards the timeStretch edge spike)
    }
    return out;
  }

  function pitchShift(x, sr, semitones, progress) {
    if (!semitones) return new Float32Array(x);
    const r = Math.pow(2, semitones / 12);
    const stretched = timeStretch(x, r, progress ? (f) => progress(0.6 * f) : null); // longer by r, same pitch
    const shifted = resampleLinear(stretched, r);    // faster by r -> duration restored, pitch x r
    // keep the singer's natural timbre instead of chipmunk/monster
    return formantCorrect(x, shifted, sr, r, progress ? (f) => progress(0.6 + 0.4 * f) : null);
  }

  return {
    preFilter, hpssHarmonic, yinTrack, stabilizeOctave, detectOnsets, detectTonic, notate, notateRegions, buildPracticeContour, notationText, analyzeRaga,
    swaraInfo, tokenText, tokenFullText, synthesize, percentile,
    pitchShift, timeStretch, resampleLinear, formantCorrect,
    SWARA_LETTERS,
    _internal: { biquadCoefs, applyBiquad, viterbiSelect, postProcess, VIT, YIN, isMeendChain },
  };
}));
