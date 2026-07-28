'use strict';

function centsDistance(aHz, bHz) {
  if (!(aHz > 0) || !(bHz > 0)) return Infinity;
  return Math.abs(1200 * Math.log2(aHz / bHz));
}

function chromaCentsDistance(aHz, bHz) {
  const cents = centsDistance(aHz, bHz);
  if (!Number.isFinite(cents)) return Infinity;
  const wrapped = cents % 1200;
  return Math.min(wrapped, 1200 - wrapped);
}

function nearestFrame(track, timeSec) {
  const index = Math.max(0, Math.min(track.f0.length - 1, Math.round(timeSec / track.hopSec)));
  return {
    f0: track.f0[index] || 0,
    clarity: track.clarity ? track.clarity[index] || 0 : 1,
  };
}

function evaluatePitch(reference, estimated, clarityThreshold) {
  const threshold = clarityThreshold == null ? 0.5 : clarityThreshold;
  const counts = {
    frames: 0,
    referenceVoiced: 0,
    referenceUnvoiced: 0,
    estimatedVoicedOnReferenceVoiced: 0,
    estimatedVoicedOnReferenceUnvoiced: 0,
    rawPitchCorrect: 0,
    rawChromaCorrect: 0,
    overallCorrect: 0,
  };
  const voicedErrors = [];

  for (let i = 0; i < reference.times.length; i++) {
    const refHz = reference.f0[i] || 0;
    const frame = nearestFrame(estimated, reference.times[i]);
    const estHz = frame.f0 > 0 && frame.clarity >= threshold ? frame.f0 : 0;
    const refVoiced = refHz > 0;
    const estVoiced = estHz > 0;
    counts.frames++;

    if (refVoiced) {
      counts.referenceVoiced++;
      if (estVoiced) {
        counts.estimatedVoicedOnReferenceVoiced++;
        const rawError = centsDistance(estHz, refHz);
        const chromaError = chromaCentsDistance(estHz, refHz);
        voicedErrors.push(rawError);
        if (rawError <= 50) {
          counts.rawPitchCorrect++;
          counts.overallCorrect++;
        }
        if (chromaError <= 50) counts.rawChromaCorrect++;
      }
    } else {
      counts.referenceUnvoiced++;
      if (estVoiced) counts.estimatedVoicedOnReferenceUnvoiced++;
      else counts.overallCorrect++;
    }
  }

  voicedErrors.sort((a, b) => a - b);
  return Object.assign(scoresFromPitchCounts(counts), {
    counts,
    medianCentsError: voicedErrors.length ? voicedErrors[voicedErrors.length >> 1] : null,
  });
}

function scoresFromPitchCounts(counts) {
  return {
    rawPitchAccuracy: divide(counts.rawPitchCorrect, counts.referenceVoiced),
    rawChromaAccuracy: divide(counts.rawChromaCorrect, counts.referenceVoiced),
    voicingRecall: divide(counts.estimatedVoicedOnReferenceVoiced, counts.referenceVoiced),
    voicingFalseAlarm: divide(counts.estimatedVoicedOnReferenceUnvoiced, counts.referenceUnvoiced),
    overallAccuracy: divide(counts.overallCorrect, counts.frames),
  };
}

function noteCompatible(reference, estimated, requireOffset) {
  if (Math.abs(reference.onset - estimated.onset) > 0.05) return false;
  if (centsDistance(reference.frequency, estimated.frequency) > 50) return false;
  if (!requireOffset) return true;
  const offsetTolerance = Math.max(0.05, 0.2 * (reference.offset - reference.onset));
  return Math.abs(reference.offset - estimated.offset) <= offsetTolerance;
}

function maximumMatches(reference, estimated, requireOffset) {
  const edges = reference.map((ref) => {
    const candidates = [];
    for (let j = 0; j < estimated.length; j++) {
      if (noteCompatible(ref, estimated[j], requireOffset)) candidates.push(j);
    }
    return candidates;
  });
  const order = reference.map((_, i) => i).sort((a, b) => edges[a].length - edges[b].length);
  const estimatedMatch = new Int32Array(estimated.length).fill(-1);

  function augment(referenceIndex, seen) {
    for (const estimatedIndex of edges[referenceIndex]) {
      if (seen[estimatedIndex]) continue;
      seen[estimatedIndex] = 1;
      if (estimatedMatch[estimatedIndex] < 0 ||
          augment(estimatedMatch[estimatedIndex], seen)) {
        estimatedMatch[estimatedIndex] = referenceIndex;
        return true;
      }
    }
    return false;
  }

  let matches = 0;
  for (const referenceIndex of order) {
    if (augment(referenceIndex, new Uint8Array(estimated.length))) matches++;
  }
  return matches;
}

function evaluateNotes(reference, estimated, requireOffset) {
  const counts = {
    matches: maximumMatches(reference, estimated, requireOffset),
    reference: reference.length,
    estimated: estimated.length,
  };
  return Object.assign(scoresFromNoteCounts(counts), { counts });
}

function scoresFromNoteCounts(counts) {
  const precision = divide(counts.matches, counts.estimated);
  const recall = divide(counts.matches, counts.reference);
  return {
    precision,
    recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
  };
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + value;
  return target;
}

function divide(a, b) {
  return b ? a / b : 0;
}

module.exports = {
  addCounts,
  centsDistance,
  chromaCentsDistance,
  evaluateNotes,
  evaluatePitch,
  maximumMatches,
  scoresFromNoteCounts,
  scoresFromPitchCounts,
};
