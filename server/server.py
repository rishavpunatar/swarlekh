#!/usr/bin/env python3
"""
SwarLekh local analysis server — highest-quality pitch track, on YOUR machine.

Pipeline: Demucs (htdemucs) isolates the VOCAL stem from the mix, then CREPE
(full model, Viterbi decoding) tracks pitch on the clean voice. Separating the
voice first is what removes the harmonium/tabla confusion that makes octaves
flip — the single biggest quality lever.

Privacy: this runs entirely on localhost. The browser sends the decoded audio
to 127.0.0.1 only; nothing leaves your machine. Start it, then in the web app
pick Pitch engine → "Best (local server)".

Run:  server/.venv/bin/python server/server.py
"""
import io, os, gc, time, hashlib
import numpy as np
import soundfile as sf
import torch, torchaudio, torchcrepe
import pyworld as pw
import librosa
import pyrubberband
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# Ensure the Rubber Band CLI (Homebrew) is on PATH even under launchd, whose
# LaunchAgents start with a minimal PATH that excludes /opt/homebrew/bin.
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ.get('PATH', '')
from demucs.pretrained import get_model
from demucs.apply import apply_model

PORT = 8765
HOP = 256            # 16 ms at 16 kHz — matches the in-browser pipeline
SR = 16000
DEMUCS_SR = 44100
ANALYSIS_STRETCH = 3.0   # slow the voice this much before CREPE so fast murki/sargam
                         # notes (often <~64 ms, CREPE's window) resolve as distinct notes.
                         # Measured sweet spot: 3x captures ~60ms notes fully and recovers
                         # most ~40ms ones; 4x starts degrading (stretch artifacts confuse CREPE).

# CPU, deliberately: Apple's MPS backend is far SLOWER than CPU for Demucs's
# transformer here (measured ~10x), so CPU (multi-threaded) is the fast path.
torch.set_num_threads(os.cpu_count() or 4)
DEVICE = 'cpu'
# Lazy-load Demucs on first use (not at startup) so the always-on login service
# idles light — the ~1 GB model is only paged in when a separation actually runs.
_demucs = None
_voc_idx = None
def get_demucs():
    global _demucs, _voc_idx
    if _demucs is None:
        print('[swarlekh] loading Demucs (htdemucs) … device=%s' % DEVICE, flush=True)
        _demucs = get_model('htdemucs'); _demucs.eval()
        _voc_idx = _demucs.sources.index('vocals')
    return _demucs, _voc_idx
print('[swarlekh] ready (model loads on first request). POST audio to http://127.0.0.1:%d/analyze' % PORT)

app = Flask(__name__)
CORS(app)   # allow the GitHub-Pages page (and localhost) to call this


CHUNK = int(30 * DEMUCS_SR)      # separate ~30 s at a time …
OVERLAP = int(1.0 * DEMUCS_SR)   # … with a 1 s crossfade at the joins


def separate_stems(mix):
    """mix: torch [2, n] @44.1k -> (vocals, drums) each [2, n], separated in CHUNKS
    so peak memory stays ~one window's worth (not the whole song's 4 stems, which
    OOMs 8 GB machines). The pitched accompaniment (bass+other) is recovered by the
    caller as mix - vocals - drums. Overlap-add crossfade hides the seams."""
    model, voc_idx = get_demucs()
    drum_idx = model.sources.index('drums')
    n = mix.shape[1]
    voc = torch.zeros(2, n)
    drm = torch.zeros(2, n)
    wsum = torch.zeros(n)
    pos, idx = 0, 0
    nchunks = max(1, (n + CHUNK - 1) // CHUNK)
    while pos < n:
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
        drm[:, a:b] += src[drum_idx] * w
        wsum[a:b] += w
        del src
        gc.collect()
        pos = b
    wsum = wsum.clamp(min=1e-6)
    return voc / wsum, drm / wsum


# Cache the most recently separated stems so /transpose can reuse the separation
# /analyze just did (the "Best" engine separates the same bytes first). Keyed by a
# hash of the posted audio; the client sends identical WAV to both endpoints, so
# the normal analyze->transpose flow is a cache hit and skips the slow Demucs.
_stem_cache = {'key': None, 'voc44': None, 'drm44': None}


def separated_stems_44k(raw, x):
    """(vocal, drums) mono [1, n] @44.1k, reusing the cached separation when the
    posted audio matches the last separated (skips the ~minutes-long Demucs pass)."""
    key = hashlib.md5(raw).hexdigest()
    if _stem_cache['key'] == key and _stem_cache['voc44'] is not None:
        print('[swarlekh] reusing cached separation (skipping Demucs)', flush=True)
        return _stem_cache['voc44'], _stem_cache['drm44']
    voc, drm = separate_stems(x)
    voc = voc.mean(0, keepdim=True); drm = drm.mean(0, keepdim=True)   # [1, n] @44.1k
    _stem_cache.update(key=key, voc44=voc, drm44=drm)
    return voc, drm


@app.get('/')
def health():
    return jsonify(ok=True, device=DEVICE, hopSec=HOP / SR, sr=SR)


@app.post('/analyze')
def analyze():
    t0 = time.time()
    raw = request.get_data()
    audio, in_sr = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)  # [n, ch]
    x = torch.tensor(audio.T)                          # [ch, n]
    if x.shape[0] == 1:
        x = x.repeat(2, 1)                             # mono -> stereo for Demucs
    if in_sr != DEMUCS_SR:
        x = torchaudio.functional.resample(x, in_sr, DEMUCS_SR)
    voc, _ = separated_stems_44k(raw, x)               # [1, n] @44.1k (cached for /transpose)
    voc16 = torchaudio.functional.resample(voc, DEMUCS_SR, SR)[0].cpu().numpy().astype(np.float32)  # [n] @16k
    t_sep = time.time() - t0
    print('[swarlekh] separation done in %.1fs — slowing %gx + tracking pitch on the clean voice…'
          % (t_sep, ANALYSIS_STRETCH), flush=True)

    # Slow the voice down BEFORE pitch tracking: a fast murki/sargam note can be
    # shorter than CREPE's ~64 ms analysis window, so two notes blur into one and
    # the note is missed. Stretching the voice ~2x pushes each note past the window
    # so it resolves cleanly; we then report f0 at the matching finer hop, which
    # maps straight back onto the original timing.
    voc16s = pyrubberband.time_stretch(voc16, SR, 1.0 / ANALYSIS_STRETCH)   # rate<1 = slower / longer
    hop_sec = (HOP / SR) / ANALYSIS_STRETCH                                  # finer effective hop on the original timeline

    # 'tiny' model + weighted_argmax: on the CLEAN separated voice the separation
    # has already done the hard part, so tiny CREPE is octave-accurate and fast.
    f0, pd = torchcrepe.predict(torch.tensor(voc16s)[None], SR, hop_length=HOP, fmin=50, fmax=1100,
                                model='tiny', decoder=torchcrepe.decode.weighted_argmax,
                                return_periodicity=True, batch_size=512, device=DEVICE)
    f0 = torchcrepe.filter.median(f0, 3)               # cheap jitter/glitch smoothing
    f0 = f0[0].cpu().numpy(); pd = pd[0].cpu().numpy()

    # VOCAL-ENERGY GATE on the SAME (slowed) timeline: separation isn't perfect —
    # instrumental-only stretches leave a faint residual that would read as spurious
    # notes; silence frames well below the singing level so only sung notes survive.
    n_frames = len(f0)
    rms = np.zeros(n_frames, dtype='float32')
    for i in range(n_frames):
        s = i * HOP
        rms[i] = float(np.sqrt(np.mean(voc16s[s:s + 1024] ** 2))) if s + 1024 <= len(voc16s) else 0.0
    loud = np.percentile(rms[rms > 0], 90) if np.any(rms > 0) else 0.0
    thresh = max(0.08 * loud, 1e-4)                    # ~residual is far quieter than singing
    keep = (pd > 0.01) & (rms > thresh)
    f0 = np.where(keep, f0, 0.0)
    print('[swarlekh] %.1fs sep + %.1fs total · %d frames @ %.0fms hop · %d voiced'
          % (t_sep, time.time() - t0, n_frames, hop_sec * 1000, int(keep.sum())), flush=True)
    return jsonify(f0=[round(float(x), 2) for x in f0],
                   periodicity=[round(float(x), 3) for x in pd],
                   rms=[round(float(x), 5) for x in rms],
                   hopSec=hop_sec, sr=SR)


WORLD_SR = 24000     # WORLD runs here: plenty for voice, ~2x faster than 44.1k


def world_pitch_shift(mono, sr, semitones, f0=None, t=None):
    """Shift ONLY pitch, keeping the spectral envelope (formants) fixed — so the
    voice changes key but still sounds like the same person, not chipmunk/zombie.
    WORLD decomposes into f0 + spectral envelope + aperiodicity; we scale f0 and
    resynthesize with the ORIGINAL envelope. Pass a CREPE f0 (smooth + octave-
    accurate) via f0/t; otherwise harvest is the fallback. mono float32 @sr."""
    x = mono.astype(np.float64)
    if f0 is None:
        f0, t = pw.harvest(x, sr, f0_floor=55.0, f0_ceil=1100.0)
    # Low f0_floor → longer FFT → smoother envelope on deep low notes. cheaptrick
    # and d4c MUST share fft_size or synthesize() rejects the spec/ap dim mismatch.
    fft_size = pw.get_cheaptrick_fft_size(sr, 40.0)
    sp = pw.cheaptrick(x, f0, t, sr, f0_floor=40.0, fft_size=fft_size)
    ap = pw.d4c(x, f0, t, sr, fft_size=fft_size)   # aperiodicity (breath/voicing)
    y = pw.synthesize(f0 * (2.0 ** (semitones / 12.0)), sp, ap, sr)
    # Match the input loudness (no peak-normalize — the music is mixed in after).
    ry = float(np.sqrt(np.mean(y * y))) or 1.0
    rx = float(np.sqrt(np.mean(x * x)))
    return (y * (rx / ry)).astype(np.float32)


@app.post('/transpose')
def transpose():
    """Transpose to a new key: the singer with WORLD (formant-preserving) driven by
    a smooth, octave-accurate CREPE f0 — clean, in-tune pitch; the tabla/drums
    (pitched — tuned to Sa) with a transient-crisp Rubber Band shift; the
    harmonium/rest with a smooth Rubber Band shift. Remixed. ?semitones=-7."""
    semis = float(request.args.get('semitones', -7))
    t0 = time.time()
    raw = request.get_data()
    audio, in_sr = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    x = torch.tensor(audio.T)
    if x.shape[0] == 1:
        x = x.repeat(2, 1)
    if in_sr != DEMUCS_SR:
        x = torchaudio.functional.resample(x, in_sr, DEMUCS_SR)
    voc, drm = separated_stems_44k(raw, x)             # [1, n] each @44.1k (reuses /analyze's separation)
    rest = x.mean(0, keepdim=True) - voc - drm         # pitched accompaniment (bass + harmonium…)
    print('[swarlekh] separated in %.1fs — CREPE f0 → WORLD voice + shift music %.1f st…'
          % (time.time() - t0, semis), flush=True)

    # Voice = WORLD driven by a CREPE f0. This is the version with the CLEAN, in-tune
    # pitch the user preferred (the voice is resynthesized from the tracked melody);
    # Rubber Band on the raw voice lost that definition. (High/low octaves can still
    # go a touch robotic — a WORLD formant-undersampling limit at f0 extremes.)
    voc16 = torchaudio.functional.resample(voc, DEMUCS_SR, SR)            # [1, n] @16k
    f0c, pdc = torchcrepe.predict(voc16, SR, hop_length=HOP, fmin=50, fmax=1100,
                                  model='tiny', decoder=torchcrepe.decode.weighted_argmax,
                                  return_periodicity=True, batch_size=512, device=DEVICE)
    f0c = torchcrepe.filter.median(f0c, 3)[0].cpu().numpy()
    pdc = pdc[0].cpu().numpy()
    crepe_t = np.arange(len(f0c)) * (HOP / SR)
    voc_w = torchaudio.functional.resample(voc, DEMUCS_SR, WORLD_SR)[0].cpu().numpy()
    _f0, tw = pw.dio(voc_w.astype(np.float64), WORLD_SR)                  # just for WORLD's frame times
    vmask = f0c > 0
    if int(vmask.sum()) > 1:
        f0_use = np.interp(tw, crepe_t[vmask], f0c[vmask])               # smooth over voiced frames
        f0_use = np.where(np.interp(tw, crepe_t, pdc) > 0.25, f0_use, 0.0)  # unvoiced -> 0
    else:
        f0_use = _f0
    y_voc = world_pitch_shift(voc_w, WORLD_SR, semis, f0=f0_use, t=tw)

    # Music: the tabla (drums) IS pitched — tuned to Sa — so it must shift in key,
    # but as percussion it needs a transient-preserving shift (Rubber Band, crisp)
    # to stay crisp not smeared; the harmonium/rest gets a normal Rubber Band shift.
    drm_w = torchaudio.functional.resample(drm, DEMUCS_SR, WORLD_SR)[0].cpu().numpy().astype(np.float32)
    rest_w = torchaudio.functional.resample(rest, DEMUCS_SR, WORLD_SR)[0].cpu().numpy().astype(np.float32)
    y_drm = pyrubberband.pitch_shift(drm_w, WORLD_SR, semis, rbargs={'-c': '6'})   # crisp transients (percussion)
    y_rest = pyrubberband.pitch_shift(rest_w, WORLD_SR, semis)                     # smooth (harmonium etc.)

    L = min(len(y_voc), len(y_drm), len(y_rest))
    out = y_voc[:L] + y_drm[:L] + y_rest[:L]           # remix in the new key
    pk = float(np.max(np.abs(out))) or 1.0
    out = (out / pk * 0.95).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, out, WORLD_SR, format='WAV', subtype='PCM_16')
    buf.seek(0)
    print('[swarlekh] /transpose done in %.1fs (%.1f st, %d samples)'
          % (time.time() - t0, semis, len(out)), flush=True)
    return Response(buf.read(), mimetype='audio/wav')


if __name__ == '__main__':
    # threaded=False: one heavy job at a time (keeps 8 GB RAM sane)
    app.run(host='127.0.0.1', port=PORT, threaded=False)
