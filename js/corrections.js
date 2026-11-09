/* Pure correction operations shared by the editor and regression tests. */
(function (root) {
  'use strict';
  function transposeEdits(edits, semitones) {
    return edits.map(edit => {
      const next = Object.assign({}, edit);
      for (const key of ['k', 'originalK', 'freeTargetK']) {
        if (Number.isFinite(next[key])) next[key] += semitones;
      }
      return next;
    });
  }
  function tonicShift(referenceHz, saHz) {
    return Math.round(12 * Math.log2(referenceHz / saHz));
  }
  // Shift the existing score, including every ornament pitch, without running
  // detection again or changing the singer's syllable boundaries.
  function transposeTokens(tokens, semitones, cents = semitones * 100) {
    return tokens.map(token => {
      const next = Object.assign({}, token);
      for (const key of ['k', 'learnedK', 'andolanLo', 'andolanHi', 'manualFreeTargetK']) {
        if (Number.isFinite(next[key])) next[key] += semitones;
      }
      for (const key of ['cents', 'sungCents']) {
        if (Number.isFinite(next[key])) next[key] += cents;
      }
      for (const key of ['via', 'kan', 'murki', 'graceAfter']) {
        if (Array.isArray(next[key])) next[key] = next[key].map(k => k + semitones);
      }
      if (Array.isArray(next.orn)) next.orn = transposeTokens(next.orn, semitones, cents);
      return next;
    });
  }
  function removeIntervals(tokens, deletions) {
    let result = tokens;
    for (const cut of deletions) {
      result = result.flatMap(token => {
        if (token.t1 <= cut.t0 || token.t0 >= cut.t1) return [token];
        const parts = [];
        if (cut.t0 - token.t0 >= 0.025) parts.push(Object.assign({}, token, { t1: cut.t0 }));
        if (token.t1 - cut.t1 >= 0.025) parts.push(Object.assign({}, token, { t0: cut.t1 }));
        return parts;
      });
    }
    return result;
  }
  // Learn a conservative segmentation floor from expert-reviewed syllables.
  // Tonic and absolute pitches are song-specific and are never transferred.
  function learnTiming(examples) {
    const durations = examples.flatMap(example => example.notes.map(n => (n.t1 - n.t0) * 1000))
      .filter(ms => Number.isFinite(ms) && ms >= 50 && ms <= 2000).sort((a, b) => a - b);
    if (durations.length < 8) return null;
    const short = durations[Math.floor((durations.length - 1) * 0.1)];
    const minNoteMs = Math.max(50, Math.min(170, Math.round(short * 0.65 / 5) * 5));
    return { version: 1, examples: examples.length, minNoteMs,
      onsetMinMs: Math.max(45, Math.min(125, Math.round(minNoteMs * 0.75 / 5) * 5)) };
  }
  const api = { transposeEdits, transposeTokens, tonicShift, removeIntervals, learnTiming };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Corrections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
