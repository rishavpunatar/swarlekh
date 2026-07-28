# SwarLekh local neural analysis server

This optional helper runs on **your own machine** and gives the best pitch
accuracy by isolating the **vocal stem** with BS-RoFormer (when installed), with
[Demucs](https://github.com/facebookresearch/demucs) as the automatic fallback.
It analyzes the clean voice with three independent singing systems:

- **RMVPE** supplies robust frame-level pitch and preserves the singer's octave.
- **Praat cross-correlation** confirms borderline voiced frames.
- **GAME** predicts discrete sung-note boundaries and continuous note pitches,
  including short murkis and repeated notes at the same pitch.

**Privacy:** audio is sent only to `127.0.0.1` (this computer). Nothing leaves
your machine — same on‑device guarantee as the rest of the app.

## One‑time setup

Requires [Homebrew](https://brew.sh). From the repo root:

```sh
brew install uv rubberband libsndfile
uv venv server/.venv --python 3.12
uv pip install --python server/.venv/bin/python \
  demucs torch torchaudio torchcrepe \
  flask flask-cors soundfile numpy librosa \
  praat-parselmouth pyworld pyrubberband
uv pip install --python server/.venv/bin/python \
  -r server/requirements-neural.txt
server/install-models.sh
```

The model installer downloads checksum-verified RMVPE and GAME ONNX weights.
GAME is MIT-licensed; RMVPE and its ONNX runtime wrapper are Apache-2.0 and
MIT-licensed respectively. The first analysis also downloads the Demucs model. If
`server/.venv-sep/bin/audio-separator` is present, the server automatically uses
its higher-quality BS-RoFormer vocal model; otherwise it uses Demucs.

## Run it

```sh
server/.venv/bin/python server/server.py
```

You'll see `ready. POST audio to http://127.0.0.1:8765/analyze`. Leave it
running, then in the web app set **Settings → Pitch engine → "Best (local
server)"** and upload as usual.

- Neural model weights are installed once and all inference stays local.
- Separation is the slow stage. On a 33-second vocal excerpt, RMVPE plus GAME
  adds roughly 3-8 seconds after model warm-up on Apple silicon.
- Works from both the local preview and the public site
  (https://rishavpunatar.github.io/swarlekh) — browsers allow a page to reach
  `http://localhost`. Use **Chrome/Edge/Firefox** (Safari blocks https→http to
  localhost).

Stop it with Ctrl‑C. If you change `server.py`, restart it.

## Tests

```sh
server/.venv/bin/python -m unittest discover -s server -p 'test_*.py'
npm test
```

## Keep it running automatically (login service)

So you never have to start it by hand, install it as a macOS LaunchAgent — it
starts at login and restarts itself if it ever stops:

```sh
cp server/com.swarlekh.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.swarlekh.server.plist
```

The model loads lazily (only when the first request arrives), so it idles light.
Logs go to `server/server.log`.

To stop / uninstall it:

```sh
launchctl unload ~/Library/LaunchAgents/com.swarlekh.server.plist
rm ~/Library/LaunchAgents/com.swarlekh.server.plist
```

(The plist uses absolute paths for this machine — edit them if your checkout
lives elsewhere.)
