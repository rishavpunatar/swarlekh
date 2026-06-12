/* SwarLekh — minimal iterative radix-2 complex FFT (UMD, no dependencies). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FFTMod = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const revCache = new Map();

  function bitReverseTable(n) {
    let rev = revCache.get(n);
    if (rev) return rev;
    rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    revCache.set(n, rev);
    return rev;
  }

  /**
   * In-place complex FFT. re/im are Float32Array (or Float64Array) of
   * power-of-two length. inverse=true applies 1/n scaling.
   */
  function fft(re, im, inverse) {
    const n = re.length;
    if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');
    const rev = bitReverseTable(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curR = 1, curI = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const tr = re[b] * curR - im[b] * curI;
          const ti = re[b] * curI + im[b] * curR;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const nr = curR * wr - curI * wi;
          curI = curR * wi + curI * wr;
          curR = nr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  return { fft };
}));
