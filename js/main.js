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
    tonicChips: $('tonicChips'), tonicNote: $('tonicNote'), tonicFine: $('tonicFine'),
    tonicFineVal: $('tonicFineVal'), tonicHz: $('tonicHz'), droneBtn: $('droneBtn'), tonicHint: $('tonicHint'),
    canvas: $('contour'), zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'),
    notation: $('notation'),
    copyBtn: $('copyBtn'), dlTxtBtn: $('dlTxtBtn'), dlJsonBtn: $('dlJsonBtn'), dlWavBtn: $('dlWavBtn'),
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
    opts: { clarityThresh: 0.5, minNoteMs: 90 },
  };

  let worker = null;
  let actx = null;            // shared AudioContext (decode + drone)
  let droneNodes = null;
  let origUrl = null, synthUrl = null;
  let rafId = 0;
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
      worker = new Worker('js/worker.js');
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

      els.progressCard.hidden = true;
      els.resultArea.hidden = false;
      applySpeed();
      applySource();
      updateTimeDisp();
      state.ready = true;
      if (result.tonic[0].uncertain) toast('Not enough melody found to detect Sa — set it manually.');
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
      b.title = 'Use this tonic';
      b.addEventListener('click', () => { state.saHz = c.hz; syncTonicControls(); renotateNow(); });
      els.tonicChips.appendChild(b);
    });
    markSelectedChip();
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
  }

  function tonicFromControls() {
    const base = midiHz(parseInt(els.tonicNote.value, 10));
    const cents = parseInt(els.tonicFine.value, 10) || 0;
    state.saHz = base * Math.pow(2, cents / 1200);
    els.tonicFineVal.textContent = `${cents >= 0 ? '+' : ''}${cents}¢`;
    els.tonicHz.textContent = `${state.saHz.toFixed(1)} Hz`;
    markSelectedChip();
    updateDroneFreq();
    renotateDebounced();
  }
  els.tonicNote.addEventListener('change', tonicFromControls);
  els.tonicFine.addEventListener('input', tonicFromControls);

  els.droneBtn.addEventListener('click', () => {
    const on = !droneNodes;
    setDrone(on);
    els.droneBtn.classList.toggle('on', on);
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
    computeCentsRange();
    renderNotation();
    drawCanvas();
    updateStats();
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
    activeTokIdx = -1;
    let flatIdx = 0;
    for (const ph of state.phrases) {
      const row = document.createElement('div');
      row.className = 'phrase';
      const tEl = document.createElement('span');
      tEl.className = 'ptime';
      tEl.textContent = fmtTime(ph.t0);
      row.appendChild(tEl);
      for (const tk of ph.tokens) {
        const s = DSP.swaraInfo(tk.k);
        const span = document.createElement('span');
        span.className = 'tok' + (s.komal ? ' komal' : '') + (s.tivra ? ' tivra' : '');
        const oct = Math.max(-2, Math.min(2, s.octave));
        if (oct !== 0) span.dataset.oct = String(oct);
        if (tk.meend) {
          const mm = document.createElement('span');
          mm.className = 'meend-mark';
          mm.textContent = '~';
          span.appendChild(mm);
        }
        span.appendChild(document.createTextNode(s.letter));
        span.dataset.i = String(flatIdx);
        span.title = `${DSP.tokenText(tk.k, tk.meend)} · ${fmtTime(tk.t0, true)}`;
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
    }
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
    els.statsLine.textContent =
      `Sa ≈ ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz) · ${state.tokens.length} notes · voiced ${Math.round(voiced / state.f0.length * 100)}%`;
  }

  function exportHeader() {
    return `SwarLekh notation — ${state.fileName}\n` +
      `Sa = ${noteLabel(state.saHz)} (${state.saHz.toFixed(1)} Hz)\n` +
      `Legend: capitals shuddh; lowercase komal (r g d n); m = shuddh Ma, M = teevra Ma;\n` +
      `        X' = taar saptak, .X = mandra saptak; ~ = meend; – ≈ 0.3 s held\n\n`;
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
      phrases: state.phrases.map(ph => ({
        t0: +ph.t0.toFixed(3), t1: +ph.t1.toFixed(3),
        tokens: ph.tokens.map(tk => ({
          t0: +tk.t0.toFixed(3), t1: +tk.t1.toFixed(3),
          swara: DSP.tokenText(tk.k, tk.meend), k: tk.k, cents: +tk.cents.toFixed(1),
        })),
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

  /* animation loop */
  function startRaf() { stopRaf(); rafId = requestAnimationFrame(tick); }
  function stopRaf() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
  function tick() {
    const t = origEl.currentTime;
    if (state.loopA != null && state.loopB != null && t >= state.loopB) {
      seek(state.loopA);
    } else {
      // keep synth in lockstep
      if (!synthEl.paused && Math.abs(synthEl.currentTime - t) > 0.08 && t < state.synthDuration) {
        synthEl.currentTime = t;
      }
      const viewSec = viewWidthSec();
      if (t > state.scrollSec + viewSec * 0.72 || t < state.scrollSec) {
        state.scrollSec = clampScroll(t - viewSec * 0.25);
      }
    }
    updateTimeDisp();
    drawCanvas();
    highlightActive(t);
    if (state.playing) rafId = requestAnimationFrame(tick);
  }

  function highlightActive(t) {
    // binary search: last token with t0 <= t
    const toks = state.tokens;
    let lo = 0, hi = toks.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid].t0 <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx >= 0 && t >= toks[idx].t1) idx = -1;
    if (idx === activeTokIdx) return;
    const prev = els.notation.querySelectorAll('.active');
    prev.forEach(el => el.classList.remove('active'));
    activeTokIdx = idx;
    if (idx >= 0) {
      const sels = els.notation.querySelectorAll(`[data-i="${idx}"]`);
      sels.forEach(el => el.classList.add('active'));
      const first = sels[0];
      if (first) {
        const c = els.notation;
        const top = first.offsetTop - c.offsetTop;
        if (top < c.scrollTop + 10 || top > c.scrollTop + c.clientHeight - 50) {
          c.scrollTo({ top: Math.max(0, top - 80), behavior: 'smooth' });
        }
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

    // swara grid lines + labels
    cctx.font = '11px -apple-system, sans-serif';
    cctx.textBaseline = 'middle';
    for (let k = Math.ceil(centsLo / 100); k <= Math.floor(centsHi / 100); k++) {
      const y = cToY(k * 100);
      const deg = ((k % 12) + 12) % 12;
      cctx.beginPath();
      if (deg === 0) { cctx.strokeStyle = colors.saLine; cctx.lineWidth = 1.6; cctx.setLineDash([]); }
      else if (deg === 7) { cctx.strokeStyle = colors.paLine; cctx.lineWidth = 1; cctx.setLineDash([5, 4]); }
      else { cctx.strokeStyle = colors.grid; cctx.lineWidth = 1; cctx.setLineDash([]); }
      cctx.moveTo(GUTTER, y);
      cctx.lineTo(W, y);
      cctx.stroke();
      cctx.setLineDash([]);
      const info = DSP.swaraInfo(k);
      cctx.fillStyle = info.komal ? colors.komal : (deg === 0 ? colors.accent : colors.muted);
      cctx.textAlign = 'right';
      cctx.fillText(DSP.tokenText(k, false), GUTTER - 8, y);
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

    // quantized swara bars
    cctx.fillStyle = colors.accent;
    cctx.globalAlpha = 0.55;
    for (const tk of state.tokens) {
      if (tk.t1 < scrollSec || tk.t0 > tEnd) continue;
      const x = tToX(tk.t0), w = Math.max(2, (tk.t1 - tk.t0) * pxPerSec - 1);
      const y = cToY(tk.k * 100);
      cctx.beginPath();
      cctx.roundRect(x, y - 4.5, w, 9, 4);
      cctx.fill();
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
  window.SwarLekh = { processFile, state, renotate: renotateNow };
})();
