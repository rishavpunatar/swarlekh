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
import io, os, gc, time
import numpy as np
import soundfile as sf
import torch, torchaudio, torchcrepe
from flask import Flask, request, jsonify
from flask_cors import CORS
from demucs.pretrained import get_model
from demucs.apply import apply_model

PORT = 8765
HOP = 256            # 16 ms at 16 kHz — matches the in-browser pipeline
SR = 16000
DEMUCS_SR = 44100

# CPU, deliberately: Apple's MPS backend is far SLOWER than CPU for Demucs's
# transformer here (measured ~10x), so CPU (multi-threaded) is the fast path.
torch.set_num_threads(os.cpu_count() or 4)
DEVICE = 'cpu'
print(f'[swarlekh] loading Demucs (htdemucs) … device={DEVICE}')
_demucs = get_model('htdemucs'); _demucs.eval()
_voc_idx = _demucs.sources.index('vocals')
print('[swarlekh] ready. POST audio to  http://127.0.0.1:%d/analyze' % PORT)

app = Flask(__name__)
CORS(app)   # allow the GitHub-Pages page (and localhost) to call this


CHUNK = int(30 * DEMUCS_SR)      # separate ~30 s at a time …
OVERLAP = int(1.0 * DEMUCS_SR)   # … with a 1 s crossfade at the joins


def separate_vocals(mix):
    """mix: torch [2, n] @44.1k -> vocal stem [2, n], separated in CHUNKS so
    peak memory stays ~one window's worth (not the whole song's 4 stems, which
    OOMs 8 GB machines). Overlap-add with a triangular crossfade hides seams."""
    n = mix.shape[1]
    voc = torch.zeros(2, n)
    wsum = torch.zeros(n)
    pos, idx = 0, 0
    nchunks = max(1, (n + CHUNK - 1) // CHUNK)
    while pos < n:
        a = max(0, pos - OVERLAP)
        b = min(n, pos + CHUNK)
        idx += 1
        print('[swarlekh] separating chunk %d/%d …' % (idx, nchunks), flush=True)
        with torch.no_grad():
            src = apply_model(_demucs, mix[:, a:b][None], device=DEVICE,
                              split=True, overlap=0.1, progress=False)[0]
        v = src[_voc_idx]                 # [2, b-a]
        L = b - a
        w = torch.ones(L)
        if a > 0: w[:OVERLAP] = torch.linspace(0, 1, OVERLAP)        # fade in over the join
        if b < n: w[-OVERLAP:] = torch.linspace(1, 0, OVERLAP)       # fade out into the next
        voc[:, a:b] += v * w
        wsum[a:b] += w
        del src, v
        gc.collect()
        pos = b
    return voc / wsum.clamp(min=1e-6)


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
    voc = separate_vocals(x)                           # [2, n] @44.1k
    voc16 = torchaudio.functional.resample(voc.mean(0, keepdim=True), DEMUCS_SR, SR)  # [1, n] @16k
    t_sep = time.time() - t0
    print('[swarlekh] separation done in %.1fs — tracking pitch on the clean voice…' % t_sep, flush=True)

    # 'tiny' model + weighted_argmax: on the CLEAN separated voice the separation
    # has already done the hard part, so tiny CREPE is just as octave-accurate as
    # full but ~10x faster — full CREPE on CPU is minutes/song. Viterbi is also
    # dropped (O(frames x 360^2), far too slow); the client smooths what's left.
    f0, pd = torchcrepe.predict(voc16, SR, hop_length=HOP, fmin=50, fmax=1100,
                                model='tiny', decoder=torchcrepe.decode.weighted_argmax,
                                return_periodicity=True, batch_size=512, device=DEVICE)
    f0 = torchcrepe.filter.median(f0, 3)               # cheap jitter/glitch smoothing
    f0 = f0[0].cpu().numpy(); pd = pd[0].cpu().numpy()
    # silence the obviously-unvoiced frames so the client gates cleanly
    f0 = np.where(pd > 0.01, f0, 0.0)
    print('[swarlekh] %.1fs sep + %.1fs total · %d frames' % (t_sep, time.time() - t0, len(f0)))
    return jsonify(f0=[round(float(v), 2) for v in f0],
                   periodicity=[round(float(v), 3) for v in pd],
                   hopSec=HOP / SR, sr=SR)


if __name__ == '__main__':
    # threaded=False: one heavy job at a time (keeps 8 GB RAM sane)
    app.run(host='127.0.0.1', port=PORT, threaded=False)
