/* SwarLekh — analysis worker. Receives 16 kHz mono samples, returns the
 * pitch track, tonic candidates and a synthesized melody preview. */
'use strict';
// Inherit the ?v= cache-busting query from the worker URL so fft.js/dsp.js
// are refreshed in lockstep with this file (no stale-DSP-in-worker drift).
var V = self.location.search || '';
importScripts('fft.js' + V, 'dsp.js' + V);

self.onmessage = function (e) {
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

    prog('filter', 0);
    const filtered = DSP.preFilter(samples, sr);

    prog('pitch', 0);
    const track = DSP.yinTrack(filtered, sr, {}, (f) => prog('pitch', f));

    prog('tonic', 0);
    const tonic = DSP.detectTonic(track.f0, track.clarity, track.hopSec, track.rms);

    // Syllable/word onsets, on the band-limited signal so tabla is suppressed.
    const hopSamples = Math.round(track.hopSec * sr);
    const onsets = DSP.detectOnsets(filtered, sr, hopSamples);

    prog('synth', 0);
    const synth = DSP.synthesize(track.f0, track.clarity, track.hopSec, sr);

    self.postMessage({
      type: 'result',
      f0: track.f0,
      clarity: track.clarity,
      rms: track.rms,
      hopSec: track.hopSec,
      tonic,
      onsets,
      synth,
      sr,
    }, [track.f0.buffer, track.clarity.buffer, track.rms.buffer, synth.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
