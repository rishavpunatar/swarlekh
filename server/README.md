# SwarLekh local analysis server (highest quality)

This optional helper runs on **your own machine** and gives the best pitch
accuracy by isolating the **vocal stem** with [Demucs](https://github.com/facebookresearch/demucs)
before tracking pitch with the full **CREPE** model. Separating the voice from
the harmonium/tabla is what removes the octave confusion on busy live
recordings.

**Privacy:** audio is sent only to `127.0.0.1` (this computer). Nothing leaves
your machine — same on‑device guarantee as the rest of the app.

## One‑time setup

Requires [Homebrew](https://brew.sh). From the repo root:

```sh
brew install uv
uv venv server/.venv --python 3.12
uv pip install --python server/.venv/bin/python demucs torchcrepe flask flask-cors soundfile numpy
```

(~1.5 GB of packages; the Demucs + CREPE model weights, ~160 MB, download on
the first analysis.)

## Run it

```sh
server/.venv/bin/python server/server.py
```

You'll see `ready. POST audio to http://127.0.0.1:8765/analyze`. Leave it
running, then in the web app set **Settings → Pitch engine → "Best (local
server)"** and upload as usual.

- First call downloads the models (one time).
- Analysis is CPU‑bound: roughly **real‑time** (a 7‑minute song ≈ 5 minutes).
  It's slow but it's the highest quality; the tab shows "Separating voice on
  local server…".
- Works from both the local preview and the public site
  (https://rishavpunatar.github.io/swarlekh) — browsers allow a page to reach
  `http://localhost`. Use **Chrome/Edge/Firefox** (Safari blocks https→http to
  localhost).

Stop it with Ctrl‑C. If you change `server.py`, restart it.

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
