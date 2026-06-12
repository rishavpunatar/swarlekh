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
   * Fast YIN: difference function via FFT cross-correlation, CMNDF,
   * multiple candidates per frame, then Viterbi over candidates for a
   * smooth melody line with an explicit unvoiced state.
   * ---------------------------------------------------------------- */

  const YIN = {
    W: 512,          // comparison window (32 ms @ 16 kHz)
    fmin: 80,
    fmax: 800,
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
      let tFirst = 0;
      for (let t = tauMin + 1; t < tauMax; t++) {
        if (c[t] < c[t - 1] && c[t] <= c[t + 1] && c[t] < YIN.candThresh) {
          const y0 = c[t - 1], y1 = c[t], y2 = c[t + 1];
          const denom = y0 - 2 * y1 + y2;
          let delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
          if (delta > 1) delta = 1; else if (delta < -1) delta = -1;
          const tau = t + delta;
          const cval = Math.max(0, y1 - 0.25 * (y0 - y2) * delta);
          if (!tFirst && cval < YIN.firstThresh) tFirst = tau;
          cands.push({ tau, cval, pen: 0 });
          // Skip ahead past this dip's immediate neighborhood.
          while (t + 1 < tauMax && c[t + 1] <= c[t]) t++;
        }
      }
      cands.sort((a, b) => a.cval - b.cval);
      cands.length = Math.min(cands.length, 3);
      if (tFirst) {
        for (const cd of cands) {
          if (cd.tau > 1.8 * tFirst) cd.pen += 0.18;      // subharmonic (octave-low)
        }
      }
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
   * Tonic (Sa) detection: duration-weighted pitch-class histogram with
   * fifth/fourth reinforcement, then octave placement so the singer's
   * range sits mostly between mandra Pa and taar Ga.
   * ---------------------------------------------------------------- */

  function detectTonic(f0, clarity, hopSec) {
    const BINS = 240; // 5-cent bins
    const hist = new Float64Array(BINS);
    const rels = [];
    for (let i = 0; i < f0.length; i++) {
      if (f0[i] > 0 && clarity[i] >= 0.5) {
        const rel = 1200 * Math.log2(f0[i] / 55);
        rels.push(rel);
        const pc = ((rel % 1200) + 1200) % 1200;
        const bin = Math.round(pc / 5) % BINS;
        hist[bin] += clarity[i] * clarity[i];
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

    // Ending-note evidence: melodies tend to resolve on Sa.
    const tailFrames = Math.round(2 / hopSec);
    const tail = [];
    for (let i = f0.length - 1; i >= 0 && tail.length < tailFrames; i--) {
      if (f0[i] > 0) tail.push(((1200 * Math.log2(f0[i] / 55)) % 1200 + 1200) % 1200);
    }
    tail.sort((a, b) => a - b);
    const endPc = tail.length ? tail[Math.floor(tail.length / 2)] : null;

    const circDist = (a, b) => {
      const d = Math.abs((((a - b) % 1200) + 1200) % 1200);
      return Math.min(d, 1200 - d);
    };

    for (const p of peaks) {
      p.score = at(p.pc) + 0.65 * at(p.pc + 702) + 0.4 * at(p.pc + 498);
      if (endPc !== null && circDist(p.pc, endPc) < 35) p.score += 0.12 * maxH;
    }
    peaks.sort((a, b) => b.score - a.score);

    // Octave placement: maximize voiced coverage in [-650, +1900) cents.
    const placed = [];
    for (const p of peaks.slice(0, 3)) {
      let bestHz = 0, bestCov = -1;
      for (let oct = 0; oct <= 4; oct++) {
        const hz = 55 * Math.pow(2, (p.pc / 1200)) * Math.pow(2, oct);
        if (hz < 80 || hz > 400) continue;
        let cov = 0;
        for (const r of rels) {
          const rc = r - 1200 * Math.log2(hz / 55);
          if (rc >= -650 && rc < 1900) cov++;
        }
        if (cov > bestCov) { bestCov = cov; bestHz = hz; }
      }
      if (bestHz > 0) placed.push({ hz: bestHz, score: p.score / (maxH * 2.05), coverage: bestCov / rels.length });
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

  /**
   * Quantize an f0 track to swara tokens relative to saHz.
   * Returns { tokens, phrases } where tokens = [{t0,t1,k,cents,meend}]
   * and phrases group tokens separated by gaps >= 0.6 s.
   */
  function notate(f0, clarity, hopSec, saHz, opts) {
    opts = opts || {};
    const thresh = opts.clarityThresh != null ? opts.clarityThresh : 0.5;
    const minNoteMs = opts.minNoteMs != null ? opts.minNoteMs : 90;
    const minFrames = Math.max(2, Math.round(minNoteMs / 1000 / hopSec));
    const n = f0.length;

    const cents = new Float32Array(n);
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (f0[i] > 0 && clarity[i] >= thresh) {
        voiced[i] = 1;
        cents[i] = 1200 * Math.log2(f0[i] / saHz);
      }
    }

    // Per-frame semitone, median-5 smoothed within voiced runs.
    const kArr = new Int16Array(n);
    for (let i = 0; i < n; i++) if (voiced[i]) kArr[i] = Math.round(cents[i] / 100);
    const kSm = new Int16Array(kArr);
    const win = [];
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      win.length = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        if (voiced[j]) win.push(kArr[j]);
      }
      win.sort((a, b) => a - b);
      kSm[i] = win[Math.floor(win.length / 2)];
    }

    // Voiced segments -> runs of constant k -> merge runs below minFrames.
    const tokens = [];
    let segStart = -1;
    for (let i = 0; i <= n; i++) {
      const v = i < n && voiced[i];
      if (v && segStart < 0) segStart = i;
      if (!v && segStart >= 0) {
        const segEnd = i; // exclusive
        let runs = [];
        let rs = segStart;
        for (let j = segStart + 1; j <= segEnd; j++) {
          if (j === segEnd || kSm[j] !== kSm[rs]) {
            runs.push({ start: rs, end: j, k: kSm[rs] });
            rs = j;
          }
        }
        // Iteratively merge the shortest sub-minimum run into its closer-pitched neighbor.
        for (let guard = 0; guard < 200; guard++) {
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
          // Merge now-adjacent equal-k runs.
          for (let r = runs.length - 2; r >= 0; r--) {
            if (runs[r].k === runs[r + 1].k && runs[r].end === runs[r + 1].start) {
              runs[r].end = runs[r + 1].end;
              runs.splice(r + 1, 1);
            }
          }
        }
        if (runs.length === 1 && runs[0].end - runs[0].start < minFrames) runs = [];
        for (const r of runs) {
          let cMin = Infinity, cMax = -Infinity, cSum = 0;
          for (let j = r.start; j < r.end; j++) {
            const cv = cents[j];
            if (cv < cMin) cMin = cv;
            if (cv > cMax) cMax = cv;
            cSum += cv;
          }
          tokens.push({
            t0: r.start * hopSec,
            t1: r.end * hopSec,
            k: r.k,
            cents: cSum / (r.end - r.start),
            meend: (cMax - cMin) > 90,
          });
        }
        segStart = -1;
      }
    }

    // Phrases: split at gaps >= 0.6 s.
    const phrases = [];
    let cur = null;
    for (const tk of tokens) {
      if (!cur || tk.t0 - cur.t1 >= 0.6) {
        cur = { t0: tk.t0, t1: tk.t1, tokens: [tk] };
        phrases.push(cur);
      } else {
        cur.tokens.push(tk);
        cur.t1 = tk.t1;
      }
    }
    return { tokens, phrases };
  }

  /** Render notation as plain text, with ~0.3 s sustain dashes. */
  function notationText(phrases) {
    const lines = [];
    for (const ph of phrases) {
      const mm = Math.floor(ph.t0 / 60);
      const ss = Math.floor(ph.t0 % 60).toString().padStart(2, '0');
      const parts = [];
      for (const tk of ph.tokens) {
        let t = tokenText(tk.k, tk.meend);
        const dashes = Math.min(8, Math.max(0, Math.round((tk.t1 - tk.t0 - 0.35) / 0.3)));
        for (let d2 = 0; d2 < dashes; d2++) t += ' –';
        parts.push(t);
      }
      lines.push('[' + mm + ':' + ss + ']  ' + parts.join('  '));
    }
    return lines.join('\n');
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

  return {
    preFilter, yinTrack, detectTonic, notate, notationText,
    swaraInfo, tokenText, synthesize, percentile,
    SWARA_LETTERS,
    _internal: { biquadCoefs, applyBiquad, viterbiSelect, postProcess, VIT, YIN },
  };
}));
