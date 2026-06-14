/* SwarLekh — UI: file handling, playback, tonic control, pitch-contour
 * canvas and sargam notation rendering. All processing stays on-device. */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    dropzone: $('dropzone'), fileInput: $('fileInput'), chooseBtn: $('chooseBtn'),
    progressCard: $('progressCard'), progStage: $('progStage'), progPct: $('progPct'), progBar: $('progBar'),
    resultArea: $('resultArea'),
    playBtn: $('playBtn'), timeDisp: $('timeDisp'), speedSel: $('speedSel'), sourceSel: $('sourceSel'),
    loopABtn: $('loopABtn'), loopBBtn: $('loopBBtn'), loopClearBtn: $('loopClearBtn'), loopDisp: $('loopDisp'),
    ragaThaat: $('ragaThaat'), ragaGuess: $('ragaGuess'), swarPalette: $('swarPalette'), ragaGrammar: $('ragaGrammar'),
    tonicCard: $('tonicCard'), tonicChips: $('tonicChips'), tonicNote: $('tonicNote'), tonicFine: $('tonicFine'),
    tonicFineVal: $('tonicFineVal'), tonicHz: $('tonicHz'), droneBtn: $('droneBtn'), tonicHint: $('tonicHint'),
    canvas: $('contour'), zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'),
    notation: $('notation'),
    copyBtn: $('copyBtn'), dlTxtBtn: $('dlTxtBtn'), dlJsonBtn: $('dlJsonBtn'), dlWavBtn: $('dlWavBtn'),
    pitchCtl: document.querySelector('.pitch-ctl'), pitchDownBtn: $('pitchDownBtn'), pitchUpBtn: $('pitchUpBtn'),
    pitchSel: $('pitchSel'), pitchKey: $('pitchKey'),
    sensSlider: $('sensSlider'), sensVal: $('sensVal'),
    minNoteSlider: $('minNoteSlider'), minNoteVal: $('minNoteVal'),
    statsLine: $('statsLine'), toast: $('toast'),
  };

  const state = {
    ready: false, fileName: '',
    f0: null, clarity: null, hopSec: 0.016, sr: 16000,
    tonicCands: [], saHz: 146.83,
    tokens: [], phrases: [],
    duration: 0, synthDuration: 0,
    loopA: null, loopB: null,
    pxPerSec: 120, scrollSec: 0, centsLo: -700, centsHi: 1900,
    playing: false,
    semitones: 0, fileMono: null, fileSr: 16000,
    f0raw: null, f0auto: null, octaveMode: 'auto', octaveDoubled: false,
    raga: null, highlightPc: null, ragaMatches: [], script: 'latin',
    engine: 'yin', file: null,
    opts: { clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45, clean: true, onsets: [] },
  };

  // Bump on every deploy that touches js/ (also bump the ?v= on the <script>
  // tags in index.html to match). Versioning the worker URL cascades to its
  // importScripts, so returning users never run a stale cached worker/DSP.
  const WORKER_URL = 'js/worker.js?v=22';
  const PITCH_LIMIT = 12;
  const pitchCache = new Map();   // semitones -> { origUrl, synthUrl }
  let pitchWorker = null;
  let pitchSeq = 0;               // guards against stale renders

  let worker = null;
  let actx = null;            // shared AudioContext (decode + drone)
  let droneNodes = null;
  let origUrl = null, synthUrl = null;
  let rafId = 0;
  let activeLineIdx = -1;
  let activeTokIdx = -1;

  const origEl = new Audio();
  const synthEl = new Audio();
  for (const el of [origEl, synthEl]) {
    el.preservesPitch = true;
    try { el.webkitPreservesPitch = true; } catch (e) { /* older Safari */ }
  }
  synthEl.volume = 0.9;

  /* ------------------------------ helpers ------------------------------ */

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function noteLabel(hz) {
    const m = 69 + 12 * Math.log2(hz / 440);
    const near = Math.round(m);
    const dev = Math.round((m - near) * 100);
    const name = NOTE_NAMES[((near % 12) + 12) % 12] + (Math.floor(near / 12) - 1);
    return dev === 0 ? name : `${name} ${dev > 0 ? '+' : ''}${dev}¢`;
  }
  function fmtTime(t, frac) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = t % 60;
    return frac ? `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}` : `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
  }
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, 4200);
  }
  function ensureCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* --------------------------- file handling --------------------------- */

  els.chooseBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files[0]) processFile(els.fileInput.files[0]);
  });
  els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); });
  els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) processFile(f);
  });

  function setStage(label, frac) {
    els.progStage.textContent = label;
    els.progPct.textContent = `${Math.round(frac * 100)}%`;
    els.progBar.style.width = `${Math.round(frac * 100)}%`;
  }

  const STAGE_LABEL = { loading: 'Loading neural model…', filter: 'Filtering…', pitch: 'Tracking pitch…', tonic: 'Finding Sa…', synth: 'Rendering melody…' };

  function runWorker(samples, sr, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (worker) worker.terminate();
      worker = new Worker(WORKER_URL);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          const base = { loading: 0.12, filter: 0.16, pitch: 0.18, tonic: 0.82, synth: 0.9 }[m.stage] || 0.2;
          const frac = m.stage === 'pitch' ? 0.18 + (m.frac || 0) * 0.62 : base;
          setStage(STAGE_LABEL[m.stage] || m.stage, frac);
        } else if (m.type === 'result') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Analysis failed'));
      worker.postMessage({
        samples, sr,
        neural: !!opts.neural,
        providedF0: opts.providedF0 || null,
        providedClarity: opts.providedClarity || null,
        providedHopSec: opts.providedHopSec || 0,
      }, [samples.buffer]);
    });
  }

  // "Best (local server)" engine: POST the original-rate mono as a WAV to the
  // local Demucs+CREPE server (127.0.0.1), which returns the pitch track of the
  // separated voice. Audio only ever goes to your own machine.
  const SERVER_URL = 'http://127.0.0.1:8765';
  async function analyzeViaServer() {
    const wav = encodeWav(state.fileMono, state.fileSr);
    const resp = await fetch(SERVER_URL + '/analyze', {
      method: 'POST', body: wav, headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();   // { f0, periodicity, hopSec, sr }
  }

  async function processFile(file) {
    try {
      state.ready = false;
      pause();
      state.loopA = state.loopB = null;
      updateLoopUI();
      clearPitchCache();
      state.semitones = 0;
      els.dropzone.classList.add('compact');
      els.progressCard.hidden = false;
      els.resultArea.hidden = true;
      state.fileName = file.name;
      state.file = file;            // kept so toggling the pitch engine can re-analyze
      setStage('Decoding audio…', 0.04);

      const ab = await file.arrayBuffer();
      const ctx = ensureCtx();
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab);
      } catch (err) {
        throw new Error('Could not decode this file — is it a valid audio file?');
      }
      state.duration = buf.duration;
      if (buf.duration < 1) throw new Error('This clip is too short to analyze.');

      // Full-rate mono kept for transposition (pitch shifting).
      const fmono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < buf.length; i++) fmono[i] += d[i] / buf.numberOfChannels;
      }
      state.fileMono = fmono;
      state.fileSr = buf.sampleRate;

      if (origUrl) URL.revokeObjectURL(origUrl);
      origUrl = URL.createObjectURL(file);
      origEl.src = origUrl;

      setStage('Resampling…', 0.1);
      const targetSr = 16000;
      const oac = new OfflineAudioContext(1, Math.ceil(buf.duration * targetSr), targetSr);
      const src = oac.createBufferSource();
      src.buffer = buf;
      src.connect(oac.destination);
      src.start();
      const mono = (await oac.startRendering()).getChannelData(0);

      let workerOpts = {};
      if (state.engine === 'neural') {
        workerOpts = { neural: true };
      } else if (state.engine === 'server') {
        setStage('Separating voice on local server… (a few minutes)', 0.12);
        let data;
        try {
          data = await analyzeViaServer();
        } catch (err) {
          throw new Error('Local server not reachable. Start it (see server/README.md), then pick "Best (local server)" again. [' + err.message + ']');
        }
        workerOpts = { providedF0: data.f0, providedClarity: data.periodicity, providedHopSec: data.hopSec };
      }
      const result = await runWorker(new Float32Array(mono), targetSr, workerOpts);
      if (!result.f0.length) throw new Error('This clip is too short to analyze.');

      state.f0auto = result.f0;            // worker's auto-stabilized track
      state.f0raw = result.f0raw;          // raw track (octaves as heard)
      state.octaveDoubled = !!result.doubled;
      state.clarity = result.clarity;
      state.hopSec = result.hopSec;
      state.sr = result.sr;
      state.tonicCands = result.tonic;
      state.opts.onsets = result.onsets || [];
      state.opts.rms = result.rms;
      applyOctaveMode(false);
      state.synthDuration = result.synth.length / targetSr;

      setStage('Building notation…', 0.96);
      if (synthUrl) URL.revokeObjectURL(synthUrl);
      synthUrl = URL.createObjectURL(encodeWav(result.synth, targetSr));
      synthEl.src = synthUrl;

      state.saHz = result.tonic[0].hz;
      renderTonicChips();
      syncTonicControls();
      state.scrollSec = 0;
      renotate();

      pitchCache.set(0, { origUrl, synthUrl });
      populatePitchOptions();

      els.progressCard.hidden = true;
      els.resultArea.hidden = false;
      applySpeed();
      applySource();
      updateTimeDisp();
      state.ready = true;
      maybeShowFirstRun();
      if (result.tonic[0].uncertain) {
        toast('Sa may be off — check it with the Drone (see the note below the tonic).');
      } else if (state.octaveDoubled) {
        toast('Fixed some octave glitches. If two voices an octave apart still show, pick “Single octave” under Octave.');
      }
    } catch (err) {
      els.progressCard.hidden = true;
      toast(err.message || String(err));
    }
  }

  // First-run guide — shown once (stored locally; nothing leaves the device).
  function maybeShowFirstRun() {
    let seen = false;
    try { seen = localStorage.getItem('swarlekh.seen') === '1'; } catch (e) {}
    if (seen) return;
    const fr = $('firstRun');
    if (fr) fr.hidden = false;
  }
  const frClose = $('firstRunClose');
  if (frClose) frClose.addEventListener('click', () => {
    $('firstRun').hidden = true;
    try { localStorage.setItem('swarlekh.seen', '1'); } catch (e) {}
  });

  /* ------------------------------- tonic ------------------------------- */

  // Note dropdown: C2..B5.
  for (let m = 36; m <= 83; m++) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
    els.tonicNote.appendChild(opt);
  }

  function renderTonicChips() {
    els.tonicChips.textContent = '';
    state.tonicCands.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = `${noteLabel(c.hz)} · ${c.hz.toFixed(1)} Hz${i === 0 ? ' ★' : ''}`;
      b.title = i === 0 ? 'Best guess for Sa — verify by ear with the Drone' : 'Alternative Sa — try it with the Drone';
      b.addEventListener('click', () => { state.saHz = c.hz; syncTonicControls(); renotateNow(); });
      els.tonicChips.appendChild(b);
    });
    markSelectedChip();
    updateTonicHint();
  }

  function updateTonicHint() {
    const cands = state.tonicCands;
    const uncertain = cands[0] && cands[0].uncertain;
    els.tonicCard.classList.toggle('uncertain', !!uncertain);
    els.droneBtn.classList.toggle('pulse', !!uncertain && !droneNodes);
    if (uncertain && cands.length > 1) {
      els.tonicHint.innerHTML = '⚠️ <b>Sa is a close call</b> — this is usually Sa vs Pa. Tap each candidate above and play the <b>Drone</b> against the song; the right Sa is the note that sounds like “home”.';
    } else if (uncertain) {
      els.tonicHint.innerHTML = '⚠️ Couldn’t hear enough clear melody to be sure of Sa. Set it by note below, or play the <b>Drone</b> and match it to the song’s home note.';
    } else {
      els.tonicHint.innerHTML = 'Pick the candidate that sounds like the song’s home note — toggle the <b>Drone</b> and listen against the recording.';
    }
  }
  function markSelectedChip() {
    const chips = els.tonicChips.children;
    state.tonicCands.forEach((c, i) => {
      if (chips[i]) chips[i].classList.toggle('sel', Math.abs(1200 * Math.log2(c.hz / state.saHz)) < 1);
    });
  }

  function syncTonicControls() {
    const m = 69 + 12 * Math.log2(state.saHz / 440);
    let near = Math.round(m);
    let cents = Math.round((m - near) * 100);
    if (cents > 50) { near++; cents -= 100; }
    if (cents < -50) { near--; cents += 100; }
    near = Math.max(36, Math.min(83, near));
    els.tonicNote.value = near;
    els.tonicFine.value = cents;
    els.tonicFineVal.textContent = `${cents >= 0 ? '+' : ''}${cents}¢`;
    els.tonicHz.textContent = `${state.saHz.toFixed(1)} Hz`;
    markSelectedChip();
    updateDroneFreq();
    populatePitchOptions();
  }

  function tonicFromControls() {
    const base = midiHz(parseInt(els.tonicNote.value, 10));
    const cents = parseInt(els.tonicFine.value, 10) || 0;
    state.saHz = base * Math.pow(2, cents / 1200);
    els.tonicFineVal.textContent = `${cents >= 0 ? '+' : ''}${cents}¢`;
    els.tonicHz.textContent = `${state.saHz.toFixed(1)} Hz`;
    markSelectedChip();
    updateDroneFreq();
    populatePitchOptions();
    renotateDebounced();
  }
  els.tonicNote.addEventListener('change', tonicFromControls);
  els.tonicFine.addEventListener('input', tonicFromControls);

  els.droneBtn.addEventListener('click', () => {
    const on = !droneNodes;
    setDrone(on);
    els.droneBtn.classList.toggle('on', on);
    els.droneBtn.classList.remove('pulse');
  });

  function setDrone(on) {
    const ctx = ensureCtx();
    if (on && !droneNodes) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(ctx.destination);
      const mk = (f, vol) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = vol;
        o.connect(og); og.connect(g); o.start();
        return o;
      };
      droneNodes = {
        g,
        oscs: [mk(state.saHz, 0.5), mk(state.saHz / 2, 0.45), mk(state.saHz * 2 / 3, 0.28), mk(state.saHz * 2, 0.07)],
      };
      g.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.4);
    } else if (!on && droneNodes) {
      const d = droneNodes;
      droneNodes = null;
      d.g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
      setTimeout(() => { d.oscs.forEach(o => o.stop()); d.g.disconnect(); }, 350);
    }
  }
  function updateDroneFreq() {
    if (!droneNodes) return;
    const f = [state.saHz, state.saHz / 2, state.saHz * 2 / 3, state.saHz * 2];
    droneNodes.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f[i], actx.currentTime, 0.04));
  }

  /* ----------------------------- notation ----------------------------- */

  // Choose which pitch track to show, per state.octaveMode. 'auto' uses the
  // worker's already-stabilized track; 'force' folds the raw track always;
  // 'off' shows the octaves exactly as heard.
  function applyOctaveMode(reflow) {
    if (!state.f0raw) return;
    if (state.octaveMode === 'off') {
      state.f0 = state.f0raw;
    } else if (state.octaveMode === 'force') {
      state.f0 = DSP.stabilizeOctave(state.f0raw, state.clarity, state.opts.rms, state.hopSec, 'force').f0;
    } else {
      state.f0 = state.f0auto;
    }
    if (reflow) renotateNow();
  }

  function renotateNow() {
    if (!state.f0) return;
    const res = DSP.notate(state.f0, state.clarity, state.hopSec, state.saHz, state.opts);
    state.tokens = res.tokens;
    state.phrases = res.phrases;
    state.raga = DSP.analyzeRaga(res.tokens, res.phrases);
    state.ragaMatches = (state.raga && window.RagaId && window.RAGAS)
      ? RagaId.rankRagas(state.raga, RAGAS).filter((m) => m.score > 0.05).slice(0, 4) : [];
    computeScale();
    computeCentsRange();
    renderRaga();
    renderNotation();
    drawCanvas();
    updateStats();
  }

  // The song's scale: pitch classes carrying real melodic weight (duration),
  // used to highlight singable lines on the contour. Sa is always included.
  function computeScale() {
    const w = new Float64Array(12);
    let total = 0;
    for (const t of state.tokens) {
      const d = t.t1 - t.t0;
      w[((t.k % 12) + 12) % 12] += d;
      total += d;
    }
    const scale = new Set([0]);
    if (total > 0) for (let pc = 0; pc < 12; pc++) if (w[pc] / total >= 0.03) scale.add(pc);
    state.scale = scale;
  }
  const renotateDebounced = debounce(renotateNow, 140);
  function renotate() { renotateNow(); }

  function computeCentsRange() {
    if (!state.tokens.length) { state.centsLo = -700; state.centsHi = 1900; return; }
    let lo = Infinity, hi = -Infinity;
    for (const t of state.tokens) { if (t.k * 100 < lo) lo = t.k * 100; if (t.k * 100 > hi) hi = t.k * 100; }
    lo = Math.min(lo, 0) - 200;
    hi = Math.max(hi, 0) + 250;
    if (hi - lo < 1200) { const pad = (1200 - (hi - lo)) / 2; lo -= pad; hi += pad; }
    state.centsLo = Math.floor(lo / 100) * 100;
    state.centsHi = Math.ceil(hi / 100) * 100;
  }

  const swLetter = (pc) => DSP.swaraInfo(((pc % 12) + 12) % 12).letter;

  // Devanagari swara glyphs (base akshara; komal/teevra/octave shown by marks).
  const DEVA = { S: 'स', R: 'रे', G: 'ग', M: 'म', P: 'प', D: 'ध', N: 'नि' };
  // The glyph for a swara letter under the current script.
  function glyph(letter) {
    if (state.script !== 'devanagari') return letter;
    return DEVA[letter.toUpperCase()] || letter;
  }
  // Full swara glyph with octave marks (script-aware); used for inline paths.
  function tokenGlyph(k) {
    const s = DSP.swaraInfo(k);
    let t = glyph(s.letter);
    if (s.octave > 0) t += "'".repeat(s.octave);
    else if (s.octave < 0) t = '.'.repeat(-s.octave) + t;
    return t;
  }

  // A glide's path trimmed to its in-scale swaras (keep the endpoints).
  function viaDisplay(via) {
    const sc = state.scale;
    if (!sc || !via || via.length <= 2) return via || [];
    return via.filter((k, i) => i === 0 || i === via.length - 1 || sc.has(((k % 12) + 12) % 12));
  }

  const confWord = (c) => (c >= 0.75 ? 'likely' : c >= 0.5 ? 'possibly' : c >= 0.3 ? 'a guess' : 'weak match');

  // "This sounds like…" — ranked raga suggestions (never a single verdict).
  function renderRagaGuess() {
    const m = state.ragaMatches || [];
    els.ragaGuess.textContent = '';
    if (!m.length) return;
    const head = document.createElement('div');
    head.className = 'guess-head';
    head.innerHTML = m[0].ambiguous
      ? 'Sounds like one of these <span class="muted">— same scale; tell them apart by the phrase &amp; resting note</span>'
      : 'Sounds like…';
    els.ragaGuess.appendChild(head);
    const row = document.createElement('div');
    row.className = 'guess-row';
    m.forEach((cand, i) => {
      const db = (window.RAGAS || []).find((r) => r.name === cand.name);
      const chip = document.createElement('div');
      chip.className = 'guess' + (i === 0 ? ' top' : '');
      const conf = confWord(cand.confidence);
      chip.innerHTML =
        `<span class="g-name">${cand.name}</span>` +
        `<span class="g-conf g-${conf.split(' ')[0]}">${conf}</span>` +
        `<span class="g-why">${cand.rationale}</span>` +
        (i === 0 && db && db.distinctive ? `<span class="g-dist">${db.distinctive}</span>` : '');
      row.appendChild(chip);
    });
    els.ragaGuess.appendChild(row);
  }

  // Raag analysis card: the swar palette + the learner's worksheet (thaat,
  // aaroh/avaroh, vadi/samvadi, nyas, jati, intonation).
  function renderRaga() {
    const r = state.raga;
    if (!r) { els.swarPalette.textContent = ''; els.ragaThaat.textContent = ''; els.ragaGrammar.textContent = ''; return; }

    if (r.thaat) {
      const c = r.thaat.confidence;
      const tag = c > 0.66 ? '' : c > 0.4 ? ' · approx' : ' · uncertain';
      els.ragaThaat.textContent = (r.thaat.mixed ? 'mixed scale · ' : '') + 'thaat ' + r.thaat.name + tag;
    } else els.ragaThaat.textContent = '';

    renderRagaGuess();

    els.swarPalette.textContent = '';
    const byPc = {};
    for (const s of r.swaras) byPc[s.pc] = s;
    const maxW = Math.max(...r.swaras.map((s) => s.weight), 1e-4);
    for (let pc = 0; pc < 12; pc++) {
      const info = DSP.swaraInfo(pc);
      const used = byPc[pc];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'swar-cell' + (used ? '' : ' unused') + (info.komal ? ' komal' : '') +
        (info.tivra ? ' tivra' : '') + (pc === r.vadi ? ' vadi' : '') + (pc === r.samvadi ? ' samvadi' : '');
      cell.dataset.pc = String(pc);
      const bar = document.createElement('span');
      bar.className = 'swar-bar';
      bar.style.height = used ? (5 + Math.round(used.weight / maxW * 26)) + 'px' : '0';
      cell.appendChild(bar);
      const letter = document.createElement('span');
      letter.className = 'swar-letter';
      letter.textContent = glyph(info.letter);
      cell.appendChild(letter);
      if (used && Math.abs(used.devCents) >= 6) {   // show real intonation, not rounding noise
        const dev = document.createElement('span');
        dev.className = 'swar-dev';
        dev.textContent = (used.devCents > 0 ? '+' : '') + used.devCents;
        cell.appendChild(dev);
      }
      cell.title = used
        ? `${info.letter}${info.komal ? ' komal' : info.tivra ? ' teevra' : ''} · ${Math.round(used.weight * 100)}% of sung time` +
          `${used.devCents ? ` · ${used.devCents > 0 ? '+' : ''}${used.devCents}¢ vs ET` : ''}` +
          `${pc === r.vadi ? ' · vadi' : ''}${pc === r.samvadi ? ' · samvadi' : ''} — tap to highlight`
        : `${info.letter} — not used in this recording`;
      els.swarPalette.appendChild(cell);
    }

    const parts = [];
    if (r.aaroh.length) parts.push('<b>Aaroh</b> ' + r.aaroh.map(swLetter).join(' '));
    if (r.avaroh.length) parts.push('<b>Avaroh</b> ' + r.avaroh.slice().reverse().map(swLetter).join(' '));
    if (r.vadi != null) parts.push('<b>Vadi</b> ' + swLetter(r.vadi) + (r.samvadi != null ? ' · <b>Samvadi</b> ' + swLetter(r.samvadi) : ''));
    if (r.nyas && r.nyas.length) parts.push('<b>Nyas</b> ' + r.nyas.map(swLetter).join(' '));
    if (r.jati) parts.push('<b>Jati</b> ' + r.jati);
    els.ragaGrammar.innerHTML = parts.join('<span class="sep">·</span>');
  }

  // Tap a palette swara to spotlight every place it appears.
  els.swarPalette.addEventListener('click', (e) => {
    const cell = e.target.closest('.swar-cell');
    if (!cell || cell.classList.contains('unused')) return;
    const pc = parseInt(cell.dataset.pc, 10);
    state.highlightPc = state.highlightPc === pc ? null : pc;
    els.swarPalette.querySelectorAll('.swar-cell').forEach((c) =>
      c.classList.toggle('spot', parseInt(c.dataset.pc, 10) === state.highlightPc));
    applyPcHighlight();
    drawCanvas();
  });

  function applyPcHighlight() {
    const pc = state.highlightPc;
    els.notation.classList.toggle('filtering', pc != null);
    els.notation.querySelectorAll('.tok').forEach((el) => {
      el.classList.toggle('pc-hit', pc != null && parseInt(el.dataset.pc, 10) === pc);
    });
  }

  function renderNotation() {
    els.notation.textContent = '';
    activeLineIdx = -1;
    activeTokIdx = -1;
    let flatIdx = 0;
    state.phrases.forEach((ph, phIdx) => {
      ph._start = flatIdx;   // global index of this line's first token
      if (ph.section && phIdx > 0) {
        const gap = document.createElement('div');
        gap.className = 'section-gap';
        gap.textContent = '· · ·';
        els.notation.appendChild(gap);
      }
      const row = document.createElement('div');
      row.className = 'phrase';
      row.dataset.p = String(phIdx);
      const nEl = document.createElement('span');
      nEl.className = 'lnum';
      nEl.textContent = String(phIdx + 1);
      row.appendChild(nEl);
      const tEl = document.createElement('span');
      tEl.className = 'ptime';
      tEl.textContent = fmtTime(ph.t0);
      row.appendChild(tEl);
      for (const tk of ph.tokens) {
        const s = DSP.swaraInfo(tk.k);
        // A meend glide: render the whole via-path S⌒R⌒G⌒m⌒P as one gesture.
        if (tk.glide && tk.via && tk.via.length > 1) {
          const g = document.createElement('span');
          g.className = 'tok glide';
          g.dataset.i = String(flatIdx);
          g.dataset.pc = String(((tk.k % 12) + 12) % 12);
          g.textContent = viaDisplay(tk.via).map((k) => tokenGlyph(k)).join('⌒');
          g.title = `meend through ${viaDisplay(tk.via).map((k) => DSP.tokenText(k)).join(' ')} · ${fmtTime(tk.t0, true)}`;
          row.appendChild(g);
          flatIdx++;
          continue;
        }
        if (tk.meendFromPrev && row.querySelector('.tok')) {
          const conn = document.createElement('span');
          conn.className = 'meend-conn';
          // Show the swaras the glide passes through, not just an arc.
          const v = viaDisplay(tk.via);
          const mid = v.length > 2 ? v.slice(1, -1).map((k) => tokenGlyph(k)).join('⌒') : '';
          conn.textContent = mid ? '⌒' + mid + '⌒' : '⌒';
          conn.title = 'meend (glide)';
          conn.dataset.i = String(flatIdx);
          row.appendChild(conn);
        }
        const span = document.createElement('span');
        span.className = 'tok' + (s.komal ? ' komal' : '') + (s.tivra ? ' tivra' : '') + (tk.andolan ? ' andolan' : '');
        span.dataset.pc = String(((tk.k % 12) + 12) % 12);
        const oct = Math.max(-2, Math.min(2, s.octave));
        if (oct !== 0) span.dataset.oct = String(oct);
        const pre = tk.kan || tk.murki;
        if (pre) {
          const o = document.createElement('span');
          o.className = 'orn';
          o.textContent = '(' + pre.map(k => glyph(DSP.swaraInfo(k).letter)).join('') + ')';
          o.title = tk.kan ? 'kan (grace note)' : 'murki';
          span.appendChild(o);
        }
        if (tk.meend) {
          const mm = document.createElement('span');
          mm.className = 'meend-mark';
          mm.textContent = '~';
          mm.title = 'glide within the note';
          span.appendChild(mm);
        }
        span.appendChild(document.createTextNode(glyph(s.letter)));
        if (tk.andolan && tk.andolanLo != null && (tk.andolanHi > tk.k || tk.andolanLo < tk.k)) {
          const o = document.createElement('span');
          o.className = 'orn';
          o.textContent = '(' + glyph(DSP.swaraInfo(tk.andolanLo).letter) + '–' + glyph(DSP.swaraInfo(tk.andolanHi).letter) + ')';
          o.title = 'andolan swings between these swaras';
          span.appendChild(o);
        }
        if (tk.graceAfter) {
          const o = document.createElement('span');
          o.className = 'orn';
          o.textContent = '(' + tk.graceAfter.map(k => glyph(DSP.swaraInfo(k).letter)).join('') + ')';
          o.title = 'grace after the note';
          span.appendChild(o);
        }
        span.dataset.i = String(flatIdx);
        span.title = `${DSP.tokenFullText(tk, state.scale)} · ${fmtTime(tk.t0, true)}`;
        row.appendChild(span);
        const dashes = Math.min(8, Math.max(0, Math.round((tk.t1 - tk.t0 - 0.35) / 0.3)));
        for (let d = 0; d < dashes; d++) {
          const su = document.createElement('span');
          su.className = 'sus';
          su.textContent = '–';
          su.dataset.i = String(flatIdx);
          row.appendChild(su);
        }
        flatIdx++;
      }
      els.notation.appendChild(row);
    });
    applyPcHighlight();
  }

  els.notation.addEventListener('click', seekFromTokenEl);
  function seekFromTokenEl(e) {
    const t = e.target.closest('[data-i]');
    if (!t) return;
    const tk = state.tokens[parseInt(t.dataset.i, 10)];
    if (tk) seek(tk.t0 + 0.005);
  }

  function updateStats() {
    if (!state.f0) return;
    let voiced = 0;
    for (let i = 0; i < state.f0.length; i++) {
      if (state.f0[i] > 0 && state.clarity[i] >= state.opts.clarityThresh) voiced++;
    }
    let kan = 0, murki = 0, meend = 0, andolan = 0;
    for (const tk of state.tokens) {
      if (tk.kan) kan++;
      if (tk.murki) murki++;
      if (tk.graceAfter) kan++;
      if (tk.meendFromPrev || tk.meend) meend++;
      if (tk.andolan) andolan++;
    }
    let txt = `Sa ≈ ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz) · ${state.tokens.length} notes · voiced ${Math.round(voiced / state.f0.length * 100)}%`;
    const orn = [];
    if (kan) orn.push(`${kan} kan`);
    if (murki) orn.push(`${murki} murki`);
    if (meend) orn.push(`${meend} meend`);
    if (andolan) orn.push(`${andolan} andolan`);
    if (orn.length) txt += ' · ' + orn.join(' · ');
    els.statsLine.textContent = txt;
  }

  function exportHeader() {
    return `SwarLekh notation — ${state.fileName}\n` +
      `Sa = ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz)\n` +
      `Legend: capitals shuddh; lowercase komal (r g d n); m = shuddh Ma, M = teevra Ma;\n` +
      `        X' = taar saptak, .X = mandra saptak; – ≈ 0.3 s held\n` +
      `        (R)G = kan; (GRG)m = murki; X~Y = meend; ≈X = andolan/gamak; ~X = glide in note\n\n`;
  }

  els.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportHeader() + DSP.notationText(state.phrases, state.scale));
      els.copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1500);
    } catch (e) { toast('Clipboard unavailable — use Download instead.'); }
  });

  function download(blob, name) {
    const a = document.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }
  const baseName = () => state.fileName.replace(/\.[^.]+$/, '') || 'swarlekh';

  els.dlTxtBtn.addEventListener('click', () =>
    download(new Blob([exportHeader() + DSP.notationText(state.phrases, state.scale)], { type: 'text/plain' }), baseName() + '.sargam.txt'));

  els.dlJsonBtn.addEventListener('click', () => {
    const data = {
      app: 'SwarLekh', version: 1, file: state.fileName,
      saHz: +state.saHz.toFixed(2), options: state.opts,
      phrases: state.phrases.map((ph, i) => ({
        line: i + 1, section: !!ph.section,
        t0: +ph.t0.toFixed(3), t1: +ph.t1.toFixed(3),
        tokens: ph.tokens.map(tk => {
          const o = {
            t0: +tk.t0.toFixed(3), t1: +tk.t1.toFixed(3),
            swara: DSP.tokenText(tk.k, false), display: DSP.tokenFullText(tk, state.scale),
            k: tk.k, cents: +tk.cents.toFixed(1),
          };
          if (tk.kan) o.kan = tk.kan.map(k => DSP.tokenText(k, false));
          if (tk.murki) o.murki = tk.murki.map(k => DSP.tokenText(k, false));
          if (tk.graceAfter) o.graceAfter = tk.graceAfter.map(k => DSP.tokenText(k, false));
          if (tk.meendFromPrev) o.meendFromPrev = true;
          if (tk.meend) o.glide = true;
          if (tk.andolan) o.andolan = true;
          return o;
        }),
      })),
    };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), baseName() + '.sargam.json');
  });

  els.dlWavBtn.addEventListener('click', async () => {
    if (!synthUrl) return;
    const blob = await (await fetch(synthUrl)).blob();
    download(blob, baseName() + '.melody.wav');
  });

  function encodeWav(samples, sr) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ----------------------------- settings ----------------------------- */

  const octaveSel = $('octaveSel');
  octaveSel.addEventListener('change', () => {
    state.octaveMode = octaveSel.value;
    applyOctaveMode(true);
  });

  // Pitch engine: Fast (YIN DSP) vs Accurate (neural CREPE). Switching re-runs
  // the analysis on the same file (the neural model downloads once, ~3 MB).
  const engineSel = $('engineSel');
  if (engineSel) engineSel.addEventListener('change', () => {
    state.engine = engineSel.value;
    if (state.ready && state.file) {
      if (state.engine === 'neural') toast('Loading neural model (≈3 MB, once) and re-analyzing — give it a moment.');
      else if (state.engine === 'server') toast('Sending to your local server to separate the voice — can take a few minutes.');
      processFile(state.file);
    }
  });

  const scriptSel = $('scriptSel');
  scriptSel.addEventListener('change', () => {
    state.script = scriptSel.value;
    document.body.classList.toggle('deva', state.script === 'devanagari');
    if (state.ready) { renderRaga(); renderNotation(); }
  });

  const detailSel = $('detailSel');
  detailSel.addEventListener('change', () => {
    const v = detailSel.value;
    // Clean keeps ornaments ON now (so murkis/bends show which swaras they
    // touch) but filters noise; Detailed shows every nuance; Simple is the
    // bare melodic skeleton.
    if (v === 'clean') Object.assign(state.opts, { ornaments: true, clean: true, ornMinMs: 45, minNoteMs: 130 });
    else if (v === 'detailed') Object.assign(state.opts, { ornaments: true, clean: false, ornMinMs: 30, minNoteMs: 90 });
    else Object.assign(state.opts, { ornaments: false, clean: true, ornMinMs: 45, minNoteMs: 170 });
    els.minNoteSlider.value = state.opts.minNoteMs;
    els.minNoteVal.textContent = `${state.opts.minNoteMs} ms`;
    renotateNow();
  });

  els.sensSlider.addEventListener('input', () => {
    state.opts.clarityThresh = parseFloat(els.sensSlider.value);
    els.sensVal.textContent = els.sensSlider.value;
    renotateDebounced();
  });
  els.minNoteSlider.addEventListener('input', () => {
    state.opts.minNoteMs = parseInt(els.minNoteSlider.value, 10);
    els.minNoteVal.textContent = `${state.opts.minNoteMs} ms`;
    renotateDebounced();
  });

  /* ----------------------------- playback ----------------------------- */

  function applySpeed() {
    const r = parseFloat(els.speedSel.value);
    origEl.playbackRate = r;
    synthEl.playbackRate = r;
  }
  els.speedSel.addEventListener('change', applySpeed);

  function applySource() {
    const mode = els.sourceSel.value;
    origEl.muted = mode === 'synth';
    synthEl.muted = mode === 'original';
  }
  els.sourceSel.addEventListener('change', applySource);

  /* ------------------------------ pitch ------------------------------ */

  function clearPitchCache() {
    for (const [, v] of pitchCache) {
      if (v.origUrl && v.origUrl !== origUrl) URL.revokeObjectURL(v.origUrl);
      if (v.synthUrl && v.synthUrl !== synthUrl) URL.revokeObjectURL(v.synthUrl);
    }
    pitchCache.clear();
  }

  const noteName = (hz) => noteLabel(hz).split(' ')[0];

  // Rebuild the key dropdown — each reachable transposition labelled by the
  // Sa note it lands on. Call when Sa changes (labels) or a file loads.
  function populatePitchOptions() {
    const sel = els.pitchSel;
    sel.textContent = '';
    for (let s = -PITCH_LIMIT; s <= PITCH_LIMIT; s++) {
      const opt = document.createElement('option');
      opt.value = String(s);
      const tag = s === 0 ? 'original' : (s > 0 ? `+${s}` : `${s}`);
      opt.textContent = state.saHz ? `Sa=${noteName(state.saHz * Math.pow(2, s / 12))} (${tag})` : tag;
      sel.appendChild(opt);
    }
    updatePitchUI();
  }

  function updatePitchUI() {
    const s = state.semitones;
    els.pitchSel.value = String(s);
    els.pitchKey.textContent = '';
    els.pitchDownBtn.disabled = s <= -PITCH_LIMIT;
    els.pitchUpBtn.disabled = s >= PITCH_LIMIT;
  }

  // One reusable worker; requests are matched by id so rapid shifts don't race.
  const pitchPending = new Map();
  let pitchReqId = 0;
  function ensurePitchWorker() {
    if (pitchWorker) return pitchWorker;
    pitchWorker = new Worker(WORKER_URL);
    pitchWorker.onmessage = (e) => {
      const m = e.data;
      const p = pitchPending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.frac); }
      else if (m.type === 'pitchResult') { pitchPending.delete(m.id); p.resolve(m.samples); }
      else if (m.type === 'error') { pitchPending.delete(m.id); p.reject(new Error(m.message)); }
    };
    pitchWorker.onerror = (e) => {
      for (const [, p] of pitchPending) p.reject(new Error(e.message || 'Pitch shift failed'));
      pitchPending.clear();
      pitchWorker = null; // recreate next time
    };
    return pitchWorker;
  }
  function runPitchWorker(samples, sr, semitones, onProgress) {
    return new Promise((resolve, reject) => {
      const w = ensurePitchWorker();
      const id = ++pitchReqId;
      pitchPending.set(id, { resolve, reject, onProgress });
      w.postMessage({ cmd: 'pitch', id, samples, sr, semitones }, [samples.buffer]);
    });
  }

  // Swap the audio sources while keeping the playhead and play/pause state.
  function swapAudioSources(oUrl, sUrl) {
    const t = Math.min(origEl.currentTime, state.duration - 0.05);
    const wasPlaying = state.playing;
    pause();
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      origEl.removeEventListener('loadeddata', restore);
      try { origEl.currentTime = t; if (t < state.synthDuration) synthEl.currentTime = t; } catch (e) {}
      updateTimeDisp();
      if (!state.playing) drawCanvas();
      if (wasPlaying) play();
    };
    origEl.addEventListener('loadeddata', restore);
    origEl.src = oUrl;
    synthEl.src = sUrl;
    origEl.load();
    synthEl.load();
  }

  async function applyPitch(semitones) {
    semitones = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, semitones));
    if (!state.ready || semitones === state.semitones) return;
    state.semitones = semitones;
    updatePitchUI();

    const cached = pitchCache.get(semitones);
    if (cached) { origUrl = cached.origUrl; synthUrl = cached.synthUrl; swapAudioSources(origUrl, synthUrl); return; }

    const seq = ++pitchSeq;
    els.pitchCtl.classList.add('busy');
    try {
      const r = Math.pow(2, semitones / 12);
      const shifted = await runPitchWorker(state.fileMono.slice(), state.fileSr, semitones,
        (f) => { if (seq === pitchSeq) els.pitchKey.textContent = `shifting… ${Math.round(f * 100)}%`; });
      // Re-synthesize the melody guide at the matching pitch (cheap, exact).
      const f0s = new Float32Array(state.f0.length);
      for (let i = 0; i < f0s.length; i++) f0s[i] = state.f0[i] > 0 ? state.f0[i] * r : 0;
      const syn = DSP.synthesize(f0s, state.clarity, state.hopSec, state.sr);
      if (seq !== pitchSeq) return; // a newer request superseded this one
      const oUrl = URL.createObjectURL(encodeWav(shifted, state.fileSr));
      const sUrl = URL.createObjectURL(encodeWav(syn, state.sr));
      pitchCache.set(semitones, { origUrl: oUrl, synthUrl: sUrl });
      origUrl = oUrl; synthUrl = sUrl;
      swapAudioSources(oUrl, sUrl);
    } catch (err) {
      toast('Pitch shift failed: ' + (err.message || err));
    } finally {
      if (seq === pitchSeq) { els.pitchCtl.classList.remove('busy'); updatePitchUI(); }
    }
  }
  els.pitchDownBtn.addEventListener('click', () => applyPitch(state.semitones - 1));
  els.pitchUpBtn.addEventListener('click', () => applyPitch(state.semitones + 1));
  els.pitchSel.addEventListener('change', () => applyPitch(parseInt(els.pitchSel.value, 10)));

  async function play() {
    if (!state.ready) return;
    ensureCtx();
    try {
      await origEl.play();
      if (origEl.currentTime < state.synthDuration) {
        synthEl.currentTime = origEl.currentTime;
        await synthEl.play().catch(() => {});
      }
      state.playing = true;
      els.playBtn.textContent = '⏸';
      startRaf();
    } catch (e) { toast('Playback failed: ' + e.message); }
  }
  function pause() {
    origEl.pause();
    synthEl.pause();
    state.playing = false;
    els.playBtn.textContent = '▶';
    stopRaf();
    updateTimeDisp();
  }
  function togglePlay() { state.playing ? pause() : play(); }
  els.playBtn.addEventListener('click', togglePlay);
  origEl.addEventListener('ended', () => pause());

  function seek(t) {
    t = Math.max(0, Math.min(state.duration - 0.01, t));
    origEl.currentTime = t;
    if (t < state.synthDuration) synthEl.currentTime = t;
    updateTimeDisp();
    if (!state.playing) drawCanvas();
  }

  function updateTimeDisp() {
    els.timeDisp.textContent = `${fmtTime(origEl.currentTime, true)} / ${fmtTime(state.duration)}`;
  }

  /* loop */
  function updateLoopUI() {
    els.loopABtn.classList.toggle('on', state.loopA != null);
    els.loopBBtn.classList.toggle('on', state.loopB != null);
    els.loopDisp.textContent = (state.loopA != null && state.loopB != null)
      ? `${fmtTime(state.loopA)}–${fmtTime(state.loopB)}` : '';
  }
  function setLoopA() {
    state.loopA = origEl.currentTime;
    if (state.loopB != null && state.loopB <= state.loopA) state.loopB = null;
    updateLoopUI(); drawCanvas();
  }
  function setLoopB() {
    const t = origEl.currentTime;
    if (state.loopA == null) state.loopA = 0;
    if (t <= state.loopA + 0.1) { toast('Loop end must come after loop start.'); return; }
    state.loopB = t;
    updateLoopUI(); drawCanvas();
  }
  function clearLoop() { state.loopA = state.loopB = null; updateLoopUI(); drawCanvas(); }
  els.loopABtn.addEventListener('click', setLoopA);
  els.loopBBtn.addEventListener('click', setLoopB);
  els.loopClearBtn.addEventListener('click', clearLoop);

  /* Playback-driven updates. timeupdate (media clock, ~4 Hz, fires even in
   * background/throttled tabs) owns correctness: loop, sync, highlight.
   * requestAnimationFrame only adds smooth canvas motion when visible. */
  function onTimeUpdate() {
    if (!state.ready) return;
    const t = origEl.currentTime;
    if (state.playing && state.loopA != null && state.loopB != null && t >= state.loopB) {
      seek(state.loopA);
      return;
    }
    if (state.playing && !synthEl.paused && Math.abs(synthEl.currentTime - t) > 0.08 && t < state.synthDuration) {
      synthEl.currentTime = t;
    }
    updateTimeDisp();
    highlightActive(t);
    if (!rafId) drawCanvas();
  }
  origEl.addEventListener('timeupdate', onTimeUpdate);

  function startRaf() { stopRaf(); rafId = requestAnimationFrame(tick); }
  function stopRaf() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
  function tick() {
    const t = origEl.currentTime;
    if (!(state.loopA != null && state.loopB != null && t >= state.loopB)) {
      const viewSec = viewWidthSec();
      if (t > state.scrollSec + viewSec * 0.72 || t < state.scrollSec) {
        state.scrollSec = clampScroll(t - viewSec * 0.25);
      }
    }
    updateTimeDisp();
    highlightActive(t);
    drawCanvas();
    if (state.playing) rafId = requestAnimationFrame(tick);
    else rafId = 0;
  }

  function highlightActive(t) {
    // Line tint for context + exact current-swara cursor inside it.
    const phs = state.phrases;
    let lo = 0, hi = phs.length - 1, lineIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (phs[mid].t0 <= t) { lineIdx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (lineIdx >= 0 && t > phs[lineIdx].t1 + 0.4) lineIdx = -1;

    const toks = state.tokens;
    lo = 0; hi = toks.length - 1;
    let tokIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid].t0 <= t + 0.02) { tokIdx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (tokIdx >= 0 && t >= toks[tokIdx].t1 + 0.03) tokIdx = -1;

    if (lineIdx !== activeLineIdx) {
      els.notation.querySelectorAll('.active-line').forEach(el => el.classList.remove('active-line'));
      activeLineIdx = lineIdx;
      if (lineIdx >= 0) {
        const row = els.notation.querySelector(`.phrase[data-p="${lineIdx}"]`);
        if (row) {
          row.classList.add('active-line');
          const c = els.notation;
          const top = row.offsetTop - c.offsetTop;
          if (top < c.scrollTop + 10 || top > c.scrollTop + c.clientHeight - 70) {
            c.scrollTo({ top: Math.max(0, top - 90), behavior: 'smooth' });
          }
        }
      }
    }
    if (tokIdx !== activeTokIdx) {
      els.notation.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
      activeTokIdx = tokIdx;
      if (tokIdx >= 0) {
        els.notation.querySelectorAll(`[data-i="${tokIdx}"]`).forEach(el => el.classList.add('active'));
      }
    }
  }

  /* ------------------------------ canvas ------------------------------ */

  const cvs = els.canvas;
  const cctx = cvs.getContext('2d');
  let colors = {};
  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = {
      card: v('--card'), grid: v('--grid'), gridStrong: v('--grid-strong'),
      saLine: v('--sa-line'), paLine: v('--pa-line'), muted: v('--muted'),
      accent: v('--accent'), accentSoft: v('--accent-soft'), contour: v('--contour'),
      komal: v('--komal'), text: v('--text'),
    };
  }
  refreshColors();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { refreshColors(); drawCanvas(); });
  }

  const GUTTER = 46, RULER = 18;
  function viewWidthSec() { return Math.max(1, (cvs.clientWidth - GUTTER) / state.pxPerSec); }
  function clampScroll(s) { return Math.max(0, Math.min(Math.max(0, state.duration - viewWidthSec() * 0.5), s)); }

  // Indian classical melody moves in curves (meend/gamak), never angular steps —
  // so every melodic line is drawn as a smooth Catmull-Rom spline through its
  // points rather than straight segments. Caller handles beginPath()/stroke();
  // this adds one moveTo + smooth bézier subpath for the given [x,y] points.
  function smoothSub(ctx, pts) {
    const n = pts.length;
    if (n === 0) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (n === 1) return;
    if (n === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]);
    }
  }

  function drawCanvas() {
    if (!state.f0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cvs.clientWidth, H = cvs.clientHeight;
    if (!W || !H) return;
    if (cvs.width !== Math.round(W * dpr) || cvs.height !== Math.round(H * dpr)) {
      cvs.width = Math.round(W * dpr);
      cvs.height = Math.round(H * dpr);
    }
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    cctx.fillStyle = colors.card;
    cctx.fillRect(0, 0, W, H);

    // Follow the playhead while playing so the current notes stay on screen
    // (the view is zoomed in for legibility, so it page-turns as it goes).
    if (state.playing) {
      const pt = origEl.currentTime, vw = viewWidthSec();
      if (pt < state.scrollSec + vw * 0.12 || pt > state.scrollSec + vw * 0.82) {
        state.scrollSec = clampScroll(pt - vw * 0.35);
      }
    }

    const { centsLo, centsHi, scrollSec, pxPerSec, saHz } = state;
    const tToX = (t) => GUTTER + (t - scrollSec) * pxPerSec;
    const cToY = (c) => RULER + (centsHi - c) / (centsHi - centsLo) * (H - RULER - 10);
    const viewSec = viewWidthSec();
    const tEnd = scrollSec + viewSec;

    // Octave-band shading: alternate ultra-faint fills so mandra / madhya /
    // taar saptak read as distinct registers in a wide-range alaap.
    const octLo = Math.floor(centsLo / 1200), octHi = Math.ceil(centsHi / 1200);
    cctx.fillStyle = colors.grid;
    for (let o = octLo; o < octHi; o++) {
      if ((((o % 2) + 2) % 2) === 0) continue;
      const yTop = cToY((o + 1) * 1200), yBot = cToY(o * 1200);
      cctx.globalAlpha = 0.35;
      cctx.fillRect(GUTTER, Math.min(yTop, yBot), W - GUTTER, Math.abs(yBot - yTop));
      cctx.globalAlpha = 1;
    }

    // Swara grid: notes in the song's scale get solid, labelled lines (the
    // "staff" you sight-read from); other semitones are faint, so the eye
    // locks onto the singable degrees.
    const scale = state.scale || new Set([0, 2, 4, 5, 7, 9, 11]);
    cctx.textBaseline = 'middle';
    for (let k = Math.ceil(centsLo / 100); k <= Math.floor(centsHi / 100); k++) {
      const y = cToY(k * 100);
      const deg = ((k % 12) + 12) % 12;
      const inScale = scale.has(deg);
      cctx.beginPath();
      if (deg === 0) { cctx.strokeStyle = colors.saLine; cctx.lineWidth = 1.6; cctx.setLineDash([]); }
      else if (deg === 7) { cctx.strokeStyle = colors.paLine; cctx.lineWidth = 1.1; cctx.setLineDash([5, 4]); }
      else if (inScale) { cctx.strokeStyle = colors.gridStrong; cctx.lineWidth = 1; cctx.setLineDash([]); }
      else { cctx.strokeStyle = colors.grid; cctx.lineWidth = 1; cctx.setLineDash([2, 5]); }
      cctx.moveTo(GUTTER, y);
      cctx.lineTo(W, y);
      cctx.stroke();
      cctx.setLineDash([]);
      const info = DSP.swaraInfo(k);
      const prominent = inScale || deg === 0;
      cctx.font = (prominent ? '600 ' : '') + (prominent ? '12px' : '10px') + ' -apple-system, sans-serif';
      cctx.globalAlpha = prominent ? 1 : 0.5;
      cctx.fillStyle = deg === 0 ? colors.accent : (info.komal ? colors.komal : (prominent ? colors.text : colors.muted));
      cctx.textAlign = 'right';
      cctx.fillText(DSP.tokenText(k, false), GUTTER - 8, y);
      cctx.globalAlpha = 1;
    }

    // time ruler
    cctx.strokeStyle = colors.gridStrong;
    cctx.fillStyle = colors.muted;
    cctx.textAlign = 'center';
    cctx.font = '10px -apple-system, sans-serif';
    const labelEvery = pxPerSec >= 60 ? 5 : pxPerSec >= 25 ? 10 : 30;
    const tickEvery = labelEvery / 5;
    for (let t = Math.ceil(scrollSec / tickEvery) * tickEvery; t <= tEnd; t += tickEvery) {
      const x = tToX(t);
      const isLabel = Math.abs(t / labelEvery - Math.round(t / labelEvery)) < 1e-6;
      cctx.beginPath();
      cctx.moveTo(x, 0);
      cctx.lineTo(x, isLabel ? 8 : 4);
      cctx.stroke();
      if (isLabel) cctx.fillText(fmtTime(t), x, 13);
    }

    // loop region
    if (state.loopA != null && state.loopB != null) {
      cctx.fillStyle = colors.accentSoft;
      cctx.fillRect(tToX(state.loopA), RULER, (state.loopB - state.loopA) * pxPerSec, H - RULER);
    }

    // ---- The melody as ONE flowing curve. This is where the bends read: every
    // meend, murki and gamak shows as the shape of the line (never straight
    // segments). Bold, so it is the main thing on the canvas. ----
    const { f0, clarity, hopSec, opts } = state;
    const i0 = Math.max(0, Math.floor(scrollSec / hopSec));
    const i1 = Math.min(f0.length - 1, Math.ceil(tEnd / hopSec));
    // The line is coloured by how the pitch is MOVING, so the kinds of bend read
    // at a glance: steady note (indigo) vs a glide. Glide speed (net cents/sec,
    // measured over ±3 frames so vibrato — which nets to ~0 — stays "steady")
    // splits into a slow meend (thick saffron) and a quick bend / step (thin
    // saffron). So a long expressive slide looks different from a fast flick or
    // a clean note change.
    const MOVE = [
      { c: colors.contour, w: 2.3, a: 0.5 },   // 0 steady / vibrato
      { c: colors.accent, w: 3.4, a: 0.85 },   // 1 slow bend (meend)
      { c: colors.accent, w: 1.5, a: 0.95 },   // 2 quick bend / step
    ];
    cctx.lineJoin = 'round'; cctx.lineCap = 'round';
    let pts = [], cnt = [];
    const flushRun = () => {
      if (pts.length >= 2) {
        const cls = new Array(pts.length);
        for (let k = 0; k < pts.length; k++) {
          const a = Math.max(0, k - 3), b = Math.min(pts.length - 1, k + 3);
          const slope = Math.abs(cnt[b] - cnt[a]) / (((b - a) * hopSec) || 1);   // cents/sec
          cls[k] = slope < 250 ? 0 : slope < 1500 ? 1 : 2;
        }
        let s = 0;
        for (let k = 1; k <= pts.length; k++) {
          if (k === pts.length || cls[k] !== cls[s]) {
            const st = MOVE[cls[s]];
            cctx.strokeStyle = st.c; cctx.lineWidth = st.w; cctx.globalAlpha = st.a;
            cctx.beginPath(); smoothSub(cctx, pts.slice(s, Math.min(pts.length, k + 1))); cctx.stroke();
            s = k;
          }
        }
      }
      pts = []; cnt = [];
    };
    for (let i = i0; i <= i1; i++) {
      if (f0[i] > 0 && clarity[i] >= opts.clarityThresh) {
        const cc = 1200 * Math.log2(f0[i] / saHz);
        const y = cToY(cc);
        if (y < RULER || y > H) { flushRun(); continue; }
        pts.push([tToX(i * hopSec), y]); cnt.push(cc);
      } else flushRun();
    }
    flushRun();
    cctx.globalAlpha = 1;

    // ---- Name EVERY note. A dot sits on the line at each note the voice hits,
    // and its swara is written beside it; glides name every scale-swara they
    // travel through. If a name won't fit, it is SHRUNK (down to ~7px) rather
    // than ever dropped — names sit right beside their dot with no connector
    // lines (those just read as clutter), each with a card-coloured halo so it
    // stays legible over the curve and grid. ----
    const placed = [];   // boxes [x0,y0,x1,y1] already occupied this frame
    const free = (x0, y0, x1, y1) => {
      for (const b of placed) if (x0 < b[2] + 1 && x1 > b[0] - 1 && y0 < b[3] + 1 && y1 > b[1] - 1) return false;
      return true;
    };
    const labelAt = (text, cx, cy, big, color) => {
      const sizes = big ? [13, 11, 9.5, 8, 7] : [11, 9.5, 8, 7];
      const aboveFirst = cy > RULER + 46;
      let fs = sizes[sizes.length - 1], ly = cy - 11, box = null;
      for (const s of sizes) {
        cctx.font = (big ? '700 ' : '600 ') + s + 'px Georgia, serif';
        const w = cctx.measureText(text).width + 3, h = s + 3, base = h / 2 + 3;
        const offs = aboveFirst ? [-base, base, -(base + 13), base + 13] : [base, -base, base + 13, -(base + 13)];
        for (const dy of offs) {
          const b = [cx - w / 2, cy + dy - h / 2, cx + w / 2, cy + dy + h / 2];
          if (free(b[0], b[1], b[2], b[3])) { fs = s; ly = cy + dy; box = b; break; }
        }
        if (box) break;
      }
      if (!box) {   // no gap even at the smallest size — draw it anyway, just above
        fs = sizes[sizes.length - 1];
        cctx.font = '600 ' + fs + 'px Georgia, serif';
        const w = cctx.measureText(text).width + 3, h = fs + 3;
        ly = cy - (h / 2 + 3); box = [cx - w / 2, ly - h / 2, cx + w / 2, ly + h / 2];
      }
      placed.push(box);
      cctx.font = (big ? '700 ' : '600 ') + fs + 'px Georgia, serif';
      cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
      cctx.lineWidth = 3; cctx.lineJoin = 'round'; cctx.strokeStyle = colors.card;
      cctx.strokeText(text, cx, ly);   // halo for legibility
      cctx.fillStyle = color;
      cctx.fillText(text, cx, ly);
    };

    const vis = [];
    for (let ti = 0; ti < state.tokens.length; ti++) {
      const tk = state.tokens[ti];
      if (tk.t1 >= scrollSec && tk.t0 <= tEnd) vis.push(ti);
    }
    const isGlide = (tk) => (tk.glide || tk.meendFromPrev) && tk.via && tk.via.length > 1;
    const viaX = (tk, p, n) => tToX(tk.t0 + (tk.t1 - tk.t0) * (n > 1 ? p / (n - 1) : 0));

    // Pass 1 — dots & gesture bands: every note is marked, even where its name won't fit.
    for (const ti of vis) {
      const tk = state.tokens[ti];
      const isActive = ti === activeTokIdx;
      if (isGlide(tk)) {
        const vv = viaDisplay(tk.via);
        cctx.fillStyle = colors.contour; cctx.globalAlpha = isActive ? 1 : 0.85;
        for (let p = 0; p < vv.length; p++) { cctx.beginPath(); cctx.arc(viaX(tk, p, vv.length), cToY(vv[p] * 100), 3, 0, 2 * Math.PI); cctx.fill(); }
        cctx.globalAlpha = 1; continue;
      }
      const dur = tk.t1 - tk.t0;
      if (tk.andolan && tk.andolanLo != null && tk.andolanHi > tk.andolanLo) {
        const x = tToX(tk.t0), w = Math.max(3, dur * pxPerSec - 1);
        const yTop = cToY(tk.andolanHi * 100), yBot = cToY(tk.andolanLo * 100);
        cctx.fillStyle = colors.accent; cctx.globalAlpha = isActive ? 0.3 : 0.16;
        cctx.beginPath(); cctx.roundRect(x, yTop - 2, w, (yBot - yTop) + 4, 4); cctx.fill();
        cctx.globalAlpha = 1;
      }
      const cx = tToX((tk.t0 + tk.t1) / 2), cy = cToY(tk.k * 100);
      const held = dur >= 0.28;
      const r = isActive ? 6 : (held ? 4.5 : 3);
      if (isActive) { cctx.fillStyle = colors.accentSoft; cctx.beginPath(); cctx.arc(cx, cy, r + 5, 0, 2 * Math.PI); cctx.fill(); }
      cctx.fillStyle = isActive || held ? colors.accent : colors.contour;
      cctx.globalAlpha = isActive || held ? 1 : 0.8;
      cctx.beginPath(); cctx.arc(cx, cy, r, 0, 2 * Math.PI); cctx.fill();
      cctx.globalAlpha = 1;
    }

    // Pass 2 — names, important notes first so they always win a lane.
    const prio = (ti) => { const t = state.tokens[ti]; return ti === activeTokIdx ? 3 : (t.t1 - t.t0) >= 0.28 ? 2 : isGlide(t) || t.andolan ? 1.5 : 1; };
    for (const ti of vis.slice().sort((a, b) => prio(b) - prio(a) || state.tokens[a].t0 - state.tokens[b].t0)) {
      const tk = state.tokens[ti];
      const isActive = ti === activeTokIdx;
      if (isGlide(tk)) {
        const vv = viaDisplay(tk.via);
        for (let p = 0; p < vv.length; p++) labelAt(tokenGlyph(vv[p]), viaX(tk, p, vv.length), cToY(vv[p] * 100), false, colors.contour);
        continue;
      }
      const cx = tToX((tk.t0 + tk.t1) / 2), cy = cToY(tk.k * 100);
      const big = isActive || (tk.t1 - tk.t0) >= 0.28;
      const col = isActive ? colors.accent : (DSP.swaraInfo(tk.k).komal ? colors.komal : colors.text);
      labelAt((tk.andolan ? '≈' : '') + tokenGlyph(tk.k), cx, cy, big, col);
    }
    cctx.globalAlpha = 1;

    // playhead
    const pt = origEl.currentTime;
    if (pt >= scrollSec && pt <= tEnd) {
      const x = tToX(pt);
      cctx.strokeStyle = colors.accent;
      cctx.lineWidth = 1.6;
      cctx.beginPath();
      cctx.moveTo(x, RULER);
      cctx.lineTo(x, H);
      cctx.stroke();
      cctx.fillStyle = colors.accent;
      cctx.beginPath();
      cctx.moveTo(x - 5, RULER);
      cctx.lineTo(x + 5, RULER);
      cctx.lineTo(x, RULER + 7);
      cctx.fill();
    }
  }

  // canvas interactions: click to seek, drag to pan, wheel to scroll
  let dragInfo = null;
  cvs.addEventListener('pointerdown', (e) => {
    dragInfo = { x: e.clientX, scroll0: state.scrollSec, moved: false };
    cvs.setPointerCapture(e.pointerId);
  });
  cvs.addEventListener('pointermove', (e) => {
    if (!dragInfo) return;
    const dx = e.clientX - dragInfo.x;
    if (Math.abs(dx) > 4) dragInfo.moved = true;
    if (dragInfo.moved) {
      state.scrollSec = clampScroll(dragInfo.scroll0 - dx / state.pxPerSec);
      drawCanvas();
    }
  });
  cvs.addEventListener('pointerup', (e) => {
    if (dragInfo && !dragInfo.moved) {
      const rect = cvs.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x > GUTTER) seek(state.scrollSec + (x - GUTTER) / state.pxPerSec);
    }
    dragInfo = null;
  });
  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.scrollSec = clampScroll(state.scrollSec + d / state.pxPerSec);
    drawCanvas();
  }, { passive: false });

  function zoom(factor) {
    const viewSec = viewWidthSec();
    const center = state.scrollSec + viewSec / 2;
    state.pxPerSec = Math.max(15, Math.min(400, state.pxPerSec * factor));
    state.scrollSec = clampScroll(center - viewWidthSec() / 2);
    drawCanvas();
  }
  els.zoomInBtn.addEventListener('click', () => zoom(1.35));
  els.zoomOutBtn.addEventListener('click', () => zoom(1 / 1.35));

  if (window.ResizeObserver) new ResizeObserver(() => drawCanvas()).observe(cvs);

  /* ---------------------------- keyboard ---------------------------- */

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (!state.ready) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(origEl.currentTime - 2); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(origEl.currentTime + 2); }
    else if (e.key === '[') setLoopA();
    else if (e.key === ']') setLoopB();
    else if (e.key === 'l' || e.key === 'L') clearLoop();
  });

  /* test/debug hook */
  window.SwarLekh = { processFile, state, renotate: renotateNow, _hl: highlightActive,
    _ali: () => activeLineIdx, _renderTonic: renderTonicChips, _syncTonic: syncTonicControls,
    _applyPitch: applyPitch, _audio: { orig: origEl, synth: synthEl } };
})();
