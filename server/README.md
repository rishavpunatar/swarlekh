# SwarLekh local analysis server

This optional helper runs on **your own machine** and powers the app's **Best** engine. It isolates the vocal stem, then analyses the clean voice with three independent singing systems:

- **BS-RoFormer** (via `audio-separator`) isolates the voice. [Demucs](https://github.com/facebookresearch/demucs) is the automatic fallback.
- **RMVPE** supplies robust frame-level pitch and keeps the singer's octave.
- **Praat cross-correlation** confirms borderline voiced frames.
- **GAME** predicts sung-note boundaries and pitches, including short murkis and repeated notes.
- **Beat This!** and librosa estimate the felt pulse, taal cycle and sam from the accompaniment.

Long recordings run in overlapping 30-second chunks, so memory stays bounded on an 8 GB Mac.

## Privacy and safety

- It listens on `127.0.0.1:8765` only. Audio never leaves your computer.
- Browser requests are accepted only from `https://rishavpunatar.github.io` and `http://localhost` / `http://127.0.0.1` pages. Any other website is refused before any work starts. Add more origins with `SWARLEKH_ALLOWED_ORIGINS=https://example.org` (comma-separated).
- Uploads are limited to 2 GB and 3 hours (`SWARLEKH_MAX_UPLOAD_MB`, `SWARLEKH_MAX_MINUTES`).
- One analysis runs at a time. A new upload of a different recording replaces a running one.
- Separated vocals are cached in `server/cache/stems/` as FLAC, capped at 2 GB with the least recently used removed first (`SWARLEKH_CACHE_DIR`, `SWARLEKH_CACHE_MB`). Delete the folder at any time.

## One-time setup

Requires [Homebrew](https://brew.sh). From the repo root:

```sh
brew install uv ffmpeg libsndfile

# Analysis server (Python 3.12, pinned versions)
uv venv server/.venv --python 3.12
uv pip install --python server/.venv/bin/python -r server/requirements.txt
server/install-models.sh

# Optional but recommended: BS-RoFormer vocal separator in its own venv
uv venv server/.venv-sep --python 3.12
uv pip install --python server/.venv-sep/bin/python -r server/requirements-separator.txt
```

`install-models.sh` downloads checksum-verified RMVPE and GAME ONNX weights. The BS-RoFormer model (about 640 MB) downloads into `server/models/audio-separator/` on first use. Beat This! downloads its 8 MB checkpoint and Demucs its weights on first use. GAME and Beat This! are MIT-licensed; RMVPE is Apache-2.0.

ffmpeg lets the server read M4A/AAC and other formats that libsndfile can't. If it's missing, the browser sends a WAV instead.

## Run it

```sh
server/.venv/bin/python server/server.py
```

You'll see `ready … POST audio to http://127.0.0.1:8765/analyze`. Then open the app, either the public site or a local copy, and upload. The app uses the server automatically when it is running. Chrome, Edge and Firefox allow the public HTTPS site to reach `localhost`; Safari blocks it, so use one of the others or run the site locally.

**Speed:** separation dominates, at roughly 2–3.5× real time on an M1 (a 7-minute song takes 15–25 minutes the first time). Re-analysing the same file reuses the cached vocals, and pitch, notes and rhythm then take well under a minute.

## API

| Request | Response |
|---|---|
| `GET /` | health: `analysisVersion`, `api`, `separator`, `neuralModelsInstalled`, `busy`, current `job` |
| `GET /status?job=ID` | `{ busy, job: { id, stage, progress, elapsed, eta, note }, waiting }` |
| `POST /analyze?job=ID` (body: audio file) | `f0`, `periodicity`, `rms`, `hopSec`, `noteRegions`, `onsets`, `rhythm`, `voicedFraction`, `separator`, `separationCached` |
| `POST /cancel?job=ID` | stops that analysis and kills the separator process; the analyze request returns `409 {cancelled: true}` |

Errors come back as JSON `{ error }` with HTTP 400 (bad input), 403 (origin refused), 409 (cancelled), 413 (too large or too long) or 415 (unreadable format).

## Keep it running automatically (login service)

So you never have to start it by hand, install it as a macOS LaunchAgent. It starts at login and restarts if it stops:

```sh
cp server/com.swarlekh.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.swarlekh.server.plist
```

The plist uses absolute paths for this machine; edit them if your checkout lives elsewhere. Models load lazily on the first request, so the idle service stays light. Logs go to `server/server.log`. After editing `server.py`, restart it:

```sh
launchctl kickstart -k gui/$(id -u)/com.swarlekh.server
```

To stop and uninstall:

```sh
launchctl unload ~/Library/LaunchAgents/com.swarlekh.server.plist
rm ~/Library/LaunchAgents/com.swarlekh.server.plist
```

## Tests

```sh
cd server && .venv/bin/python -m unittest discover -p 'test_*.py'
npm test   # from the repo root: browser DSP + app-level accuracy benchmark
```
