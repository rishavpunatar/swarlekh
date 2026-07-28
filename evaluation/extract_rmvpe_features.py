#!/usr/bin/env python3
"""Extract RMVPE F0 and confidence for a directory of Vocadito tracks."""

import argparse
import csv
import json
import pathlib

import soundfile as sf
from rmvpe_onnx import RMVPE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=pathlib.Path)
    parser.add_argument("output")
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    with open(args.dataset / "vocadito_metadata.csv", encoding="utf-8") as metadata_file:
        metadata = list(csv.DictReader(metadata_file))

    model = RMVPE(device=args.device)
    tracks = {}
    for index, track in enumerate(metadata):
        track_id = track["track_id"]
        print(f"\rRMVPE {index + 1}/{len(metadata)}", end="", flush=True)
        audio, sample_rate = sf.read(
            args.dataset / "Audio" / f"vocadito_{track_id}.wav",
            dtype="float32",
            always_2d=True,
        )
        audio = audio.mean(axis=1)
        times, frequency, confidence, _ = model.predict(audio=audio, sr=sample_rate)
        tracks[track_id] = {
            "hopSec": round(float(times[1] - times[0]), 8),
            "f0": [round(float(value), 3) for value in frequency],
            "confidence": [round(float(value), 6) for value in confidence],
        }
    print()
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(
            {
                "model": "RMVPE ONNX",
                "device": args.device or "auto",
                "tracks": tracks,
            },
            output,
            separators=(",", ":"),
        )


if __name__ == "__main__":
    main()
