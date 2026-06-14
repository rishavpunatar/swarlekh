/* SwarLekh — analysis worker. Receives 16 kHz mono samples, returns the
 * pitch track, tonic candidates and a synthesized melody preview.
 *
 * Two pitch engines:
 *   • default — DSP.yinTrack (fast, dependency-free DSP).
 *   • neural  — CREPE-tiny via TensorFlow.js (WASM backend), loaded lazily ONLY
 *     when requested, all self-hosted (no third-party fetch, no audio egress).
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

    let track;
    if (e.data.neural) {
      await ensureNeural(prog);
      prog('pitch', 0);
      track = await CREPE.track('../models/crepe/model.json', samples, sr, (f) => prog('pitch', f));
    } else {
      prog('pitch', 0);
      track = DSP.yinTrack(filtered, sr, {}, (f) => prog('pitch', f));
    }
    const f0raw = track.f0.slice();

    // Collapse octave-tracking errors so Sa and everything downstream sit in one
    // consistent register. CREPE is already octave-accurate, so it only needs the
    // gentle isolated-glitch pass; the full 'auto' align is for YIN's noisy track.
    const stab = DSP.stabilizeOctave(track.f0, track.clarity, track.rms, track.hopSec, e.data.neural ? 'gentle' : 'auto');

    prog('tonic', 0);
    const tonic = DSP.detectTonic(stab.f0, track.clarity, track.hopSec, track.rms);

    // Syllable/word onsets, on the band-limited signal so tabla is suppressed.
    const hopSamples = Math.round(track.hopSec * sr);
    const onsets = DSP.detectOnsets(filtered, sr, hopSamples);

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
