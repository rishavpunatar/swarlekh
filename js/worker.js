/* SwarLekh — analysis worker. Receives 16 kHz mono samples, returns the
 * pitch track, tonic candidates and a synthesized melody preview. */
'use strict';
importScripts('fft.js', 'dsp.js');

self.onmessage = function (e) {
  const { samples, sr } = e.data;
  try {
    const prog = (stage, frac) => self.postMessage({ type: 'progress', stage, frac });

    prog('filter', 0);
    const filtered = DSP.preFilter(samples, sr);

    prog('pitch', 0);
    const track = DSP.yinTrack(filtered, sr, {}, (f) => prog('pitch', f));

    prog('tonic', 0);
    const tonic = DSP.detectTonic(track.f0, track.clarity, track.hopSec);

    prog('synth', 0);
    const synth = DSP.synthesize(track.f0, track.clarity, track.hopSec, sr);

    self.postMessage({
      type: 'result',
      f0: track.f0,
      clarity: track.clarity,
      hopSec: track.hopSec,
      tonic,
      synth,
      sr,
    }, [track.f0.buffer, track.clarity.buffer, synth.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
