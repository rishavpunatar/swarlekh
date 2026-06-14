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
import io, os, time
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


def separate_vocals(mix_44k_stereo):
    """mix: torch [2, n] @44.1k -> vocal stem torch [2, n] @44.1k."""
    with torch.no_grad():
        src = apply_model(_demucs, mix_44k_stereo[None], device=DEVICE,
                          split=True, overlap=0.1, progress=True)[0]
    return src[_voc_idx]


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

    f0, pd = torchcrepe.predict(voc16, SR, hop_length=HOP, fmin=50, fmax=1100,
                                model='full', decoder=torchcrepe.decode.viterbi,
                                return_periodicity=True, batch_size=512, device=DEVICE)
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
