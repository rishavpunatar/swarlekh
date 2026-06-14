/* SwarLekh — optional neural pitch tracker (CREPE-tiny, run in-browser).
 *
 * CREPE is a small CNN that reads 1024-sample frames at 16 kHz and outputs a
 * 360-bin pitch activation (20-cent resolution). It is markedly more
 * octave-robust than YIN on live recordings where harmonium/tabla bleed into
 * the voice — exactly the passages YIN slips on. The model (≈1.9 MB, MIT) and
 * the TensorFlow.js runtime are SELF-HOSTED in this repo, so enabling this mode
 * still sends no audio anywhere and downloads nothing from a third party.
 *
 * Decoding is a Viterbi pass over each frame's activation peaks (not a naive
 * per-frame argmax): it picks the most CONTINUOUS path, so a momentary octave
 * slip — where the true-octave bin is still a secondary peak — is overridden by
 * its confident neighbours. This is the main accuracy lever over raw CREPE.
 *
 * Output matches DSP.yinTrack: { f0, clarity, rms, hopSec } so the rest of the
 * pipeline (stabilizeOctave → detectTonic → notate) is unchanged.
 */
'use strict';
var CREPE = (function () {
  var model = null, loading = null;
  // CREPE cent grid: cents[i] = 1997.379… + 20·i  →  freq = 10·2^(cents/1200).
  var MAP = new Float32Array(360);
  for (var i = 0; i < 360; i++) MAP[i] = 1997.3794084376191 + 20 * i;

  function loadModel(url) {
    if (model) return Promise.resolve(model);
    if (!loading) loading = tf.loadLayersModel(url).then(function (m) { model = m; return m; });
    return loading;
  }

  // Sub-bin cents at a peak: salience-weighted centroid over ±4 bins.
  function peakCents(act, base, k) {
    var lo = Math.max(0, k - 4), hi = Math.min(359, k + 4), num = 0, den = 0;
    for (var i = lo; i <= hi; i++) { num += MAP[i] * act[base + i]; den += act[base + i]; }
    return den > 0 ? num / den : MAP[k];
  }

  // samples: Float32Array at 16 kHz. onProgress(frac) optional.
  async function track(modelUrl, samples, sr, onProgress) {
    var m = await loadModel(modelUrl);
    var hopSec = 0.016, hop = Math.round(hopSec * sr), W = 1024;
    var n = Math.max(0, Math.floor((samples.length - W) / hop) + 1);
    var rms = new Float32Array(n);
    // Per-frame pitch candidates (activation peaks) for the Viterbi decode.
    var candC = new Array(n);   // [cents,…]   (empty ⇒ unvoiced)
    var candS = new Array(n);   // [salience,…]
    var B = 128, buf = new Float32Array(B * W);
    var VOICED = 0.10;          // frame is voiced if its top activation clears this

    for (var b = 0; b < n; b += B) {
      var cnt = Math.min(B, n - b);
      for (var i = 0; i < cnt; i++) {
        var st = (b + i) * hop, mean = 0, energy = 0;
        for (var j = 0; j < W; j++) { var s = samples[st + j] || 0; mean += s; energy += s * s; }
        mean /= W;
        rms[b + i] = Math.sqrt(energy / W);
        var sd = 0;
        for (var j2 = 0; j2 < W; j2++) { var d = (samples[st + j2] || 0) - mean; sd += d * d; }
        var std = Math.sqrt(sd / W) || 1e-8;
        for (var j3 = 0; j3 < W; j3++) buf[i * W + j3] = ((samples[st + j3] || 0) - mean) / std;
      }
      var input = tf.tensor(buf.subarray(0, cnt * W), [cnt, W]);
      var pred = m.predict(input);
      var act = pred.dataSync();
      input.dispose(); pred.dispose();
      for (var r = 0; r < cnt; r++) {
        var t = b + r, base = r * 360, mv = 0;
        for (var k = 0; k < 360; k++) if (act[base + k] > mv) mv = act[base + k];
        if (mv < VOICED) { candC[t] = []; candS[t] = []; continue; }
        // local maxima above a fraction of the frame's peak — keeps the true
        // octave as a candidate even on frames where a wrong octave is tallest.
        var floor = Math.max(0.05, 0.10 * mv), cs = [], ss = [];
        for (var k3 = 1; k3 < 359; k3++) {
          if (act[base + k3] >= act[base + k3 - 1] && act[base + k3] > act[base + k3 + 1] && act[base + k3] >= floor) {
            cs.push(peakCents(act, base, k3)); ss.push(act[base + k3]);
          }
        }
        if (!cs.length) { cs.push(peakCents(act, base, 0)); ss.push(mv); }
        // keep the 8 strongest candidates
        if (cs.length > 8) {
          var order = cs.map(function (_, ix) { return ix; }).sort(function (a, c) { return ss[c] - ss[a]; }).slice(0, 8);
          cs = order.map(function (ix) { return cs[ix]; });
          ss = order.map(function (ix) { return ss[ix]; });
        }
        candC[t] = cs; candS[t] = ss;
      }
      if (onProgress) onProgress((b + cnt) / n);
      await Promise.resolve();        // yield to keep the worker responsive
    }

    // ---- Viterbi over candidates: emission = −log(salience); transition =
    // (Δsemitones)²·λ, so small melodic moves are nearly free but octave-scale
    // jumps are expensive — a continuous line beats a flickering one. ----
    var LAMBDA = 0.02;
    var f0 = new Float32Array(n), clarity = new Float32Array(n);
    var cost = new Array(n), back = new Array(n);
    for (var t2 = 0; t2 < n; t2++) {
      var c = candC[t2], s = candS[t2];
      if (!c || !c.length) { cost[t2] = null; back[t2] = null; continue; }
      var cur = new Float64Array(c.length), bk = new Int16Array(c.length);
      var prev = t2 > 0 ? cost[t2 - 1] : null;
      var pc = prev ? candC[t2 - 1] : null;
      for (var ci = 0; ci < c.length; ci++) {
        var emit = -Math.log(s[ci] + 1e-6);
        if (!prev) { cur[ci] = emit; bk[ci] = -1; continue; }
        var best = Infinity, bi = 0;
        for (var pi = 0; pi < pc.length; pi++) {
          var dsemi = (c[ci] - pc[pi]) / 100;
          var v = prev[pi] + dsemi * dsemi * LAMBDA;
          if (v < best) { best = v; bi = pi; }
        }
        cur[ci] = emit + best; bk[ci] = bi;
      }
      cost[t2] = cur; back[t2] = bk;
    }
    // Backtrack each contiguous voiced run independently.
    for (var e = n - 1; e >= 0; e--) {
      if (!cost[e]) continue;
      var end = e, st2 = e;
      while (st2 - 1 >= 0 && cost[st2 - 1]) st2--;   // run = [st2 .. end]
      var bestI = 0, bestV = cost[end][0];
      for (var q = 1; q < cost[end].length; q++) if (cost[end][q] < bestV) { bestV = cost[end][q]; bestI = q; }
      for (var t3 = end; t3 >= st2; t3--) {
        var ce = candC[t3][bestI];
        f0[t3] = 10 * Math.pow(2, ce / 1200);
        clarity[t3] = candS[t3][bestI];
        bestI = back[t3][bestI] < 0 ? 0 : back[t3][bestI];
      }
      e = st2;   // jump past the run we just resolved
    }
    return { f0: f0, clarity: clarity, rms: rms, hopSec: hopSec };
  }

  return { track: track, loadModel: loadModel };
})();
if (typeof module !== 'undefined') module.exports = CREPE;
