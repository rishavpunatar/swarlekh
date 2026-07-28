/* SwarLekh — analysis worker. Receives 16 kHz mono samples, returns the
 * pitch track, tonic candidates and a synthesized melody preview.
 *
 * Three pitch engines:
 *   • default — DSP.yinTrack (fast, dependency-free DSP).
 *   • neural  — CREPE-tiny via TensorFlow.js (WASM backend), loaded lazily ONLY
 *     when requested, all self-hosted (no third-party fetch, no audio egress).
 *   • external — voice separation + Praat-CC from the optional local server.
 * Everything downstream (stabilizeOctave → detectTonic → notate) is identical,
 * so the engine only changes how the f0 track is produced. */
'use strict';
// Inherit the ?v= cache-busting query so fft.js/dsp.js/crepe.js refresh in
// lockstep with this file (no stale-DSP-in-worker drift).
var V = self.location.search || '';
importScripts('fft.js' + V, 'dsp.js' + V, 'crepe.js' + V);

var tfReady = false;
function ensureNeural(prog) {
  if (tfReady) return Promise.resolve();
  prog('loading', 0);
  // Self-hosted runtime + WASM SIMD backend (relative paths keep the project
  // sub-path deployment, e.g. /swarlekh/, working).
  importScripts('vendor/tf.min.js' + V, 'vendor/tf-backend-wasm.js' + V);
  tf.wasm.setWasmPaths('vendor/');
  return tf.setBackend('wasm').then(function () { return tf.ready(); }).then(function () { tfReady = true; });
}

self.onmessage = async function (e) {
  const { samples, sr } = e.data;

  // Transpose job: phase-vocoder pitch shift, duration preserved.
  if (e.data.cmd === 'pitch') {
    const id = e.data.id;
    try {
      const out = DSP.pitchShift(samples, sr, e.data.semitones,
        (f) => self.postMessage({ type: 'progress', id, frac: f }));
      self.postMessage({ type: 'pitchResult', id, samples: out, sr, semitones: e.data.semitones }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
    }
    return;
  }

  try {
    const prog = (stage, frac) => self.postMessage({ type: 'progress', stage, frac });

    // Band-limit for the onset detector (suppresses tabla). YIN also tracks on
    // this; CREPE tracks on the raw signal (it is trained on full-mix audio).
    prog('filter', 0);
    const filtered = DSP.preFilter(samples, sr);

    const external = !!e.data.providedF0;   // pitch track from the local separator + Praat-CC server
    let track;
    if (external) {
      // The heavy lifting (vocal separation + Praat-CC) happened on the local
      // server; wrap its f0/periodicity like a yinTrack result and compute the
      // per-frame rms here for the loudness gate.
      prog('pitch', 0.5);
      const pf = e.data.providedF0, pc = e.data.providedClarity, ph = e.data.providedHopSec || 0.016;
      let rmsArr;
      if (e.data.providedRms && e.data.providedRms.length === pf.length) {
        // Separated-voice loudness — so the clean-mode gate keys off the VOICE,
        // not the mix; instrumental stretches stay silent instead of leaking notes.
        rmsArr = Float32Array.from(e.data.providedRms);
      } else {
        const hs = Math.round(ph * sr); rmsArr = new Float32Array(pf.length);
        for (let k = 0; k < pf.length; k++) {
          let en = 0; const st = k * hs;
          for (let j = 0; j < 1024 && st + j < samples.length; j++) en += samples[st + j] * samples[st + j];
          rmsArr[k] = Math.sqrt(en / 1024);
        }
      }
      track = { f0: Float32Array.from(pf), clarity: Float32Array.from(pc), rms: rmsArr, hopSec: ph };
    } else if (e.data.neural) {
      await ensureNeural(prog);
      prog('pitch', 0);
      track = await CREPE.track('../models/crepe/model.json', samples, sr, (f) => prog('pitch', f));
    } else {
      prog('pitch', 0);
      track = DSP.yinTrack(filtered, sr, {}, (f) => prog('pitch', f));
    }
    const f0raw = track.f0.slice();

    // CREPE and the separated-vocal Praat track are already octave-accurate:
    // apply only the gentle glitch pass. YIN's noisier track gets full register
    // alignment.
    const cleanTrack = e.data.neural || external;
    const stab = DSP.stabilizeOctave(track.f0, track.clarity, track.rms, track.hopSec, cleanTrack ? 'gentle' : 'auto');

    prog('tonic', 0);
    // Browser CREPE's flatter salience can confuse the YIN-tuned tonic scorer,
    // so it keeps the established quick-YIN fallback. The local-server path is
    // different: its f0, clarity and loudness all come from the separated voice.
    // Using mix YIN here would throw that isolation away and let harmonium or
    // accompaniment choose Sa.
    let tonic;
    if (e.data.neural) {
      const yt = DSP.yinTrack(filtered, sr, {});
      const ys = DSP.stabilizeOctave(yt.f0, yt.clarity, yt.rms, yt.hopSec, 'auto');
      tonic = DSP.detectTonic(ys.f0, yt.clarity, yt.hopSec, yt.rms);
    } else {
      tonic = DSP.detectTonic(stab.f0, track.clarity, track.hopSec, track.rms);
    }

    // Syllable/consonant onsets. The local server detects them on the
    // SEPARATED voice (clean consonants, no tabla) and sends times in seconds
    // — convert to frame indices. Otherwise detect on the band-limited mix.
    const hopSamples = Math.round(track.hopSec * sr);
    const onsets = (external && e.data.providedOnsets && e.data.providedOnsets.length)
      ? e.data.providedOnsets.map(function (t) { return Math.round(t / track.hopSec); })
      : DSP.detectOnsets(filtered, sr, hopSamples);

    prog('synth', 0);
    const synth = DSP.synthesize(stab.f0, track.clarity, track.hopSec, sr);

    self.postMessage({
      type: 'result',
      f0: stab.f0,
      f0raw,
      doubled: stab.doubled,
      clarity: track.clarity,
      rms: track.rms,
      hopSec: track.hopSec,
      tonic,
      onsets,
      synth,
      sr,
    }, [stab.f0.buffer, f0raw.buffer, track.clarity.buffer, track.rms.buffer, synth.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
