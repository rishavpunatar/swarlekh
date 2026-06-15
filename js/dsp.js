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
    const minIOI = Math.max(2, Math.round(0.12 * fps));   // notes ≥ ~120 ms apart
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
    let runStart = -1, nPhrases = 0;
    const N = f0.length;
    for (let i = 0; i <= N; i++) {
      const v = i < N && f0[i] > 0 && clarity[i] >= 0.5;
      if (v && runStart < 0) runStart = i;
      if (!v && runStart >= 0) {
        if (i - runStart >= minRun) {
          addCad(medPc(runStart, Math.min(i, runStart + edge)), 1.0);          // phrase onset
          addCad(medPc(Math.max(runStart, i - edge), i), 1.4);                 // phrase resolution
          nPhrases++;
        }
        runStart = -1;
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

    // Score each candidate Sa. Terms (all normalized to [0,1]):
    //   + self      : the tonic is itself prominent (drone + dwelling)
    //   + fifth     : a strong Pa sits +702c above a true Sa
    //   + cadence   : phrases start/resolve here  (breaks Sa/Pa symmetry)
    //   - asPa      : a strong note +498c above means *we* are likely its Pa
    // No credit for the fourth-above (the old bug: it let Pa borrow Sa).
    for (const p of peaks) {
      const self = at(p.pc) / maxH;
      const fifth = at(p.pc + 702) / maxH;
      const asPa = at(p.pc + 498) / maxH;
      p.score = 0.50 * self + 0.42 * fifth + 1.30 * cadConf * cadAt(p.pc) - 0.30 * Math.min(asPa, 1.2 * self);
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
      if (placed.length > 1 && placed[1].score >= 0.85) placed[0].uncertain = true;
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
  function absorbOscillations(runs, stableFrames) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        const k0 = runs[i].k;
        let j = i, nExc = 0;
        while (j < runs.length) {
          const r = runs[j];
          if (r.k === k0) { j++; continue; }
          if (Math.abs(r.k - k0) <= 1 && (r.end - r.start) < stableFrames) { nExc++; j++; continue; }
          break;
        }
        // Collapse only a genuinely fast oscillation (andolan/gamak): the ±1
        // touches must recur often enough across the span (≳2 per second, i.e.
        // ~0.035 per 16 ms frame). A held swara with a couple of sparse grace
        // touches has a low excursion rate — leave those touches as their own
        // notes so they stay visible. (A slower continuous swing is still folded
        // downstream by collapseAndolan from the token stream, where over-
        // collapsing here would have destroyed the touches irreversibly.)
        const spanFrames = j > i ? runs[j - 1].end - runs[i].start : 0;
        if (nExc >= 2 && j - i >= 4 && spanFrames > 0 && nExc / spanFrames >= 0.035) {
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
  function analyzeToken(cents, start, end) {
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
    const durSec = (end - start) * 0.016;            // hopSec is 16 ms
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
      for (const t of onsetT) { if (t > a + 0.04 && t < b - 0.001) return true; if (t >= b) break; }
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

    const makeToken = (r) => {
      const a = analyzeToken(cents, r.start, r.end);
      const tk = {
        t0: r.start * hopSec, t1: r.end * hopSec, k: r.k,
        cents: a.mean, meend: a.meend, andolan: a.andolan,
      };
      if (a.andolan) { tk.andolanLo = a.andolanLo; tk.andolanHi = a.andolanHi; }
      return tk;
    };
    const ornOf = (r, type) => ({ k: r.k, t0: r.start * hopSec, t1: r.end * hopSec, type });

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
        if (ornaments) absorbOscillations(runs, stableFrames);
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
                for (const r of pending) tokens.push(makeToken(r));   // each note, distinct
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

    /* Clean mode: keep only confident, singable notes.
     * Drops weak/short blips and glitch jumps, snaps rare off-scale notes
     * onto the song's scale, and merges a swara re-struck across a breath. */
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
      // 3. Snap rare off-scale short notes onto the song's scale.
      const classDur = new Float64Array(12);
      let total = 0;
      for (const tk of out) {
        const d = tk.t1 - tk.t0;
        classDur[((tk.k % 12) + 12) % 12] += d;
        total += d;
      }
      if (total > 0) {
        const order = Array.from({ length: 12 }, (_, i) => i).sort((a, b) => classDur[b] - classDur[a]);
        const scale = new Set();
        let acc = 0;
        for (const pc of order) {
          if (classDur[pc] <= 0) break;
          if (acc / total >= 0.9 && scale.size >= 5) break;
          scale.add(pc);
          acc += classDur[pc];
        }
        for (const tk of out) {
          if (tk.glide || tk.andolan) continue;   // gestures are already resolved
          const pc = ((tk.k % 12) + 12) % 12;
          if (scale.has(pc) || (tk.t1 - tk.t0) >= 0.3) continue;
          const rare = classDur[pc] / total < 0.02 || classDur[pc] < 0.6;
          if (!rare) continue;
          const cands = [];
          if (scale.has((pc + 1) % 12)) cands.push(tk.k + 1);
          if (scale.has((pc + 11) % 12)) cands.push(tk.k - 1);
          if (cands.length) {
            cands.sort((a, b) => Math.abs(tk.cents - a * 100) - Math.abs(tk.cents - b * 100));
            tk.k = cands[0];
          }
        }
      }
      // 4. A held note re-struck on syllables/breaths reads as ONE note:
      // collapse consecutive repeats of the same swara within a line. In the
      // pure clean preset (no ornaments) merge across wider gaps and drop
      // wobble marks — a hold with natural drift is just a hold.
      const holdGap = ornaments ? 0.3 : 0.75;
      const merged = [];
      for (const tk of out) {
        if (!ornaments) { tk.meend = false; tk.andolan = false; }
        const last = merged[merged.length - 1];
        // A re-articulation (onset) between two same-pitch notes means a new
        // syllable — keep them separate so every vocalised start is a note.
        if (last && !last.glide && !tk.glide && !last.andolan && !tk.andolan && last.k === tk.k && tk.t0 - last.t1 < holdGap && !onsetBetween(last.t1, tk.t0)) {
          last.t1 = tk.t1;
          last.meend = last.meend || tk.meend;
          last.andolan = last.andolan || tk.andolan;
          if (tk.orn) last.orn = (last.orn || []).concat(tk.orn);
          if (tk.graceAfter) last.graceAfter = tk.graceAfter;
        } else merged.push(tk);
      }
      // 5. Clear meend connectors whose left side was dropped.
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
        // Only split where each resulting piece is a real, singable length
        // (≥0.18 s) — avoids shaving a held note into spurious repeats.
        const cuts = [];
        let prevCut = tk.t0;
        for (const t of onsetT) {
          if (t > prevCut + 0.18 && t < tk.t1 - 0.18) { cuts.push(t); prevCut = t; }
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

    // Lines: split where the singer pauses >= lineGapSec.
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
    // Section breaks at long gaps (interludes, verse boundaries).
    let prevEnd = 0;
    for (const ph of phrases) {
      ph.section = ph.t0 - prevEnd >= 4;
      prevEnd = ph.t1;
    }
    return { tokens, phrases };
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
    preFilter, hpssHarmonic, yinTrack, stabilizeOctave, detectOnsets, detectTonic, notate, notationText, analyzeRaga,
    swaraInfo, tokenText, tokenFullText, synthesize, percentile,
    pitchShift, timeStretch, resampleLinear, formantCorrect,
    SWARA_LETTERS,
    _internal: { biquadCoefs, applyBiquad, viterbiSelect, postProcess, VIT, YIN, isMeendChain },
  };
}));
