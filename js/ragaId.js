/* SwarLekh — rank candidate ragas for a transcription. Pure, dependency-free.
 * Suggestions only, never a verdict (confidence capped < 1, ambiguity flagged).
 *
 *   var ranked = RagaId.rankRagas(analysis, RAGAS);
 *   // -> [{ name, score, confidence, rationale, why:[...], ambiguous? }, ...]
 *
 * analysis: DSP.analyzeRaga output — { swaras:[{pc,weight,devCents}], vadi(pc),
 *           samvadi(pc), aaroh:[pc], avaroh:[pc], seq:[pc], thaat?:{name}, total? }
 * db rows : { name, thaat, scalePcs:[0-11], aroha, avaroha, vadi(letter),
 *             samvadi(letter), pakad:[strings], distinctive? }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RagaId = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LETTER_PC = { S: 0, r: 1, R: 2, g: 3, G: 4, m: 5, M: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };
  var PC_LETTER = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];

  // Parse a swara/pakad string into octave-agnostic pitch classes.
  function parsePhrase(str) {
    var pcs = [], i, ch;
    for (i = 0; i < str.length; i++) { ch = str.charAt(i); if (LETTER_PC.hasOwnProperty(ch)) pcs.push(LETTER_PC[ch]); }
    return pcs;
  }
  function toPc(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    return LETTER_PC.hasOwnProperty(v) ? LETTER_PC[v] : null;
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function uniq(arr) { var s = {}, o = [], i, k; for (i = 0; i < arr.length; i++) { k = arr[i]; if (!s[k]) { s[k] = 1; o.push(k); } } return o; }
  function jaccard(aArr, bArr) {
    var a = {}, i, inter = 0, seen = {}, uni = 0;
    for (i = 0; i < aArr.length; i++) a[aArr[i]] = 1;
    for (i = 0; i < bArr.length; i++) { if (a[bArr[i]]) inter++; seen[bArr[i]] = 1; }
    for (i = 0; i < aArr.length; i++) seen[aArr[i]] = 1;
    for (var k in seen) if (seen.hasOwnProperty(k)) uni++;
    return uni === 0 ? 0 : inter / uni;
  }
  function hasContiguous(seq, pat) {
    var n = seq.length, L = pat.length, i, j, ok;
    if (L === 0 || L > n) return false;
    for (i = 0; i + L <= n; i++) { ok = true; for (j = 0; j < L; j++) if (seq[i + j] !== pat[j]) { ok = false; break; } if (ok) return true; }
    return false;
  }
  // Best in-order gapped match of pat[] in seq[]: 1 = tight, decays as stretched.
  function bestSubsequence(seq, pat) {
    var n = seq.length, L = pat.length, start, k, i, span, best = 0, maxSpan = L * 3 + 4;
    if (L === 0 || L > n) return 0;
    for (start = 0; start <= n - L; start++) {
      if (seq[start] !== pat[0]) continue;
      k = 1; i = start + 1;
      while (i < n && k < L) { if (seq[i] === pat[k]) k++; i++; if (i - start > maxSpan) break; }
      if (k === L) { span = i - start; var q = L / span; if (q > best) best = q; if (best >= 0.999) break; }
    }
    return clamp01(best);
  }
  function userScale(analysis) {
    if (analysis.scalePcs && analysis.scalePcs.length) return uniq(analysis.scalePcs);
    var out = [], sw = analysis.swaras || [], i; for (i = 0; i < sw.length; i++) out.push(sw[i].pc); return uniq(out);
  }
  function userWeights(analysis) {
    var w = {}, sw = analysis.swaras || [], i, sum = 0;
    for (i = 0; i < sw.length; i++) { w[sw[i].pc] = sw[i].weight || 0; sum += sw[i].weight || 0; }
    if (sum > 0 && Math.abs(sum - 1) > 0.01) for (var k in w) if (w.hasOwnProperty(k)) w[k] /= sum;
    return w;
  }
  function pcName(pc) { return pc == null ? '?' : PC_LETTER[((pc % 12) + 12) % 12]; }
  function phraseStr(pcs) { var s = [], i; for (i = 0; i < pcs.length; i++) s.push(pcName(pcs[i])); return s.join(' '); }

  var W = { scale: 0.34, pakad: 0.34, vs: 0.16, dir: 0.08, thaat: 0.08 };
  var PEN_FOREIGN = 1.6, GAP_DISCOUNT = 0.8, FOREIGN_GATE = 0.18;

  function scoreOne(analysis, raga, uScale, uWeights) {
    var why = [], i, pc;
    var rScale = uniq(raga.scalePcs || []);
    var rSet = {}; for (i = 0; i < rScale.length; i++) rSet[rScale[i]] = 1;

    var inRagaW = 0, foreignW = 0, interCount = 0, foreignList = [];
    for (i = 0; i < uScale.length; i++) {
      pc = uScale[i];
      var wv = uWeights.hasOwnProperty(pc) ? uWeights[pc] : 0;
      if (rSet[pc]) { inRagaW += wv; interCount++; } else { foreignW += wv; foreignList.push(pc); }
    }
    var coverage = rScale.length ? interCount / rScale.length : 0;
    var sScale = clamp01(inRagaW - PEN_FOREIGN * foreignW) * (0.55 + 0.45 * coverage);
    if (interCount > 0) why.push('scale ' + Math.round(inRagaW * 100) + '% in-raag' + (coverage < 0.85 ? ' (partial)' : ''));
    if (foreignList.length) { var fl = []; for (i = 0; i < foreignList.length; i++) fl.push(pcName(foreignList[i])); why.push('off-raag: ' + fl.join(' ')); }

    var uVadi = toPc(analysis.vadi), uSam = toPc(analysis.samvadi), rVadi = toPc(raga.vadi), rSam = toPc(raga.samvadi);
    var vadiKnown = uVadi != null && rVadi != null, vadiHit = 0, samHit = 0;
    if (vadiKnown) vadiHit = (uVadi === rVadi) ? 1 : (uVadi === rSam ? 0.5 : 0);
    if (uSam != null && rSam != null) samHit = (uSam === rSam) ? 1 : (uSam === rVadi ? 0.5 : 0);
    var sVs = 0.65 * vadiHit + 0.35 * samHit;
    if (vadiHit === 1) why.push('vadi ' + pcName(rVadi)); else if (vadiHit === 0.5) why.push('vadi~samvadi ' + pcName(uVadi));

    var sDir = 0.5 * jaccard(analysis.aaroh || [], parsePhrase(raga.aroha || '')) +
               0.5 * jaccard(analysis.avaroh || [], parsePhrase(raga.avaroha || ''));

    var seq = analysis.seq || [], sPakad = 0, longestHit = null, pakads = raga.pakad || [];
    for (i = 0; i < pakads.length; i++) {
      var pat = pakads[i].join ? pakads[i] : parsePhrase(pakads[i]);
      if (pat.length < 2) continue;
      var contig = hasContiguous(seq, pat) ? 1.0 : 0;
      var qP = Math.max(contig, GAP_DISCOUNT * bestSubsequence(seq, pat));
      if (qP > sPakad) sPakad = qP;
      if (qP >= 0.5 && (!longestHit || pat.length > longestHit.len)) longestHit = { str: phraseStr(pat), len: pat.length, contig: contig === 1 };
    }
    if (longestHit) why.push("pakad '" + longestHit.str + "' " + (longestHit.contig ? 'found' : 'traced'));

    var uThaat = analysis.thaat && analysis.thaat.name;
    var sThaat = (uThaat && raga.thaat && uThaat === raga.thaat) ? 1 : 0;

    var raw = W.scale * sScale + W.pakad * sPakad + W.vs * sVs + W.dir * sDir + W.thaat * sThaat;
    if (foreignW > FOREIGN_GATE) raw *= (1 - Math.min(0.6, (foreignW - FOREIGN_GATE) * 2.0));

    return {
      name: raga.name, raw: raw, foreignW: foreignW, vadiKnown: vadiKnown, pakadFired: sPakad >= 0.5,
      dirFired: (analysis.aaroh && analysis.aaroh.length) > 0, sScale: sScale, sVs: sVs, sDir: sDir, why: why,
    };
  }

  function rankRagas(analysis, db) {
    if (!analysis || !db || !db.length) return [];
    var uScale = userScale(analysis), uWeights = userWeights(analysis), i;
    var totalSec = typeof analysis.total === 'number' ? analysis.total : 0;
    var nNotes = (analysis.seq || []).length;
    var dataAmt = clamp01(Math.min(totalSec / 25, nNotes / 30));
    var anyDbPakad = false;
    for (i = 0; i < db.length; i++) if (db[i].pakad && db[i].pakad.length) { anyDbPakad = true; break; }

    var scored = [];
    for (i = 0; i < db.length; i++) scored.push(scoreOne(analysis, db[i], uScale, uWeights));
    scored.sort(function (a, b) { return b.raw - a.raw; });
    var secondRaw = scored.length > 1 ? scored[1].raw : 0;

    var out = [];
    for (i = 0; i < scored.length; i++) {
      var s = scored[i];
      var cues = 1, fired = s.sScale > 0 ? 1 : 0.3;
      if (anyDbPakad) { cues++; fired += s.pakadFired ? 1 : 0.2; }
      if (s.vadiKnown) { cues++; fired += s.sVs > 0 ? 1 : 0.3; }
      if (s.dirFired) { cues++; fired += s.sDir > 0 ? 1 : 0.3; }
      var evidence = clamp01(0.4 + 0.6 * (fired / cues));
      var margin = clamp01((s.raw - secondRaw) / 0.15);
      var conf = s.raw * (0.45 + 0.30 * evidence + 0.25 * dataAmt);
      if (i === 0) conf *= (0.7 + 0.3 * margin);
      conf = Math.max(0, Math.min(0.95, conf));
      if (s.pakadFired) conf = Math.max(conf, 0.5);
      var reasons = s.why.slice(0, 3);
      var rationale = reasons.length ? reasons.join(' + ') : 'weak scale overlap only';
      if (dataAmt < 0.4) rationale += ' — short clip, low confidence';
      out.push({ name: s.name, score: Math.round(s.raw * 1000) / 1000, confidence: Math.round(conf * 100) / 100, rationale: rationale, why: s.why });
    }
    if (out.length > 1) { var lead = out[0].score - out[1].score; if (lead < 0.06 || dataAmt < 0.35) out[0].ambiguous = true; }
    return out;
  }

  return { rankRagas: rankRagas, parsePhrase: parsePhrase, _bestSubsequence: bestSubsequence };
}));
