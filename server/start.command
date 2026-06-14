#!/bin/bash
# Double-click this in Finder to start the SwarLekh local analysis server.
# (macOS opens it in Terminal and runs it. Close the window or Ctrl-C to stop.)
cd "$(dirname "$0")/.." || exit 1
echo "Starting SwarLekh local server — keep this window open while you use 'Best (local server)'."
echo "Stop it with Ctrl-C or by closing this window."
echo
exec server/.venv/bin/python server/server.py
