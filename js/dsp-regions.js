/* SwarLekh — notation for the Best engine. GAME's learned note regions are
 * refined with the frame-level pitch contour: entry landings, slide clean-up,
 * murki/turn recovery, vibrato folding and phrase-end fade landings. Installs
 * DSP.notateRegions onto the DSP core (dsp.js), which must load first:
 *   browser/worker: <script src="js/dsp.js"> then <script src="js/dsp-regions.js">
 *   Node: require('./dsp.js') already includes it.
 * Every change here is scored by evaluation/app-benchmark.js (npm test). */
(function (root, install) {
  if (typeof module === 'object' && module.exports) {
    module.exports = install;
  } else {
    install(root.DSP);
  }
}(typeof self !== 'undefined' ? self : this, function install(DSP) {
  'use strict';
  const { analyzeToken, groupPhrases } = DSP._internal;
  const notate = DSP.notate;

  /**
   * Restore short, clearly landed turning notes that sit inside a broader GAME
   * region. Each recovery is limited to the local three-note gesture around the
   * turn. This keeps a real murki visible without allowing one frame-level turn
   * to replace the neural model's boundaries across an entire alaap phrase.
   */
  function fuseTurningOrnaments(neuralTokens, frameTokens, suppressedTurns) {
    if (neuralTokens.length < 1 || frameTokens.length < 3) {
      return neuralTokens;
    }
    const refinedTokens = neuralTokens.map((token) => Object.assign({}, token));
    const recoveredEntries = [];
    for (let tokenIndex = 0; tokenIndex < refinedTokens.length; tokenIndex++) {
      const token = refinedTokens[tokenIndex];
      for (let frameIndex = 1; frameIndex < frameTokens.length; frameIndex++) {
        let lead = frameTokens[frameIndex - 1];
        const landing = frameTokens[frameIndex];
        if (lead.t1 - lead.t0 <= 0.055 && frameIndex >= 2) {
          const earlier = frameTokens[frameIndex - 2];
          if (landing.t0 - earlier.t1 <= 0.12) lead = earlier;
        }
        const overlapInside = landing.t0 >= token.t0 + 0.07 &&
          landing.t0 <= token.t1 - 0.025;
        const leadCrossesOnset = lead.t0 <= token.t0 + 0.02 &&
          lead.t1 >= token.t0 + 0.07;
        const connected = landing.t0 - lead.t1 <= 0.12;
        const closeStart = token.t0 - lead.t0 <= 0.30;
        const materiallyEarlier = token.t0 - lead.t0 >= 0.08;
        if (landing.k !== token.k || lead.k === token.k ||
            lead.t1 - lead.t0 < 0.07 || !overlapInside ||
            !leadCrossesOnset || !connected || !closeStart ||
            !materiallyEarlier) {
          continue;
        }
        const previous = refinedTokens[tokenIndex - 1];
        const start = previous ? Math.max(lead.t0, previous.t1) : lead.t0;
        if (landing.t0 - start < 0.06) continue;
        recoveredEntries.push(Object.assign({}, lead, {
          t0: start,
          t1: landing.t0,
          hybridOrnament: true,
          recoveredEntry: true,
        }));
        token.t0 = landing.t0;
        break;
      }
    }
    if (recoveredEntries.length) {
      refinedTokens.push(...recoveredEntries);
      refinedTokens.sort((a, b) => a.t0 - b.t0);
    }
    const missingTurns = [];
    const maxTurnSec = 0.16;
    const maxNeighborGapSec = 0.06;
    const wasSuppressed = (candidate) => (suppressedTurns || []).some((turn) => {
      if (turn.k !== candidate.k) return false;
      return Math.min(turn.t1, candidate.t1) -
        Math.max(turn.t0, candidate.t0) >= 0.02;
    });
    const existingHit = (candidate) => refinedTokens.some((token) => {
      if (token.k !== candidate.k) return false;
      const overlap = Math.min(token.t1, candidate.t1) -
        Math.max(token.t0, candidate.t0);
      return overlap >= Math.min(0.025, (candidate.t1 - candidate.t0) * 0.4);
    });

    for (let i = 1; i + 1 < frameTokens.length; i++) {
      const previous = frameTokens[i - 1];
      const token = frameTokens[i];
      const next = frameTokens[i + 1];
      const duration = token.t1 - token.t0;
      const leftGap = token.t0 - previous.t1;
      const rightGap = next.t0 - token.t1;
      const reverses = (token.k - previous.k) * (next.k - token.k) < 0;
      const totalLeap = Math.abs(token.k - previous.k) +
        Math.abs(next.k - token.k);
      const neighborSpan = Math.abs(next.k - previous.k);
      const outside = Math.max(
        Math.min(previous.k, next.k) - token.k,
        token.k - Math.max(previous.k, next.k),
        0
      );
      // RMVPE can briefly jump an octave-like distance during a consonant. A
      // real sub-100 ms murki turn is compact; these very large rebounds are
      // tracker glitches. A one-semitone hook just outside two adjacent targets
      // is transition geometry, so it belongs in the bend rather than as a note.
      const implausibleSpike = duration <= 0.10 && totalLeap >= 7;
      const weakExtreme = duration <= 0.08 &&
        Number.isFinite(token.conf) && token.conf < 0.78;
      const classicNeighborTurn = previous.k === next.k && duration >= 0.065;
      const adjacentHook = duration <= 0.14 && neighborSpan <= 2 &&
        outside === 1 && !classicNeighborTurn;
      if (duration >= 0.025 && duration <= maxTurnSec &&
          leftGap <= maxNeighborGapSec && rightGap <= maxNeighborGapSec &&
          reverses && !implausibleSpike && !weakExtreme && !adjacentHook &&
          !existingHit(token) && !wasSuppressed(token)) {
        missingTurns.push(i);
      }
    }
    if (!missingTurns.length) return refinedTokens;

    // Limit each missing turn to its immediate anchors. Merge only overlapping
    // three-note windows, never every connected frame token in the phrase.
    const components = [];
    for (const index of missingTurns) {
      const first = index - 1;
      const last = index + 1;
      const previous = components[components.length - 1];
      if (previous && first <= previous.last + 1) {
        previous.last = Math.max(previous.last, last);
      } else {
        components.push({ first, last });
      }
    }

    let result = refinedTokens.slice();
    for (const component of components) {
      const replacements = frameTokens
        .slice(component.first, component.last + 1)
        .map((token) => Object.assign({}, token, { hybridOrnament: true }));
      const start = replacements[0].t0;
      const end = replacements[replacements.length - 1].t1;
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= start || token.t0 >= end) {
          preserved.push(token);
          continue;
        }
        // A broad neural region can straddle a recovered turn. Keep its useful
        // outer portions so local frame evidence cannot erase the rest of it.
        if (token.t0 < start - 0.025) {
          preserved.push(Object.assign({}, token, { t1: start }));
        }
        if (token.t1 > end + 0.025) {
          preserved.push(Object.assign({}, token, { t0: end }));
        }
      }
      result = preserved;
      result.push(...replacements);
    }
    result.sort((a, b) => a.t0 - b.t0);
    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.hybridOrnament || token.hybridOrnament)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.hybridOrnament = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  function rawPitchRuns(f0, clarity, hopSec, saHz, thresh) {
    const runs = [];
    for (let frame = 0; frame < f0.length; frame++) {
      if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
      const cents = 1200 * Math.log2(f0[frame] / saHz);
      const k = Math.round(cents / 100);
      const previous = runs[runs.length - 1];
      if (previous && previous.k === k && frame - previous.end <= 2) {
        previous.end = frame + 1;
        previous.values.push(cents);
        previous.confidences.push(clarity[frame]);
      } else {
        runs.push({
          k,
          start: frame,
          end: frame + 1,
          values: [cents],
          confidences: [clarity[frame]],
        });
      }
    }
    return runs;
  }

  /**
   * Remove note regions that are characteristic of accompaniment leaking into
   * an otherwise quiet vocal stem. A repeated residual tone must be both among
   * the quietest events in a long recording and isolated from normal vocal
   * energy; soft sung phrases with changing notes are left alone.
   */
  function rejectInstrumentalPitchLeakage(tokens, thresh) {
    if (!tokens || !tokens.length) return tokens || [];
    let result = tokens.filter((token) => {
      const duration = token.t1 - token.t0;
      return !(duration >= 1.0 &&
        Number.isFinite(token.conf) &&
        token.conf < Math.max(0.12, thresh * 0.30));
    });
    const reference = result
      .filter((token) =>
        token.t1 - token.t0 >= 0.08 &&
        token.t1 - token.t0 <= 4.0 &&
        Number.isFinite(token.loud) &&
        Number.isFinite(token.conf) &&
        token.conf >= Math.max(0.70, thresh)
      )
      .map((token) => token.loud)
      .sort((a, b) => a - b);
    if (reference.length < 12) return result;

    const vocalFloor = reference[
      Math.floor((reference.length - 1) * 0.20)
    ];
    const leakageCeiling = Math.max(1e-5, vocalFloor * 0.16);
    const quiet = result
      .map((token, index) => ({ token, index }))
      .filter(({ token }) =>
        token.t1 - token.t0 >= 0.08 &&
        token.t1 - token.t0 <= 0.45 &&
        token.conf >= 0.75 &&
        token.loud <= leakageCeiling
      );
    const rejected = new Set();
    for (let first = 0; first < quiet.length; first++) {
      const group = [quiet[first]];
      let previous = quiet[first].token;
      for (let next = first + 1; next < quiet.length; next++) {
        const candidate = quiet[next].token;
        const gap = candidate.t0 - previous.t1;
        if (candidate.t0 - quiet[first].token.t0 > 2.5) break;
        if (candidate.k === quiet[first].token.k &&
            gap >= 0.08 && gap <= 1.0 &&
            Math.abs(candidate.cents - quiet[first].token.cents) <= 24) {
          group.push(quiet[next]);
          previous = candidate;
        }
      }
      if (group.length < 2) continue;
      const start = group[0].token.t0;
      const end = group[group.length - 1].token.t1;
      const nearbyVocal = result.some((token) =>
        token.t1 > start - 0.15 &&
        token.t0 < end + 0.15 &&
        token.loud > leakageCeiling * 2.4 &&
        token.k !== group[0].token.k
      );
      if (nearbyVocal) continue;
      for (const item of group) rejected.add(item.index);
    }
    if (!rejected.size) return result;
    return result.filter((token, index) => !rejected.has(index));
  }

  /**
   * Restore a soft phrase entry that GAME omitted even though the vocal pitch
   * tracker heard a stable note growing out of silence. The independent vocal
   * onset, quiet lead-in, rising energy and robust periodicity are all required;
   * a steady accompaniment residual therefore cannot create a note by itself.
   */
  function fuseSoftSwellEntries(tokens, frameTokens, clarity, rms, hopSec,
    onsets, thresh) {
    if (!frameTokens.length || !clarity || !rms || !(hopSec > 0) ||
        !onsets || !onsets.length) {
      return tokens;
    }
    const onsetTimes = onsets
      .map((frame) => Number(frame) * hopSec)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!onsetTimes.length) return tokens;

    const windowQuantile = (values, t0, t1, quantile) => {
      const start = Math.max(0, Math.floor(t0 / hopSec));
      const end = Math.min(values.length, Math.ceil(t1 / hopSec));
      const selected = [];
      for (let frame = start; frame < end; frame++) {
        const value = Number(values[frame]);
        if (Number.isFinite(value) && value >= 0) selected.push(value);
      }
      if (!selected.length) return 0;
      selected.sort((a, b) => a - b);
      return selected[
        Math.floor((selected.length - 1) * quantile)
      ];
    };

    const recovered = [];
    for (const candidate of frameTokens) {
      const duration = candidate.t1 - candidate.t0;
      if (duration < 0.28 || duration > 4.5 ||
          candidate.glide || candidate.meend || candidate.andolan ||
          !Number.isFinite(candidate.conf) ||
          candidate.conf < Math.max(0.86, thresh + 0.20)) {
        continue;
      }
      let represented = 0;
      for (const token of tokens) {
        represented += Math.max(
          0,
          Math.min(token.t1, candidate.t1) -
            Math.max(token.t0, candidate.t0)
        );
      }
      if (represented >= Math.min(0.06, duration * 0.15)) continue;

      let vocalOnset = null;
      for (const onset of onsetTimes) {
        if (onset < candidate.t0 - 0.18) continue;
        if (onset > candidate.t0 + 0.08) break;
        if (vocalOnset == null ||
            Math.abs(onset - candidate.t0) <
              Math.abs(vocalOnset - candidate.t0)) {
          vocalOnset = onset;
        }
      }
      if (vocalOnset == null) continue;

      const earlyEnd = candidate.t0 + Math.min(0.30, duration * 0.28);
      const bodyEnd = Math.min(
        candidate.t1,
        candidate.t0 + Math.max(0.65, Math.min(1.25, duration * 0.75))
      );
      const beforeLevel = windowQuantile(
        rms,
        vocalOnset - 0.16,
        vocalOnset,
        0.50
      );
      const entryLevel = windowQuantile(
        rms,
        candidate.t0,
        earlyEnd,
        0.50
      );
      const bodyLevel = windowQuantile(rms, earlyEnd, bodyEnd, 0.75);
      const clarityFloor = windowQuantile(
        clarity,
        candidate.t0,
        candidate.t1,
        0.20
      );
      if (!(entryLevel > 0) ||
          beforeLevel > entryLevel * 0.35 ||
          bodyLevel < entryLevel * 1.20 ||
          clarityFloor < Math.max(0.82, thresh + 0.20)) {
        continue;
      }

      recovered.push(Object.assign({}, candidate, {
        cents: candidate.k * 100,
        hybridRecovery: true,
        softSwellEntry: true,
      }));
    }
    if (!recovered.length) return tokens;
    return tokens.concat(recovered).sort((a, b) => a.t0 - b.t0);
  }

  /**
   * Split a broad destination region when its entrance contains a deliberate,
   * stable plateau several swaras away from the learned destination. Straight
   * monotonic crossings fail the endpoint-drift and centred-frame tests.
   */
  function fuseBroadEntryLandings(tokens, f0, clarity, hopSec, saHz, thresh) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const result = [];
    for (const token of tokens) {
      const duration = token.t1 - token.t0;
      if (duration < 0.45) {
        result.push(token);
        continue;
      }
      let entry = null;
      for (const run of runs) {
        const runStart = run.start * hopSec;
        const runEnd = run.end * hopSec;
        const runDuration = runEnd - runStart;
        const pitchDistance = Math.abs(run.k - token.k);
        if (runStart < token.t0 - 0.015 ||
            runStart > token.t0 + 0.09 ||
            runEnd > token.t0 + 0.32 ||
            runDuration < 0.10 || runDuration > 0.24 ||
            pitchDistance < 2 || pitchDistance > 6 ||
            Math.abs(run.values[run.values.length - 1] - run.values[0]) > 50) {
          continue;
        }
        const centered = run.values.filter((cents) =>
          Math.abs(cents - run.k * 100) <= 35
        ).length * hopSec;
        const sortedClarity = run.confidences.slice().sort((a, b) => a - b);
        const clarityFloor = sortedClarity[
          Math.floor((sortedClarity.length - 1) * 0.20)
        ];
        if (centered < 0.075 || clarityFloor < Math.max(0.86, thresh)) {
          continue;
        }
        const targetReturn = runs.some((later) =>
          later.k === token.k &&
          later.start * hopSec >= runEnd &&
          later.start * hopSec <= token.t0 + 0.55 &&
          (later.end - later.start) * hopSec >= 0.18
        );
        if (!targetReturn) continue;
        entry = { run, runStart, runEnd };
        break;
      }
      if (!entry) {
        result.push(token);
        continue;
      }
      if (entry.runStart - token.t0 >= 0.09) {
        result.push(Object.assign({}, token, { t1: entry.runStart }));
      }
      result.push({
        t0: entry.runStart,
        t1: entry.runEnd,
        k: entry.run.k,
        cents: entry.run.k * 100,
        neural: true,
        hybridOrnament: true,
        rawLandmark: true,
        compressedEntryLanding: true,
      });
      result.push(Object.assign({}, token, {
        t0: entry.runEnd,
        meendFromPrev: true,
      }));
    }
    return result.sort((a, b) => a.t0 - b.t0);
  }

  /**
   * Recover a very short adjacent-neighbour turn (for example D-n-D) directly
   * from the raw contour when neural hysteresis has merged it into two same-note
   * regions. A nearby neural boundary is required as independent evidence, which
   * keeps ordinary vibrato from becoming a stream of one-semitone murki labels.
   */
  function fuseRawNeighborTurns(tokens, f0, clarity, hopSec, saHz, thresh,
    suppressedTurns, onsets) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const wasSuppressed = (candidate) => (suppressedTurns || []).some((turn) =>
      turn.k === candidate.k &&
      Math.min(turn.t1, candidate.t1) - Math.max(turn.t0, candidate.t0) >= 0.02
    );
    let result = tokens.slice();
    const insertTurn = (previous, candidate, next, flags) => {
      const start = Math.max(previous.start * hopSec, candidate.t0 - 0.14);
      const end = Math.min(next.end * hopSec, candidate.t1 + 0.14);
      const replacements = [
        { t0: start, t1: candidate.t0, k: previous.k },
        candidate,
        { t0: candidate.t1, t1: end, k: next.k },
      ].map((token) => Object.assign({}, token, {
        cents: token.k * 100,
        hybridOrnament: true,
        rawLandmark: true,
      }, flags || {}));
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= start || token.t0 >= end) {
          preserved.push(token);
          continue;
        }
        if (token.t0 < start - 0.025) {
          preserved.push(Object.assign({}, token, { t1: start }));
        }
        if (token.t1 > end + 0.025) {
          preserved.push(Object.assign({}, token, { t0: end }));
        }
      }
      result = preserved.concat(replacements).sort((a, b) => a.t0 - b.t0);
    };
    for (let index = 1; index + 1 < runs.length; index++) {
      const previous = runs[index - 1];
      const run = runs[index];
      const next = runs[index + 1];
      const duration = (run.end - run.start) * hopSec;
      if (previous.k !== next.k || run.k === previous.k ||
          Math.abs(run.k - previous.k) > 2 ||
          duration < 0.045 || duration > 0.16 ||
          (run.start - previous.end) * hopSec > 0.02 ||
          (next.start - run.end) * hopSec > 0.02) {
        continue;
      }
      let plateau = 0, bestPlateau = 0;
      for (const cents of run.values) {
        if (Math.abs(cents - run.k * 100) <= 32) {
          plateau++;
          bestPlateau = Math.max(bestPlateau, plateau);
        } else {
          plateau = 0;
        }
      }
      if (bestPlateau * hopSec < 0.025) continue;
      const sortedValues = run.values.slice().sort((a, b) => a - b);
      const landingMedian = sortedValues[sortedValues.length >> 1];
      const candidate = {
        t0: run.start * hopSec,
        t1: run.end * hopSec,
        k: run.k,
      };
      const center = (candidate.t0 + candidate.t1) / 2;
      const neuralBoundary = result.some((token, tokenIndex) => {
        const following = result[tokenIndex + 1];
        if (!following || token.k !== previous.k ||
            following.k !== previous.k) {
          return false;
        }
        return Math.abs((token.t1 + following.t0) / 2 - center) <= 0.12;
      });
      // GAME sometimes keeps a nuanced return turn inside one broad anchor
      // note, so there is no neural boundary to confirm it. Accept containment
      // as the independent evidence only when the raw target is tightly
      // centred, both anchor sides are sustained, and the gesture is isolated
      // rather than one cycle of recurring vibrato/andolan.
      const anchorDuration = (
        previous.end - previous.start +
        next.end - next.start
      ) * hopSec;
      const leftAnchorDuration = (previous.end - previous.start) * hopSec;
      const rightAnchorDuration = (next.end - next.start) * hopSec;
      const containingAnchor = result.some((token) =>
        !token.glide && !token.andolan && token.k === previous.k &&
        token.t0 <= candidate.t0 - 0.04 &&
        token.t1 >= candidate.t1 + 0.04
      );
      let nearbyMatchingTurns = 0;
      for (let otherIndex = 1; otherIndex + 1 < runs.length; otherIndex++) {
        const other = runs[otherIndex];
        if (other.k !== run.k ||
            runs[otherIndex - 1].k !== previous.k ||
            runs[otherIndex + 1].k !== previous.k) {
          continue;
        }
        const otherCenter = (other.start + other.end) * hopSec / 2;
        if (Math.abs(otherCenter - center) <= 0.45) nearbyMatchingTurns++;
      }
      const containedPlateau = containingAnchor &&
        duration >= 0.055 &&
        duration <= 0.12 &&
        Math.abs(run.k - previous.k) === 1 &&
        bestPlateau * hopSec >= 0.045 &&
        Math.abs(landingMedian - run.k * 100) <= 22 &&
        anchorDuration >= 0.16 &&
        leftAnchorDuration >= 0.025 &&
        rightAnchorDuration >= 0.025 &&
        (nearbyMatchingTurns <= 1 || (onsets || []).some((time) =>
          Math.abs(time * hopSec - center) <= 0.12
        ));
      const existingHit = result.some((token) =>
        token.k === candidate.k &&
        Math.min(token.t1, candidate.t1) -
          Math.max(token.t0, candidate.t0) >= 0.025
      );
      if ((!neuralBoundary && !containedPlateau) ||
          existingHit || wasSuppressed(candidate)) {
        continue;
      }
      insertTurn(previous, candidate, next);
    }
    // A nuanced turn can contain one still-smaller traversal, for example
    // S-N-n-N-S. The 20 ms inner n is transition geometry, but the two N
    // plateaus together form one clearly reached target. Recover only this
    // symmetric nested shape inside a broad neural anchor; arbitrary multi-run
    // movement remains untouched.
    for (let first = 1; first + 3 < runs.length; first++) {
      const previous = runs[first - 1];
      for (let last = first + 2;
        last <= Math.min(first + 3, runs.length - 2);
        last++) {
        const next = runs[last + 1];
        const excursion = runs.slice(first, last + 1);
        const targetK = excursion[0].k;
        if (previous.k !== next.k || targetK !== excursion[excursion.length - 1].k ||
            targetK === previous.k || Math.abs(targetK - previous.k) > 2) {
          continue;
        }
        const direction = Math.sign(targetK - previous.k);
        const sameSide = excursion.every((part) =>
          part.k !== previous.k &&
          Math.sign(part.k - previous.k) === direction &&
          Math.abs(part.k - previous.k) <= 2
        );
        let connected = true;
        for (let part = 1; part < excursion.length; part++) {
          if ((excursion[part].start - excursion[part - 1].end) * hopSec > 0.02) {
            connected = false;
            break;
          }
        }
        if (!sameSide || !connected) continue;

        const candidate = {
          t0: excursion[0].start * hopSec,
          t1: excursion[excursion.length - 1].end * hopSec,
          k: targetK,
        };
        const duration = candidate.t1 - candidate.t0;
        const targetValues = excursion
          .filter((part) => part.k === targetK)
          .flatMap((part) => part.values);
        const targetFrames = excursion
          .filter((part) => part.k === targetK)
          .reduce((sum, part) => sum + part.end - part.start, 0);
        const targetEntryFrames = excursion[0].end - excursion[0].start;
        const targetReturnFrames =
          excursion[excursion.length - 1].end -
          excursion[excursion.length - 1].start;
        const sortedValues = targetValues.slice().sort((a, b) => a - b);
        const landingMedian = sortedValues[sortedValues.length >> 1];
        const leftAnchor = (previous.end - previous.start) * hopSec;
        const rightAnchor = (next.end - next.start) * hopSec;
        const containingAnchor = result.some((token) =>
          !token.glide && !token.andolan && token.k === previous.k &&
          token.t0 <= candidate.t0 - 0.04 &&
          token.t1 >= candidate.t1 + 0.04
        );
        const existingHit = result.some((token) =>
          token.k === candidate.k &&
          Math.min(token.t1, candidate.t1) -
            Math.max(token.t0, candidate.t0) >= 0.025
        );
        if (!containingAnchor || duration < 0.09 || duration > 0.18 ||
            targetFrames * hopSec < 0.07 ||
            targetEntryFrames * hopSec < 0.04 ||
            targetReturnFrames * hopSec < 0.04 ||
            Math.abs(landingMedian - targetK * 100) > 24 ||
            leftAnchor < 0.055 || rightAnchor < 0.055 ||
            existingHit || wasSuppressed(candidate)) {
          continue;
        }
        insertTurn(previous, candidate, next, { nestedTurn: true });
        break;
      }
    }
    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.rawLandmark || token.rawLandmark)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.rawLandmark = true;
        previous.hybridOrnament = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  /**
   * Recover a compact sequence of stable pitch landings when GAME compresses a
   * whole fast murki into one or two broad regions. Quantized crossing frames
   * are deliberately excluded: a candidate must spend at least 30 ms centred
   * on the swara and must not drift straight through it. The sequence also
   * needs either multiple varied reversals or one compact return, plus a broad
   * non-andolan neural region that independently proves model compression.
   */
  function fuseRawMurkiClusters(tokens, f0, clarity, hopSec, saHz, thresh) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const landings = [];
    for (const run of runs) {
      const duration = (run.end - run.start) * hopSec;
      if (duration < 0.04 || duration > 0.32) continue;
      const sorted = run.values.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      if (Math.abs(median - run.k * 100) > 34) continue;
      let centeredFrames = 0;
      for (const cents of run.values) {
        if (Math.abs(cents - run.k * 100) <= 35) centeredFrames++;
      }
      if (centeredFrames * hopSec <
          Math.max(0.03, duration * 0.55) - 1e-9) {
        continue;
      }
      // A run that enters one side and leaves the other is a crossing even if
      // its median happens to sit on the swara.
      if (Math.abs(run.values[run.values.length - 1] - run.values[0]) > 65) {
        continue;
      }
      const candidate = {
        t0: run.start * hopSec,
        t1: run.end * hopSec,
        k: run.k,
      };
      const sortedClarity = run.confidences.slice().sort((a, b) => a - b);
      candidate.clarityFloor = sortedClarity[
        Math.floor((sortedClarity.length - 1) * 0.2)
      ];
      candidate.clarityMedian = sortedClarity[
        Math.floor(sortedClarity.length / 2)
      ];
      if (candidate.clarityFloor < Math.max(0.84, thresh) ||
          candidate.clarityMedian < Math.max(0.90, thresh)) {
        continue;
      }
      landings.push(candidate);
    }
    if (landings.length < 3) return tokens;

    const chains = [];
    for (const landing of landings) {
      const chain = chains[chains.length - 1];
      const previous = chain && chain[chain.length - 1];
      if (previous &&
          landing.t0 - previous.t1 <= 0.15 &&
          Math.abs(landing.k - previous.k) <= 6) {
        chain.push(landing);
      } else {
        chains.push([landing]);
      }
    }

    const recoveries = [];
    for (const chain of chains) {
      if (chain.length < 3) continue;
      const turns = [];
      for (let index = 1; index + 1 < chain.length; index++) {
        const incoming = chain[index].k - chain[index - 1].k;
        const outgoing = chain[index + 1].k - chain[index].k;
        if (incoming * outgoing < 0 &&
            Math.abs(incoming) <= 5 &&
            Math.abs(outgoing) <= 5) {
          turns.push(index);
        }
      }
      const components = [];
      for (const turn of turns) {
        const first = turn - 1;
        const last = turn + 1;
        const previous = components[components.length - 1];
        const mergedSpan = previous
          ? (chain[last].t0 + chain[last].t1) / 2 -
            (chain[previous.first].t0 + chain[previous.first].t1) / 2
          : 0;
        if (previous && first <= previous.last + 1 && mergedSpan <= 1.35) {
          previous.last = Math.max(previous.last, last);
          previous.turns++;
        } else {
          components.push({ first, last, turns: 1 });
        }
      }

      for (const component of components) {
        const sequence = chain.slice(component.first, component.last + 1);
        const classicReturn = sequence.length === 3 &&
          component.turns === 1 &&
          sequence[0].k === sequence[2].k &&
          Math.abs(sequence[1].k - sequence[0].k) <= 2 &&
          sequence[1].t1 - sequence[1].t0 <= 0.18 &&
          sequence[0].t1 - sequence[0].t0 <= 0.45 &&
          sequence[2].t1 - sequence[2].t0 <= 0.45;
        const variedCluster = sequence.length >= 4 &&
          component.turns >= 2 &&
          new Set(sequence.map((landing) => landing.k)).size >= 3;
        const repeatedReturn = sequence.length >= 5 &&
          component.turns >= 3 &&
          new Set(sequence.map((landing) => landing.k)).size === 2 &&
          Math.abs(sequence[1].k - sequence[0].k) >= 2 &&
          sequence.every((landing, index) =>
            index === 0 || landing.k !== sequence[index - 1].k
          );
        if (!classicReturn && !variedCluster && !repeatedReturn) continue;
        const centers = sequence.map((landing) =>
          (landing.t0 + landing.t1) / 2
        );
        const sequenceSpan = centers[centers.length - 1] - centers[0];
        if (sequenceSpan > (repeatedReturn ? 1.30 : (variedCluster ? 1.00 : 0.90))) {
          continue;
        }
        if (classicReturn &&
            sequenceSpan > 0.55) {
          continue;
        }
        const intervals = [];
        for (let index = 1; index < centers.length; index++) {
          intervals.push(centers[index] - centers[index - 1]);
        }
        intervals.sort((a, b) => a - b);
        if (intervals[intervals.length >> 1] >
            (classicReturn ? 0.30 : (repeatedReturn ? 0.22 : 0.18))) {
          continue;
        }

        const start = sequence[0].t0;
        const end = sequence[sequence.length - 1].t1;
        const overlapping = tokens.filter((token) =>
          token.t1 > start && token.t0 < end
        );
        if (!overlapping.length ||
            overlapping.some((token) => token.andolan)) {
          continue;
        }
        const compressed = overlapping.some((token) => {
          if (token.t1 - token.t0 < 0.16) return false;
          let coveredLandings = 0;
          for (const landing of sequence) {
            const center = (landing.t0 + landing.t1) / 2;
            if (center >= token.t0 && center <= token.t1) coveredLandings++;
          }
          return coveredLandings >= 2;
        });
        if (!compressed) continue;
        const missing = sequence.filter((landing) => !tokens.some((token) => {
          if (token.k !== landing.k) return false;
          const overlap = Math.min(token.t1, landing.t1) -
            Math.max(token.t0, landing.t0);
          return overlap >= Math.min(
            0.025,
            (landing.t1 - landing.t0) * 0.4
          );
        }));
        if (!missing.length) continue;
        if (classicReturn && missing.length === 1) {
          const middle = sequence[1];
          if (!missing.includes(middle)) continue;
          const representedFlank = (landing) => tokens.some((token) =>
            token.k === landing.k &&
            Math.min(token.t1, landing.t1) -
              Math.max(token.t0, landing.t0) >= 0.025
          );
          if (!representedFlank(sequence[0]) ||
              !representedFlank(sequence[2])) {
            continue;
          }
          const conflictingTarget = tokens.some((token) =>
            token.k !== middle.k &&
            token.k !== sequence[0].k &&
            Math.min(token.t1, middle.t1) -
              Math.max(token.t0, middle.t0) >= 0.025
          );
          if (conflictingTarget) continue;
        }
        recoveries.push(sequence);
      }
    }
    if (!recoveries.length) return tokens;

    let result = tokens.slice();
    for (const sequence of recoveries) {
      const rawStart = sequence[0].t0;
      const rawEnd = sequence[sequence.length - 1].t1;
      const replacements = sequence.map((landing) => ({
        t0: landing.t0,
        t1: landing.t1,
        k: landing.k,
        cents: landing.k * 100,
        hybridOrnament: true,
        rawLandmark: true,
        rawMurkiCluster: true,
      }));
      for (let index = 1; index < replacements.length; index++) {
        const boundary = (
          sequence[index - 1].t1 + sequence[index].t0
        ) / 2;
        replacements[index - 1].t1 = boundary;
        replacements[index].t0 = boundary;
      }
      const preserved = [];
      for (const token of result) {
        if (token.t1 <= rawStart || token.t0 >= rawEnd) {
          preserved.push(token);
          continue;
        }
        if (token.t0 < rawStart - 0.025) {
          preserved.push(Object.assign({}, token, { t1: rawStart }));
        }
        if (token.t1 > rawEnd + 0.025) {
          preserved.push(Object.assign({}, token, { t0: rawEnd }));
        }
      }
      result = preserved.concat(replacements).sort((a, b) => a.t0 - b.t0);
    }

    const joined = [];
    for (const token of result) {
      const previous = joined[joined.length - 1];
      if (previous && previous.k === token.k &&
          token.t0 - previous.t1 <= 0.03 &&
          (previous.rawMurkiCluster || token.rawMurkiCluster)) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.rawLandmark = true;
        previous.hybridOrnament = true;
        previous.rawMurkiCluster = true;
      } else {
        joined.push(token);
      }
    }
    return joined;
  }

  function insertRawLandmark(tokens, candidate, flags) {
    const existing = tokens.some((token) =>
      token.k === candidate.k &&
      Math.min(token.t1, candidate.t1) -
        Math.max(token.t0, candidate.t0) >= 0.015
    );
    if (existing) return tokens;
    const preserved = [];
    for (const token of tokens) {
      if (token.t1 <= candidate.t0 || token.t0 >= candidate.t1) {
        preserved.push(token);
        continue;
      }
      if (candidate.t0 - token.t0 >= 0.025) {
        preserved.push(Object.assign({}, token, { t1: candidate.t0 }));
      }
      if (token.t1 - candidate.t1 >= 0.025) {
        preserved.push(Object.assign({}, token, { t0: candidate.t1 }));
      }
    }
    preserved.push(Object.assign({
      t0: candidate.t0,
      t1: candidate.t1,
      k: candidate.k,
      cents: candidate.k * 100,
      hybridOrnament: true,
      rawLandmark: true,
    }, flags || {}));
    return preserved.sort((a, b) => a.t0 - b.t0);
  }

  /**
   * A rapidly repeated turn can make each extreme too short for the ordinary
   * landing threshold. Three recurring, same-pitch reversals inside one broad
   * neural note provide stronger evidence than any individual 20–40 ms touch.
   * Requiring a two-semitone excursion keeps normal adjacent-note vibrato out.
   */
  function fuseRepeatedRawExtrema(tokens, f0, clarity, hopSec, saHz, thresh) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    const extrema = [];
    for (let index = 1; index + 1 < runs.length; index++) {
      const previous = runs[index - 1];
      const run = runs[index];
      const next = runs[index + 1];
      const duration = (run.end - run.start) * hopSec;
      const connected = (run.start - previous.end) * hopSec <= 0.02 &&
        (next.start - run.end) * hopSec <= 0.02;
      const turning = (
        run.k < previous.k && run.k < next.k
      ) || (
        run.k > previous.k && run.k > next.k
      );
      if (!connected || !turning || duration < 0.025 || duration > 0.11) {
        continue;
      }
      const t0 = run.start * hopSec;
      const t1 = run.end * hopSec;
      const container = tokens.find((token) =>
        !token.andolan &&
        token.t1 - token.t0 >= 0.40 &&
        token.t0 <= t0 - 0.015 &&
        token.t1 >= t1 + 0.015 &&
        Math.abs(token.k - run.k) >= 2 &&
        Math.abs(token.k - run.k) <= 4
      );
      if (!container) continue;
      const centered = run.values.filter((cents) =>
        Math.abs(cents - run.k * 100) <= 35
      ).length * hopSec;
      const sortedClarity = run.confidences.slice().sort((a, b) => a - b);
      const clarityFloor = sortedClarity[
        Math.floor((sortedClarity.length - 1) * 0.20)
      ];
      if (centered + 1e-9 < 0.01 ||
          clarityFloor < Math.max(0.88, thresh)) {
        continue;
      }
      extrema.push({
        t0,
        t1,
        k: run.k,
        centered,
        container,
      });
    }
    let result = tokens.slice();
    for (let first = 0; first < extrema.length; first++) {
      const seed = extrema[first];
      const group = extrema.filter((candidate) =>
        candidate.container === seed.container &&
        candidate.k === seed.k &&
        candidate.t0 >= seed.t0 - 1e-9 &&
        candidate.t1 - seed.t0 <= 1.35
      );
      const strong = group.filter((candidate) =>
        candidate.centered + 1e-9 >= 0.02
      );
      if (group.length < 3 || strong.length < 2) continue;
      let regular = true;
      for (let index = 1; index < strong.length; index++) {
        const interval = (
          strong[index].t0 + strong[index].t1 -
          strong[index - 1].t0 - strong[index - 1].t1
        ) / 2;
        if (interval < 0.10 || interval > 0.38) {
          regular = false;
          break;
        }
      }
      if (!regular) continue;
      for (const candidate of group) {
        result = insertRawLandmark(result, candidate, {
          rawMurkiCluster: true,
          repeatedExtremumConsensus: true,
        });
      }
      first += group.length - 1;
    }
    return result;
  }

  /**
   * Preserve the reached pitch around one still-smaller inner traversal, such
   * as r-S-N-S-r, even when the surrounding neural anchor is one semitone away.
   * The two target plateaus are combined into one readable murki landmark.
   */
  function fuseNestedRawLandmarks(tokens, f0, clarity, hopSec, saHz, thresh) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    const runs = rawPitchRuns(f0, clarity, hopSec, saHz, thresh);
    let result = tokens.slice();
    for (let first = 1; first + 3 < runs.length; first++) {
      const sideIn = runs[first - 1];
      const targetIn = runs[first];
      const inner = runs[first + 1];
      const targetOut = runs[first + 2];
      const sideOut = runs[first + 3];
      if (targetIn.k !== targetOut.k ||
          sideIn.k !== sideOut.k ||
          Math.abs(targetIn.k - sideIn.k) !== 1 ||
          Math.abs(inner.k - targetIn.k) !== 1 ||
          Math.sign(inner.k - targetIn.k) !==
            Math.sign(targetIn.k - sideIn.k)) {
        continue;
      }
      const parts = [targetIn, inner, targetOut];
      let connected = true;
      for (let index = 1; index < parts.length; index++) {
        if ((parts[index].start - parts[index - 1].end) * hopSec > 0.02) {
          connected = false;
          break;
        }
      }
      const t0 = targetIn.start * hopSec;
      const t1 = targetOut.end * hopSec;
      const span = t1 - t0;
      const targetDuration = (
        targetIn.end - targetIn.start +
        targetOut.end - targetOut.start
      ) * hopSec;
      if (!connected || span < 0.06 || span > 0.14 ||
          targetDuration < 0.045 ||
          (targetIn.end - targetIn.start) * hopSec < 0.02 ||
          (targetOut.end - targetOut.start) * hopSec < 0.02) {
        continue;
      }
      const targetValues = targetIn.values.concat(targetOut.values);
      const centered = targetValues.filter((cents) =>
        Math.abs(cents - targetIn.k * 100) <= 40
      ).length * hopSec;
      const confidences = targetIn.confidences
        .concat(inner.confidences, targetOut.confidences)
        .sort((a, b) => a - b);
      const clarityFloor = confidences[
        Math.floor((confidences.length - 1) * 0.20)
      ];
      const containing = result.some((token) =>
        !token.andolan &&
        token.t1 - token.t0 >= 0.28 &&
        token.t0 <= t0 - 0.025 &&
        token.t1 >= t1 + 0.025 &&
        Math.abs(token.k - sideIn.k) <= 1
      );
      if (!containing || centered < 0.025 ||
          clarityFloor < Math.max(0.88, thresh)) {
        continue;
      }
      result = insertRawLandmark(result, {
        t0,
        t1,
        k: targetIn.k,
      }, {
        rawNestedLandmark: true,
      });
    }
    return result;
  }

  /**
   * Keep repeated, time-compressed murkis structurally consistent. The same
   * three-note entry must occur at least three times, and the first (usually
   * slowest) rendition must expose a varied ornament sequence. Later renditions
   * inherit those targets at normalized times; their own contour still decides
   * whether each connector is a step, bend or meend.
   */
  function harmonizeRepeatedMurkiMotifs(tokens) {
    if (!tokens || tokens.length < 12) return tokens || [];
    const source = tokens.slice().sort((a, b) => a.t0 - b.t0);
    const seedGroups = new Map();
    for (let index = 0; index + 2 < source.length; index++) {
      const seed = source.slice(index, index + 3);
      const span = seed[2].t1 - seed[0].t0;
      const connected = seed[1].t0 - seed[0].t1 <= 0.12 &&
        seed[2].t0 - seed[1].t1 <= 0.12;
      if (!connected || span > 0.48 ||
          seed.some((token) => token.t1 - token.t0 > 0.30) ||
          new Set(seed.map((token) => token.k)).size < 3) {
        continue;
      }
      const key = seed.map((token) => token.k).join(',');
      if (!seedGroups.has(key)) seedGroups.set(key, []);
      seedGroups.get(key).push(index);
    }

    const candidates = [];
    for (const indexes of seedGroups.values()) {
      const spaced = [];
      for (const index of indexes) {
        const previous = spaced[spaced.length - 1];
        if (previous == null ||
            source[index].t0 - source[previous].t0 >= 0.35) {
          spaced.push(index);
        }
      }
      if (spaced.length < 3) continue;
      for (let start = 0; start + 2 < spaced.length; start++) {
        const group = spaced.slice(start, start + 3);
        const starts = group.map((index) => source[index].t0);
        const periods = [starts[1] - starts[0], starts[2] - starts[1]];
        if (periods.some((period) => period < 0.35 || period > 1.60) ||
            Math.max(...periods) / Math.min(...periods) > 1.45) {
          continue;
        }
        candidates.push({ indexes: group, starts, periods });
      }
    }
    if (!candidates.length) return source;

    let result = source;
    const used = [];
    for (const candidate of candidates) {
      const templateStart = candidate.starts[0];
      const templateEnd = candidate.starts[1];
      if (used.some((range) =>
        templateStart < range.t1 && candidate.starts[2] > range.t0)) {
        continue;
      }
      const template = source.filter((token) =>
        token.t0 >= templateStart - 1e-6 &&
        token.t0 < templateEnd - 1e-6
      );
      const uniqueTargets = new Set(template.map((token) => token.k));
      let turns = 0;
      for (let index = 1; index + 1 < template.length; index++) {
        if ((template[index].k - template[index - 1].k) *
            (template[index + 1].k - template[index].k) < 0) {
          turns++;
        }
      }
      const rawEvidence = source.some((token) =>
        token.t0 >= templateStart &&
        token.t0 < candidate.starts[2] + candidate.periods[1] &&
        token.rawMurkiCluster
      );
      if (template.length < 6 || template.length > 12 ||
          uniqueTargets.size < 3 || turns < 3 || !rawEvidence) {
        continue;
      }

      for (let repeat = 1; repeat < 3; repeat++) {
        const repeatStart = candidate.starts[repeat];
        let repeatEnd = repeat < 2
          ? candidate.starts[repeat + 1]
          : repeatStart + candidate.periods[1];
        if (repeat === 2) {
          const expected = candidate.periods[1];
          const finalK = template[template.length - 1].k;
          const ending = source
            .filter((token) =>
              token.k === finalK &&
              token.t1 >= repeatStart + expected * 0.55 &&
              token.t1 <= repeatStart + expected * 1.25
            )
            .sort((a, b) =>
              Math.abs((a.t1 - repeatStart) - expected) -
              Math.abs((b.t1 - repeatStart) - expected)
            )[0];
          if (ending) repeatEnd = ending.t1;
        }
        if (repeatEnd - repeatStart < 0.30) continue;

        const templateDuration = templateEnd - templateStart;
        const repeatDuration = repeatEnd - repeatStart;
        const replacements = template.map((token) => {
          const t0 = repeatStart +
            (token.t0 - templateStart) / templateDuration * repeatDuration;
          const t1 = repeatStart +
            (token.t1 - templateStart) / templateDuration * repeatDuration;
          return Object.assign({}, token, {
            t0,
            t1: Math.max(t0 + 0.025, t1),
            cents: token.k * 100,
            hybridOrnament: true,
            repeatedMurkiConsensus: true,
          });
        });
        const preserved = [];
        for (const token of result) {
          if (token.t1 <= repeatStart || token.t0 >= repeatEnd) {
            preserved.push(token);
            continue;
          }
          if (token.t0 < repeatStart - 0.025) {
            preserved.push(Object.assign({}, token, { t1: repeatStart }));
          }
          if (token.t1 > repeatEnd + 0.025) {
            preserved.push(Object.assign({}, token, { t0: repeatEnd }));
          }
        }
        result = preserved.concat(replacements)
          .sort((a, b) => a.t0 - b.t0);
      }
      used.push({
        t0: templateStart,
        t1: candidate.starts[2] + candidate.periods[1],
      });
    }
    return result;
  }

  /**
   * Convert singing-specific neural note regions to swara tokens. GAME already
   * supplies the primary boundaries. A conservative frame-level fusion restores
   * only stable turning notes that GAME hid inside a broad ornament region.
   */
  /**
   * Vibrato is a periodic pitch oscillation around one held swara, not a murki.
   * The raw-contour recovery passes cannot tell the two apart from a single
   * excursion, so a quick inserted touch that sits inside a regular 4–10 Hz
   * train of alternating extrema centred on its neighbouring note is folded
   * back into that note. Sparse touches (fewer than two full cycles) and
   * irregular murki runs keep their notes.
   */
  function vibratoTrainAround(f0, clarity, hopSec, saHz, thresh, tCenter) {
    const hysteresis = 25;
    const first = Math.max(0, Math.floor((tCenter - 0.45) / hopSec));
    const last = Math.min(f0.length, Math.ceil((tCenter + 0.45) / hopSec));
    const extrema = [];
    let direction = 0, extreme = NaN, extremeIndex = -1;
    for (let frame = first; frame < last; frame++) {
      if (!(f0[frame] > 0) || clarity[frame] < thresh) {
        // A voicing gap ends the train: vibrato rides one sustained tone.
        if (frame * hopSec < tCenter) extrema.length = 0;
        else break;
        direction = 0;
        extreme = NaN;
        continue;
      }
      const cents = 1200 * Math.log2(f0[frame] / saHz);
      if (Number.isNaN(extreme)) {
        extreme = cents;
        extremeIndex = frame;
      } else if (direction >= 0 && cents < extreme - hysteresis) {
        if (direction > 0) extrema.push({ t: extremeIndex * hopSec, cents: extreme });
        direction = -1;
        extreme = cents;
        extremeIndex = frame;
      } else if (direction <= 0 && cents > extreme + hysteresis) {
        if (direction < 0) extrema.push({ t: extremeIndex * hopSec, cents: extreme });
        direction = 1;
        extreme = cents;
        extremeIndex = frame;
      } else if ((direction >= 0 && cents > extreme) ||
          (direction <= 0 && cents < extreme)) {
        extreme = cents;
        extremeIndex = frame;
      }
    }
    if (extrema.length < 5) return null;
    const intervals = [];
    const swings = [];
    for (let i = 1; i < extrema.length; i++) {
      intervals.push(extrema[i].t - extrema[i - 1].t);
      swings.push(Math.abs(extrema[i].cents - extrema[i - 1].cents));
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) /
      values.length;
    const halfPeriod = mean(intervals);
    const spread = Math.sqrt(mean(intervals.map((value) =>
      (value - halfPeriod) * (value - halfPeriod))));
    const swing = mean(swings);
    if (halfPeriod < 0.05 || halfPeriod > 0.13 || spread / halfPeriod > 0.35 ||
        swing > 180) {
      return null;
    }
    return { center: mean(extrema.map((point) => point.cents)) };
  }

  function suppressVibratoOrnaments(tokens, f0, clarity, hopSec, saHz, thresh) {
    if (!tokens.length || !f0 || !clarity || !(hopSec > 0)) return tokens;
    // Relabel each quick inserted touch that rides a vibrato train back to the
    // swara the train oscillates around …
    let folded = false;
    for (const token of tokens) {
      if (!token.hybridOrnament || token.manualCorrection ||
          token.t1 - token.t0 >= 0.16) {
        continue;
      }
      const train = vibratoTrainAround(
        f0, clarity, hopSec, saHz, thresh, (token.t0 + token.t1) / 2
      );
      if (!train || Math.abs(token.k * 100 - train.center) <= 40) continue;
      token.k = Math.round(train.center / 100);
      token.cents = train.center;
      token.vibrato = true;
      for (const flag of ['hybridOrnament', 'rawLandmark', 'rawMurkiCluster',
        'nestedTurn', 'rawNestedLandmark', 'repeatedExtremumConsensus']) {
        delete token[flag];
      }
      folded = true;
    }
    if (!folded) return tokens;
    // … then merge it with the held note on either side.
    const result = [];
    for (const token of tokens) {
      const previous = result[result.length - 1];
      if (previous && previous.k === token.k && token.t0 - previous.t1 <= 0.06 &&
          (previous.vibrato || token.vibrato) &&
          !previous.manualCorrection && !token.manualCorrection) {
        previous.t1 = Math.max(previous.t1, token.t1);
        previous.vibrato = true;
        continue;
      }
      result.push(token);
    }
    return result;
  }

  function notateRegions(regions, f0, clarity, hopSec, saHz, opts) {
    opts = opts || {};
    const clean = opts.clean === true;
    const ornaments = opts.ornaments !== false;
    const thresh = opts.clarityThresh != null ? opts.clarityThresh : 0.5;
    const lineGapSec = opts.lineGapSec != null ? opts.lineGapSec : (clean ? 1.0 : 0.6);
    const rms = opts.rms;
    let tokens = [];
    const suppressedTurns = [];

    for (const region of regions || []) {
      const t0 = Number(region.onset != null ? region.onset : region.t0);
      const t1 = Number(region.offset != null ? region.offset : region.t1);
      const frequency = region.frequency > 0
        ? Number(region.frequency)
        : 440 * Math.pow(2, (Number(region.midi) - 69) / 12);
      if (!(t0 >= 0) || !(t1 > t0) || !(frequency > 0)) continue;

      const noteCents = 1200 * Math.log2(frequency / saHz);
      const contour = [];
      let confidenceSum = 0, loudnessSum = 0, frameCount = 0;
      const i0 = Math.max(0, Math.floor(t0 / hopSec));
      const i1 = Math.min(f0 ? f0.length : 0, Math.ceil(t1 / hopSec));
      for (let i = i0; i < i1; i++) {
        if (f0[i] > 0 && (!clarity || clarity[i] >= thresh)) {
          contour.push(1200 * Math.log2(f0[i] / saHz));
        }
        if (clarity) confidenceSum += clarity[i] || 0;
        if (rms) loudnessSum += rms[i] || 0;
        frameCount++;
      }

      const character = ornaments && contour.length >= 2
        ? analyzeToken(contour, 0, contour.length, hopSec)
        : { mean: noteCents, meend: false, andolan: false };
      const token = {
        t0,
        t1,
        k: Math.round(noteCents / 100),
        learnedK: Math.round(noteCents / 100),
        cents: contour.length ? character.mean : noteCents,
        meend: !!character.meend,
        andolan: !!character.andolan,
        neural: true,
        _contour: contour,
      };
      if (character.andolan) {
        token.andolanLo = character.andolanLo;
        token.andolanHi = character.andolanHi;
      }
      if (frameCount) {
        token.conf = confidenceSum / frameCount;
        token.loud = loudnessSum / frameCount;
      }
      tokens.push(token);
    }

    tokens.sort((a, b) => a.t0 - b.t0);
    if (clean && rms && clarity) {
      tokens = rejectInstrumentalPitchLeakage(tokens, thresh);
    }
    let frameTokens = [];
    if (ornaments && f0 && clarity && hopSec > 0) {
      const frameOpts = Object.assign({}, opts, {
        ornaments: true,
        ornMinMs: Math.min(
          opts.ornMinMs != null ? opts.ornMinMs : 30,
          25
        ),
        landingCenterCents: opts.landingCenterCents != null
          ? opts.landingCenterCents
          : 45,
      });
      frameTokens = notate(
        f0,
        clarity,
        hopSec,
        saHz,
        frameOpts
      ).tokens;
    }
    if (clean) {
      // GAME can average a stable entry note together with its outgoing glide
      // and place the whole region one semitone toward the destination. When a
      // frame-level plateau begins with the region and lasts long enough to be
      // sung deliberately, use that landed pitch for the singer-facing label.
      for (const token of tokens) {
        let entry = null;
        for (const frameToken of frameTokens) {
          const duration = frameToken.t1 - frameToken.t0;
          const overlap = Math.min(token.t1, frameToken.t1) -
            Math.max(token.t0, frameToken.t0);
          if (Math.abs(frameToken.k - token.k) !== 1 ||
              duration < 0.075 || overlap < 0.07 ||
              frameToken.t0 < token.t0 - 0.035 ||
              frameToken.t0 > token.t0 + 0.06) {
            continue;
          }
          if (!entry || overlap > entry.overlap) {
            entry = { frameToken, overlap };
          }
        }
        if (entry) {
          // A short overshoot at the region entrance can look like an adjacent
          // plateau even though GAME correctly labelled the longer pitch it
          // resolves onto. Keep that neural target when frame evidence returns
          // to it and remains there materially longer than the entry touch.
          const entryOverlap = entry.overlap;
          const returnPlateau = frameTokens.some((frameToken) => {
            if (frameToken.k !== token.k ||
                frameToken.t0 < entry.frameToken.t1 - 0.025) {
              return false;
            }
            const overlap = Math.min(token.t1, frameToken.t1) -
              Math.max(token.t0, frameToken.t0);
            return overlap >= 0.09 &&
              overlap >= entryOverlap + 0.025;
          });
          if (returnPlateau) continue;
          token.k = entry.frameToken.k;
          token.entryPlateauSnap = true;
          continue;
        }
        const learnedReturn = frameTokens.some((frameToken) => {
          if (frameToken.k !== token.learnedK ||
              frameToken.t1 < token.t0 + 0.12) {
            return false;
          }
          const overlap = Math.min(token.t1, frameToken.t1) -
            Math.max(token.t0, frameToken.t0);
          return overlap >= 0.09;
        });
        if (learnedReturn) continue;
        const startFrame = Math.max(0, Math.floor(token.t0 / hopSec));
        const endFrame = Math.min(
          f0 ? f0.length : 0,
          Math.ceil(Math.min(token.t1, token.t0 + 0.14) / hopSec)
        );
        const counts = new Map();
        for (let frame = startFrame; frame < endFrame; frame++) {
          if (!(f0[frame] > 0) || (clarity && clarity[frame] < thresh)) continue;
          const k = Math.round(12 * Math.log2(f0[frame] / saHz));
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        let landedK = token.k, landedFrames = 0;
        for (const [k, count] of counts) {
          if (count > landedFrames) {
            landedK = k;
            landedFrames = count;
          }
        }
        if (Math.abs(landedK - token.k) === 1 &&
            landedFrames * hopSec >= 0.075 &&
            token.t1 - token.t0 >= 0.20) {
          token.k = landedK;
          token.entryPlateauSnap = true;
        }
      }

      // GAME occasionally inserts a boundary inside one held note. Merge it
      // only when the source track stays voiced, close to the shared swara and
      // energetic across the boundary. Re-articulations with a pitch/energy
      // break remain separate notes.
      if (rms && f0 && clarity && hopSec > 0) {
        const merged = [];
        const median = (values) => {
          if (!values.length) return 0;
          values.sort((a, b) => a - b);
          return values[values.length >> 1];
        };
        const continuousBoundary = (left, right) => {
          if (left.k !== right.k || right.t0 - left.t1 > 0.03) return false;
          const boundary = (left.t1 + right.t0) / 2;
          const boundaryOnset = (opts.onsets || []).some((frame) =>
            Math.abs(frame * hopSec - boundary) <= Math.max(0.06, 3 * hopSec)
          );
          // Server v4 onsets come from the isolated vocal articulation detector,
          // independently of GAME. A nearby onset therefore means the singer
          // re-struck the note even when GAME placed its boundary a few frames
          // later.
          if (boundaryOnset) return false;
          const spanningFrame = frameTokens.some((frameToken) =>
            frameToken.k === left.k &&
            frameToken.t0 <= boundary - 0.02 &&
            frameToken.t1 >= boundary + 0.02
          );
          if (!spanningFrame) return false;
          const center = Math.round(boundary / hopSec);
          const radius = Math.max(2, Math.round(0.025 / hopSec));
          let leftVoiced = 0, rightVoiced = 0, silentRun = 0, maxSilentRun = 0;
          const leftRms = [], rightRms = [];
          for (let frame = center - radius; frame <= center + radius; frame++) {
            if (frame < 0 || frame >= f0.length) continue;
            const voiced = f0[frame] > 0 &&
              (!clarity || clarity[frame] >= thresh);
            if (voiced) {
              const cents = 1200 * Math.log2(f0[frame] / saHz);
              if (Math.abs(cents - left.k * 100) > 70) return false;
              if (frame < center) leftVoiced++;
              else rightVoiced++;
              silentRun = 0;
            } else {
              silentRun++;
              maxSilentRun = Math.max(maxSilentRun, silentRun);
            }
            const level = Number(rms[frame]);
            if (Number.isFinite(level) && level >= 0) {
              (frame < center ? leftRms : rightRms).push(level);
            }
          }
          if (leftVoiced < 2 || rightVoiced < 2 || maxSilentRun > 1) {
            return false;
          }
          const sideLevel = Math.min(median(leftRms), median(rightRms));
          const centerLevel = (
            Number(rms[Math.max(0, center - 1)]) +
            Number(rms[Math.min(rms.length - 1, center)])
          ) / 2;
          return sideLevel <= 0 ||
            (Number.isFinite(centerLevel) && centerLevel >= sideLevel * 0.45);
        };

        for (const token of tokens) {
          const previous = merged[merged.length - 1];
          if (!previous || !continuousBoundary(previous, token)) {
            merged.push(token);
            continue;
          }
          const previousDuration = previous.t1 - previous.t0;
          const tokenDuration = token.t1 - token.t0;
          const totalDuration = previousDuration + tokenDuration;
          previous.t1 = token.t1;
          previous.cents = totalDuration > 0
            ? (previous.cents * previousDuration +
              token.cents * tokenDuration) / totalDuration
            : previous.cents;
          previous.meend = previous.meend || token.meend;
          previous.andolan = previous.andolan || token.andolan;
          previous._contour = (previous._contour || [])
            .concat(token._contour || []);
          if (Number.isFinite(previous.conf) && Number.isFinite(token.conf)) {
            previous.conf = (previous.conf * previousDuration +
              token.conf * tokenDuration) / totalDuration;
          }
          if (Number.isFinite(previous.loud) && Number.isFinite(token.loud)) {
            previous.loud = (previous.loud * previousDuration +
              token.loud * tokenDuration) / totalDuration;
          }
        }
        tokens = merged;
      }

      // Fold a short one-semitone hook into the following target when its raw
      // contour enters from the previous note, turns, and leaves toward the
      // target. This is sung transition geometry, not a separate note landing.
      // The same rule handles a leading dip after a pause when it immediately
      // rebounds into a stronger adjacent target.
      for (let i = 0; i + 1 < tokens.length; i++) {
        const previous = i > 0 ? tokens[i - 1] : null;
        const token = tokens[i];
        const next = tokens[i + 1];
        const path = token._contour || [];
        const duration = token.t1 - token.t0;
        const previousConnected = !!previous &&
          token.t0 - previous.t1 <= 0.035;
        const nextConnected = next.t0 - token.t1 <= 0.035;
        if (!nextConnected || duration > 0.24 || path.length < 5) continue;

        let pathMin = path[0], pathMax = path[0];
        let extremeIndex = 0;
        const hookHigh = token.k > next.k;
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((hookHigh && path[p] > path[extremeIndex]) ||
              (!hookHigh && path[p] < path[extremeIndex])) {
            extremeIndex = p;
          }
        }
        const range = pathMax - pathMin;
        const endNearTarget = Math.abs(path[path.length - 1] - next.k * 100) <= 75;
        const turnsInside = extremeIndex > 0 &&
          extremeIndex < path.length - 2;
        const oneStepIntoTarget = Math.abs(token.k - next.k) === 1;
        const leadingBend = !previousConnected && oneStepIntoTarget &&
          range >= 75 && turnsInside && endNearTarget;

        let connectedHook = false;
        if (previousConnected) {
          const lo = Math.min(previous.k, next.k);
          const hi = Math.max(previous.k, next.k);
          const outside = Math.max(lo - token.k, token.k - hi, 0);
          const neighborSpan = Math.abs(next.k - previous.k);
          const startsAtPrevious = Math.abs(path[0] - previous.k * 100) <= 85;
          const approachesTarget =
            Math.abs(path[path.length - 1] - next.k * 100) + 35 <
            Math.abs(path[0] - next.k * 100);
          connectedHook = outside === 1 && neighborSpan <= 2 &&
            duration <= 0.16 && range >= 70 && turnsInside &&
            startsAtPrevious && approachesTarget;
        }
        if (!leadingBend && !connectedHook) continue;

        suppressedTurns.push({ t0: token.t0, t1: token.t1, k: token.k });
        next.t0 = token.t0;
        next.meendFromPrev = previousConnected;
        tokens.splice(i, 1);
        i--;
      }

      // GAME can split the bottom of one continuous rebound into a separate
      // note (for example G -> [dip to S] -> R). In Clean mode, fold that
      // overshoot into the target only when the robust contour enters from the
      // target side, turns inside the short region, and leaves the extreme
      // again. A flat short note and a G-R-G murki do not match this geometry.
      for (let i = 1; i + 1 < tokens.length; i++) {
        const previous = tokens[i - 1];
        const token = tokens[i];
        const next = tokens[i + 1];
        const path = token._contour || [];
        const nextStrictlyBetween = (
          token.k < next.k && next.k < previous.k
        ) || (
          previous.k < next.k && next.k < token.k
        );
        const connected = token.t0 - previous.t1 <= 0.035 &&
          next.t0 - token.t1 <= 0.035;
        if (!nextStrictlyBetween || !connected ||
            token.t1 - token.t0 > 0.18 || path.length < 5) {
          continue;
        }
        const centeredFrames = path.filter((cents) =>
          Math.abs(cents - token.k * 100) <= 45
        ).length;
        const beyondTarget = token.k > next.k
          ? Math.max(...path) - token.k * 100
          : token.k * 100 - Math.min(...path);
        const neuralLanding = token.neural &&
          (!Number.isFinite(token.conf) || token.conf >= 0.76) &&
          beyondTarget >= 35 &&
          centeredFrames * hopSec + 1e-9 >= Math.min(
            0.04,
            (token.t1 - token.t0) * 0.28
          );
        if (neuralLanding) continue;

        let extreme = path[0], extremeIndex = 0;
        let pathMin = path[0], pathMax = path[0];
        const lowOvershoot = token.k < next.k;
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((lowOvershoot && path[p] < extreme) ||
              (!lowOvershoot && path[p] > extreme)) {
            extreme = path[p];
            extremeIndex = p;
          }
        }
        const entered = Math.abs(path[0] - extreme);
        const recovered = Math.abs(path[path.length - 1] - extreme);
        const excursion = pathMax - pathMin;
        const requiredExcursion = Math.max(
          90,
          Math.abs(next.k - token.k) * 55
        );
        if (extremeIndex > 0 && extremeIndex < path.length - 2 &&
            entered >= 70 && recovered >= 35 &&
            excursion >= requiredExcursion) {
          suppressedTurns.push({
            t0: token.t0,
            t1: token.t1,
            k: token.k,
          });
          next.t0 = token.t0;
          tokens.splice(i, 1);
          i--;
        }
      }

      // A short neural region can also be a pitch crossed during a one-way
      // meend rather than a note the singer landed on. Fold that region into
      // the destination only when its contour travels strongly in the same
      // direction as both neighbours and the frame segmenter found no matching
      // stable note. The geometry remains visible as a bend into the next note.
      for (let i = 1; i + 1 < tokens.length; i++) {
        const previous = tokens[i - 1];
        const token = tokens[i];
        const next = tokens[i + 1];
        const direction = Math.sign(next.k - previous.k);
        const strictlyBetween = direction !== 0 &&
          (token.k - previous.k) * direction > 0 &&
          (next.k - token.k) * direction > 0;
        const connected = token.t0 - previous.t1 <= 0.035 &&
          next.t0 - token.t1 <= 0.035;
        const path = token._contour || [];
        if (!strictlyBetween || !connected ||
            token.t1 - token.t0 > 0.16 || path.length < 5) {
          continue;
        }

        const matchingLanding = frameTokens.some((frameToken) => {
          // GAME and frame f0 can disagree by one semitone when a fast landing
          // sits close to a komal/shuddh boundary. The presence of a stable
          // adjacent plateau still proves this is a note, not a monotonic pass.
          const pitchDistance = Math.abs(frameToken.k - token.k);
          if (pitchDistance > 1 ||
              (pitchDistance === 1 && frameToken.t1 - frameToken.t0 > 0.22)) {
            return false;
          }
          const overlap = Math.min(frameToken.t1, token.t1) -
            Math.max(frameToken.t0, token.t0);
          return overlap >= Math.min(0.04, (token.t1 - token.t0) * 0.35);
        });
        if (matchingLanding) continue;

        let orderedSteps = 0, pathMin = path[0], pathMax = path[0];
        for (let p = 1; p < path.length; p++) {
          pathMin = Math.min(pathMin, path[p]);
          pathMax = Math.max(pathMax, path[p]);
          if ((path[p] - path[p - 1]) * direction >= -18) orderedSteps++;
        }
        const netTravel = (path[path.length - 1] - path[0]) * direction;
        const orderedRatio = orderedSteps / (path.length - 1);
        if (netTravel < 80 || pathMax - pathMin < 90 ||
            orderedRatio < 0.68) {
          continue;
        }

        suppressedTurns.push({
          t0: token.t0,
          t1: token.t1,
          k: token.k,
        });
        next.t0 = token.t0;
        next.meendFromPrev = true;
        tokens.splice(i, 1);
        i--;
      }
    }
    if (clean && f0 && clarity && hopSec > 0) {
      tokens = fuseBroadEntryLandings(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh
      );
    }
    if (clean && f0 && clarity && hopSec > 0) {
      // A compact U-shaped bend can overshoot below Sa/Pa (or above it) for a
      // few frames even though the singer enters and returns through that fixed
      // swara. GAME may isolate only the extreme and label it as a separate
      // note. Keep the invariant Sa/Pa anchor when the extreme has no sustained
      // plateau and the following contour completes the return.
      for (let index = 0; index + 1 < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        const duration = token.t1 - token.t0;
        const direction = Math.sign(next.k - token.k);
        if (duration < 0.055 || duration > 0.12 ||
            direction === 0 || Math.abs(next.k - token.k) < 2 ||
            (Number.isFinite(token.conf) && token.conf < 0.84) ||
            next.t0 - token.t1 > 0.035) {
          continue;
        }

        const lo = Math.min(token.k, next.k);
        const hi = Math.max(token.k, next.k);
        const fixedAnchors = [];
        for (let k = Math.floor((lo - 12) / 12) * 12;
          k <= Math.ceil((hi + 12) / 12) * 12;
          k++) {
          const pc = ((k % 12) + 12) % 12;
          if ((pc === 0 || pc === 7) && k > lo && k < hi) {
            fixedAnchors.push(k);
          }
        }
        if (!fixedAnchors.length) continue;

        const frameStart = Math.max(0, Math.floor(token.t0 / hopSec));
        const frameEnd = Math.min(
          f0.length,
          Math.ceil(Math.min(next.t1, token.t1 + 0.12) / hopSec)
        );
        const path = [];
        for (let frame = frameStart; frame < frameEnd; frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          path.push(1200 * Math.log2(f0[frame] / saHz));
        }
        if (path.length < 8) continue;

        const entryCents = path[0];
        fixedAnchors.sort((a, b) =>
          Math.abs(entryCents - a * 100) -
          Math.abs(entryCents - b * 100)
        );
        const anchorK = fixedAnchors[0];
        const anchorCents = anchorK * 100;
        if (Math.abs(entryCents - anchorCents) > 100) continue;

        let extremeIndex = 0;
        for (let point = 1; point < path.length; point++) {
          if ((direction > 0 && path[point] < path[extremeIndex]) ||
              (direction < 0 && path[point] > path[extremeIndex])) {
            extremeIndex = point;
          }
        }
        const excursion = Math.abs(path[extremeIndex] - anchorCents);
        const returned = path.slice(extremeIndex + 1).some((cents) =>
          Math.abs(cents - anchorCents) <= 85
        );
        let centeredFrames = 0;
        for (let frame = frameStart;
          frame < Math.min(frameEnd, Math.ceil(token.t1 / hopSec));
          frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          const cents = 1200 * Math.log2(f0[frame] / saHz);
          if (Math.abs(cents - token.k * 100) <= 45) centeredFrames++;
        }
        if (extremeIndex === 0 || !returned || excursion < 160 ||
            centeredFrames * hopSec >
              Math.min(0.05, duration * 0.60) + 1e-9) {
          continue;
        }

        suppressedTurns.push({ t0: token.t0, t1: token.t1, k: token.k });
        token.k = anchorK;
        token.cents = anchorCents;
        token.meend = true;
        token.andolan = false;
        token.fixedAnchorBend = true;
      }
    }
    if (clean && frameTokens.length >= 3) {
      // Frame segmentation can read a compact overshoot at a neural boundary
      // as a return murki: R -> [brief G-m-G] where the learned target is G.
      // When the first target touch is brief, the excursion continues in the
      // direction of arrival, and the return dominates, keep the whole shape
      // as a bend into the target rather than inventing the outside swara.
      for (let frameIndex = 1; frameIndex + 1 < frameTokens.length; frameIndex++) {
        const lead = frameTokens[frameIndex - 1];
        const excursion = frameTokens[frameIndex];
        const returned = frameTokens[frameIndex + 1];
        const leadDuration = lead.t1 - lead.t0;
        const excursionDuration = excursion.t1 - excursion.t0;
        const returnDuration = returned.t1 - returned.t0;
        if (lead.k !== returned.k ||
            Math.abs(excursion.k - lead.k) !== 1 ||
            leadDuration > 0.055 ||
            excursionDuration > 0.10 ||
            returnDuration < 0.09 ||
            excursion.t0 - lead.t1 > 0.025 ||
            returned.t0 - excursion.t1 > 0.025) {
          continue;
        }
        const targetIndex = tokens.findIndex((token) =>
          token.k === lead.k &&
          Math.abs(token.t0 - excursion.t0) <= 0.035 &&
          token.t1 >= returned.t0 + 0.08
        );
        if (targetIndex < 1) continue;
        const approach = tokens[targetIndex - 1];
        const target = tokens[targetIndex];
        const arrivalDirection = Math.sign(target.k - approach.k);
        const overshootDirection = Math.sign(excursion.k - target.k);
        if (arrivalDirection === 0 ||
            arrivalDirection !== overshootDirection ||
            target.t0 - approach.t1 > 0.035) {
          continue;
        }
        suppressedTurns.push({
          t0: excursion.t0,
          t1: excursion.t1,
          k: excursion.k,
        });
      }
    }
    if (frameTokens.length) {
      tokens = fuseTurningOrnaments(tokens, frameTokens, suppressedTurns);
    }
    if (ornaments) {
      tokens = fuseRawNeighborTurns(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh,
        suppressedTurns,
        opts.onsets
      );
      tokens = fuseRawMurkiClusters(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh
      );
      tokens = fuseRepeatedRawExtrema(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh
      );
      tokens = fuseNestedRawLandmarks(
        tokens,
        f0,
        clarity,
        hopSec,
        saHz,
        thresh
      );
      tokens = harmonizeRepeatedMurkiMotifs(tokens);
    }

    if (clean && frameTokens.length && clarity && rms && hopSec > 0) {
      tokens = fuseSoftSwellEntries(
        tokens,
        frameTokens,
        clarity,
        rms,
        hopSec,
        opts.onsets,
        thresh
      );
    }
    if (ornaments && f0 && clarity && hopSec > 0) {
      tokens = suppressVibratoOrnaments(tokens, f0, clarity, hopSec, saHz, thresh);
    }

    // If a phrase audibly fades onto a new swara, keep the last stable target
    // reached before the tracker follows the dying tail below it. This recovers
    // singer-facing arrivals such as R -> S without labeling every pitch crossed
    // after the voice has already faded away.
    if (clean && f0 && clarity && rms && hopSec > 0) {
      const withFadeLandings = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        const isolatedEnd = !next || next.t0 - token.t1 >= 0.12;
        const frameEnd = Math.min(f0.length, Math.ceil(token.t1 / hopSec));
        const frameStart = Math.max(
          Math.floor(token.t0 / hopSec),
          frameEnd - Math.max(4, Math.round(0.18 / hopSec))
        );
        const runs = [];
        for (let frame = frameStart; frame < frameEnd; frame++) {
          if (!(f0[frame] > 0) || clarity[frame] < thresh) continue;
          const k = Math.round(12 * Math.log2(f0[frame] / saHz));
          const previousRun = runs[runs.length - 1];
          if (previousRun && previousRun.k === k &&
              frame - previousRun.end <= 2) {
            previousRun.end = frame + 1;
          } else {
            runs.push({ k, start: frame, end: frame + 1 });
          }
        }
        // A fade endpoint needs a perceptible landing, not merely two or three
        // quantized frames crossed while the pitch disappears.
        const minLandingFrames = Math.max(3, Math.round(0.055 / hopSec));
        let landing = null;
        for (const run of runs) {
          if (run.k !== token.k && run.end - run.start >= minLandingFrames &&
              run.end >= frameEnd - Math.max(2, Math.round(0.04 / hopSec))) {
            landing = run;
          }
        }

        let recovered = null;
        if (isolatedEnd && landing && Math.abs(landing.k - token.k) <= 4) {
          let beforeLevel = 0, beforeCount = 0, landingLevel = 0, landingCount = 0;
          const beforeStart = Math.max(
            Math.floor(token.t0 / hopSec),
            landing.start - Math.max(3, Math.round(0.12 / hopSec))
          );
          for (let frame = beforeStart; frame < landing.start; frame++) {
            if (Number.isFinite(rms[frame])) {
              beforeLevel += rms[frame];
              beforeCount++;
            }
          }
          for (let frame = landing.start; frame < frameEnd; frame++) {
            if (Number.isFinite(rms[frame])) {
              landingLevel += rms[frame];
              landingCount++;
            }
          }
          beforeLevel = beforeCount ? beforeLevel / beforeCount : 0;
          landingLevel = landingCount ? landingLevel / landingCount : 0;
          const splitTime = landing.start * hopSec;
          if (beforeLevel > 0 && landingLevel <= beforeLevel * 0.62 &&
              splitTime >= token.t0 + 0.04 &&
              token.t1 - splitTime >= minLandingFrames * hopSec) {
            token.t1 = splitTime;
            recovered = {
              t0: splitTime,
              t1: frameEnd * hopSec,
              k: landing.k,
              cents: landing.k * 100,
              meend: false,
              andolan: false,
              meendFromPrev: true,
              neural: true,
              fadeLanding: true,
            };
          }
        }
        withFadeLandings.push(token);
        if (recovered) withFadeLandings.push(recovered);
      }
      tokens = withFadeLandings;
    }
    for (const token of tokens) delete token._contour;
    return { tokens, phrases: groupPhrases(tokens, lineGapSec, clean) };
  }

  /**
   * Build a singer-facing contour from notation tokens. Stable notes sit
   * exactly on their swara targets; only a sustained, continuous traversal of
   * the interval becomes a slide. Analysis keeps the full pitch contour, but
   * the visual guide should not turn vibrato or tracker jitter into instructions.
   */

  DSP.notateRegions = notateRegions;
  DSP._internal.harmonizeRepeatedMurkiMotifs = harmonizeRepeatedMurkiMotifs;
  DSP._internal.suppressVibratoOrnaments = suppressVibratoOrnaments;
  return DSP;
}));
