#!/usr/bin/env python3
"""
SwarLekh local analysis server — highest-quality pitch track, on YOUR machine.

Pipeline: BS-RoFormer isolates the VOCAL stem from the mix when available,
falling back to Demucs (htdemucs). RMVPE tracks robust frame-level pitch, Praat
confirms uncertain voicing decisions, and GAME predicts sung note boundaries.
Separation removes harmonium/tabla confusion; the neural models preserve
octaves and resolve fast murkis and sargam runs.

Privacy and safety: the server listens on 127.0.0.1 only. Browser requests are
accepted only from the SwarLekh site and localhost pages (any other Origin is
refused before any work starts), uploads are size- and duration-limited, and
one analysis runs at a time. Separated vocals are cached on this disk only.

API (all JSON unless noted):
  GET  /                 health + current job
  GET  /status           current job: stage, progress, elapsed, eta
  POST /analyze?job=ID   body = audio file bytes -> pitch, note regions, rhythm
  POST /cancel?job=ID    stop the running analysis

Run:  server/.venv/bin/python server/server.py
"""
import gc
import glob
import hashlib
import importlib.util
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

import numpy as np
import soundfile as sf
import torch
import torchaudio
import librosa
import parselmouth
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
from singing_models import GameTranscriber, RobustPitchTracker
from rhythm import TAALS, summarize_neural_rhythm

# Homebrew tools (ffmpeg) must be on PATH even under launchd, whose
# LaunchAgents start with a minimal PATH that excludes /opt/homebrew/bin.
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ.get('PATH', '')
from demucs.pretrained import get_model
from demucs.apply import apply_model

PORT = 8765
API_VERSION = 2          # /status, /cancel, job ids, structured errors
ANALYSIS_VERSION = 5     # Learned pulse/downbeats + taal-cycle reconciliation.
PRAAT_HOP_SEC = 0.004
SR = 16000
DEMUCS_SR = 44100
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_ROOT = os.path.join(SERVER_DIR, 'models')
GAME_MODEL_DIR = os.environ.get(
    'SWARLEKH_GAME_MODEL',
    os.path.join(MODEL_ROOT, 'GAME-1.0.3-small-onnx'),
)

# Uploads: a 3-hour stereo 16-bit WAV is ~1.9 GB; compressed files are far
# smaller. Anything bigger or longer is refused before work starts.
MAX_UPLOAD_BYTES = int(os.environ.get('SWARLEKH_MAX_UPLOAD_MB', '2048')) * 1024 * 1024
MAX_DURATION_SEC = float(os.environ.get('SWARLEKH_MAX_MINUTES', '180')) * 60

# Only these browser origins may call the server. Requests without an Origin
# header come from local tools (curl, tests), which already have local access.
ALLOWED_ORIGINS = [
    'https://rishavpunatar.github.io',
    re.compile(r'^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$'),
] + [o.strip() for o in os.environ.get('SWARLEKH_ALLOWED_ORIGINS', '').split(',') if o.strip()]


def origin_allowed(origin):
    for allowed in ALLOWED_ORIGINS:
        if isinstance(allowed, re.Pattern):
            if allowed.match(origin):
                return True
        elif origin == allowed:
            return True
    return False


# Separated vocals persist on disk (FLAC, 24-bit) keyed by the upload's hash,
# so a server restart or an analysis upgrade never repeats the slow step.
CACHE_DIR = os.environ.get('SWARLEKH_CACHE_DIR', os.path.join(SERVER_DIR, 'cache', 'stems'))
CACHE_LIMIT_BYTES = int(os.environ.get('SWARLEKH_CACHE_MB', '2048')) * 1024 * 1024

# CPU, deliberately: Apple's MPS backend is far SLOWER than CPU for Demucs's
# transformer here (measured ~10x), so CPU (multi-threaded) is the fast path.
torch.set_num_threads(os.cpu_count() or 4)
DEVICE = 'cpu'
# Models load lazily on first use so the always-on login service idles light.
_demucs = None
_voc_idx = None
_robust_pitch = None
_robust_pitch_failed = False
_game = None
_game_failed = False
_rhythm_tracker = None
_rhythm_tracker_failed = False


def get_robust_pitch():
    global _robust_pitch, _robust_pitch_failed
    if _robust_pitch is None and not _robust_pitch_failed:
        try:
            print('[swarlekh] loading RMVPE...', flush=True)
            _robust_pitch = RobustPitchTracker(
                model_path=os.environ.get('SWARLEKH_RMVPE_MODEL'),
                device=os.environ.get('SWARLEKH_ONNX_DEVICE'),
            )
        except Exception as error:
            _robust_pitch_failed = True
            print('[swarlekh] RMVPE unavailable (%s); using Praat fallback' % error, flush=True)
    return _robust_pitch


def get_game():
    global _game, _game_failed
    if _game is None and not _game_failed:
        try:
            print('[swarlekh] loading GAME note transcriber...', flush=True)
            _game = GameTranscriber(GAME_MODEL_DIR, steps=2)
        except Exception as error:
            _game_failed = True
            print('[swarlekh] GAME unavailable (%s); using contour notation fallback'
                  % error, flush=True)
    return _game


def get_rhythm_tracker():
    global _rhythm_tracker, _rhythm_tracker_failed
    if _rhythm_tracker is None and not _rhythm_tracker_failed:
        try:
            from beat_this.inference import Audio2Beats
            print('[swarlekh] loading Beat This! rhythm model...', flush=True)
            _rhythm_tracker = Audio2Beats(
                checkpoint_path='small0',
                device='cpu',
                dbn=False,
            )
        except Exception as error:
            _rhythm_tracker_failed = True
            print('[swarlekh] learned rhythm model unavailable (%s); using signal fallback'
                  % error, flush=True)
    return _rhythm_tracker


def get_demucs():
    global _demucs, _voc_idx
    if _demucs is None:
        print('[swarlekh] loading Demucs (htdemucs) … device=%s' % DEVICE, flush=True)
        _demucs = get_model('htdemucs'); _demucs.eval()
        _voc_idx = _demucs.sources.index('vocals')
    return _demucs, _voc_idx


# --------------------------------------------------------------------------
# Jobs: one heavy analysis at a time, observable and cancellable.
# --------------------------------------------------------------------------

class Cancelled(Exception):
    """The running analysis was cancelled by the user or superseded."""


class AnalysisError(Exception):
    """A request the server understood but cannot analyse (shown to the user)."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Job:
    # Overall progress bands per stage, so the client can draw one honest bar.
    BANDS = {
        'queued': (0.0, 0.0), 'decoding': (0.0, 0.02), 'separating': (0.02, 0.80),
        'pitch': (0.80, 0.88), 'notes': (0.88, 0.95), 'rhythm': (0.95, 0.99),
        'done': (1.0, 1.0),
    }

    def __init__(self, job_id=None, key=None, duration=0.0):
        self.id = job_id or uuid.uuid4().hex[:12]
        self.key = key
        self.duration = float(duration)
        self.stage = 'queued'
        self.fraction = 0.0
        self.started = time.time()
        self.stage_started = self.started
        self.cancel_event = threading.Event()
        self.done = threading.Event()
        self.process = None
        self.note = ''

    def set(self, stage, fraction=0.0, note=None):
        if stage != self.stage:
            self.stage_started = time.time()
        self.stage = stage
        self.fraction = max(0.0, min(1.0, float(fraction)))
        if note is not None:
            self.note = note
        self.check()

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled()

    def cancel(self):
        self.cancel_event.set()
        process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
            # A separator still loading its model can ignore SIGTERM for a while.
            threading.Timer(2.0, lambda: process.poll() is None and process.kill()).start()

    @property
    def progress(self):
        lo, hi = self.BANDS.get(self.stage, (0.0, 1.0))
        return lo + (hi - lo) * self.fraction

    def snapshot(self):
        elapsed = time.time() - self.started
        progress = self.progress
        eta = None
        # Separation dominates; once it has measurably advanced, extrapolate.
        if 0.06 < progress < 1.0 and elapsed > 5:
            eta = round(elapsed / progress * (1.0 - progress), 1)
        return {
            'id': self.id, 'stage': self.stage, 'progress': round(progress, 4),
            'elapsed': round(elapsed, 1), 'eta': eta,
            'duration': round(self.duration, 2), 'note': self.note,
            'cancelled': self.cancel_event.is_set(),
        }


_job_lock = threading.Lock()      # serialises heavy work (keeps 8 GB RAM sane)
_state_lock = threading.Lock()    # guards _current and _active
_current = None                   # the job holding _job_lock
_active = {}                      # id -> job, running or waiting for the lock


def current_job():
    with _state_lock:
        job = _current
    return job if job is not None and not job.done.is_set() else None


def active_jobs():
    with _state_lock:
        return [job for job in _active.values() if not job.done.is_set()]


# --------------------------------------------------------------------------
# Audio decoding
# --------------------------------------------------------------------------

def decode_audio(raw):
    """Return (float32 [n, ch], sample_rate). libsndfile reads WAV/FLAC/OGG/MP3;
    anything else (M4A/AAC, WebM, …) goes through ffmpeg."""
    try:
        return sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    except Exception:
        pass
    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg is None:
        raise AnalysisError("Couldn't read this audio format. Install ffmpeg "
                            "(brew install ffmpeg) or upload MP3, WAV or FLAC.", 415)
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'input')
        dst = os.path.join(td, 'decoded.wav')
        with open(src, 'wb') as handle:
            handle.write(raw)
        result = subprocess.run(
            [ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', src, '-vn',
             '-acodec', 'pcm_f32le', '-f', 'wav', dst],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600,
        )
        if result.returncode != 0 or not os.path.exists(dst):
            raise AnalysisError("Couldn't read this audio file — is it a valid recording?", 415)
        return sf.read(dst, dtype='float32', always_2d=True)


# --------------------------------------------------------------------------
# Vocal separation (+ on-disk cache)
# --------------------------------------------------------------------------

CHUNK = int(30 * DEMUCS_SR)      # Demucs separates ~30 s at a time …
OVERLAP = int(1.0 * DEMUCS_SR)   # … with a 1 s crossfade at the joins


def separate_vocals_demucs(mix, job):
    """mix: torch [2, n] @44.1k -> mono vocals [1, n], separated in CHUNKS so
    peak memory stays ~one window's worth (whole-song stems OOM 8 GB machines).
    Overlap-add crossfade hides the seams."""
    model, voc_idx = get_demucs()
    n = mix.shape[1]
    voc = torch.zeros(2, n)
    wsum = torch.zeros(n)
    pos, idx = 0, 0
    nchunks = max(1, (n + CHUNK - 1) // CHUNK)
    while pos < n:
        job.set('separating', idx / nchunks, note='Demucs')
        a = max(0, pos - OVERLAP)
        b = min(n, pos + CHUNK)
        idx += 1
        print('[swarlekh] separating chunk %d/%d …' % (idx, nchunks), flush=True)
        with torch.no_grad():
            src = apply_model(model, mix[:, a:b][None], device=DEVICE,
                              split=True, overlap=0.1, progress=False)[0]
        L = b - a
        w = torch.ones(L)
        if a > 0: w[:OVERLAP] = torch.linspace(0, 1, OVERLAP)        # fade in over the join
        if b < n: w[-OVERLAP:] = torch.linspace(1, 0, OVERLAP)       # fade out into the next
        voc[:, a:b] += src[voc_idx] * w
        wsum[a:b] += w
        del src
        gc.collect()
        pos = b
    wsum = wsum.clamp(min=1e-6)
    return (voc / wsum).mean(0, keepdim=True)


# --- BS-RoFormer separation (state of the art for vocals: ~12.1 SDR vs
# Demucs htdemucs's ~9 on real music). Runs the pip package `audio-separator`
# from its own isolated venv via subprocess, so this env stays untouched.
# Any failure falls back to Demucs automatically. ---
SEPARATOR = os.environ.get('SWARLEKH_SEP', 'roformer')     # 'roformer' | 'demucs'
ROFORMER_BIN = os.path.join(SERVER_DIR, '.venv-sep', 'bin', 'audio-separator')
ROFORMER_MODEL = 'model_bs_roformer_ep_368_sdr_12.9628.ckpt'
# Persistent model folder (the tool's default is /tmp, which macOS purges).
ROFORMER_MODEL_DIR = os.environ.get(
    'SWARLEKH_SEPARATOR_MODELS', os.path.join(MODEL_ROOT, 'audio-separator'))
_TQDM = re.compile(rb'(\d+)/(\d+) \[')


def roformer_timeout(duration):
    # Measured ~2-3.5x realtime on an M1; allow generous headroom.
    return max(30 * 60, 8 * duration)


def separate_vocals_roformer(x, job):
    """x: torch [2, n] @44.1k -> mono vocal [1, n] via BS-RoFormer (subprocess)."""
    with tempfile.TemporaryDirectory() as td:
        mix_path = os.path.join(td, 'mix.wav')
        sf.write(mix_path, x.T.cpu().numpy(), DEMUCS_SR, subtype='FLOAT')
        print('[swarlekh] separating with BS-RoFormer (best quality; slower)…', flush=True)
        job.set('separating', 0.0, note='Loading the BS-RoFormer model')
        os.makedirs(ROFORMER_MODEL_DIR, exist_ok=True)
        process = subprocess.Popen(
            [ROFORMER_BIN, mix_path, '--model_filename', ROFORMER_MODEL,
             '--model_file_dir', ROFORMER_MODEL_DIR, '--output_dir', td,
             '--output_format', 'WAV', '--single_stem', 'Vocals', '--use_soundfile'],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        job.process = process
        deadline = time.time() + roformer_timeout(job.duration)
        tail = b''
        try:
            fd = process.stderr.fileno()
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                tail = (tail + chunk)[-4096:]
                # tqdm redraws "  45%|████ | 9/20 [..]" with carriage returns.
                matches = _TQDM.findall(chunk)
                if matches:
                    done, total = matches[-1]
                    if int(total) > 0:
                        job.set('separating', int(done) / int(total), note='BS-RoFormer')
                job.check()
                if time.time() > deadline:
                    process.kill()
                    raise RuntimeError('BS-RoFormer exceeded its time limit')
            process.wait()
        finally:
            job.process = None
            if process.poll() is None:
                process.kill()
                process.wait()
        job.check()
        if process.returncode != 0:
            raise RuntimeError('audio-separator exited %d: %s' % (
                process.returncode, tail.decode('utf-8', 'replace').strip()[-300:]))
        voc_path = [p for p in glob.glob(os.path.join(td, '*.wav')) if '(Vocals)' in p][0]
        v, vsr = sf.read(voc_path, dtype='float32', always_2d=True)      # [n, ch]
        voc = torch.tensor(v.T).mean(0, keepdim=True)                    # [1, n]
        if vsr != DEMUCS_SR:
            voc = torchaudio.functional.resample(voc, vsr, DEMUCS_SR)
        n = x.shape[1]
        if voc.shape[1] < n: voc = torch.nn.functional.pad(voc, (0, n - voc.shape[1]))
        return voc[:, :n]


def _cache_paths(key):
    return sorted(glob.glob(os.path.join(CACHE_DIR, key + '-*.flac')))


def load_cached_vocals(key, n):
    for path in _cache_paths(key):
        try:
            v, vsr = sf.read(path, dtype='float32', always_2d=True)
        except Exception:
            continue
        if vsr != DEMUCS_SR:
            continue
        os.utime(path)                                   # LRU: mark as recently used
        voc = torch.tensor(v[:, 0])[None]
        if voc.shape[1] < n: voc = torch.nn.functional.pad(voc, (0, n - voc.shape[1]))
        separator = os.path.basename(path)[len(key) + 1:-len('.flac')]
        return voc[:, :n], separator
    return None, None


def save_cached_vocals(key, separator, voc):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, '%s-%s.flac' % (key, separator))
        partial = path + '.part'
        sf.write(partial, voc[0].cpu().numpy(), DEMUCS_SR, format='FLAC', subtype='PCM_24')
        os.replace(partial, path)
        prune_cache()
    except Exception as error:
        print('[swarlekh] could not cache separated vocals: %s' % error, flush=True)


def prune_cache(limit=None):
    limit = CACHE_LIMIT_BYTES if limit is None else limit
    files = [(os.path.getmtime(p), os.path.getsize(p), p)
             for p in glob.glob(os.path.join(CACHE_DIR, '*.flac'))]
    total = sum(size for _, size, _ in files)
    for _, size, path in sorted(files):                  # oldest first
        if total <= limit:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass


def separated_vocals_44k(key, x, job):
    """Mono vocal [1, n] @44.1k and the separator that produced it."""
    voc, separator = load_cached_vocals(key, x.shape[1])
    if voc is not None:
        print('[swarlekh] reusing cached separation (%s)' % separator, flush=True)
        job.set('separating', 1.0, note='cached')
        return voc, separator, True
    if SEPARATOR == 'roformer' and os.path.exists(ROFORMER_BIN):
        try:
            voc = separate_vocals_roformer(x, job)
            # Sanity: a near-silent stem means the model found no voice at all
            # (degenerate input) — better to fall back than return an empty track.
            mix_rms = float(x.pow(2).mean().sqrt())
            voc_rms = float(voc.pow(2).mean().sqrt())
            if mix_rms > 0 and voc_rms < 0.005 * mix_rms:
                print('[swarlekh] RoFormer stem is near-silent (%.5f vs %.5f) — falling back to Demucs'
                      % (voc_rms, mix_rms), flush=True)
            else:
                save_cached_vocals(key, 'roformer', voc)
                return voc, 'roformer', False
        except Cancelled:
            raise
        except Exception as e:
            print('[swarlekh] RoFormer failed (%s) — falling back to Demucs' % e, flush=True)
    voc = separate_vocals_demucs(x, job)
    save_cached_vocals(key, 'demucs', voc)
    return voc, 'demucs', False


# --------------------------------------------------------------------------
# Rhythm
# --------------------------------------------------------------------------

def detect_rhythm(x, voc):
    """BPM + dominant taal cycle from accompaniment ticks and learned downbeats.

    Librosa supplies a fine percussion grid that stays useful when a tabla
    articulates subdivisions. Beat This! independently estimates the felt pulse
    and downbeats. Reconciliation resolves half/double-tempo ambiguity, while
    repeated downbeat distances identify the cycle and sam. Bass-fold scoring
    remains as an offline/model-failure fallback.
    """
    try:
        from scipy.signal import butter, sosfilt
        acc = (x.mean(0) - voc[0]).cpu().numpy()
        RSR = 22050
        acc = librosa.resample(acc.astype(np.float32), orig_sr=DEMUCS_SR, target_sr=RSR)
        oenv = librosa.onset.onset_strength(y=acc, sr=RSR)
        tempo, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=RSR, trim=False)
        tempo = float(np.atleast_1d(tempo)[0])
        if tempo <= 0 or len(beats) < 16:
            return None
        bt = librosa.frames_to_time(beats, sr=RSR)
        iv = np.diff(bt)
        if iv.size == 0 or np.std(iv) / max(np.mean(iv), 1e-6) > 0.35:
            return None                                    # too unsteady to call
        base = {'bpm': round(tempo, 1), 'beats': [round(float(t), 3) for t in bt],
                'matraBpm': round(tempo, 1), 'pulseSubdivision': 1,
                'tempoRange': None, 'cycle': None, 'taal': None, 'alt': None,
                'conf': None, 'sam': None, 'cycleConfidence': None,
                'beatSource': 'librosa'}

        rhythm_tracker = get_rhythm_tracker()
        if rhythm_tracker is not None:
            try:
                mix = x.mean(0).cpu().numpy().astype(np.float32)
                model_beats, model_downbeats = rhythm_tracker(mix, DEMUCS_SR)
                learned = summarize_neural_rhythm(
                    bt,
                    tempo,
                    model_beats,
                    model_downbeats,
                )
                if learned:
                    base.update(learned)
                    if base['taal']:
                        return base
            except Exception as error:
                print('[swarlekh] learned rhythm inference failed (%s); using signal fallback'
                      % error, flush=True)

        # Per-beat bass energy (stroke lands in the first half-beat window).
        sos = butter(4, 200, 'low', fs=RSR, output='sos')
        bass2 = sosfilt(sos, acc); bass2 = bass2 * bass2
        Tb = 60.0 / tempo
        e = np.array([float(bass2[int(t * RSR):int((t + 0.5 * Tb) * RSR)].sum()) for t in bt[:-1]])
        if e.std() <= 0:
            return base
        e = (e - e.mean()) / e.std()
        n = len(e); sst = float(((e - e.mean()) ** 2).sum())
        scores = {}
        for L in TAALS:
            if n < 2 * L: continue
            ssw = 0.0
            for r in range(L):
                g = e[r::L]
                if len(g) > 1: ssw += float(((g - g.mean()) ** 2).sum())
            scores[L] = 1.0 - (ssw / max(n - L, 1)) / (sst / max(n - 1, 1))
        if not scores:
            return base
        best = max(scores.values())
        if best < 0.15:
            return base                                    # no repeating accent cycle
        good = [L for L, sc in scores.items() if sc >= 0.9 * best and sc > 0]
        L = min(good) if good else max(scores, key=scores.get)
        # Sam phase = the rotation with the strongest mean bass (the dagga on sam).
        phase = int(np.argmax([np.mean(e[r::L]) for r in range(L)]))
        name, alt = TAALS[L]
        base.update(cycle=int(L), taal=name, alt=alt,
                    conf=('likely' if best >= 0.35 else 'possibly'),
                    cycleConfidence=round(float(best), 3),
                    sam=[round(float(t), 3) for t in bt[phase::L]])
        return base
    except Exception as e:
        print('[swarlekh] rhythm detection failed: %s' % e, flush=True)
        return None


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

def run_analysis(job, x):
    voc, separator, cached = separated_vocals_44k(job.key, x, job)
    voc44 = voc[0].cpu().numpy().astype(np.float32)
    voc16 = torchaudio.functional.resample(voc, DEMUCS_SR, SR)[0].cpu().numpy().astype(np.float64)  # [n] @16k
    t_sep = time.time() - job.started
    print('[swarlekh] separation done in %.1fs -- neural singing analysis...'
          % t_sep, flush=True)

    # Praat supplies an independent voicing decision for borderline RMVPE
    # frames. High-confidence RMVPE frames stand on their own. This preserves
    # RMVPE's octave robustness without accepting every low-confidence edge.
    job.set('pitch', 0.0)
    snd = parselmouth.Sound(voc16, sampling_frequency=SR)
    quick = snd.to_pitch_cc(time_step=0.01, pitch_floor=75.0, pitch_ceiling=1200.0)
    qf = quick.selected_array['frequency']; qf = qf[qf > 0]
    floor = float(np.clip(0.8 * np.percentile(qf, 5), 75.0, 200.0)) if qf.size else 120.0
    p2 = snd.to_pitch_cc(time_step=PRAAT_HOP_SEC, pitch_floor=floor,
                         pitch_ceiling=1200.0, very_accurate=True)
    praat_f0 = np.nan_to_num(p2.selected_array['frequency'])
    strength = np.nan_to_num(p2.selected_array['strength'])
    job.set('pitch', 0.2)

    analyzer = 'praat-cc'
    robust_pitch = get_robust_pitch()
    if robust_pitch is not None:
        pitch = robust_pitch.predict(
            voc44,
            DEMUCS_SR,
            praat_f0,
            strength,
            PRAAT_HOP_SEC,
            on_chunk=lambda fraction: job.set('pitch', 0.2 + 0.8 * fraction),
        )
        f0 = pitch['f0']
        pd = pitch['confidence']
        hop_sec = pitch['hopSec']
        analyzer = 'rmvpe+praat'
    else:
        hop_sec = PRAAT_HOP_SEC
        f0 = praat_f0
        pd = np.where(f0 > 0, np.clip(strength, 0.0, 1.0), 0.0)

    n_frames = len(f0)
    hop_n = int(round(hop_sec * SR))
    rms = np.zeros(n_frames, dtype='float32')
    for i in range(n_frames):
        s = i * hop_n
        rms[i] = float(np.sqrt(np.mean(voc16[s:s + 1024] ** 2))) if s + 1024 <= len(voc16) else 0.0
    if robust_pitch is None:
        # The fallback still needs the vocal-energy gate that RMVPE's learned
        # voiced/unvoiced confidence replaces.
        loud = np.percentile(rms[rms > 0], 90) if np.any(rms > 0) else 0.0
        threshold = max(0.08 * loud, 1e-4)
        keep = (pd > 0.01) & (rms > threshold)
        f0 = np.where(keep, f0, 0.0)
        pd = np.where(keep, pd, 0.0)

    job.set('notes', 0.0)
    note_regions = []
    game = get_game()
    if game is not None:
        try:
            note_regions = game.transcribe(
                voc44, DEMUCS_SR,
                on_chunk=lambda fraction: job.set('notes', fraction),
            )
            analyzer += '+game'
        except Cancelled:
            raise
        except Exception as error:
            print('[swarlekh] GAME inference failed for this recording: %s'
                  % error, flush=True)

    # Articulation evidence must be independent of GAME. Treating every GAME
    # note boundary as a syllable onset made downstream cleanup preserve the
    # very duplicate/ornament splits it was meant to audit.
    try:
        onsets = librosa.onset.onset_detect(
            y=voc16.astype(np.float32),
            sr=SR,
            hop_length=160,
            units='time',
            backtrack=True,
        )
        onsets = [round(float(t), 3) for t in onsets]
    except Exception as error:
        print('[swarlekh] onset detect failed: %s' % error, flush=True)
        onsets = []
    job.set('rhythm', 0.0)
    rhythm = detect_rhythm(x, voc)
    job.set('done', 1.0)
    voiced = int(np.count_nonzero(f0))
    print('[swarlekh] %.1fs sep + %.1fs total · %s · %s%s · %d frames @ %.0fms hop · %d voiced · %d notes · rhythm=%s'
          % (t_sep, time.time() - job.started, separator, analyzer, ' (cached)' if cached else '',
             n_frames, hop_sec * 1000, voiced, len(note_regions),
             ('%s %s %sbpm' % (rhythm['conf'], rhythm['taal'], rhythm['bpm'])) if rhythm else 'none'), flush=True)
    return dict(f0=[round(float(v), 2) for v in f0],
                periodicity=[round(float(v), 3) for v in pd],
                rms=[round(float(v), 5) for v in rms],
                onsets=onsets, noteRegions=note_regions, rhythm=rhythm,
                analyzer=analyzer, separator=separator, separationCached=cached,
                voicedFraction=round(voiced / max(n_frames, 1), 4),
                duration=round(job.duration, 3),
                hopSec=hop_sec, sr=SR)


app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES
CORS(app, origins=ALLOWED_ORIGINS, allow_private_network=True)


@app.before_request
def refuse_foreign_origins():
    # CORS alone only hides responses; a "simple" cross-site POST would still
    # run. Refuse any browser request from another site before doing work.
    origin = request.headers.get('Origin')
    if origin is not None and not origin_allowed(origin):
        return jsonify(error='This origin may not use the SwarLekh server.'), 403
    return None


@app.errorhandler(HTTPException)
def http_error(error):
    message = error.description
    if error.code == 413:
        message = 'This file is too large for the local server (limit %d MB).' % (
            MAX_UPLOAD_BYTES // (1024 * 1024))
    return jsonify(error=message), error.code


def health_payload():
    game_files = ('encoder.onnx', 'segmenter.onnx', 'bd2dur.onnx', 'estimator.onnx')
    job = current_job()
    return dict(
        ok=True,
        api=API_VERSION,
        device=DEVICE,
        analysisVersion=ANALYSIS_VERSION,
        analyzer='rmvpe+praat+game',
        separator='roformer' if SEPARATOR == 'roformer' and os.path.exists(ROFORMER_BIN) else 'demucs',
        neuralModelsInstalled=(
            importlib.util.find_spec('rmvpe_onnx') is not None
            and all(
                os.path.exists(os.path.join(GAME_MODEL_DIR, name))
                for name in game_files
            )
        ),
        busy=job is not None,
        job=job.snapshot() if job else None,
        sr=SR,
    )


@app.get('/')
def health():
    return jsonify(health_payload())


@app.get('/status')
def status():
    job = current_job()
    wanted = request.args.get('job')
    waiting = [other for other in active_jobs() if other is not job]
    mine = next((other for other in active_jobs() if other.id == wanted), None) if wanted else None
    return jsonify(busy=job is not None, job=job.snapshot() if job else None,
                   waiting=len(waiting), mine=mine.snapshot() if mine else None)


@app.post('/cancel')
def cancel():
    wanted = request.args.get('job')
    targets = [job for job in active_jobs() if not wanted or job.id == wanted]
    for job in targets:
        print('[swarlekh] cancelling job %s' % job.id, flush=True)
        job.cancel()
    return jsonify(cancelled=bool(targets), jobs=[job.id for job in targets])


@app.post('/analyze')
def analyze():
    global _current
    raw = request.get_data()
    if not raw:
        return jsonify(error='No audio was sent.'), 400
    job_id = (request.args.get('job') or '')[:64] or None
    key = hashlib.sha256(raw).hexdigest()
    try:
        audio, in_sr = decode_audio(raw)
    except AnalysisError as error:
        return jsonify(error=str(error)), error.status
    duration = audio.shape[0] / float(in_sr or 1)
    if duration < 0.5:
        return jsonify(error='This clip is too short to analyze.'), 400
    if duration > MAX_DURATION_SEC:
        return jsonify(error='Recordings longer than %d minutes are not supported by the local server.'
                       % (MAX_DURATION_SEC // 60)), 413

    # One analysis at a time. A new upload supersedes a different running one
    # (the UI only ever shows the latest); the same recording waits for the
    # running job and then reuses its cached separation.
    for other in active_jobs():
        if other.key != key:
            print('[swarlekh] superseding job %s with a new upload' % other.id, flush=True)
            other.cancel()

    job = Job(job_id, key, duration)
    with _state_lock:
        _active[job.id] = job
    try:
        _job_lock.acquire()
    except BaseException:
        with _state_lock:
            _active.pop(job.id, None)
        raise
    try:
        if job.cancel_event.is_set():
            return jsonify(error='Cancelled.', cancelled=True), 409
        with _state_lock:
            _current = job
        job.started = job.stage_started = time.time()   # time spent queued doesn't count
        try:
            job.set('decoding', 0.5)
            x = torch.tensor(audio.T)                          # [ch, n]
            del audio
            if x.shape[0] == 1:
                x = x.repeat(2, 1)                             # mono -> stereo for separation
            elif x.shape[0] > 2:
                x = x[:2]
            if in_sr != DEMUCS_SR:
                x = torchaudio.functional.resample(x, in_sr, DEMUCS_SR)
            result = run_analysis(job, x)
            return jsonify(result)
        except Cancelled:
            print('[swarlekh] job %s cancelled after %.1fs' % (job.id, time.time() - job.started), flush=True)
            return jsonify(error='Cancelled.', cancelled=True), 409
        except AnalysisError as error:
            return jsonify(error=str(error)), error.status
        except Exception as error:
            print('[swarlekh] analysis failed: %r' % (error,), flush=True)
            return jsonify(error='The local analysis failed: %s' % error), 500
        finally:
            gc.collect()
    finally:
        job.done.set()
        with _state_lock:
            if _current is job:
                _current = None
            _active.pop(job.id, None)
        _job_lock.release()


if __name__ == '__main__':
    print('[swarlekh] ready (models load on first request). POST audio to http://127.0.0.1:%d/analyze' % PORT,
          flush=True)
    # Threaded so /status and /cancel answer while an analysis runs; heavy work
    # itself is serialised by _job_lock.
    app.run(host='127.0.0.1', port=PORT, threaded=True)
