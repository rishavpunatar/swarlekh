#!/usr/bin/env node
'use strict';

// Real Hindustani evaluation on Saraga 1.5 Hindustani (CC BY-NC-SA 4.0):
//   • Sa: the annotated tonic of each vocal recording, judged on three
//     90-second excerpts (25/50/75% through the concert) as a user would
//     upload them — pitch class within 50 cents, and the right octave.
//   • Sargam: each manually annotated melodic phrase ("NrG", "MGrS", …) that
//     falls inside an excerpt is checked as an in-order subsequence of the
//     app's swaras over that stretch — once with the app's own Sa, once with
//     the annotated Sa (so note errors are separated from tonic errors).
//
// Setup (about 4 GB): download saraga1.5_hindustani.zip from
// https://zenodo.org/records/4301737 into evaluation/data/saraga/ and unzip
// it there (the large *.pitch.txt files are not needed). Requires ffmpeg.
//
//   node evaluation/evaluate-saraga.js [--engine fast|best] [--limit N] [--every K]
//        [--positions 0.25,0.5,0.75] [--split tune|holdout] [--json out.json]
//   SWARLEKH_DSP=path/to/dsp.js …   # A/B another DSP build
//
// The Best engine posts each excerpt to the local server (slow: separation).

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'data', 'saraga', 'saraga1.5_hindustani');
const CACHE = path.join(__dirname, 'cache', 'saraga');
const SR = 16000;
const EXCERPT_SEC = 90;
const CLEAN = { clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45, onsetMinMs: 100, clean: true };
const LETTER = { S: 0, r: 1, R: 2, g: 3, G: 4, m: 5, M: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };

function parseArgs(argv) {
  const args = { engine: 'fast', limit: Infinity, json: null, server: 'http://127.0.0.1:8765', positions: [0.25, 0.5, 0.75], every: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--engine') args.engine = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = path.resolve(argv[++i]);
    else if (argv[i] === '--server') args.server = argv[++i];
    else if (argv[i] === '--positions') args.positions = argv[++i].split(',').map(Number);
    else if (argv[i] === '--every') args.every = Number(argv[++i]);
    else if (argv[i] === '--split') args.split = argv[++i];
  }
  return args;
}

function listRecordings() {
  if (!fs.existsSync(ROOT)) throw new Error(`Saraga not found at ${ROOT} (see the header of this file).`);
  const out = [];
  for (const album of fs.readdirSync(ROOT)) {
    const albumDir = path.join(ROOT, album);
    if (!fs.statSync(albumDir).isDirectory()) continue;
    for (const track of fs.readdirSync(albumDir)) {
      const dir = path.join(albumDir, track);
      if (!fs.statSync(dir).isDirectory()) continue;
      const base = path.join(dir, track);
      if (!fs.existsSync(base + '.ctonic.txt') || !fs.existsSync(base + '.mp3.mp3')) continue;
      const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
      const instruments = (meta.artists || []).map((a) => (a.instrument && a.instrument.name) || '');
      const vocal = instruments.some((name) => /voice|vocal/i.test(name));
      if (!vocal || /introduc|speech|lyrics|concept|taal and sur/i.test(track)) continue;
      const phrasesFile = base + '.mphrases-manual.txt';
      const phrases = fs.existsSync(phrasesFile)
        ? fs.readFileSync(phrasesFile, 'utf8').trim().split(/\r?\n/).map((line) => line.split('\t'))
          .filter((cols) => cols.length >= 4)
          .map(([start, , dur, sargam]) => ({ t0: Number(start), t1: Number(start) + Number(dur), sargam: sargam.trim() }))
        : [];
      out.push({
        id: `${album} / ${track}`, base,
        tonic: Number(fs.readFileSync(base + '.ctonic.txt', 'utf8').trim().split(/\s+/)[0]),
        duration: (meta.length || 0) / 1000,
        raag: ((meta.raags || [])[0] || {}).name || '',
        phrases,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function excerpt(rec, startSec) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(`${rec.base}|${startSec}|${EXCERPT_SEC}`).digest('hex').slice(0, 16);
  const file = path.join(CACHE, `${key}.f32`);
  if (!fs.existsSync(file)) {
    const result = childProcess.spawnSync('ffmpeg', [
      '-v', 'error', '-nostdin', '-ss', String(startSec), '-t', String(EXCERPT_SEC),
      '-i', rec.base + '.mp3.mp3', '-ac', '1', '-ar', String(SR), '-f', 'f32le', file,
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ffmpeg failed for ${rec.id}: ${result.stderr}`);
  }
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function wavBytes(samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

// Mirrors js/worker.js for the chosen engine; returns { sa, notate(saHz) }.
async function analyze(DSP, samples, engine, server) {
  const filtered = DSP.preFilter(samples, SR);
  let track, mode = 'auto', onsets, regions = [];
  if (engine === 'best') {
    const resp = await fetch(`${server}/analyze`, { method: 'POST', body: wavBytes(samples) });
    if (!resp.ok) throw new Error(`server HTTP ${resp.status}`);
    const data = await resp.json();
    const rmsArr = Float32Array.from(data.rms);
    track = { f0: Float32Array.from(data.f0), clarity: Float32Array.from(data.periodicity), rms: rmsArr, hopSec: data.hopSec };
    mode = 'gentle';
    onsets = data.onsets.map((t) => Math.round(t / data.hopSec));
    regions = data.noteRegions || [];
  } else {
    track = DSP.yinTrack(filtered, SR, {});
  }
  const stable = DSP.stabilizeOctave(track.f0, track.clarity, track.rms, track.hopSec, mode);
  let tonic = null, f0 = stable.f0, drift = null;
  const extra = DSP.droneProfile ? { drone: DSP.droneProfile(samples, SR) } : undefined;
  if (DSP.tonicWithDrift) {
    const t = DSP.tonicWithDrift(stable.f0, track.clarity, track.hopSec, track.rms, extra);
    tonic = t.tonic; f0 = t.f0; drift = t.drift;
  } else {
    tonic = DSP.detectTonic(stable.f0, track.clarity, track.hopSec, track.rms);
  }
  if (!onsets) {
    onsets = DSP.detectOnsets(filtered, SR, Math.round(track.hopSec * SR),
      DSP.voiceOnsetEvidence ? { track } : undefined);
  }
  if (drift && regions.length) {
    regions = regions.map((r) => {
      const f = (r.frequency || 440 * Math.pow(2, (r.midi - 69) / 12)) * Math.pow(2, -DSP.driftAt(drift, (r.onset + r.offset) / 2) / 1200);
      return Object.assign({}, r, { frequency: f });
    });
  }
  const notateWith = (saHz) => {
    const opts = Object.assign({}, CLEAN, { onsets, rms: track.rms });
    return (regions.length ? DSP.notateRegions(regions, f0, track.clarity, track.hopSec, saHz, opts)
      : DSP.notate(f0, track.clarity, track.hopSec, saHz, opts)).tokens;
  };
  return { sa: tonic[0].hz, uncertain: !!tonic[0].uncertain, notateWith };
}

const circular = (c) => { const d = ((c % 1200) + 1200) % 1200; return Math.min(d, 1200 - d); };

function phraseFound(tokens, phrase, offset) {
  const want = [...phrase.sargam].filter((ch) => ch in LETTER).map((ch) => LETTER[ch]);
  if (!want.length) return null;
  const seq = [];
  for (const tk of tokens) {
    const t0 = tk.t0 + offset, t1 = tk.t1 + offset;
    if (t1 <= phrase.t0 || t0 >= phrase.t1) continue;
    const pc = ((tk.k % 12) + 12) % 12;
    if (seq[seq.length - 1] !== pc) seq.push(pc);
  }
  let j = 0;
  for (const pc of seq) if (pc === want[j] && ++j === want.length) return true;
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const DSP = require(process.env.SWARLEKH_DSP ? path.resolve(process.env.SWARLEKH_DSP) : '../js/dsp.js');
  // A fixed split: every third recording (sorted by id) was used to tune
  // parameters; report results on the rest ('holdout').
  const inSplit = (i) => !args.split || (args.split === 'tune' ? i % 3 === 0 : i % 3 !== 0);
  const recordings = listRecordings().filter((_, i) => inSplit(i) && i % args.every === 0).slice(0, args.limit);
  const agg = { excerpts: 0, pc50: 0, pc30: 0, octave: 0, flagged: 0, flaggedWrong: 0, wrong: 0,
    phrases: 0, found: 0, foundOracle: 0, perRecording: [] };
  for (const [index, rec] of recordings.entries()) {
    const starts = args.positions.map((f) => Math.max(0, Math.min(rec.duration - EXCERPT_SEC, f * rec.duration)));
    const rows = [];
    for (const start of starts) {
      let res;
      try {
        res = await analyze(DSP, excerpt(rec, start), args.engine, args.server);
      } catch (error) {
        console.error(`skip ${rec.id} @${start.toFixed(0)}s: ${error.message}`);
        continue;
      }
      const err = 1200 * Math.log2(res.sa / rec.tonic);
      const ok50 = circular(err) < 50, okOct = ok50 && Math.abs(err) < 600;
      agg.excerpts++; agg.pc50 += ok50; agg.pc30 += circular(err) < 30; agg.octave += okOct;
      if (!okOct) agg.wrong++;
      if (res.uncertain) { agg.flagged++; if (!okOct) agg.flaggedWrong++; }
      let tokensOwn = null, tokensOracle = null;
      for (const ph of rec.phrases) {
        if (ph.t0 < start || ph.t1 > start + EXCERPT_SEC) continue;
        tokensOwn = tokensOwn || res.notateWith(res.sa);
        tokensOracle = tokensOracle || res.notateWith(rec.tonic);
        const own = phraseFound(tokensOwn, ph, start), oracle = phraseFound(tokensOracle, ph, start);
        if (own == null) continue;
        agg.phrases++; agg.found += own; agg.foundOracle += oracle;
      }
      rows.push({ start: Math.round(start), sa: Number(res.sa.toFixed(2)), err: Math.round(err), ok: okOct, uncertain: res.uncertain });
    }
    agg.perRecording.push({ id: rec.id, raag: rec.raag, tonic: rec.tonic, excerpts: rows });
    process.stderr.write(`\r${index + 1}/${recordings.length} ${rec.id.slice(0, 60).padEnd(60)}`);
  }
  process.stderr.write('\n');
  const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  const summary = {
    engine: args.engine, recordings: recordings.length, excerpts: agg.excerpts,
    saPitchClass50: pct(agg.pc50, agg.excerpts), saPitchClass30: pct(agg.pc30, agg.excerpts),
    saWithOctave: pct(agg.octave, agg.excerpts),
    flaggedUncertain: pct(agg.flagged, agg.excerpts),
    wrongSaFlagged: pct(agg.flaggedWrong, agg.wrong),
    phrases: agg.phrases, phrasesFound: pct(agg.found, agg.phrases), phrasesFoundWithTrueSa: pct(agg.foundOracle, agg.phrases),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ summary, perRecording: agg.perRecording }, null, 2) + '\n');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
