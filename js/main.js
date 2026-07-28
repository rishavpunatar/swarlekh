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
    tonicFineVal: $('tonicFineVal'), tonicHz: $('tonicHz'), droneBtn: $('droneBtn'),
    saAtPlayheadBtn: $('saAtPlayheadBtn'), tonicHint: $('tonicHint'),
    canvas: $('contour'), zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'),
    pitchCtl: document.querySelector('.pitch-ctl'), pitchDownBtn: $('pitchDownBtn'), pitchUpBtn: $('pitchUpBtn'),
    pitchSel: $('pitchSel'), pitchKey: $('pitchKey'),
    micBtn: $('micBtn'), micReadout: $('micReadout'),
    phrasePrevBtn: $('phrasePrevBtn'), phraseNextBtn: $('phraseNextBtn'), phraseDisp: $('phraseDisp'),
    rampBtn: $('rampBtn'), rampDisp: $('rampDisp'),
    sensSlider: $('sensSlider'), sensVal: $('sensVal'),
    minNoteSlider: $('minNoteSlider'), minNoteVal: $('minNoteVal'),
    statsLine: $('statsLine'), toast: $('toast'),
  };

  const state = {
    ready: false, fileName: '',
    f0: null, clarity: null, hopSec: 0.016, sr: 16000,
    tonicCands: [], saHz: 146.83,
    tokens: [], phrases: [], noteRegions: [],
    duration: 0, synthDuration: 0,
    loopA: null, loopB: null,
    phraseLoop: -1,                 // index into state.phrases; -1 = no phrase loop
    ramp: { on: false, rate: 0 },   // speed-ramp practice (active only with a loop)
    micTrail: [],                   // [{t, cents, wall}] — sung trail drawn on the contour
    micCents: null,                 // latest voiced mic reading (cents rel. original Sa space)
    pxPerSec: 120, scrollSec: 0, centsLo: -700, centsHi: 1900,
    playing: false,
    semitones: 0, fileMono: null, fileSr: 16000,
    f0raw: null, f0auto: null, octaveMode: 'auto', octaveDoubled: false,
    raga: null, highlightPc: null, ragaMatches: [], script: 'latin', rhythm: null,
    engine: 'yin', file: null,
    opts: {
      clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45,
      onsetMinMs: 100, clean: true, onsets: [],
    },
  };

  // Bump on every deploy that touches js/ (also bump the ?v= on the <script>
  // tags in index.html to match). Versioning the worker URL cascades to its
  // importScripts, so returning users never run a stale cached worker/DSP.
  const WORKER_URL = 'js/worker.js?v=44';
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
    if (els.fileInput.files[0]) startUpload(els.fileInput.files[0]);
  });
  els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); });
  els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startUpload(f);
  });

  // After upload, go straight to the Best (local-server) voice separation +
  // analysis, then the dashboard. Pitch is changed there — each change asks the
  // server to re-shift the voice and remix the music into the chosen key.
  function startUpload(file) {
    state.engine = 'server';
    const eSel = $('engineSel'); if (eSel) eSel.value = 'server';
    processFile(file);
  }


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
        providedRms: opts.providedRms || null,
        providedHopSec: opts.providedHopSec || 0,
        providedOnsets: opts.providedOnsets || null,
        providedNoteRegions: opts.providedNoteRegions || null,
      }, [samples.buffer]);
    });
  }

  // "Best (local server)" engine: POST the original-rate mono as a WAV to the
  // local Demucs+Praat server (127.0.0.1), which returns the pitch track of the
  // separated voice. Audio only ever goes to your own machine.
  const SERVER_URL = 'http://127.0.0.1:8765';
  let analyzeAbort = null;   // lets the Cancel button stop a long separation
  async function analyzeViaServer() {
    const wav = encodeWav(state.fileMono, state.fileSr);
    analyzeAbort = new AbortController();
    const ctrl = analyzeAbort;
    const to = setTimeout(() => ctrl.abort(), 30 * 60 * 1000);   // safety net, 30 min
    try {
      const resp = await fetch(SERVER_URL + '/analyze', {
        method: 'POST', body: wav, headers: { 'Content-Type': 'application/octet-stream' }, signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();   // { f0, periodicity, rms, noteRegions, hopSec, sr }
    } finally {
      clearTimeout(to);
      if (analyzeAbort === ctrl) analyzeAbort = null;
    }
  }

  // Quick reachability probe so a visitor without the local server never
  // dead-ends: if it isn't up, we fall back to the in-browser engine instead
  // of failing after a long wait.
  async function serverUp() {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 1500);
      const r = await fetch(SERVER_URL + '/', { signal: c.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) { return false; }
  }

  /* Per-file analysis cache (IndexedDB, on-device): re-uploading the same
   * recording tomorrow restores the separated-voice analysis instantly instead
   * of re-running the multi-minute separation. Keyed by SHA-256 of the file. */
  function idbOpen() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('swarlekh', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('analysis');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((res) => {
        const rq = db.transaction('analysis').objectStore('analysis').get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  function idbPut(key, val) {
    idbOpen().then((db) => db.transaction('analysis', 'readwrite').objectStore('analysis').put(val, key)).catch(() => {});
  }
  async function fileHash(ab) {
    const h = await crypto.subtle.digest('SHA-256', ab);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  let processSeq = 0;
  async function processFile(file) {
    const seq = ++processSeq;                 // supersedes any in-flight run
    pitchSeq++;                               // …and any in-flight pitch shift
    const stale = () => seq !== processSeq;
    try {
      state.ready = false;
      pause();
      stopMic();
      state.loopA = state.loopB = null;
      state.phraseLoop = -1;
      state.ramp.on = false; rampUI();
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
      if (stale()) return;
      const hash = 'v4:' + await fileHash(ab.slice(0));   // v4: neural pitch + note regions
      const ctx = ensureCtx();
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab);
      } catch (err) {
        throw new Error('Could not decode this file — is it a valid audio file?');
      }
      if (stale()) return;
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
      if (stale()) return;

      let workerOpts = {};
      state.rhythm = null;
      if (state.engine === 'neural') {
        workerOpts = { neural: true };
      } else if (state.engine === 'server') {
        // Same file analyzed before? Restore the separated-voice analysis
        // instantly from the on-device cache instead of re-separating.
        const cached = await idbGet(hash);
        if (stale()) return;
        if (cached && cached.f0 && cached.f0.length) {
          workerOpts = {
            providedF0: cached.f0,
            providedClarity: cached.periodicity,
            providedRms: cached.rms,
            providedHopSec: cached.hopSec,
            providedOnsets: cached.onsets,
            providedNoteRegions: cached.noteRegions,
          };
          state.rhythm = cached.rhythm || null;
          toast('Analyzed this recording before — restored instantly.');
        } else if (!(await serverUp())) {
          if (stale()) return;
          // No local server: never dead-end — analyze in the browser instead.
          state.engine = 'yin';
          const eSel = $('engineSel'); if (eSel) eSel.value = 'yin';
          toast('Local analysis server not running — using the in-browser engine. Start the server (server/README.md) and re-upload for the highest quality.');
        } else {
          if (stale()) return;
          // The server doesn't stream sub-progress, so show a live elapsed
          // timer — honest about the wait, cancellable any time.
          const t0 = performance.now();
          const estMin = Math.max(1, Math.round(state.duration / 60));
          const ticker = setInterval(() => {
            const s = (performance.now() - t0) / 1000;
            const mm = Math.floor(s / 60), ss = Math.floor(s % 60);
            const frac = 0.12 + 0.64 * (1 - Math.exp(-s / 150));
            setStage(`Isolating the voice on your local server — ${mm}:${ss < 10 ? '0' : ''}${ss} elapsed (typically ${estMin}–${estMin * 2} min, once per recording)`, frac);
          }, 1000);
          let data = null;
          try {
            data = await analyzeViaServer();
          } catch (err) {
            if (stale()) return;
            if (err && err.name === 'AbortError') return;   // user cancelled
            state.engine = 'yin';
            const eSel = $('engineSel'); if (eSel) eSel.value = 'yin';
            toast('The local server hit an error — continuing with the in-browser engine. (' + (err.message || err) + ')');
          } finally {
            clearInterval(ticker);
          }
          if (stale()) return;
          if (data) {
            workerOpts = {
              providedF0: data.f0,
              providedClarity: data.periodicity,
              providedRms: data.rms,
              providedHopSec: data.hopSec,
              providedOnsets: data.onsets,
              providedNoteRegions: data.noteRegions,
            };
            state.rhythm = data.rhythm || null;
            idbPut(hash, {
              f0: data.f0,
              periodicity: data.periodicity,
              rms: data.rms,
              onsets: data.onsets,
              noteRegions: data.noteRegions,
              rhythm: data.rhythm,
              hopSec: data.hopSec,
              ts: Date.now(),
            });
          }
        }
      }
      const result = await runWorker(new Float32Array(mono), targetSr, workerOpts);
      if (stale()) return;
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
      state.noteRegions = result.noteRegions || [];
      applyOctaveMode(false);
      state.synthDuration = result.synth.length / targetSr;

      setStage('Building the contour…', 0.96);
      if (synthUrl) URL.revokeObjectURL(synthUrl);
      synthUrl = URL.createObjectURL(encodeWav(result.synth, targetSr));
      synthEl.src = synthUrl;

      state.saHz = result.tonic[0].hz;
      renderRhythm();
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
      if (seq !== processSeq) return;
      els.progressCard.hidden = true;
      if (!state.ready) els.dropzone.classList.remove('compact');
      toast(err.message || String(err));
    }
  }

  // Cancel a long separation and return to the dropzone.
  if ($('cancelBtn')) $('cancelBtn').addEventListener('click', () => {
    processSeq++;
    if (analyzeAbort) analyzeAbort.abort();
    els.progressCard.hidden = true;
    if (!state.ready) els.dropzone.classList.remove('compact');
    else els.resultArea.hidden = false;
  });

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

  // Taal & tempo line in the Raag card — shown only when the accompaniment has
  // a clear, steady pulse (the dominant one; rhythm sections may vary).
  function renderRhythm() {
    const el = $('taalLine');
    if (!el) return;
    const r = state.rhythm;
    if (!r) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    if (!r.taal) {
      el.innerHTML = `\u2669 \u2248 <b>${Math.round(r.bpm)} BPM</b> \u00b7 no single repeating cycle stood out. Beats tick along the contour ruler.`;
    } else {
      const alt = r.alt ? ` (or ${r.alt})` : '';
      el.innerHTML = `\u2669 \u2248 <b>${Math.round(r.bpm)} BPM</b> \u00b7 ${r.cycle}-beat cycle \u2014 ${r.conf} <b>${r.taal}</b>${alt}. Beats tick along the contour ruler; the heavier ticks are the estimated sam.`;
    }
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
      els.tonicHint.innerHTML = '⚠️ <b>Sa is a close call.</b> Try the candidates with the <b>Drone</b>, or pause on a sung Sa and choose <b>Set playhead as Sa</b>.';
    } else if (uncertain) {
      els.tonicHint.innerHTML = '⚠️ Couldn’t hear enough clear melody to be sure of Sa. Set it by note, or pause on a sung Sa and choose <b>Set playhead as Sa</b>.';
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

  function setPlayheadAsSa() {
    if (!state.f0 || !state.clarity) return;
    const center = Math.round(origEl.currentTime / state.hopSec);
    const collect = (radiusSec) => {
      const vals = [];
      const radius = Math.max(1, Math.round(radiusSec / state.hopSec));
      for (let i = Math.max(0, center - radius); i <= Math.min(state.f0.length - 1, center + radius); i++) {
        if (state.f0[i] > 0 && state.clarity[i] >= state.opts.clarityThresh) vals.push(state.f0[i]);
      }
      vals.sort((a, b) => a - b);
      return vals;
    };
    let vals = collect(0.08);
    if (!vals.length) vals = collect(0.25);
    if (!vals.length) {
      toast('No clear sung pitch at the playhead. Move it onto a steady Sa and try again.');
      return;
    }
    state.saHz = vals[vals.length >> 1];
    syncTonicControls();
    renotateNow();
    toast(`Sa set from the playhead: ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz).`);
  }
  if (els.saAtPlayheadBtn) els.saAtPlayheadBtn.addEventListener('click', setPlayheadAsSa);

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
    // The drone must sound in the key you're PRACTISING in — follow the transpose.
    const sa = state.saHz * Math.pow(2, (state.semitones || 0) / 12);
    const f = [sa, sa / 2, sa * 2 / 3, sa * 2];
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
    // Fine-hop contour tracks can resolve short notes directly. The local
    // neural path uses GAME's learned note regions instead of this heuristic.
    const opts = Object.assign({}, state.opts);
    if (state.hopSec <= 0.006 && opts.ornaments && opts.ornMinMs > 25) opts.ornMinMs = 25;
    const res = state.noteRegions.length
      ? DSP.notateRegions(
        state.noteRegions,
        state.f0,
        state.clarity,
        state.hopSec,
        state.saHz,
        opts
      )
      : DSP.notate(state.f0, state.clarity, state.hopSec, state.saHz, opts);
    state.tokens = res.tokens;
    state.phrases = res.phrases;
    state.raga = DSP.analyzeRaga(res.tokens, res.phrases);
    state.ragaMatches = (state.raga && window.RagaId && window.RAGAS)
      ? RagaId.rankRagas(state.raga, RAGAS).filter((m) => m.score > 0.05).slice(0, 4) : [];
    computeScale();
    computeCentsRange();
    computeSmoothedCents();
    renderRaga();
    drawCanvas();
    updateStats();
  }

  // Precompute the smoothed contour cents ONCE per analysis/Sa/threshold change
  // (drawCanvas runs every animation frame — doing thousands of median sorts
  // per frame there made playback churn). Median over ±~16 ms: jitter dies,
  // each fast note's plateau survives. NaN = unvoiced.
  function computeSmoothedCents() {
    const { f0, clarity, hopSec, saHz, opts } = state;
    const n = f0.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = (f0[i] > 0 && clarity[i] >= opts.clarityThresh) ? 1200 * Math.log2(f0[i] / saHz) : NaN;
    }
    const half = Math.max(1, Math.round(0.016 / hopSec));
    const out = new Float32Array(n);
    const win = [];
    for (let k = 0; k < n; k++) {
      if (isNaN(raw[k])) { out[k] = NaN; continue; }
      win.length = 0;
      for (let j = Math.max(0, k - half); j <= Math.min(n - 1, k + half); j++) {
        if (!isNaN(raw[j])) win.push(raw[j]);
      }
      win.sort((a, b) => a - b);
      out[k] = win[win.length >> 1];
    }
    state.centsSm = out;
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
    drawCanvas();
  });



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

  // Remember the learner's settings across visits (on-device only).
  function savePrefs() {
    try {
      localStorage.setItem('swarlekh.prefs', JSON.stringify({
        script: scriptSel.value, detail: detailSel.value, octave: octaveSel.value,
      }));
    } catch (e) {}
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('swarlekh.prefs') || '{}');
      if (p.script) { scriptSel.value = p.script; state.script = p.script; document.body.classList.toggle('deva', p.script === 'devanagari'); }
      if (p.detail) { detailSel.value = p.detail; detailSel.dispatchEvent(new Event('change')); }
      if (p.octave) { octaveSel.value = p.octave; state.octaveMode = p.octave; }
    } catch (e) {}
  }

  const octaveSel = $('octaveSel');
  octaveSel.addEventListener('change', () => {
    state.octaveMode = octaveSel.value;
    applyOctaveMode(true);
    savePrefs();
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
    if (state.ready) renderRaga();
    savePrefs();
  });

  const detailMirror = $('detailMirror');
  if (detailMirror) detailMirror.addEventListener('change', () => {
    detailSel.value = detailMirror.value;
    detailSel.dispatchEvent(new Event('change'));
  });
  const detailSel = $('detailSel');
  detailSel.addEventListener('change', () => {
    const v = detailSel.value;
    // Clean keeps ornaments ON now (so murkis/bends show which swaras they
    // touch) but filters noise; Detailed shows every nuance; Simple is the
    // bare melodic skeleton.
    if (v === 'clean') Object.assign(state.opts, { ornaments: true, clean: true, ornMinMs: 45, minNoteMs: 130, onsetMinMs: 100 });
    else if (v === 'detailed') Object.assign(state.opts, { ornaments: true, clean: false, ornMinMs: 30, minNoteMs: 90, onsetMinMs: 80 });
    else Object.assign(state.opts, { ornaments: false, clean: true, ornMinMs: 45, minNoteMs: 170, onsetMinMs: 125 });
    els.minNoteSlider.value = state.opts.minNoteMs;
    els.minNoteVal.textContent = `${state.opts.minNoteMs} ms`;
    if (detailMirror) detailMirror.value = v;
    renotateNow();
    savePrefs();
  });

  loadPrefs();

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
    if (state.ramp.on) return;             // ramp owns the rate while active
    const r = parseFloat(els.speedSel.value);
    origEl.playbackRate = r;
    synthEl.playbackRate = r;
  }
  els.speedSel.addEventListener('change', () => { stopRamp(); applySpeed(); });

  /* ramp practice: with a loop set, each repeat speeds up 0.65x -> 1x */
  const RAMP = { from: 0.65, step: 0.05, to: 1 };
  function setRate(r) { origEl.playbackRate = r; synthEl.playbackRate = r; }
  function rampUI() {
    els.rampBtn.classList.toggle('on', state.ramp.on);
    els.rampDisp.textContent = state.ramp.on ? state.ramp.rate.toFixed(2).replace(/0$/, '') + '\u00d7' : '';
  }
  function startRamp() {
    state.ramp.on = true;
    state.ramp.rate = RAMP.from;
    setRate(RAMP.from);
    rampUI();
  }
  function stopRamp() {
    if (!state.ramp.on) return;
    state.ramp.on = false;
    applySpeed();                          // hand the rate back to the Speed select
    rampUI();
  }
  function rampStep() {
    if (state.ramp.rate >= RAMP.to) return;
    state.ramp.rate = Math.min(RAMP.to, state.ramp.rate + RAMP.step);
    setRate(state.ramp.rate);
    rampUI();
    if (state.ramp.rate >= RAMP.to) toast('Full speed — keep looping, or \u27e9 for the next line.');
  }
  els.rampBtn.addEventListener('click', () => {
    if (state.ramp.on) { stopRamp(); return; }
    if (state.loopA == null || state.loopB == null) {
      toast('Set a loop first (drag the ruler, or \u27e8 \u27e9 for a line) \u2014 Ramp speeds up each repeat.');
      return;
    }
    startRamp();
    if (!state.playing) { seek(state.loopA); play(); }
  });

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
    updateDroneFreq();   // the drone follows the practised key
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

  // Swap the audio sources while keeping the playhead, play/pause state and
  // playback rate. A single pending restore handle: rapid consecutive swaps
  // (e.g. clicking pitch − twice) replace it instead of stacking listeners —
  // stacked listeners used to reset the playhead to 0 and stop playback.
  let pendingRestore = null;
  let swapCtx = null;   // {t, wasPlaying} captured at the FIRST of a burst of swaps
  function swapAudioSources(oUrl, sUrl) {
    if (!swapCtx) swapCtx = { t: Math.min(origEl.currentTime, state.duration - 0.05), wasPlaying: state.playing };
    pause();
    if (pendingRestore) origEl.removeEventListener('loadeddata', pendingRestore);
    const restore = () => {
      origEl.removeEventListener('loadeddata', restore);
      if (pendingRestore !== restore) return;   // superseded by a newer swap
      pendingRestore = null;
      const { t, wasPlaying } = swapCtx || { t: 0, wasPlaying: false };
      swapCtx = null;
      try { origEl.currentTime = t; if (t < state.synthDuration) synthEl.currentTime = t; } catch (e) {}
      if (state.ramp.on) setRate(state.ramp.rate); else applySpeed();   // load() resets playbackRate
      updateTimeDisp();
      if (!state.playing) drawCanvas();
      if (wasPlaying) play();
    };
    pendingRestore = restore;
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

    // In-browser phase-vocoder transpose (the server WORLD/Rubber Band path was
    // removed — it didn't sound right; transpose quality is parked for now).
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
    els.phraseDisp.textContent = state.phraseLoop >= 0
      ? `line ${state.phraseLoop + 1}/${state.phrases.length}` : '';
    els.phrasePrevBtn.classList.toggle('on', state.phraseLoop >= 0);
    els.phraseNextBtn.classList.toggle('on', state.phraseLoop >= 0);
    els.phrasePrevBtn.disabled = state.phraseLoop === 0;
    els.phraseNextBtn.disabled = state.phraseLoop >= 0 && state.phraseLoop === state.phrases.length - 1;
  }
  function setLoopA() {
    state.phraseLoop = -1;
    state.loopA = origEl.currentTime;
    if (state.loopB != null && state.loopB <= state.loopA) state.loopB = null;
    updateLoopUI(); drawCanvas();
  }
  function setLoopB() {
    state.phraseLoop = -1;
    const t = origEl.currentTime;
    if (state.loopA == null) state.loopA = 0;
    if (t <= state.loopA + 0.1) { toast('Loop end must come after loop start.'); return; }
    state.loopB = t;
    updateLoopUI(); drawCanvas();
  }
  function clearLoop() { state.loopA = state.loopB = null; state.phraseLoop = -1; stopRamp(); updateLoopUI(); drawCanvas(); }
  els.loopABtn.addEventListener('click', setLoopA);
  els.loopBBtn.addEventListener('click', setLoopB);
  els.loopClearBtn.addEventListener('click', clearLoop);

  /* phrase looping: ⟨ ⟩ snap the loop to notation lines with a small pad */
  const PHRASE_PAD = 0.15;
  function loopPhrase(idx) {
    const phs = state.phrases;
    if (!phs.length) return;
    idx = Math.max(0, Math.min(phs.length - 1, idx));
    state.phraseLoop = idx;
    state.loopA = Math.max(0, phs[idx].t0 - PHRASE_PAD);
    state.loopB = Math.min(state.duration - 0.01, phs[idx].t1 + PHRASE_PAD);
    if (state.ramp.on) startRamp();       // re-arm the ramp for the new phrase
    updateLoopUI();
    seek(state.loopA);
    if (!state.playing) play();           // one tap = hear the line immediately
    drawCanvas();
  }
  function stepPhrase(dir) {
    if (!state.phrases.length) return;
    if (state.phraseLoop >= 0) { loopPhrase(state.phraseLoop + dir); return; }
    // First press: loop the line under (or just before) the playhead.
    const t = origEl.currentTime;
    const phs = state.phrases;
    let lo = 0, hi = phs.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (phs[mid].t0 <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    loopPhrase(idx);
  }
  els.phrasePrevBtn.addEventListener('click', () => stepPhrase(-1));
  els.phraseNextBtn.addEventListener('click', () => stepPhrase(1));

  /* ------------------------- live mic practice -------------------------
   * "Sing along": the microphone is pitch-tracked entirely on this device —
   * audio is analyzed in memory and discarded; nothing is recorded and nothing
   * leaves the machine. The sung pitch draws as a teal trail over the melody. */
  const MIC = {
    RING_SEC: 0.5,        // rolling 16 kHz analysis buffer
    ANALYZE_SEC: 0.1,     // yin window per tick (1600 samples -> 4 frames)
    TICK_MS: 60,
    TRAIL_MS: 4000,       // how long the sung trail lingers on the canvas
    CLARITY_MIN: 0.6,     // close-mic voice is clean; stricter than file tracking
    LATENCY_SEC: 0.10,    // input+block latency estimate; trail is back-dated by this
  };
  let mic = null;         // { stream, src, node, silent, ring, w, filled, timer } — null = off
  async function startMic() {
    if (mic || !state.ready) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Sing-along needs microphone support (a current Chrome, Edge, Firefox or Safari).');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
    } catch (err) {
      toast(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        ? 'Mic access was blocked. Allow the microphone for this site to sing along — your voice is analyzed on this device only, never recorded, never uploaded.'
        : 'No usable microphone was found.');
      return;
    }
    const ctx = ensureCtx();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;                 // ScriptProcessor must reach the destination; keep it inaudible
    const ring = new Float32Array(Math.round(16000 * MIC.RING_SEC));
    mic = { stream, src, node, silent, ring, w: 0, filled: 0, timer: 0 };
    node.onaudioprocess = (e) => {
      const m = mic; if (!m) return;
      const inp = e.inputBuffer.getChannelData(0);
      const ratio = ctx.sampleRate / 16000;   // 44.1k/48k -> 16k, linear interp
      for (let o = 0; (o * ratio | 0) < inp.length - 1; o++) {
        const p = o * ratio, i = p | 0, fr = p - i;
        m.ring[m.w] = inp[i] * (1 - fr) + inp[i + 1] * fr;
        m.w = (m.w + 1) % m.ring.length;
        if (m.filled < m.ring.length) m.filled++;
      }
    };
    src.connect(node); node.connect(silent); silent.connect(ctx.destination);
    mic.timer = setInterval(micTick, MIC.TICK_MS);
    els.micBtn.classList.add('on');
    els.micReadout.textContent = 'listening…';
    toast('Sing along: your voice traces onto the contour in teal. Analyzed live on this device — never recorded, never uploaded. Headphones give the cleanest trace.');
  }
  function micTick() {
    const m = mic;
    if (!m) return;
    const need = Math.round(16000 * MIC.ANALYZE_SEC);
    if (m.filled < need) return;
    const seg = new Float32Array(need);   // unroll the last ~100 ms from the ring
    for (let i = 0; i < need; i++) seg[i] = m.ring[(m.w - need + i + m.ring.length) % m.ring.length];
    const r = DSP.yinTrack(seg, 16000, { fmin: 80, fmax: 1000 });
    let best = -1;
    for (let i = 0; i < r.f0.length; i++) {
      if (r.f0[i] > 0 && r.clarity[i] >= MIC.CLARITY_MIN &&
          (best < 0 || r.clarity[i] > r.clarity[best])) best = i;
    }
    if (best < 0) {
      state.micCents = null;
    } else {
      // Compare against the TRANSPOSED Sa: the user sings in the shifted key,
      // the contour is plotted rel. the original saHz — dividing the shift out
      // maps the voice straight into the contour's cents space.
      const refSa = state.saHz * Math.pow(2, state.semitones / 12);
      state.micCents = 1200 * Math.log2(r.f0[best] / refSa);
      if (state.playing) {                 // paused singing feeds the readout only
        state.micTrail.push({
          t: Math.max(0, origEl.currentTime - MIC.LATENCY_SEC),
          cents: state.micCents, wall: performance.now(),
        });
      }
    }
    const cut = performance.now() - MIC.TRAIL_MS;
    while (state.micTrail.length && state.micTrail[0].wall < cut) state.micTrail.shift();
    updateMicReadout();
    if (!state.playing && !rafId) drawCanvas();   // rAF already repaints while playing
  }
  function updateMicReadout() {
    if (!mic) return;
    if (state.micCents == null) {
      els.micReadout.textContent = '\u00b7';
      els.micReadout.classList.remove('good');
      return;
    }
    const c = state.micCents;
    const k = Math.round(c / 100), dev = Math.round(c - k * 100);
    els.micReadout.textContent = `you: ${tokenGlyph(k)} ${dev >= 0 ? '+' : ''}${dev}\u00a2`;
    els.micReadout.classList.toggle('good', Math.abs(dev) <= 20);
  }
  function stopMic() {
    const m = mic;
    if (!m) return;
    mic = null;
    clearInterval(m.timer);
    if (m.node) m.node.onaudioprocess = null;
    try { m.src.disconnect(); m.node.disconnect(); m.silent.disconnect(); } catch (e) {}
    if (m.stream && m.stream.getTracks) m.stream.getTracks().forEach((tr) => tr.stop());
    state.micTrail = [];
    state.micCents = null;
    els.micBtn.classList.remove('on');
    els.micReadout.textContent = '';
    els.micReadout.classList.remove('good');
    drawCanvas();
  }
  els.micBtn.addEventListener('click', () => (mic ? stopMic() : startMic()));

  /* Playback-driven updates. timeupdate (media clock, ~4 Hz, fires even in
   * background/throttled tabs) owns correctness: loop, sync, highlight.
   * requestAnimationFrame only adds smooth canvas motion when visible. */
  function onTimeUpdate() {
    if (!state.ready) return;
    const t = origEl.currentTime;
    if (state.playing && state.loopA != null && state.loopB != null && t >= state.loopB) {
      if (state.ramp.on) rampStep();      // one loop repetition done -> nudge the speed
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
    // Keep the just-started note lit until the NEXT note begins, so the
    // highlight never blanks between notes (the binary search above already
    // advances to the next note the instant it starts). Only clear at a real
    // rest — well past this note's end with nothing following yet.
    if (tokIdx >= 0 && t > toks[tokIdx].t1 + 0.35 &&
        (tokIdx + 1 >= toks.length || toks[tokIdx + 1].t0 > t)) tokIdx = -1;

    // drawCanvas reads these: the current swara gets the accent halo/label and
    // the phrase index feeds the phrase-loop display.
    activeLineIdx = lineIdx;
    activeTokIdx = tokIdx;
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
      komal: v('--komal'), text: v('--text'), mic: v('--mic'),
    };
  }
  refreshColors();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { refreshColors(); drawCanvas(); });
  }

  const GUTTER = 46, RULER = 18;

  // Text metrics are layout-engine calls and drawCanvas runs every frame with a
  // tiny fixed vocabulary of swara glyphs — memoize widths per (text, font).
  const textWCache = new Map();
  function textW(text, font) {
    const key = font + '|' + text;
    let w = textWCache.get(key);
    if (w === undefined) { w = cctx.measureText(text).width; textWCache.set(key, w); }
    return w;
  }
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

    // Taal beat grid: thin ticks at each detected beat in the ruler strip;
    // heavier saffron ticks mark the estimated sam (cycle start).
    if (state.rhythm && state.rhythm.beats) {
      const rb = state.rhythm;
      cctx.strokeStyle = colors.gridStrong;
      cctx.lineWidth = 1;
      for (const t of rb.beats) {
        if (t < scrollSec || t > tEnd) continue;
        const x = tToX(t);
        cctx.globalAlpha = 0.7;
        cctx.beginPath(); cctx.moveTo(x, RULER - 6); cctx.lineTo(x, RULER); cctx.stroke();
      }
      cctx.globalAlpha = 1;
      if (rb.sam) {
        cctx.strokeStyle = colors.accent;
        cctx.lineWidth = 2;
        for (const t of rb.sam) {
          if (t < scrollSec || t > tEnd) continue;
          const x = tToX(t);
          cctx.beginPath(); cctx.moveTo(x, RULER - 9); cctx.lineTo(x, RULER); cctx.stroke();
        }
      }
    }

    // loop region + draggable grab handles + bold ruler band
    if (state.loopA != null && state.loopB != null) {
      const xa = tToX(state.loopA), xb = tToX(state.loopB);
      cctx.fillStyle = colors.accentSoft;
      cctx.fillRect(xa, RULER, xb - xa, H - RULER);
      cctx.fillStyle = colors.accent;
      cctx.globalAlpha = 0.55;
      cctx.fillRect(xa, 2, xb - xa, RULER - 4);        // bold band in the ruler strip
      cctx.globalAlpha = 1;
      for (const x of [xa, xb]) {                      // edge line + pill handle
        cctx.fillRect(x - 1, RULER, 2, H - RULER);
        cctx.beginPath(); cctx.roundRect(x - 4, RULER + 3, 8, 15, 4); cctx.fill();
      }
      if (state.phraseLoop >= 0 && xb - xa > 60) {
        cctx.fillStyle = colors.card;
        cctx.font = '600 9px -apple-system, sans-serif';
        cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
        cctx.fillText('phrase ' + (state.phraseLoop + 1), (xa + xb) / 2, RULER / 2);
      }
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
    // Bridge brief drop-outs (so one note's line doesn't shatter at a clarity
    // dip) and drop isolated tiny fragments — together these remove the "random
    // unconnected lines" and leave clean lines tracing the melody through the notes.
    const BRIDGE = Math.max(2, Math.round(0.16 / hopSec));   // connect gaps ≤ ~160 ms
    const MINLEN = Math.max(3, Math.round(0.06 / hopSec));   // drop runs shorter than ~60 ms
    // Smoothed contour cents are PRECOMPUTED in computeSmoothedCents() (median,
    // ±16 ms) — drawCanvas runs every animation frame, so it only reads.
    const csm = state.centsSm || new Float32Array(0);
    let pts = [], cnt = [], gap = 0;
    const flushRun = () => {
      if (pts.length >= MINLEN) {
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
      const cc = csm[i];
      if (!isNaN(cc)) {
        const y = cToY(cc);
        if (y < RULER || y > H) { flushRun(); gap = 0; continue; }
        pts.push([tToX(i * hopSec), y]); cnt.push(cc); gap = 0;
      } else if (pts.length && ++gap > BRIDGE) { flushRun(); gap = 0; }
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
        const w = textW(text, cctx.font) + 3, h = s + 3, base = h / 2 + 3;
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
        const w = textW(text, cctx.font) + 3, h = fs + 3;
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
    // Palette spotlight: tapping a swara in the raag card dims every other note
    // so each place it appears jumps out.
    const spotPc = state.highlightPc;
    const dimmed = (tk) => spotPc != null && ((tk.k % 12) + 12) % 12 !== spotPc;

    // Pass 1 — dots & gesture bands: every note is marked, even where its name won't fit.
    for (const ti of vis) {
      const tk = state.tokens[ti];
      const isActive = ti === activeTokIdx;
      if (dimmed(tk)) {   // spotlight mode: non-matching notes become faint specks
        cctx.fillStyle = colors.muted; cctx.globalAlpha = 0.25;
        cctx.beginPath();
        cctx.arc(tToX((tk.t0 + tk.t1) / 2), cToY(tk.cents != null ? tk.cents : tk.k * 100), 2, 0, 2 * Math.PI);
        cctx.fill(); cctx.globalAlpha = 1;
        continue;
      }
      if (spotPc != null && !isActive) {   // a match while spotlighting: make it pop
        const cx0 = tToX((tk.t0 + tk.t1) / 2), cy0 = cToY(tk.cents != null ? tk.cents : tk.k * 100);
        cctx.strokeStyle = colors.accent; cctx.lineWidth = 2; cctx.globalAlpha = 0.9;
        cctx.beginPath(); cctx.arc(cx0, cy0, 7, 0, 2 * Math.PI); cctx.stroke(); cctx.globalAlpha = 1;
      }
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
      // Anchor the dot to the SUNG pitch (token mean cents), not the quantized
      // grid — so it sits ON the curve even when the note is sung komal-ish or
      // between grid lines. The label still names the quantized swara.
      const cx = tToX((tk.t0 + tk.t1) / 2), cy = cToY(tk.cents != null ? tk.cents : tk.k * 100);
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
      if (dimmed(tk)) continue;   // spotlight mode: no labels on non-matching notes
      if (isGlide(tk)) {
        const vv = viaDisplay(tk.via);
        for (let p = 0; p < vv.length; p++) labelAt(tokenGlyph(vv[p]), viaX(tk, p, vv.length), cToY(vv[p] * 100), false, colors.contour);
        continue;
      }
      const cx = tToX((tk.t0 + tk.t1) / 2), cy = cToY(tk.cents != null ? tk.cents : tk.k * 100);
      const big = isActive || (tk.t1 - tk.t0) >= 0.28;
      const col = isActive ? colors.accent : (DSP.swaraInfo(tk.k).komal ? colors.komal : colors.text);
      labelAt((tk.andolan ? '≈' : '') + tokenGlyph(tk.k), cx, cy, big, col);
    }
    cctx.globalAlpha = 1;

    // ---- Sing-along trail: the last ~4 s of the user's voice over the melody,
    // in the mic colour, fading with age. Drawn above the melody & labels,
    // below the playhead. ----
    if (state.micTrail.length) {
      const now = performance.now();
      cctx.strokeStyle = colors.mic;
      cctx.lineCap = 'round'; cctx.lineJoin = 'round';
      let prevP = null;
      for (const p of state.micTrail) {
        // connect only near-consecutive readings: >200 ms wall gap = unvoiced
        // break; >0.3 s media-time gap = a seek/loop jump — never bridge those.
        if (prevP && p.wall - prevP.wall < 200 && Math.abs(p.t - prevP.t) < 0.3) {
          cctx.globalAlpha = Math.max(0.05, 1 - (now - p.wall) / MIC.TRAIL_MS) * 0.9;
          cctx.lineWidth = 2.6;
          cctx.beginPath();
          cctx.moveTo(tToX(prevP.t), cToY(prevP.cents));
          cctx.lineTo(tToX(p.t), cToY(p.cents));
          cctx.stroke();
        }
        prevP = p;
      }
      cctx.globalAlpha = 1;
    }
    if (mic && state.micCents != null) {   // live dot riding the playhead
      const yMic = cToY(state.micCents);
      if (yMic > RULER && yMic < H) {
        cctx.fillStyle = colors.mic;
        cctx.beginPath(); cctx.arc(tToX(origEl.currentTime), yMic, 4.5, 0, 2 * Math.PI); cctx.fill();
      }
    }

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

  // canvas interactions: click to seek, body-drag to pan, RULER-drag to set
  // the loop, loop-edge handles to resize it, wheel to scroll/zoom.
  let dragInfo = null;
  const xToT = (clientX) => {
    const rect = cvs.getBoundingClientRect();
    return state.scrollSec + (clientX - rect.left - GUTTER) / state.pxPerSec;
  };
  // Hit-test the loop-edge grab handles (±6 px, any height).
  function loopEdgeAt(clientX) {
    if (state.loopA == null || state.loopB == null) return null;
    const rect = cvs.getBoundingClientRect();
    const x = clientX - rect.left;
    const xa = GUTTER + (state.loopA - state.scrollSec) * state.pxPerSec;
    const xb = GUTTER + (state.loopB - state.scrollSec) * state.pxPerSec;
    if (Math.abs(x - xb) <= 6) return 'b';     // B first: wins when the loop is tiny
    if (Math.abs(x - xa) <= 6) return 'a';
    return null;
  }
  cvs.addEventListener('pointerdown', (e) => {
    const rect = cvs.getBoundingClientRect();
    const y = e.clientY - rect.top, x = e.clientX - rect.left;
    const edge = loopEdgeAt(e.clientX);
    if (edge) {
      dragInfo = { mode: 'edge', edge, moved: false };
    } else if (y < RULER && x > GUTTER) {
      dragInfo = { mode: 'loop', t0: Math.max(0, Math.min(state.duration, xToT(e.clientX))),
                   prevA: state.loopA, prevB: state.loopB, moved: false };
    } else {
      dragInfo = { mode: 'pan', x: e.clientX, scroll0: state.scrollSec, moved: false };
    }
    cvs.setPointerCapture(e.pointerId);
  });
  cvs.addEventListener('pointermove', (e) => {
    if (!dragInfo) {   // idle: cursor affordances so the ruler invites the drag
      const y = e.clientY - cvs.getBoundingClientRect().top;
      cvs.style.cursor = loopEdgeAt(e.clientX) ? 'ew-resize' : (y < RULER ? 'crosshair' : '');
      return;
    }
    if (dragInfo.mode === 'pan') {
      const dx = e.clientX - dragInfo.x;
      if (Math.abs(dx) > 4) dragInfo.moved = true;
      if (dragInfo.moved) {
        state.scrollSec = clampScroll(dragInfo.scroll0 - dx / state.pxPerSec);
        drawCanvas();
      }
      return;
    }
    dragInfo.moved = true;
    const t = Math.max(0, Math.min(state.duration, xToT(e.clientX)));
    if (dragInfo.mode === 'loop') {
      state.loopA = Math.min(dragInfo.t0, t);
      state.loopB = Math.max(dragInfo.t0, t);
    } else if (dragInfo.edge === 'a') {
      state.loopA = Math.min(t, state.loopB - 0.1);
    } else {
      state.loopB = Math.max(t, state.loopA + 0.1);
    }
    state.phraseLoop = -1;          // a hand-set loop is no longer a phrase loop
    updateLoopUI(); drawCanvas();
  });
  cvs.addEventListener('pointerup', (e) => {
    if (dragInfo) {
      if (dragInfo.mode === 'loop') {
        // A sub-150 ms "loop" is just a click: restore what was there and seek.
        if (dragInfo.moved && state.loopB - state.loopA < 0.15) {
          state.loopA = dragInfo.prevA; state.loopB = dragInfo.prevB;
          updateLoopUI();
        }
        if (!dragInfo.moved || state.loopB == null || state.loopB - state.loopA < 0.15) {
          seek(dragInfo.t0);
        } else {
          seek(state.loopA);        // a fresh loop starts playing from its start
        }
        drawCanvas();
      } else if (!dragInfo.moved && dragInfo.mode === 'pan') {
        const rect = cvs.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x > GUTTER) seek(state.scrollSec + (x - GUTTER) / state.pxPerSec);
      }
    }
    dragInfo = null;
  });
  cvs.addEventListener('dblclick', (e) => {
    if (e.clientY - cvs.getBoundingClientRect().top < RULER) clearLoop();
  });
  cvs.addEventListener('wheel', (e) => {
    // ⌘/Ctrl+wheel (and trackpad pinch, which browsers report as ctrl+wheel)
    // zooms around the cursor; horizontal wheel pans; a plain vertical wheel
    // is left alone so the page still scrolls past the contour.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = cvs.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tAt = state.scrollSec + Math.max(0, x - GUTTER) / state.pxPerSec;
      state.pxPerSec = Math.max(15, Math.min(400, state.pxPerSec * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      state.scrollSec = clampScroll(tAt - Math.max(0, x - GUTTER) / state.pxPerSec);
      drawCanvas();
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      state.scrollSec = clampScroll(state.scrollSec + e.deltaX / state.pxPerSec);
      drawCanvas();
    }
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
    else if (e.key === ',') stepPhrase(-1);
    else if (e.key === '.') stepPhrase(1);
  });

  /* test/debug hook */
  window.SwarLekh = { processFile, state, renotate: renotateNow, _hl: highlightActive,
    _loopPhrase: loopPhrase, _stepPhrase: stepPhrase, _startRamp: startRamp, _rampStep: rampStep,
    _mic: {
      start: startMic, stop: stopMic, tick: micTick,
      inject(hz, sec) {              // feed a sine straight into the ring buffer (dev/testing)
        if (!mic) {
          mic = { ring: new Float32Array(8000), w: 0, filled: 0, timer: setInterval(micTick, MIC.TICK_MS),
                  stream: { getTracks: () => [] }, node: null, src: { disconnect() {} }, silent: { disconnect() {} } };
          els.micBtn.classList.add('on');
        }
        const n = Math.round(16000 * (sec || 0.2));
        for (let i = 0; i < n; i++) {
          mic.ring[mic.w] = 0.5 * Math.sin(2 * Math.PI * hz * i / 16000);
          mic.w = (mic.w + 1) % mic.ring.length;
          if (mic.filled < mic.ring.length) mic.filled++;
        }
      },
    },
    _ali: () => activeLineIdx, _renderTonic: renderTonicChips, _syncTonic: syncTonicControls,
    _applyPitch: applyPitch, _audio: { orig: origEl, synth: synthEl } };
})();
