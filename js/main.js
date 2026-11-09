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
    ragaThaat: $('ragaThaat'), ragaGuess: $('ragaGuess'), swarPalette: $('swarPalette'), ragaGrammar: $('ragaGrammar'),
    tonicCard: $('tonicCard'), tonicChips: $('tonicChips'), tonicNote: $('tonicNote'), tonicFine: $('tonicFine'),
    tonicFineVal: $('tonicFineVal'), tonicHz: $('tonicHz'), droneBtn: $('droneBtn'),
    saAtPlayheadBtn: $('saAtPlayheadBtn'), tonicHint: $('tonicHint'),
    canvas: $('contour'), zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'),
    addNoteBtn: $('addNoteBtn'), undoNoteBtn: $('undoNoteBtn'), deleteNoteBtn: $('deleteNoteBtn'),
    relabelSa: $('relabelSa'), relabelSaBtn: $('relabelSaBtn'), undoSaBtn: $('undoSaBtn'),
    submitFinishedBtn: $('submitFinishedBtn'), feedbackStatus: $('feedbackStatus'),
    connectorToolbar: $('connectorToolbar'),
    selectedNoteLabel: $('selectedNoteLabel'),
    incomingConnector: $('incomingConnector'),
    outgoingConnector: $('outgoingConnector'),
    freeTargetCtl: $('freeTargetCtl'), freeTarget: $('freeTarget'),
    freeLengthCtl: $('freeLengthCtl'), freeLength: $('freeLength'),
    freeLengthValue: $('freeLengthValue'),
    closeConnectorBtn: $('closeConnectorBtn'),
    pitchCtl: document.querySelector('.pitch-ctl'), pitchDownBtn: $('pitchDownBtn'), pitchUpBtn: $('pitchUpBtn'),
    pitchSel: $('pitchSel'), pitchKey: $('pitchKey'),
    sensSlider: $('sensSlider'), sensVal: $('sensVal'),
    minNoteSlider: $('minNoteSlider'), minNoteVal: $('minNoteVal'),
    statsLine: $('statsLine'), toast: $('toast'),
    playerCard: $('playerCard'), playerMoreBtn: $('playerMoreBtn'),
    notation: $('notation'), notationMeta: $('notationMeta'),
    copyBtn: $('copyBtn'), dlTxtBtn: $('dlTxtBtn'), dlJsonBtn: $('dlJsonBtn'),
    printBtn: $('printBtn'), dlWavBtn: $('dlWavBtn'), clearEditsBtn: $('clearEditsBtn'),
    ragaDetails: $('ragaDetails'), ragaSummary: $('ragaSummary'), sungBtn: $('sungBtn'),
    printTitle: $('printTitle'), printMeta: $('printMeta'),
  };

  const state = {
    ready: false, fileName: '',
    f0: null, clarity: null, hopSec: 0.016, sr: 16000,
    tonicCands: [], saHz: 146.83,
    tokens: [], phrases: [], noteRegions: [], practiceContour: [],
    duration: 0, synthDuration: 0,
    pxPerSec: 120, scrollSec: 0, centsLo: -700, centsHi: 1900,
    playing: false,
    semitones: 0, fileBytes: null, fileMono: null, fileSr: 16000,
    f0raw: null, f0auto: null, octaveMode: 'auto', octaveDoubled: false,
    raga: null, highlightPc: null, ragaMatches: [], script: 'latin', rhythm: null,
    engine: 'yin', file: null, fileSha: null, drift: null, showSung: true, notationRev: 0,
    manualEdits: [], noteEditHistory: [], addNoteMode: false,
    selectedNoteTime: null, noteEditRevision: 0,
    baseline: null, previousSa: null, notationSaHz: null, learningProfile: null, finishedSubmitted: false,
    opts: {
      clarityThresh: 0.5, minNoteMs: 130, ornaments: true, ornMinMs: 45,
      onsetMinMs: 100, clean: true, onsets: [],
    },
  };

  // Bump on every deploy that touches js/ (also bump the ?v= on the <script>
  // tags in index.html to match). Versioning the worker URL cascades to its
  // importScripts, so returning users never run a stale cached worker/DSP.
  const WORKER_URL = 'js/worker.js?v=70';
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
    clearManualNoteEdits();
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

  // "Best (local server)" engine: POST the original recording to the local
  // BS-RoFormer + RMVPE/Praat/GAME server, which returns the separated-voice
  // pitch and note regions. Audio only ever goes to your own machine.
  const SERVER_URL = 'http://127.0.0.1:8765';
  const REQUIRED_SERVER_ANALYSIS_VERSION = 5;
  const SERVER_SILENCE_LIMIT_MS = 90 * 1000;   // no status reply this long = lost contact
  let analyzeAbort = null;   // lets the Cancel button stop a long separation
  let serverJobId = null;    // the running server job, so Cancel can stop it there too
  let serverIssue = '';
  function newJobId() {
    const raw = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : `${Date.now()}${Math.random()}`;
    return raw.replace(/[^0-9a-z]/gi, '').slice(0, 24);
  }
  // Interleaved 16-bit WAV of every channel, for formats the server can't read.
  async function stereoWavFromUpload() {
    const ctx = ensureCtx();
    const buf = await ctx.decodeAudioData(state.fileBytes.slice(0));
    const channels = Math.min(2, buf.numberOfChannels);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(buf.getChannelData(c));
    return encodeWav(data, buf.sampleRate);
  }
  async function analyzeViaServer(onStatus) {
    // Preserve the uploaded channels for vocal separation. Downmixing here can
    // cancel or smear centre-panned vocals and makes GAME invent note boundaries.
    const audio = state.fileBytes || encodeWav(state.fileMono, state.fileSr);
    analyzeAbort = new AbortController();
    const ctrl = analyzeAbort;
    const jobId = newJobId();
    serverJobId = jobId;
    // No fixed time limit: long recordings legitimately take many minutes.
    // The server reports progress; only prolonged silence means trouble.
    let lastContact = performance.now();
    let legacy = false;
    const poll = setInterval(async () => {
      if (legacy) { onStatus(null); return; }      // keep the elapsed timer moving
      try {
        const r = await fetch(`${SERVER_URL}/status?job=${jobId}`, { signal: ctrl.signal });
        if (r.status === 404) { legacy = true; onStatus(null); return; }   // pre-/status server
        if (r.ok) { lastContact = performance.now(); onStatus(await r.json(), jobId); }
      } catch (e) { /* counted as silence below */ }
      if (!legacy && performance.now() - lastContact > SERVER_SILENCE_LIMIT_MS) {
        ctrl.abort(new DOMException('The local server stopped responding.', 'TimeoutError'));
      }
    }, 1500);
    const post = (body, type) => fetch(`${SERVER_URL}/analyze?job=${jobId}`, {
      method: 'POST', body, headers: { 'Content-Type': type }, signal: ctrl.signal,
    });
    try {
      let resp = await post(audio, (state.file && state.file.type) || 'application/octet-stream');
      if (resp.status === 415 && state.fileBytes) {
        // The server couldn't decode this format (no ffmpeg there): send the
        // browser's own decode as a WAV instead.
        resp = await post(await stereoWavFromUpload(), 'audio/wav');
      }
      let payload = null;
      try { payload = await resp.json(); } catch (e) { /* non-JSON error page */ }
      if (!resp.ok) {
        const err = new Error((payload && payload.error) || ('HTTP ' + resp.status));
        if (payload && payload.cancelled) err.name = 'CancelledError';
        throw err;
      }
      return payload;   // { f0, periodicity, rms, noteRegions, onsets, rhythm, hopSec, voicedFraction, … }
    } finally {
      clearInterval(poll);
      if (analyzeAbort === ctrl) analyzeAbort = null;
      if (serverJobId === jobId) serverJobId = null;
    }
  }
  function cancelServerJob() {
    if (!serverJobId) return;
    fetch(`${SERVER_URL}/cancel?job=${serverJobId}`, { method: 'POST' }).catch(() => {});
  }

  // Quick reachability probe so a visitor without the local server never
  // dead-ends: if it isn't up, we fall back to the in-browser engine instead
  // of failing after a long wait.
  async function serverUp() {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 2500);
      const r = await fetch(SERVER_URL + '/', { signal: c.signal });
      clearTimeout(t);
      if (!r.ok) { serverIssue = 'offline'; return false; }
      const info = await r.json();
      if (Number(info.analysisVersion) < REQUIRED_SERVER_ANALYSIS_VERSION ||
          info.neuralModelsInstalled !== true) {
        serverIssue = 'outdated';
        return false;
      }
      serverIssue = '';
      return true;
    } catch (e) {
      serverIssue = 'offline';
      return false;
    }
  }

  const SERVER_STAGE = {
    queued: 'Waiting for the server',
    decoding: 'Reading the audio',
    separating: 'Isolating the voice',
    pitch: 'Tracking pitch (RMVPE + Praat)',
    notes: 'Finding sung notes (GAME)',
    rhythm: 'Detecting tempo and taal',
    done: 'Finishing',
  };
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}:${s < 10 ? '0' : ''}${s}` : `${s}s`;
  }
  function showServerProgress(status, jobId, startedAt) {
    const elapsed = (performance.now() - startedAt) / 1000;
    const job = status && ((status.job && status.job.id === jobId) ? status.job : status.mine);
    if (!job) {
      // Older server without /status: an honest elapsed timer.
      const frac = 0.12 + 0.64 * (1 - Math.exp(-elapsed / 150));
      setStage(`Isolating the voice on your local server — ${fmtDuration(elapsed)} elapsed`, frac);
      return;
    }
    if (status.job && status.job.id !== jobId) {
      setStage('Waiting for the local server to finish another analysis…', 0.12);
      return;
    }
    let label = SERVER_STAGE[job.stage] || job.stage;
    if (job.stage === 'separating' && job.note) {
      label = job.note === 'cached' ? 'Reusing the separated voice'
        : /^Loading/.test(job.note) ? job.note : `${label} (${job.note})`;
    }
    const eta = job.eta != null ? ` · about ${fmtDuration(job.eta)} left` : '';
    setStage(`${label} — ${fmtDuration(job.elapsed)} elapsed${eta}`, 0.12 + 0.82 * job.progress);
  }

  /* Per-file analysis cache (IndexedDB, on-device): re-uploading the same
   * recording tomorrow restores the separated-voice analysis instantly instead
   * of re-running the multi-minute separation. Keyed by SHA-256 of the file.
   * Note corrections live in their own store under the same file hash, so they
   * survive reloads, re-uploads and analysis upgrades. */
  const IDB_ANALYSIS_LIMIT = 25;          // most recent recordings kept
  function idbOpen() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('swarlekh', 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('analysis')) db.createObjectStore('analysis');
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbGet(key, store) {
    try {
      const db = await idbOpen();
      return await new Promise((res) => {
        const rq = db.transaction(store || 'analysis').objectStore(store || 'analysis').get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  function idbPut(key, val, store) {
    return idbOpen().then((db) => new Promise((res) => {
      const tx = db.transaction(store || 'analysis', 'readwrite');
      tx.objectStore(store || 'analysis').put(val, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    })).catch(() => false);
  }
  // Keep the analysis cache bounded: drop the oldest analyses.
  async function pruneAnalysisCache() {
    try {
      const db = await idbOpen();
      const entries = await new Promise((res) => {
        const out = [];
        const rq = db.transaction('analysis').objectStore('analysis').openCursor();
        rq.onsuccess = () => {
          const cursor = rq.result;
          if (!cursor) { res(out); return; }
          out.push({ key: cursor.key, ts: (cursor.value && cursor.value.ts) || 0 });
          cursor.continue();
        };
        rq.onerror = () => res(out);
      });
      if (entries.length <= IDB_ANALYSIS_LIMIT) return;
      entries.sort((a, b) => b.ts - a.ts);
      const store = db.transaction('analysis', 'readwrite').objectStore('analysis');
      for (const entry of entries.slice(IDB_ANALYSIS_LIMIT)) store.delete(entry.key);
    } catch (e) { /* storage unavailable: nothing to prune */ }
  }
  async function fileHash(ab) {
    const h = await crypto.subtle.digest('SHA-256', ab);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function loadNoteEdits(sha) {
    const saved = sha ? await idbGet('edits:' + sha, 'edits') : null;
    return saved && Array.isArray(saved.edits) ? saved.edits : [];
  }
  function persistNoteEdits() {
    if (!state.fileSha) return;
    idbPut('edits:' + state.fileSha, {
      edits: state.manualEdits.map((edit) => Object.assign({}, edit)),
      fileName: state.fileName, saHz: state.saHz, notationSaHz: state.notationSaHz,
      ts: Date.now(),
    }, 'edits');
  }

  let processSeq = 0;
  async function processFile(file) {
    const seq = ++processSeq;                 // supersedes any in-flight run
    pitchSeq++;                               // …and any in-flight pitch shift
    const stale = () => seq !== processSeq;
    try {
      state.ready = false;
      pause();
      setAddNoteMode(false);
      state.baseline = null; state.previousSa = null; state.notationSaHz = null; state.finishedSubmitted = false;
      els.undoSaBtn.hidden = true;
      els.feedbackStatus.textContent = 'Finish correcting every syllable, then submit to improve future drafts.';
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
      // Keep the original channels for the separated-vocal server. The decoded
      // mono copy below remains useful for Fast mode and pitch transposition.
      state.fileBytes = ab.slice(0);
      // v8 adds learned pulse/downbeat reconciliation and taal-cycle metadata.
      const hash = 'v8:' + await fileHash(ab.slice(0));
      if (stale()) return;
      state.fileSha = hash.slice(3);          // corrections are keyed by the file alone
      const training = await idbGet('finished-scores', 'edits');
      if (stale()) return;
      state.learningProfile = Corrections.learnTiming(training || []);
      if (state.learningProfile) {
        Object.assign(state.opts, { minNoteMs: state.learningProfile.minNoteMs, onsetMinMs: state.learningProfile.onsetMinMs });
        els.minNoteSlider.value = state.opts.minNoteMs;
        els.minNoteVal.textContent = `${state.opts.minNoteMs} ms`;
        els.feedbackStatus.textContent = `Timing learned from ${state.learningProfile.examples} reviewed score(s) is applied to this upload.`;
      }
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
      let lowVoiceWarning = false;
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
          toast(serverIssue === 'outdated'
            ? 'Local analysis helper is outdated — update and restart it to use RMVPE + GAME. Using the in-browser engine for now.'
            : 'Local analysis server not running — using the in-browser engine. Start the server (server/README.md) and re-upload for the highest quality.');
        } else {
          if (stale()) return;
          // The server reports its stage and progress; show them live, with
          // an ETA once separation has measurably advanced. Cancellable.
          const t0 = performance.now();
          showServerProgress(null, null, t0);
          let data = null;
          try {
            data = await analyzeViaServer((status, jobId) => {
              if (!stale()) showServerProgress(status, jobId, t0);
            });
          } catch (err) {
            if (stale()) return;
            if (err && err.name === 'AbortError') return;   // user cancelled
            if (err && err.name === 'CancelledError') return;   // superseded by a newer upload
            state.engine = 'yin';
            const eSel = $('engineSel'); if (eSel) eSel.value = 'yin';
            const reason = err && err.name === 'TimeoutError'
              ? 'The local server stopped responding'
              : (err && err.message) || String(err);
            toast(`${reason} — continuing with the in-browser engine.`);
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
              voicedFraction: data.voicedFraction,
              ts: Date.now(),
            }).then(pruneAnalysisCache);
            if (data.voicedFraction != null && data.voicedFraction < 0.05) {
              lowVoiceWarning = true;
            } else if (data.separationCached) {
              toast('Reused this recording’s separated voice from the local server’s cache.');
            }
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
      state.opts.droneStrength = result.droneStrength || 0;
      state.drift = result.drift || null;
      state.noteRegions = result.noteRegions || [];
      applyOctaveMode(false);
      state.synthDuration = result.synth.length / targetSr;

      setStage('Building the contour…', 0.96);
      if (synthUrl) URL.revokeObjectURL(synthUrl);
      synthUrl = URL.createObjectURL(encodeWav(result.synth, targetSr));
      synthEl.src = synthUrl;

      state.saHz = result.tonic[0].hz;
      // Corrections made earlier on this recording come back with it. (A new
      // upload already cleared the old file's; re-analysing the same file
      // keeps the in-memory ones if storage is unavailable.)
      const savedEdits = await loadNoteEdits(state.fileSha);
      if (stale()) return;
      if (savedEdits.length) {
        state.manualEdits = savedEdits;
        state.noteEditHistory = [];
      }
      const savedSettings = await idbGet('edits:' + state.fileSha, 'edits');
      if (stale()) return;
      if (savedSettings && savedSettings.saHz > 0) state.saHz = savedSettings.saHz;
      // Older drafts used their saved tonic for detection. Keep that reference
      // on migration so existing edit coordinates continue to match.
      state.notationSaHz = savedSettings?.notationSaHz > 0 ? savedSettings.notationSaHz : state.saHz;
      updateUndoNoteButton();
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
      if (lowVoiceWarning) {
        toast('Very little singing was found in this recording — the notation may be sparse. Is the voice audible over the accompaniment?');
      } else if (state.manualEdits.length) {
        toast(`Restored your ${state.manualEdits.length} note correction${state.manualEdits.length === 1 ? '' : 's'} for this recording.`);
      } else if (result.tonic[0].uncertain) {
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
    cancelServerJob();                 // stop the work on the server too
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
    const pulse = Math.round(r.bpm);
    const matra = r.matraBpm && Math.abs(r.matraBpm - r.bpm) >= 8
      ? ` \u00b7 matras \u2248 <b>${Math.round(r.matraBpm)}/min</b>`
      : '';
    if (!r.taal) {
      el.innerHTML = `\u2669 \u2248 <b>${pulse} BPM</b>${matra} \u00b7 no single repeating cycle stood out. Beat ticks follow the contour ruler.`;
    } else {
      const alt = r.alt ? ` (or ${r.alt})` : '';
      el.innerHTML = `\u2669 \u2248 <b>${pulse} BPM</b>${matra} \u00b7 ${r.cycle}-matra cycle \u2014 ${r.conf} <b>${r.taal}</b>${alt}. The heavier contour ticks are the estimated sam.`;
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
      b.addEventListener('click', () => changeSa(c.hz));
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

  function changeSa(hz) {
    if (!Number.isFinite(hz) || hz < midiHz(36) || hz > midiHz(83)) {
      toast('That Sa is outside the supported C2–B5 range.'); return false;
    }
    const old = state.saHz;
    const referenceHz = state.notationSaHz || old;
    state.notationSaHz = referenceHz;
    const shift = Corrections.tonicShift(referenceHz, hz) - Corrections.tonicShift(referenceHz, old);
    state.previousSa = old;
    state.manualEdits = Corrections.transposeEdits(state.manualEdits, shift);
    state.noteEditHistory = state.noteEditHistory.map(edits => Corrections.transposeEdits(edits, shift));
    state.saHz = hz;
    els.undoSaBtn.hidden = false;
    // Relabel the exact score under review. Regeneration can otherwise change
    // tonic-dependent filtering, ornaments and the locations of manual edits.
    state.tokens = Corrections.transposeTokens(state.tokens, shift, 1200 * Math.log2(old / hz));
    syncTonicControls(); refreshScore(); persistNoteEdits();
    return true;
  }
  els.relabelSaBtn.addEventListener('click', () => {
    const steps = Number(els.relabelSa.value);
    if (!steps) return;
    const name = els.relabelSa.options[els.relabelSa.selectedIndex].text;
    if (changeSa(state.saHz / Math.pow(2, steps / 12))) {
      toast(`What was Sa is now ${name}. All notes relabelled; recording pitch is unchanged.`);
      els.relabelSa.value = '0';
    }
  });
  els.undoSaBtn.addEventListener('click', () => {
    if (state.previousSa) changeSa(state.previousSa);
  });
  function tonicFromControls() {
    const base = midiHz(parseInt(els.tonicNote.value, 10));
    const cents = parseInt(els.tonicFine.value, 10) || 0;
    changeSa(base * Math.pow(2, cents / 1200));
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
    changeSa(vals[vals.length >> 1]);
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
    const drift = state.drift ? DSP.driftAt(state.drift, origEl.currentTime) : 0;
    const sa = state.saHz * Math.pow(2, ((state.semitones || 0) * 100 + drift) / 1200);
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
    const referenceHz = state.notationSaHz || state.saHz;
    state.notationSaHz = referenceHz;
    const res = state.noteRegions.length
      ? DSP.notateRegions(
        state.noteRegions,
        state.f0,
        state.clarity,
        state.hopSec,
        referenceHz,
        opts
      )
      : DSP.notate(state.f0, state.clarity, state.hopSec, referenceHz, opts);
    res.tokens = Corrections.transposeTokens(res.tokens,
      Corrections.tonicShift(referenceHz, state.saHz), 1200 * Math.log2(referenceHz / state.saHz));
    if (!state.baseline) state.baseline = {
      saHz: state.saHz, engine: state.engine,
      settings: Object.assign({}, state.opts, { rms: undefined, onsets: undefined }),
      notes: res.tokens.map(token => Object.assign({}, token)),
    };
    applyManualNoteEdits(res.tokens);
    state.tokens = res.tokens;
    refreshScore();
  }

  function refreshScore() {
    if (!state.f0) return;
    if (state.finishedSubmitted) {
      els.feedbackStatus.textContent = 'The score changed after submission. Submit again when your revision is finished.';
      state.finishedSubmitted = false;
    }
    DSP.annotateSungPitch(state.tokens, state.f0, state.clarity, state.hopSec, state.saHz);
    state.phrases = DSP.regroupPhrases(
      state.tokens,
      state.opts.lineGapSec != null ? state.opts.lineGapSec : (state.opts.clean ? 1.0 : 0.6),
      state.opts.clean === true
    );
    state.raga = DSP.analyzeRaga(state.tokens, state.phrases);
    state.ragaMatches = (state.raga && window.RagaId && window.RAGAS)
      ? RagaId.rankRagas(state.raga, RAGAS).filter((m) => m.score > 0.05).slice(0, 4) : [];
    computeScale();
    computeCentsRange();
    computeSmoothedCents();
    syncConnectorEditor();
    renderRaga();
    renderNotation();
    drawCanvas();
    updateStats();
    state.notationRev++;
    if (usesNotation()) refreshNotationAudio();
  }

  function updateUndoNoteButton() {
    if (els.undoNoteBtn) {
      els.undoNoteBtn.hidden = state.noteEditHistory.length === 0;
    }
  }

  // Every committed correction is saved on this device for this recording.
  function noteEditsChanged() {
    updateUndoNoteButton();
    persistNoteEdits();
  }

  function clearManualNoteEdits() {
    state.manualEdits = [];
    state.noteEditHistory = [];
    state.selectedNoteTime = null;
    updateUndoNoteButton();
    syncConnectorEditor();
  }

  function editOverlap(edit, token) {
    return Math.min(edit.t1, token.t1) - Math.max(edit.t0, token.t0);
  }

  function matchingManualEdit(token, type) {
    let best = null;
    for (let index = 0; index < state.manualEdits.length; index++) {
      const edit = state.manualEdits[index];
      if (type && edit.type !== type) continue;
      if (!type && edit.type === 'insert') continue;
      const overlap = editOverlap(edit, token);
      const centerDistance = Math.abs(
        edit.time - (token.t0 + token.t1) / 2
      );
      if (overlap < 0.025 && centerDistance > 0.10) continue;
      const score = overlap - centerDistance * 0.2;
      if (!best || score > best.score) best = { index, edit, score };
    }
    return best;
  }

  function applyManualTarget(token, k) {
    token.k = k;
    token.cents = k * 100;
    token.manualCorrection = true;
    token.glide = false;
    token.meend = false;
    token.andolan = false;
    delete token.via;
    delete token.orn;
    delete token.kan;
    delete token.murki;
    delete token.graceAfter;
    delete token.andolanLo;
    delete token.andolanHi;
  }

  function applyManualNoteEdits(tokens) {
    for (const edit of state.manualEdits) {
      if (edit.type !== 'move') continue;
      let best = null;
      for (const token of tokens) {
        const overlap = editOverlap(edit, token);
        const centerDistance = Math.abs(
          edit.time - (token.t0 + token.t1) / 2
        );
        if (overlap < 0.025 && centerDistance > 0.10) continue;
        const score = overlap - centerDistance * 0.2;
        if (!best || score > best.score) best = { token, score };
      }
      if (best) applyManualTarget(best.token, edit.k);
    }
    for (const edit of state.manualEdits) {
      if (edit.type !== 'insert') continue;
      const preserved = [];
      for (const token of tokens) {
        if (token.t1 <= edit.t0 || token.t0 >= edit.t1) {
          preserved.push(token);
          continue;
        }
        if (edit.t0 - token.t0 >= 0.025) {
          preserved.push(Object.assign({}, token, { t1: edit.t0 }));
        }
        if (token.t1 - edit.t1 >= 0.025) {
          preserved.push(Object.assign({}, token, { t0: edit.t1 }));
        }
      }
      preserved.push({
        t0: edit.t0,
        t1: edit.t1,
        k: edit.k,
        cents: edit.k * 100,
        conf: 1,
        manualAddition: true,
        manualCorrection: true,
      });
      tokens.splice(0, tokens.length, ...preserved.sort((a, b) => a.t0 - b.t0));
    }
    const remaining = Corrections.removeIntervals(tokens, state.manualEdits.filter(edit => edit.type === 'delete'));
    tokens.splice(0, tokens.length, ...remaining);
    for (const edit of state.manualEdits) {
      if (edit.type !== 'connector') continue;
      let best = null;
      for (const token of tokens) {
        const overlap = editOverlap(edit, token);
        const centerDistance = Math.abs(
          edit.time - (token.t0 + token.t1) / 2
        );
        if (overlap < 0.025 && centerDistance > 0.10) continue;
        const score = overlap - centerDistance * 0.2;
        if (!best || score > best.score) best = { token, score };
      }
      if (!best) continue;
      best.token.manualIncoming = edit.incoming || 'auto';
      best.token.manualOutgoing = edit.outgoing || 'auto';
      best.token.manualIncomingRevision = edit.incomingRevision || 0;
      best.token.manualOutgoingRevision = edit.outgoingRevision || 0;
      best.token.manualFreeTargetK = Number.isFinite(edit.freeTargetK)
        ? edit.freeTargetK
        : best.token.k;
      best.token.manualFreeDuration = Number.isFinite(edit.freeDuration)
        ? edit.freeDuration
        : 0.4;
      best.token.manualConnector = true;
    }
  }

  function commitManualNoteEdit(tokenIndex, targetK) {
    const token = state.tokens[tokenIndex];
    if (!token || targetK === token.k) return;
    state.selectedNoteTime = (token.t0 + token.t1) / 2;
    state.noteEditHistory.push(
      state.manualEdits.map((edit) => Object.assign({}, edit))
    );
    const inserted = token.manualAddition && matchingManualEdit(token, 'insert');
    if (inserted) {
      inserted.edit.k = targetK;
      noteEditsChanged(); renotateNow(); return;
    }
    const match = matchingManualEdit(token, 'move');
    const edit = {
      type: 'move',
      t0: token.t0,
      t1: token.t1,
      time: (token.t0 + token.t1) / 2,
      k: targetK,
      originalK: match ? match.edit.originalK : token.k,
    };
    if (match && targetK === match.edit.originalK) {
      state.manualEdits.splice(match.index, 1);
    } else if (match) {
      state.manualEdits[match.index] = edit;
    } else {
      state.manualEdits.push(edit);
    }
    noteEditsChanged();
    renotateNow();
    toast(`Note corrected to ${tokenGlyph(targetK)}.`);
  }

  function commitManualNoteInsertion(t0, t1, k) {
    const start = Math.max(0, Math.min(t0, t1));
    const end = Math.min(
      state.duration,
      Math.max(start + 0.05, Math.max(t0, t1))
    );
    if (!(end > start)) return;
    state.noteEditHistory.push(
      state.manualEdits.map((edit) => Object.assign({}, edit))
    );
    // A new note can replace a previously deleted passage. Keep only the
    // non-overlapping portions of older deletion intervals.
    state.manualEdits = state.manualEdits.filter(edit => edit.type !== 'delete').concat(
      Corrections.removeIntervals(state.manualEdits.filter(edit => edit.type === 'delete'), [{ t0: start, t1: end }])
    );
    state.manualEdits.push({
      type: 'insert',
      t0: start,
      t1: end,
      time: (start + end) / 2,
      k,
    });
    state.selectedNoteTime = state.addNoteMode ? null : (start + end) / 2;
    noteEditsChanged();
    renotateNow();
    toast(`Added ${tokenGlyph(k)}.`);
  }

  function deleteSelectedNote() {
    const index = selectedTokenIndex();
    const token = state.tokens[index];
    if (!token) return;
    state.noteEditHistory.push(state.manualEdits.map(edit => Object.assign({}, edit)));
    state.manualEdits.push({ type: 'delete', t0: token.t0, t1: token.t1, time: (token.t0 + token.t1) / 2 });
    state.selectedNoteTime = null;
    noteEditsChanged(); renotateNow();
    toast('Note deleted. Undo restores it.');
  }
  els.deleteNoteBtn.addEventListener('click', deleteSelectedNote);

  function selectedTokenIndex() {
    if (!Number.isFinite(state.selectedNoteTime) || !state.tokens.length) {
      return -1;
    }
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      const center = (token.t0 + token.t1) / 2;
      const contains = state.selectedNoteTime >= token.t0 - 0.025 &&
        state.selectedNoteTime <= token.t1 + 0.025;
      const distance = Math.abs(center - state.selectedNoteTime) -
        (contains ? 0.2 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestDistance <= 0.35 ? bestIndex : -1;
  }

  function selectNoteForConnectors(tokenIndex) {
    const token = state.tokens[tokenIndex];
    if (!token) return;
    state.selectedNoteTime = (token.t0 + token.t1) / 2;
    syncConnectorEditor();
    drawCanvas();
  }

  function updateFreeConnectorControls(outgoing) {
    const visible = outgoing === 'free';
    if (els.freeTargetCtl) els.freeTargetCtl.hidden = !visible;
    if (els.freeLengthCtl) els.freeLengthCtl.hidden = !visible;
  }

  function syncConnectorEditor() {
    if (!els.connectorToolbar) return;
    const tokenIndex = selectedTokenIndex();
    const token = tokenIndex >= 0 ? state.tokens[tokenIndex] : null;
    els.connectorToolbar.hidden = !token;
    if (!token) return;

    const editMatch = matchingManualEdit(token, 'connector');
    const edit = editMatch && editMatch.edit;
    const incoming = edit ? edit.incoming || 'auto' : 'auto';
    const outgoing = edit ? edit.outgoing || 'auto' : 'auto';
    const targetK = edit && Number.isFinite(edit.freeTargetK)
      ? edit.freeTargetK
      : token.k;
    const duration = edit && Number.isFinite(edit.freeDuration)
      ? edit.freeDuration
      : 0.4;
    els.selectedNoteLabel.textContent =
      `${tokenGlyph(token.k)} ${fmtTime((token.t0 + token.t1) / 2)}`;
    els.incomingConnector.value = incoming;
    els.outgoingConnector.value = outgoing;

    const lowK = Math.min(
      token.k - 12,
      Math.ceil(state.centsLo / 100)
    );
    const highK = Math.max(
      token.k + 12,
      Math.floor(state.centsHi / 100)
    );
    els.freeTarget.textContent = '';
    for (let k = lowK; k <= highK; k++) {
      const option = document.createElement('option');
      option.value = String(k);
      option.textContent = tokenGlyph(k);
      els.freeTarget.appendChild(option);
    }
    els.freeTarget.value = String(targetK);
    els.freeLength.value = String(duration);
    els.freeLengthValue.value = `${duration.toFixed(2)}s`;
    updateFreeConnectorControls(outgoing);
  }

  function commitManualConnectorEdit(field, value) {
    const tokenIndex = selectedTokenIndex();
    const token = tokenIndex >= 0 ? state.tokens[tokenIndex] : null;
    if (!token) return;
    const match = matchingManualEdit(token, 'connector');
    const current = match
      ? Object.assign({}, match.edit)
      : {
        type: 'connector',
        t0: token.t0,
        t1: token.t1,
        time: (token.t0 + token.t1) / 2,
        incoming: 'auto',
        outgoing: 'auto',
        freeTargetK: token.k,
        freeDuration: 0.4,
      };
    if (current[field] === value) return;
    state.noteEditHistory.push(
      state.manualEdits.map((edit) => Object.assign({}, edit))
    );
    current[field] = value;
    current.t0 = token.t0;
    current.t1 = token.t1;
    current.time = (token.t0 + token.t1) / 2;
    if (field === 'incoming') {
      current.incomingRevision = ++state.noteEditRevision;
    } else if (field === 'outgoing') {
      current.outgoingRevision = ++state.noteEditRevision;
    }
    const isDefault = current.incoming === 'auto' &&
      current.outgoing === 'auto';
    if (match && isDefault) {
      state.manualEdits.splice(match.index, 1);
    } else if (match) {
      state.manualEdits[match.index] = current;
    } else if (!isDefault) {
      state.manualEdits.push(current);
    }
    state.selectedNoteTime = current.time;
    noteEditsChanged();
    renotateNow();
  }

  if (els.incomingConnector) {
    els.incomingConnector.addEventListener('change', () => {
      commitManualConnectorEdit('incoming', els.incomingConnector.value);
    });
  }
  if (els.outgoingConnector) {
    els.outgoingConnector.addEventListener('change', () => {
      commitManualConnectorEdit('outgoing', els.outgoingConnector.value);
    });
  }
  if (els.freeTarget) {
    els.freeTarget.addEventListener('change', () => {
      commitManualConnectorEdit('freeTargetK', Number(els.freeTarget.value));
    });
  }
  if (els.freeLength) {
    els.freeLength.addEventListener('input', () => {
      els.freeLengthValue.value = `${Number(els.freeLength.value).toFixed(2)}s`;
    });
    els.freeLength.addEventListener('change', () => {
      commitManualConnectorEdit('freeDuration', Number(els.freeLength.value));
    });
  }
  if (els.closeConnectorBtn) {
    els.closeConnectorBtn.addEventListener('click', () => {
      state.selectedNoteTime = null;
      syncConnectorEditor();
      drawCanvas();
    });
  }

  function undoManualNoteEdit() {
    if (!state.noteEditHistory.length) return;
    state.manualEdits = state.noteEditHistory.pop();
    noteEditsChanged();
    renotateNow();
    toast('Note edit undone.');
  }
  if (els.undoNoteBtn) {
    els.undoNoteBtn.addEventListener('click', undoManualNoteEdit);
  }
  function setAddNoteMode(on) {
    state.addNoteMode = !!on;
    if (state.addNoteMode) {
      state.selectedNoteTime = null;
      syncConnectorEditor();
    }
    if (els.addNoteBtn) {
      els.addNoteBtn.setAttribute('aria-pressed', String(state.addNoteMode));
      els.addNoteBtn.textContent = state.addNoteMode ? 'Done adding' : 'Add notes';
      els.addNoteBtn.setAttribute('aria-label', state.addNoteMode ? 'Done adding' : 'Add notes');
    }
    cvs.style.cursor = state.addNoteMode ? 'crosshair' : '';
  }
  if (els.addNoteBtn) {
    els.addNoteBtn.addEventListener('click', () => {
      setAddNoteMode(!state.addNoteMode);
      toast(state.addNoteMode ? 'Add notes is on. Click or drag for each note; choose Done adding or press Esc when finished.' : 'Adding finished. Click a note to select or delete it.');
    });
  }
  function setShowSung(on) {
    state.showSung = !!on;
    if (els.sungBtn) els.sungBtn.setAttribute('aria-pressed', String(state.showSung));
    try { localStorage.setItem('swarlekh.showSung', state.showSung ? '1' : '0'); } catch (e) {}
    drawCanvas();
  }
  try { state.showSung = localStorage.getItem('swarlekh.showSung') !== '0'; } catch (e) {}
  if (els.sungBtn) {
    els.sungBtn.setAttribute('aria-pressed', String(state.showSung));
    els.sungBtn.addEventListener('click', () => setShowSung(!state.showSung));
  }

  // Precompute contour cents once per analysis/Sa/threshold change. This track
  // is retained for slide classification and the empty-notation fallback; the
  // singer-facing guide itself is built from target-note holds. A ±35 ms median
  // suppresses vibrato-scale jitter without erasing fast note transitions.
  function computeSmoothedCents() {
    const { f0, clarity, hopSec, saHz, opts } = state;
    const n = f0.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = (f0[i] > 0 && clarity[i] >= opts.clarityThresh) ? 1200 * Math.log2(f0[i] / saHz) : NaN;
    }
    const half = Math.max(1, Math.round(0.035 / hopSec));
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
    state.practiceContour = DSP.buildPracticeContour(state.tokens, out, hopSec);
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
    const range = DSP.displayPitchRange(state.tokens);
    state.centsLo = range.lo;
    state.centsHi = range.hi;
  }

  const swLetter = (pc) => DSP.swaraInfo(((pc % 12) + 12) % 12).letter;

  // The glyph for a swara letter under the current script. Devanagari keeps
  // the komal (low line) and teevra (stroke above) marks, so r ≠ R and m ≠ M.
  function glyph(letter) {
    if (state.script !== 'devanagari') return letter;
    return DSP.devanagariSwara(letter);
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
    // Skipped semitones indicate articulated swaras, not intermediate pitches
    // swept through by a continuous meend. Name every one of those targets.
    if (via.some((k, index) => index > 0 && Math.abs(k - via[index - 1]) > 1)) return via;
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
    if (els.ragaSummary) {
      const top = (state.ragaMatches || [])[0];
      els.ragaSummary.textContent = top ? `· ${confWord(top.confidence)} ${top.name}` : '';
    }

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
    if (state.drift) {
      const c = state.drift.cents;
      txt += ` · tuning drift of ${Math.round(Math.max(...c) - Math.min(...c))}¢ corrected`;
    }
    els.statsLine.textContent = txt;
  }


  /* ------------------------- notation & export ------------------------- */

  // Readable sargam, one line per phrase — the text alternative to the
  // contour, the printable sheet and the export all come from these lines.
  let notationLineEls = [];
  let lastActiveLine = -1;
  function scriptText(text) {
    return state.script === 'devanagari' ? DSP.toDevanagari(text) : text;
  }
  function currentNotationLines() {
    return DSP.notationLines(state.phrases, state.scale);
  }
  function renderNotation() {
    if (!els.notation) return;
    const lines = currentNotationLines();
    els.notation.textContent = '';
    notationLineEls = [];
    lastActiveLine = -1;
    if (!lines.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No sung notes were found. Try lowering Voicing strictness in the settings below.';
      els.notation.appendChild(li);
    }
    for (const line of lines) {
      const li = document.createElement('li');
      li.dataset.idx = String(line.index);
      if (line.section && line.index > 0) li.className = 'section';
      const num = document.createElement('span');
      num.className = 'n-num';
      num.textContent = String(line.index + 1);
      const time = document.createElement('span');
      time.className = 'n-time';
      time.textContent = fmtTime(line.t0);
      const text = document.createElement('span');
      text.className = 'n-text';
      for (const seg of line.segments) {
        if (!seg.unsure) { text.append(scriptText(seg.text)); continue; }
        const span = document.createElement('span');
        span.className = 'unsure';
        span.title = 'Uncertain — sung between two swaras, or an inferred ornament. Check it by ear (Listen to → Notation).';
        span.textContent = scriptText(seg.text);
        text.append(span);
      }
      li.append(num, time, text);
      els.notation.appendChild(li);
      notationLineEls.push(li);
    }
    const edits = state.manualEdits.length;
    const unsure = state.tokens.filter((tk) => DSP.isUncertainNote(tk)).length;
    els.notationMeta.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · Sa ${noteLabel(state.saHz)}` +
      (unsure ? ` · ${unsure} to check` : '') +
      (edits ? ` · ${edits} correction${edits === 1 ? '' : 's'}` : '');
    if (els.clearEditsBtn) els.clearEditsBtn.hidden = edits === 0;
    cvs.setAttribute('aria-label',
      `Pitch contour: ${state.tokens.length} sung notes in ${lines.length} lines, Sa ${noteLabel(state.saHz)}. Download or copy the score for a text version.`);
    highlightNotationLine(activeLineIdx, false);
  }
  function highlightNotationLine(idx, follow) {
    if (idx === lastActiveLine) return;
    if (notationLineEls[lastActiveLine]) notationLineEls[lastActiveLine].classList.remove('active');
    lastActiveLine = idx;
    const li = notationLineEls[idx];
    if (!li) return;
    li.classList.add('active');
    if (follow) {
      // Keep the sung line visible inside the notation list without moving the page.
      const box = els.notation;
      if (li.offsetTop < box.scrollTop || li.offsetTop + li.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = li.offsetTop - box.clientHeight / 3;
      }
    }
  }
  if (els.notation) {
    els.notation.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-idx]');
      if (!li) return;
      const line = state.phrases[Number(li.dataset.idx)];
      if (line) seek(Math.max(0, line.t0 - 0.15));
    });
  }

  function baseName() {
    return (state.fileName || 'recording').replace(/\.[^.]+$/, '') || 'recording';
  }
  function notationPlainText() {
    const header = [
      `${baseName()} — SwarLekh sargam`,
      `Sa = ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz)` +
        (state.raga && state.raga.thaat ? ` · thaat ${state.raga.thaat.name}` : '') +
        (state.rhythm && state.rhythm.taal ? ` · ${state.rhythm.taal}, ~${Math.round(state.rhythm.bpm)} BPM` : ''),
      '',
    ];
    const body = DSP.notationText(state.phrases, state.scale);
    return header.join('\n') + scriptText(body) + '\n';
  }
  function downloadUrl(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    downloadUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // Everything needed to read the transcription, re-score it later against
  // your corrections, or rebuild it: notes, lines, edits and the analysis input.
  function exportJson() {
    const round = (v, d) => Math.round(v * d) / d;
    return {
      app: 'SwarLekh',
      format: 1,
      exportedAt: new Date().toISOString(),
      file: { name: state.fileName, sha256: state.fileSha, duration: round(state.duration, 1000) },
      engine: state.engine,
      saHz: round(state.saHz, 100),
      notationSaHz: state.notationSaHz,
      detail: detailSel.value,
      raga: state.raga ? {
        thaat: state.raga.thaat ? state.raga.thaat.name : null,
        aaroh: state.raga.aaroh, avaroh: state.raga.avaroh,
        vadi: state.raga.vadi, samvadi: state.raga.samvadi,
        suggestions: (state.ragaMatches || []).map((m) => ({ name: m.name, confidence: m.confidence })),
      } : null,
      rhythm: state.rhythm ? { bpm: state.rhythm.bpm, taal: state.rhythm.taal, cycle: state.rhythm.cycle } : null,
      lines: currentNotationLines().map((line) => ({ t0: round(line.t0, 1000), t1: round(line.t1, 1000), text: line.text })),
      notes: state.tokens.map((tk) => ({
        t0: round(tk.t0, 1000), t1: round(tk.t1, 1000), k: tk.k,
        swara: DSP.tokenText(tk.k, false), text: DSP.tokenFullText(tk, state.scale),
        hz: round(state.saHz * Math.pow(2, tk.k / 12), 100),
        corrected: !!tk.manualCorrection,
        uncertain: DSP.isUncertainNote(tk),
      })),
      tuningDrift: state.drift,
      corrections: state.manualEdits,
      baseline: state.baseline,
      learningProfile: state.learningProfile,
      analysis: {
        hopSec: state.hopSec,
        f0: Array.from(state.f0 || [], (v) => round(v, 100)),
        clarity: Array.from(state.clarity || [], (v) => round(v, 1000)),
        rms: Array.from(state.opts.rms || [], (v) => round(v, 100000)),
        noteRegions: state.noteRegions,
        onsets: (state.opts.onsets || []).map((frame) => round(frame * state.hopSec, 1000)),
      },
    };
  }
  async function submitFinishedScore() {
    if (!state.ready || !state.fileSha || !state.tokens.length) {
      toast('Add and review the notes before submitting a finished score.'); return;
    }
    els.submitFinishedBtn.disabled = true;
    const snapshot = JSON.parse(JSON.stringify(exportJson()));
    snapshot.purpose = 'expert-correction';
    snapshot.reviewed = true;
    snapshot.finalTokens = JSON.parse(JSON.stringify(state.tokens));
    const sha = state.fileSha;
    try {
      const examples = await idbGet('finished-scores', 'edits') || [];
      const next = examples.filter(example => example.file.sha256 !== sha).concat(snapshot).slice(-50);
      if (!await idbPut('finished-scores', next, 'edits')) {
        throw new Error('Could not save on this device. Download the JSON score to keep a copy, then retry.');
      }
      const learned = Corrections.learnTiming(next);
      const sent = await fetch('http://127.0.0.1:8765/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot), signal: AbortSignal.timeout(15000),
      }).then(async response => {
        const data = await response.json();
        if (!response.ok || !data.saved) throw new Error(data.error || 'Server did not confirm saving.');
        return data;
      }).catch(() => null);
      if (state.fileSha !== sha) return;
      state.learningProfile = learned;
      state.finishedSubmitted = true;
      els.feedbackStatus.textContent = sent
        ? `Finished score received by your local system (${sent.id.slice(0, 8)}). ${learned ? 'Learned timing will be used on your next upload.' : 'Saved for evaluation; review at least 8 notes to learn timing.'}`
        : 'Finished score saved on this device. Start or update the local SwarLekh server, then submit again to send it. Your next upload can already use its learned timing.';
      toast(sent ? 'Finished score submitted.' : 'Saved on this device; local server has not received it yet.');
    } catch (error) {
      els.feedbackStatus.textContent = error.message;
      toast(error.message);
    } finally { els.submitFinishedBtn.disabled = false; }
  }
  els.submitFinishedBtn.addEventListener('click', submitFinishedScore);

  if (els.copyBtn) els.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(notationPlainText());
      toast('Notation copied.');
    } catch (e) { toast('Copy was blocked by the browser — use .txt instead.'); }
  });
  if (els.dlTxtBtn) els.dlTxtBtn.addEventListener('click', () => {
    download(new Blob([notationPlainText()], { type: 'text/plain;charset=utf-8' }), `${baseName()} - sargam.txt`);
  });
  if (els.dlJsonBtn) els.dlJsonBtn.addEventListener('click', () => {
    download(new Blob([JSON.stringify(exportJson())], { type: 'application/json' }), `${baseName()} - swarlekh.json`);
  });
  if (els.dlWavBtn) els.dlWavBtn.addEventListener('click', () => {
    // The melody guide already lives at a blob: URL (in the current key);
    // link to it directly — the CSP rightly forbids fetch()ing blob: URLs.
    if (synthUrl) downloadUrl(synthUrl, `${baseName()} - melody.wav`);
  });
  function preparePrint() {
    if (els.printTitle) els.printTitle.textContent = `${baseName()} — sargam`;
    if (els.printMeta) {
      els.printMeta.textContent = `Sa = ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz)` +
        (state.rhythm && state.rhythm.taal ? ` · ${state.rhythm.taal}, ~${Math.round(state.rhythm.bpm)} BPM` : '') +
        ` · transcribed with SwarLekh`;
    }
    if (els.ragaDetails) els.ragaDetails.open = true;
  }
  window.addEventListener('beforeprint', preparePrint);
  if (els.printBtn) els.printBtn.addEventListener('click', () => { preparePrint(); window.print(); });
  if (els.clearEditsBtn) els.clearEditsBtn.addEventListener('click', () => {
    if (!state.manualEdits.length) return;
    state.noteEditHistory.push(state.manualEdits.map((edit) => Object.assign({}, edit)));
    state.manualEdits = [];
    noteEditsChanged();
    renotateNow();
    toast('Corrections cleared — use undo to bring them back.');
  });

  // 16-bit PCM WAV from one Float32Array (mono) or an array of channels.
  function encodeWav(samples, sr) {
    const channels = Array.isArray(samples) ? samples : [samples];
    const ch = channels.length;
    const n = channels[0].length;
    const bytes = n * ch * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
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
    if (state.ready) { renderRaga(); renderNotation(); drawCanvas(); }
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
    const r = parseFloat(els.speedSel.value);
    origEl.playbackRate = r;
    synthEl.playbackRate = r;
  }
  els.speedSel.addEventListener('change', applySpeed);

  // "Notation" plays exactly what is written — every swara at its pitch,
  // meends gliding through the swaras they name, your corrections included —
  // so you can check the transcription against the recording by ear.
  let notationUrl = null, notationKey = '';
  const usesNotation = () => els.sourceSel.value === 'notation' || els.sourceSel.value === 'orignotation';
  function notationAudioUrl() {
    const key = `${state.notationRev}:${state.semitones}`;
    if (notationUrl && notationKey === key) return notationUrl;
    const sa = state.saHz * Math.pow(2, state.semitones / 12);
    const track = DSP.notationPitchTrack(state.tokens, sa, 0.01, state.duration);
    const pcm = DSP.synthesize(track.f0, track.clarity, 0.01, 16000);
    if (notationUrl) URL.revokeObjectURL(notationUrl);
    notationUrl = URL.createObjectURL(encodeWav(pcm, 16000));
    notationKey = key;
    return notationUrl;
  }
  function synthSourceUrl() { return usesNotation() ? notationAudioUrl() : synthUrl; }
  function setSynthSource(url) {
    if (!url || synthEl.src === url) return;
    const playing = state.playing;
    synthEl.src = url;
    synthEl.load();
    synthEl.addEventListener('loadeddata', () => {
      try { synthEl.currentTime = Math.min(origEl.currentTime, synthEl.duration || origEl.currentTime); } catch (e) {}
      synthEl.playbackRate = origEl.playbackRate;
      if (playing && state.playing) synthEl.play().catch(() => {});
    }, { once: true });
  }
  const refreshNotationAudio = debounce(() => { if (usesNotation()) setSynthSource(notationAudioUrl()); }, 400);
  function applySource() {
    const mode = els.sourceSel.value;
    origEl.muted = mode === 'synth' || mode === 'notation';
    synthEl.muted = mode === 'original';
    if (state.ready) setSynthSource(synthSourceUrl());
  }
  els.sourceSel.addEventListener('change', applySource);

  if (els.playerMoreBtn) els.playerMoreBtn.addEventListener('click', () => {
    const open = !els.playerCard.classList.contains('expanded');
    els.playerCard.classList.toggle('expanded', open);
    els.playerMoreBtn.setAttribute('aria-expanded', String(open));
    els.playerMoreBtn.textContent = open ? 'Less' : 'More';
  });
  if (els.ragaDetails && window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
    els.ragaDetails.open = false;      // on a phone the contour and notation come first
  }

  /* ------------------------------ pitch ------------------------------ */

  function clearPitchCache() {
    for (const [, v] of pitchCache) {
      if (v.origUrl && v.origUrl !== origUrl) URL.revokeObjectURL(v.origUrl);
      if (v.synthUrl && v.synthUrl !== synthUrl) URL.revokeObjectURL(v.synthUrl);
    }
    pitchCache.clear();
  }

  // A shifted copy of a long recording is tens of MB; keep the original and
  // the most recent few so stepping through keys can't exhaust memory.
  const PITCH_CACHE_SHIFTS = 3;
  function prunePitchCache(keep) {
    const shifts = [...pitchCache.keys()].filter((k) => k !== 0 && k !== keep);
    while (shifts.length > PITCH_CACHE_SHIFTS - 1) {
      const oldest = shifts.shift();                 // Map keeps insertion order
      const v = pitchCache.get(oldest);
      if (v.origUrl !== origUrl) URL.revokeObjectURL(v.origUrl);
      if (v.synthUrl !== synthUrl) URL.revokeObjectURL(v.synthUrl);
      pitchCache.delete(oldest);
    }
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
      applySpeed();   // load() resets playbackRate
      updateTimeDisp();
      if (!state.playing) drawCanvas();
      if (wasPlaying) play();
    };
    pendingRestore = restore;
    origEl.addEventListener('loadeddata', restore);
    origEl.src = oUrl;
    synthEl.src = usesNotation() ? notationAudioUrl() : sUrl;
    origEl.load();
    synthEl.load();
  }

  async function applyPitch(semitones) {
    semitones = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, semitones));
    if (!state.ready || semitones === state.semitones) return;
    state.semitones = semitones;
    updatePitchUI();

    const cached = pitchCache.get(semitones);
    if (cached) {
      pitchCache.delete(semitones); pitchCache.set(semitones, cached);   // most recent
      origUrl = cached.origUrl; synthUrl = cached.synthUrl; swapAudioSources(origUrl, synthUrl); return;
    }

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
      prunePitchCache(semitones);
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
      els.playBtn.setAttribute('aria-label', 'Pause');
      startRaf();
    } catch (e) { toast('Playback failed: ' + e.message); }
  }
  function pause() {
    origEl.pause();
    synthEl.pause();
    state.playing = false;
    els.playBtn.textContent = '▶';
    els.playBtn.setAttribute('aria-label', 'Play');
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

  /* Playback-driven updates. timeupdate (media clock, ~4 Hz, fires even in
   * background/throttled tabs) owns audio sync and highlight.
   * requestAnimationFrame only adds smooth canvas motion when visible. */
  function onTimeUpdate() {
    if (!state.ready) return;
    const t = origEl.currentTime;
    if (state.playing && !synthEl.paused && Math.abs(synthEl.currentTime - t) > 0.08 &&
        (usesNotation() || t < state.synthDuration)) {
      synthEl.currentTime = t;
    }
    if (state.drift && droneNodes) updateDroneFreq();     // the drone follows the singer's tuning
    updateTimeDisp();
    highlightActive(t);
    if (!rafId) drawCanvas();
  }
  origEl.addEventListener('timeupdate', onTimeUpdate);

  function startRaf() { stopRaf(); rafId = requestAnimationFrame(tick); }
  function stopRaf() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
  function tick() {
    const t = origEl.currentTime;
    const viewSec = viewWidthSec();
    if (t > state.scrollSec + viewSec * 0.72 || t < state.scrollSec) {
      state.scrollSec = clampScroll(t - viewSec * 0.25);
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
    // the phrase index keeps the exported text in sync.
    activeLineIdx = lineIdx;
    activeTokIdx = tokIdx;
    highlightNotationLine(lineIdx, state.playing);
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

    // ---- Singer-facing practice contour. Stable notes are horizontal target
    // holds, articulated changes are clean steps, quick bends are compact
    // hooks, and sustained meend uses one broad curve. These are the only three
    // transition geometries; vibrato and tracker jitter are not drawing commands.
    // The voice itself: a faint trace of the sung pitch under the notation,
    // so you can see where the written swaras and the singing part ways.
    if (state.showSung && state.centsSm) {
      const hop = state.hopSec, sung = state.centsSm;
      const i0 = Math.max(0, Math.floor(scrollSec / hop)), i1 = Math.min(sung.length, Math.ceil(tEnd / hop));
      const step = Math.max(1, Math.floor((i1 - i0) / (W * 1.5)));
      cctx.strokeStyle = colors.muted; cctx.globalAlpha = 0.6; cctx.lineWidth = 1.2;
      cctx.lineJoin = 'round'; cctx.lineCap = 'round'; cctx.setLineDash([]);
      cctx.beginPath();
      let pen = false;
      for (let i = i0; i < i1; i += step) {
        const c = sung[i];
        if (Number.isNaN(c)) { pen = false; continue; }
        const x = tToX(i * hop), y = cToY(c);
        if (pen) cctx.lineTo(x, y); else { cctx.moveTo(x, y); pen = true; }
      }
      cctx.stroke();
      cctx.globalAlpha = 1;
    }

    const practice = state.practiceContour || [];
    cctx.lineJoin = 'round';
    cctx.lineCap = 'round';
    for (const segment of practice) {
      if (segment.t1 < scrollSec || segment.t0 > tEnd) continue;
      // Let canvas clipping hide off-screen portions. Clamping the time while
      // retaining the full pitch endpoints bends a partially visible slide.
      const x0 = tToX(segment.t0);
      const x1 = tToX(segment.t1);
      const y0 = cToY(segment.c0);
      const y1 = cToY(segment.c1);
      if (Math.max(y0, y1) < RULER || Math.min(y0, y1) > H) continue;
      cctx.beginPath();
      cctx.moveTo(x0, y0);
      if (segment.kind === 'slide') {
        const dx = x1 - x0;
        cctx.strokeStyle = colors.accent;
        cctx.lineWidth = segment.curve === 'bend' ? 2.4 : 3.4;
        cctx.globalAlpha = 0.9;
        if (segment.curve === 'bend') {
          // A compact hook: stay on the source briefly, then turn cleanly into
          // the target. Duration distinguishes it from the broad meend below.
          cctx.bezierCurveTo(
            x0 + dx * 0.62, y0,
            x1 - dx * 0.08, y1,
            x1, y1
          );
        } else {
          // Sustained meend: one balanced S-curve with horizontal tangents at
          // both swaras, so the singer can see the departure and arrival.
          cctx.bezierCurveTo(
            x0 + dx * 0.34, y0,
            x1 - dx * 0.34, y1,
            x1, y1
          );
        }
      } else if (segment.kind === 'step') {
        cctx.strokeStyle = colors.accent;
        cctx.lineWidth = 1.6;
        cctx.globalAlpha = 0.8;
        cctx.lineTo(x1, y1);
      } else {
        cctx.strokeStyle = colors.contour;
        cctx.lineWidth = 3;
        cctx.globalAlpha = 0.88;
        cctx.lineTo(Math.max(x0 + 1, x1), y1);
      }
      cctx.stroke();
    }
    cctx.globalAlpha = 1;

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
    const selectedIndex = selectedTokenIndex();

    // Pass 1 — dots & gesture bands: every note is marked, even where its name won't fit.
    for (const ti of vis) {
      const tk = state.tokens[ti];
      const isActive = ti === activeTokIdx;
      const isSelected = ti === selectedIndex;
      if (dimmed(tk)) {   // spotlight mode: non-matching notes become faint specks
        cctx.fillStyle = colors.muted; cctx.globalAlpha = 0.25;
        cctx.beginPath();
        cctx.arc(tToX((tk.t0 + tk.t1) / 2), cToY(tk.k * 100), 2, 0, 2 * Math.PI);
        cctx.fill(); cctx.globalAlpha = 1;
        continue;
      }
      if (spotPc != null && !isActive) {   // a match while spotlighting: make it pop
        const cx0 = tToX((tk.t0 + tk.t1) / 2), cy0 = cToY(tk.k * 100);
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
      // The dot is the note to hit, so anchor it to the target swara grid. Fine
      // intonation remains in the analysis panel instead of making the practice
      // instruction look out of tune.
      const cx = tToX((tk.t0 + tk.t1) / 2), cy = cToY(tk.k * 100);
      // Uncertain notes (sung between two swaras, or inferred by the ornament
      // passes) are hollow: "check this one by ear". They are never the
      // boldest marks on the page.
      const unsure = DSP.isUncertainNote(tk);
      const held = dur >= 0.28;
      const emphasized = held && !unsure;
      const r = isActive ? 6 : (isSelected ? 5 : (emphasized ? 4.5 : 3.5));
      if (isActive || isSelected) {
        cctx.fillStyle = colors.accentSoft;
        cctx.beginPath();
        cctx.arc(cx, cy, r + 5, 0, 2 * Math.PI);
        cctx.fill();
      }
      if (unsure && !isActive && !isSelected) {
        cctx.fillStyle = colors.card;
        cctx.beginPath(); cctx.arc(cx, cy, r, 0, 2 * Math.PI); cctx.fill();
        cctx.strokeStyle = colors.accent; cctx.lineWidth = 1.6;
        cctx.beginPath(); cctx.arc(cx, cy, r, 0, 2 * Math.PI); cctx.stroke();
      } else {
        cctx.fillStyle = isActive || isSelected || emphasized ? colors.accent : colors.contour;
        cctx.globalAlpha = isActive || isSelected || emphasized ? 1 : 0.8;
        cctx.beginPath(); cctx.arc(cx, cy, r, 0, 2 * Math.PI); cctx.fill();
      }
      if (tk.manualCorrection || tk.manualAddition) {
        cctx.strokeStyle = colors.accent;
        cctx.lineWidth = 1.5;
        cctx.globalAlpha = 0.9;
        cctx.beginPath(); cctx.arc(cx, cy, r + 3.5, 0, 2 * Math.PI); cctx.stroke();
      }
      cctx.globalAlpha = 1;
    }

    // Pass 2 — names, important notes first so they always win a lane. In the
    // normal view every note is named, shrinking to fit; zoomed far out, names
    // that cannot fit are skipped (the dots still mark every note) instead of
    // piling up as overlapping 7px text. Names never leave the plot.
    // Placement rules live in js/contour-layout.js (tested in Node).
    const prio = (ti) => {
      const t = state.tokens[ti];
      if (ti === activeTokIdx) return 3;
      if (ti === selectedIndex) return 2.9;
      if ((t.t1 - t.t0) >= 0.28) return 2;
      if (t.murki) return 1.8;
      return isGlide(t) || t.andolan ? 1.5 : 1;
    };
    const labelItems = [];
    for (const ti of vis.slice().sort((a, b) => prio(b) - prio(a) || state.tokens[a].t0 - state.tokens[b].t0)) {
      const tk = state.tokens[ti];
      const isActive = ti === activeTokIdx;
      const isSelected = ti === selectedIndex;
      if (dimmed(tk)) continue;   // spotlight mode: no labels on non-matching notes
      if (isGlide(tk)) {
        const vv = viaDisplay(tk.via);
        for (let p = 0; p < vv.length; p++) {
          labelItems.push({ text: tokenGlyph(vv[p]), cx: viaX(tk, p, vv.length), cy: cToY(vv[p] * 100), big: false, color: colors.contour });
        }
        continue;
      }
      const big = isActive || isSelected || (tk.t1 - tk.t0) >= 0.28;
      const color = isActive || isSelected || tk.manualCorrection || tk.manualAddition
        ? colors.accent
        : (DSP.swaraInfo(tk.k).komal ? colors.komal : colors.text);
      labelItems.push({ text: (tk.andolan ? '≈' : '') + tokenGlyph(tk.k), cx: tToX((tk.t0 + tk.t1) / 2), cy: cToY(tk.k * 100), big, color });
    }
    const labelFont = (size, big) => (big ? '700 ' : '600 ') + size + 'px Georgia, serif';
    const placements = ContourLayout.placeLabels(labelItems, {
      measure: (text, size, big) => {
        const font = labelFont(size, big), key = font + '|' + text;
        let w = textWCache.get(key);
        if (w === undefined) { cctx.font = font; w = cctx.measureText(text).width; textWCache.set(key, w); }
        return w;
      },
      bounds: { x0: GUTTER, y0: RULER, x1: W, y1: H },
      force: pxPerSec >= 60,
    });
    cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    cctx.lineWidth = 3; cctx.lineJoin = 'round';
    for (const p of placements) {
      if (p.skipped) continue;
      cctx.font = labelFont(p.size, p.item.big);
      cctx.strokeStyle = colors.card;
      cctx.strokeText(p.item.text, p.x, p.y);   // halo for legibility
      cctx.fillStyle = p.item.color;
      cctx.fillText(p.item.text, p.x, p.y);
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

  // Canvas interactions: click to seek/select, drag to edit/pan, wheel to scroll/zoom.
  let dragInfo = null;
  const xToT = (clientX) => {
    const rect = cvs.getBoundingClientRect();
    return state.scrollSec + (clientX - rect.left - GUTTER) / state.pxPerSec;
  };
  const canvasYToK = (clientY) => {
    const rect = cvs.getBoundingClientRect();
    const y = Math.max(RULER, Math.min(rect.height - 10, clientY - rect.top));
    const cents = state.centsHi -
      (y - RULER) / Math.max(1, rect.height - RULER - 10) *
      (state.centsHi - state.centsLo);
    return Math.max(
      Math.ceil(state.centsLo / 100),
      Math.min(Math.floor(state.centsHi / 100), Math.round(cents / 100))
    );
  };
  function noteAt(clientX, clientY) {
    if (!state.tokens.length) return -1;
    const rect = cvs.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x <= GUTTER || y < RULER) return -1;
    const coarsePointer = window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches;
    const hitRadius = coarsePointer ? 20 : 14;
    const time = state.scrollSec + (x - GUTTER) / state.pxPerSec;
    const pitchHeight = Math.max(1, rect.height - RULER - 10);
    let best = null;
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (time < token.t0 - 0.08 || time > token.t1 + 0.08) continue;
      const noteY = RULER +
        (state.centsHi - token.k * 100) /
        (state.centsHi - state.centsLo) * pitchHeight;
      const yDistance = Math.abs(y - noteY);
      if (yDistance > hitRadius) continue;
      const x0 = GUTTER + (token.t0 - state.scrollSec) * state.pxPerSec;
      const x1 = GUTTER + (token.t1 - state.scrollSec) * state.pxPerSec;
      const xDistance = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      if (xDistance > hitRadius) continue;
      const centerX = (x0 + x1) / 2;
      const score = yDistance * 2 + xDistance +
        Math.abs(x - centerX) * 0.02;
      if (!best || score < best.score) best = { index, score };
    }
    return best ? best.index : -1;
  }
  function restoreDraggedToken(token, original) {
    for (const key of Object.keys(token)) delete token[key];
    Object.assign(token, original);
  }
  // Touch: the canvas owns gestures (touch-action: none), so it interprets
  // them itself — a mostly-vertical swipe scrolls the page, a horizontal one
  // pans the contour, two fingers pinch-zoom, and a dot moves only after a
  // short press-and-hold so scrolling past a note can't edit it.
  const touches = new Map();          // pointerId -> { x, y }
  let pinch = null;                   // { dist, pxPerSec, tAt }
  const NOTE_HOLD_MS = 280;
  function touchSpread() {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2 };
  }
  function abandonDrag() {
    if (!dragInfo) return;
    if (dragInfo.mode === 'add-note') {
      const index = state.tokens.indexOf(dragInfo.preview);
      if (index >= 0) state.tokens.splice(index, 1);
      renotateNow();
    } else if (dragInfo.mode === 'note') {
      const token = state.tokens[dragInfo.tokenIndex];
      if (token) restoreDraggedToken(token, dragInfo.original);
      computeSmoothedCents();
      drawCanvas();
    }
    dragInfo = null;
  }
  cvs.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size >= 2) {
        abandonDrag();
        if (touches.size === 2) {
          const { dist, midX } = touchSpread();
          const rect = cvs.getBoundingClientRect();
          pinch = {
            dist, pxPerSec: state.pxPerSec,
            tAt: state.scrollSec + Math.max(0, midX - rect.left - GUTTER) / state.pxPerSec,
          };
        }
        cvs.setPointerCapture(e.pointerId);
        return;
      }
    }
    const rect = cvs.getBoundingClientRect();
    const y = e.clientY - rect.top, x = e.clientX - rect.left;
    if (state.addNoteMode && y >= RULER && x > GUTTER) {
      if (state.playing) pause();
      const time = Math.max(0, Math.min(state.duration, xToT(e.clientX)));
      const k = canvasYToK(e.clientY);
      const preview = {
        t0: Math.max(0, time - 0.09),
        t1: Math.min(state.duration, time + 0.09),
        k,
        cents: k * 100,
        conf: 1,
        manualAddition: true,
        manualCorrection: true,
      };
      dragInfo = {
        mode: 'add-note',
        anchorTime: time,
        anchorX: e.clientX,
        preview,
        moved: false,
      };
      state.tokens.push(preview);
      state.tokens.sort((a, b) => a.t0 - b.t0);
      computeCentsRange();
      computeSmoothedCents();
      drawCanvas();
    } else {
      const tokenIndex = noteAt(e.clientX, e.clientY);
      const touch = e.pointerType === 'touch';
      if (tokenIndex >= 0) {
        if (state.playing && !touch) pause();
        const token = state.tokens[tokenIndex];
        dragInfo = {
          mode: 'note',
          tokenIndex,
          original: Object.assign({}, token),
          targetK: token.k,
          x: e.clientX,
          y: e.clientY,
          scroll0: state.scrollSec,
          lastY: e.clientY,
          touch,
          downAt: performance.now(),
          moved: false,
        };
        if (!touch) cvs.style.cursor = 'ns-resize';
      } else {
        dragInfo = { mode: 'pan', x: e.clientX, y: e.clientY, lastY: e.clientY,
                     scroll0: state.scrollSec, touch, axis: null, moved: false };
      }
    }
    cvs.setPointerCapture(e.pointerId);
  });
  cvs.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const { dist, midX } = touchSpread();
        const rect = cvs.getBoundingClientRect();
        state.pxPerSec = Math.max(15, Math.min(400, pinch.pxPerSec * dist / pinch.dist));
        state.scrollSec = clampScroll(pinch.tAt - Math.max(0, midX - rect.left - GUTTER) / state.pxPerSec);
        drawCanvas();
        return;
      }
    }
    if (dragInfo && dragInfo.touch && dragInfo.mode === 'note' && !dragInfo.moved &&
        performance.now() - dragInfo.downAt < NOTE_HOLD_MS &&
        Math.hypot(e.clientX - dragInfo.x, e.clientY - dragInfo.y) > 8) {
      // Moved before the hold completed: this is a scroll or pan, not an edit.
      dragInfo = { mode: 'pan', x: dragInfo.x, y: dragInfo.y, lastY: dragInfo.lastY,
                   scroll0: dragInfo.scroll0, touch: true, axis: null, moved: false };
    }
    if (!dragInfo) {   // idle: cursor affordances so the ruler invites the drag
      const y = e.clientY - cvs.getBoundingClientRect().top;
      cvs.style.cursor = state.addNoteMode && y >= RULER
        ? 'crosshair' : (noteAt(e.clientX, e.clientY) >= 0 ? 'ns-resize' : '');
      return;
    }
    if (dragInfo.mode === 'add-note') {
      const currentTime = Math.max(
        0,
        Math.min(state.duration, xToT(e.clientX))
      );
      const horizontalDrag = Math.abs(e.clientX - dragInfo.anchorX) > 4;
      dragInfo.moved = dragInfo.moved || horizontalDrag ||
        canvasYToK(e.clientY) !== dragInfo.preview.k;
      if (horizontalDrag) {
        dragInfo.preview.t0 = Math.min(dragInfo.anchorTime, currentTime);
        dragInfo.preview.t1 = Math.max(
          dragInfo.preview.t0 + 0.05,
          Math.max(dragInfo.anchorTime, currentTime)
        );
      }
      dragInfo.preview.k = canvasYToK(e.clientY);
      dragInfo.preview.cents = dragInfo.preview.k * 100;
      state.tokens.sort((a, b) => a.t0 - b.t0);
      computeCentsRange();
      computeSmoothedCents();
      drawCanvas();
      return;
    }
    if (dragInfo.mode === 'note') {
      if (dragInfo.touch && state.playing && !dragInfo.moved) pause();
      if (Math.abs(e.clientY - dragInfo.y) > 3) dragInfo.moved = true;
      const targetK = canvasYToK(e.clientY);
      if (targetK !== dragInfo.targetK) {
        dragInfo.targetK = targetK;
        const token = state.tokens[dragInfo.tokenIndex];
        applyManualTarget(token, targetK);
        computeSmoothedCents();
        drawCanvas();
      }
      return;
    }
    if (dragInfo.mode === 'pan') {
      const dx = e.clientX - dragInfo.x;
      if (dragInfo.touch) {
        const dy = e.clientY - dragInfo.y;
        if (!dragInfo.axis && Math.hypot(dx, dy) > 8) {
          dragInfo.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
          dragInfo.moved = true;
        }
        if (dragInfo.axis === 'y') {
          window.scrollBy(0, dragInfo.lastY - e.clientY);   // let the page scroll
          dragInfo.lastY = e.clientY;
          return;
        }
        if (dragInfo.axis !== 'x') return;
      }
      if (Math.abs(dx) > 4) dragInfo.moved = true;
      if (dragInfo.moved) {
        state.scrollSec = clampScroll(dragInfo.scroll0 - dx / state.pxPerSec);
        drawCanvas();
      }
      return;
    }

  });
  function releaseTouch(e) {
    if (e.pointerType !== 'touch') return false;
    const wasPinch = !!pinch;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    return wasPinch;                    // the lifted finger ended a pinch
  }
  cvs.addEventListener('pointerup', (e) => {
    if (releaseTouch(e)) { dragInfo = null; return; }
    if (dragInfo) {
      if (dragInfo.mode === 'add-note') {
        const preview = dragInfo.preview;
        const index = state.tokens.indexOf(preview);
        if (index >= 0) state.tokens.splice(index, 1);
        commitManualNoteInsertion(preview.t0, preview.t1, preview.k);
        cvs.style.cursor = 'crosshair';
      } else if (dragInfo.mode === 'note') {
        const token = state.tokens[dragInfo.tokenIndex];
        const midpoint = (dragInfo.original.t0 + dragInfo.original.t1) / 2;
        const targetK = dragInfo.targetK;
        const changed = dragInfo.moved && targetK !== dragInfo.original.k;
        restoreDraggedToken(token, dragInfo.original);
        if (changed) commitManualNoteEdit(dragInfo.tokenIndex, targetK);
        else {
          selectNoteForConnectors(dragInfo.tokenIndex);
          seek(midpoint);
        }
        cvs.style.cursor = '';
      } else if (!dragInfo.moved && dragInfo.mode === 'pan') {
        const rect = cvs.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x > GUTTER) seek(state.scrollSec + (x - GUTTER) / state.pxPerSec);
      }
    }
    dragInfo = null;
  });
  cvs.addEventListener('pointercancel', (e) => {
    releaseTouch(e);
    abandonDrag();
    cvs.style.cursor = state.addNoteMode ? 'crosshair' : '';
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
    if (e.target.closest('input, select, textarea, [contenteditable=true]')) return;
    if (!state.ready) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(origEl.currentTime - 2); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(origEl.currentTime + 2); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedNote(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoManualNoteEdit(); }
    else if (e.key === 'Escape' && state.addNoteMode) setAddNoteMode(false);
    else if (e.key === 'Escape' && state.selectedNoteTime != null) {
      state.selectedNoteTime = null;
      syncConnectorEditor();
      drawCanvas();
    }
  });

  /* test/debug hook */
  window.SwarLekh = { processFile, state, renotate: renotateNow, _hl: highlightActive,
    _editNote: commitManualNoteEdit, _addNote: commitManualNoteInsertion,
    _selectNote: selectNoteForConnectors,
    _editConnector: commitManualConnectorEdit, _deleteNote: deleteSelectedNote, _changeSa: changeSa,
    _exportJson: exportJson, _submitFinished: submitFinishedScore,
    _undoNoteEdit: undoManualNoteEdit,
    _renderRhythm: renderRhythm,
    _ali: () => activeLineIdx, _renderTonic: renderTonicChips, _syncTonic: syncTonicControls,
    _applyPitch: applyPitch, _audio: { orig: origEl, synth: synthEl } };
})();
