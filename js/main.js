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
    tonicCard: $('tonicCard'), tonicChips: $('tonicChips'), tonicNote: $('tonicNote'), tonicFine: $('tonicFine'),
    tonicFineVal: $('tonicFineVal'), tonicHz: $('tonicHz'), droneBtn: $('droneBtn'), tonicHint: $('tonicHint'),
    canvas: $('contour'), zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'),
    notation: $('notation'),
    copyBtn: $('copyBtn'), dlTxtBtn: $('dlTxtBtn'), dlJsonBtn: $('dlJsonBtn'), dlWavBtn: $('dlWavBtn'),
    pitchCtl: document.querySelector('.pitch-ctl'), pitchDownBtn: $('pitchDownBtn'), pitchUpBtn: $('pitchUpBtn'),
    pitchVal: $('pitchVal'), pitchKey: $('pitchKey'),
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
    pxPerSec: 90, scrollSec: 0, centsLo: -700, centsHi: 1900,
    playing: false,
    semitones: 0, fileMono: null, fileSr: 16000,
    opts: { clarityThresh: 0.5, minNoteMs: 150, ornaments: false, ornMinMs: 30, clean: true },
  };

  // Bump on every deploy that touches js/ (also bump the ?v= on the <script>
  // tags in index.html to match). Versioning the worker URL cascades to its
  // importScripts, so returning users never run a stale cached worker/DSP.
  const WORKER_URL = 'js/worker.js?v=3';
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

  const STAGE_LABEL = { filter: 'Filtering…', pitch: 'Tracking pitch…', tonic: 'Finding Sa…', synth: 'Rendering melody…' };

  function runWorker(samples, sr) {
    return new Promise((resolve, reject) => {
      if (worker) worker.terminate();
      worker = new Worker(WORKER_URL);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          const base = { filter: 0.16, pitch: 0.18, tonic: 0.82, synth: 0.9 }[m.stage] || 0.2;
          const frac = m.stage === 'pitch' ? 0.18 + (m.frac || 0) * 0.62 : base;
          setStage(STAGE_LABEL[m.stage] || m.stage, frac);
        } else if (m.type === 'result') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Analysis failed'));
      worker.postMessage({ samples, sr }, [samples.buffer]);
    });
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

      const result = await runWorker(new Float32Array(mono), targetSr);
      if (!result.f0.length) throw new Error('This clip is too short to analyze.');

      state.f0 = result.f0;
      state.clarity = result.clarity;
      state.hopSec = result.hopSec;
      state.sr = result.sr;
      state.tonicCands = result.tonic;
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
      updatePitchUI();

      els.progressCard.hidden = true;
      els.resultArea.hidden = false;
      applySpeed();
      applySource();
      updateTimeDisp();
      state.ready = true;
      if (result.tonic[0].uncertain) {
        toast('Sa may be off — check it with the Drone (see the note below the tonic).');
      }
    } catch (err) {
      els.progressCard.hidden = true;
      toast(err.message || String(err));
    }
  }

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
    updatePitchUI();
  }

  function tonicFromControls() {
    const base = midiHz(parseInt(els.tonicNote.value, 10));
    const cents = parseInt(els.tonicFine.value, 10) || 0;
    state.saHz = base * Math.pow(2, cents / 1200);
    els.tonicFineVal.textContent = `${cents >= 0 ? '+' : ''}${cents}¢`;
    els.tonicHz.textContent = `${state.saHz.toFixed(1)} Hz`;
    markSelectedChip();
    updateDroneFreq();
    updatePitchUI();
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

  function renotateNow() {
    if (!state.f0) return;
    const res = DSP.notate(state.f0, state.clarity, state.hopSec, state.saHz, state.opts);
    state.tokens = res.tokens;
    state.phrases = res.phrases;
    computeScale();
    computeCentsRange();
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

  function renderNotation() {
    els.notation.textContent = '';
    activeLineIdx = -1;
    activeTokIdx = -1;
    let flatIdx = 0;
    state.phrases.forEach((ph, phIdx) => {
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
        if (tk.meendFromPrev && row.querySelector('.tok')) {
          const conn = document.createElement('span');
          conn.className = 'meend-conn';
          conn.textContent = '⌒';
          conn.title = 'meend (glide)';
          conn.dataset.i = String(flatIdx);
          row.appendChild(conn);
        }
        const span = document.createElement('span');
        span.className = 'tok' + (s.komal ? ' komal' : '') + (s.tivra ? ' tivra' : '') + (tk.andolan ? ' andolan' : '');
        const oct = Math.max(-2, Math.min(2, s.octave));
        if (oct !== 0) span.dataset.oct = String(oct);
        const pre = tk.kan || tk.murki;
        if (pre) {
          const o = document.createElement('span');
          o.className = 'orn';
          o.textContent = '(' + pre.map(k => DSP.tokenText(k, false)).join('') + ')';
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
        span.appendChild(document.createTextNode(s.letter));
        if (tk.graceAfter) {
          const o = document.createElement('span');
          o.className = 'orn';
          o.textContent = '(' + tk.graceAfter.map(k => DSP.tokenText(k, false)).join('') + ')';
          o.title = 'grace after the note';
          span.appendChild(o);
        }
        span.dataset.i = String(flatIdx);
        span.title = `${DSP.tokenFullText(tk)} · ${fmtTime(tk.t0, true)}`;
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
  }

  els.notation.addEventListener('click', (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) return;
    const tk = state.tokens[parseInt(t.dataset.i, 10)];
    if (tk) seek(tk.t0 + 0.005);
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

  function exportHeader() {
    return `SwarLekh notation — ${state.fileName}\n` +
      `Sa = ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz)\n` +
      `Legend: capitals shuddh; lowercase komal (r g d n); m = shuddh Ma, M = teevra Ma;\n` +
      `        X' = taar saptak, .X = mandra saptak; – ≈ 0.3 s held\n` +
      `        (R)G = kan; (GRG)m = murki; X~Y = meend; ≈X = andolan/gamak; ~X = glide in note\n\n`;
  }

  els.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportHeader() + DSP.notationText(state.phrases));
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
    download(new Blob([exportHeader() + DSP.notationText(state.phrases)], { type: 'text/plain' }), baseName() + '.sargam.txt'));

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
            swara: DSP.tokenText(tk.k, false), display: DSP.tokenFullText(tk),
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

  const detailSel = $('detailSel');
  detailSel.addEventListener('change', () => {
    const v = detailSel.value;
    if (v === 'clean') Object.assign(state.opts, { ornaments: false, clean: true, minNoteMs: 150 });
    else if (v === 'detailed') Object.assign(state.opts, { ornaments: true, clean: true, ornMinMs: 30, minNoteMs: 90 });
    else Object.assign(state.opts, { ornaments: true, clean: false, ornMinMs: 30, minNoteMs: 90 });
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

  function updatePitchUI() {
    const s = state.semitones;
    els.pitchVal.textContent = s > 0 ? `+${s}` : String(s);
    if (state.saHz) {
      const shifted = state.saHz * Math.pow(2, s / 12);
      els.pitchKey.textContent = `Sa→${noteLabel(shifted).replace(/ .*$/, '')}`;
    } else els.pitchKey.textContent = '';
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

    const { centsLo, centsHi, scrollSec, pxPerSec, saHz } = state;
    const tToX = (t) => GUTTER + (t - scrollSec) * pxPerSec;
    const cToY = (c) => RULER + (centsHi - c) / (centsHi - centsLo) * (H - RULER - 10);
    const viewSec = viewWidthSec();
    const tEnd = scrollSec + viewSec;

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

    // raw contour
    const { f0, clarity, hopSec, opts } = state;
    const i0 = Math.max(0, Math.floor(scrollSec / hopSec));
    const i1 = Math.min(f0.length - 1, Math.ceil(tEnd / hopSec));
    cctx.strokeStyle = colors.contour;
    cctx.lineWidth = 1.4;
    cctx.globalAlpha = 0.85;
    cctx.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      if (f0[i] > 0 && clarity[i] >= opts.clarityThresh) {
        const x = tToX(i * hopSec);
        const y = cToY(1200 * Math.log2(f0[i] / saHz));
        if (y < RULER || y > H) { pen = false; continue; }
        if (pen) cctx.lineTo(x, y); else { cctx.moveTo(x, y); pen = true; }
      } else pen = false;
    }
    cctx.stroke();
    cctx.globalAlpha = 1;

    // Quantized swaras. Held notes -> thick saffron blocks labelled with the
    // swara (the notes to sing & dwell on); quick notes -> thin indigo marks
    // (fast movement / ornament). So the eye separates "sing this" from "this
    // is a run". Ornament touches are drawn as small indigo ticks too.
    cctx.textBaseline = 'middle';
    cctx.textAlign = 'center';
    for (let ti = 0; ti < state.tokens.length; ti++) {
      const tk = state.tokens[ti];
      if (tk.t1 < scrollSec || tk.t0 > tEnd) continue;
      const isActive = ti === activeTokIdx;
      const dur = tk.t1 - tk.t0;
      const fast = dur < 0.16;
      const x = tToX(tk.t0), w = Math.max(2, dur * pxPerSec - 1);
      const y = cToY(tk.k * 100);
      const half = fast ? 2.5 : (dur >= 0.30 ? 6 : 4.5);
      cctx.fillStyle = fast ? colors.contour : colors.accent;
      cctx.globalAlpha = isActive ? 1 : (fast ? 0.5 : (dur >= 0.30 ? 0.82 : 0.62));
      cctx.beginPath();
      cctx.roundRect(x, y - (isActive ? half + 1.5 : half), w, (isActive ? half + 1.5 : half) * 2, fast ? 2 : 4);
      cctx.fill();
      // Label the swara on notes wide enough to carry it.
      if (!fast && w >= 13) {
        cctx.globalAlpha = 1;
        cctx.fillStyle = '#ffffff';
        cctx.font = '700 11px Georgia, serif';
        cctx.fillText(DSP.swaraInfo(tk.k).letter, x + w / 2, y + 0.5);
      }
      if (tk.orn) {
        cctx.fillStyle = colors.contour;
        for (const o of tk.orn) {
          cctx.globalAlpha = o.type === 'meend' ? 0.3 : 0.5;
          const ox = tToX(o.t0), ow = Math.max(2, (o.t1 - o.t0) * pxPerSec - 1);
          const oy = cToY(o.k * 100);
          cctx.beginPath();
          cctx.roundRect(ox, oy - 2, ow, 4, 2);
          cctx.fill();
        }
      }
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
