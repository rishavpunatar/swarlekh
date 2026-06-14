/* SwarLekh — optional neural pitch tracker (CREPE-tiny, run in-browser).
 *
 * CREPE is a small CNN that reads 1024-sample frames at 16 kHz and outputs a
 * 360-bin pitch activation (20-cent resolution). It is markedly more
 * octave-robust than YIN on live recordings where harmonium/tabla bleed into
 * the voice — exactly the passages YIN slips on. The model (≈1.9 MB, MIT) and
 * the TensorFlow.js runtime are SELF-HOSTED in this repo, so enabling this mode
 * still sends no audio anywhere and downloads nothing from a third party.
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

  // samples: Float32Array at 16 kHz. onProgress(frac) optional.
  async function track(modelUrl, samples, sr, onProgress) {
    var m = await loadModel(modelUrl);
    var hopSec = 0.016, hop = Math.round(hopSec * sr), W = 1024;
    var n = Math.max(0, Math.floor((samples.length - W) / hop) + 1);
    var f0 = new Float32Array(n), clarity = new Float32Array(n), rms = new Float32Array(n);
    var B = 128, buf = new Float32Array(B * W);

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
        var base = r * 360, mi = 0, mv = act[base];
        for (var k = 1; k < 360; k++) if (act[base + k] > mv) { mv = act[base + k]; mi = k; }
        // local centroid around the peak → sub-bin cents
        var lo = Math.max(0, mi - 4), hi = Math.min(359, mi + 4), num = 0, den = 0;
        for (var k2 = lo; k2 <= hi; k2++) { num += MAP[k2] * act[base + k2]; den += act[base + k2]; }
        var cents = den > 0 ? num / den : 0;
        f0[b + r] = mv > 0.001 ? 10 * Math.pow(2, cents / 1200) : 0;
        clarity[b + r] = mv;          // CREPE confidence (0..1)
      }
      if (onProgress) onProgress((b + cnt) / n);
      await Promise.resolve();        // yield to keep the worker responsive
    }
    return { f0: f0, clarity: clarity, rms: rms, hopSec: hopSec };
  }

  return { track: track, loadModel: loadModel };
})();
if (typeof module !== 'undefined') module.exports = CREPE;
