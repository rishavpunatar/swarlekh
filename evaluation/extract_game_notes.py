#!/usr/bin/env python3
"""Run an exported GAME singing-to-MIDI model with ONNX Runtime."""

import argparse
import json
import pathlib

import librosa
import numpy as np
import onnxruntime as ort


def session(model_dir, name):
    return ort.InferenceSession(
        str(model_dir / name),
        providers=["CPUExecutionProvider"],
    )


def extract(audio_path, model_dir, steps, boundary_threshold, presence_threshold, radius, seed):
    with open(model_dir / "config.json", encoding="utf-8") as config_file:
        config = json.load(config_file)
    sample_rate = int(config["samplerate"])
    waveform, _ = librosa.load(audio_path, sr=sample_rate, mono=True)
    waveform = waveform.astype(np.float32)[None, :]
    duration = np.array([waveform.shape[1] / sample_rate], dtype=np.float32)

    ort.set_seed(seed)
    encoder = session(model_dir, "encoder.onnx")
    segmenter = session(model_dir, "segmenter.onnx")
    boundaries_to_durations = session(model_dir, "bd2dur.onnx")
    estimator = session(model_dir, "estimator.onnx")

    x_seg, x_est, frame_mask = encoder.run(
        None,
        {"waveform": waveform, "duration": duration},
    )
    known_boundaries = np.zeros_like(frame_mask, dtype=bool)
    boundaries = known_boundaries.copy()
    threshold = np.array(boundary_threshold, dtype=np.float32)
    radius_value = np.array(radius, dtype=np.int64)
    language = np.array([0], dtype=np.int64)

    for step in range(steps):
        time_value = np.array([step / steps], dtype=np.float32)
        boundaries, = segmenter.run(
            None,
            {
                "x_seg": x_seg,
                "language": language,
                "known_boundaries": known_boundaries,
                "prev_boundaries": boundaries,
                "t": time_value,
                "maskT": frame_mask,
                "threshold": threshold,
                "radius": radius_value,
            },
        )

    durations, note_mask = boundaries_to_durations.run(
        None,
        {"boundaries": boundaries, "maskT": frame_mask},
    )
    presence, scores = estimator.run(
        None,
        {
            "x_est": x_est,
            "boundaries": boundaries,
            "maskT": frame_mask,
            "maskN": note_mask,
            "threshold": np.array(presence_threshold, dtype=np.float32),
        },
    )

    notes = []
    onset = 0.0
    for note_duration, is_present, midi_pitch in zip(
        durations[0], presence[0], scores[0]
    ):
        offset = onset + float(note_duration)
        if is_present and offset > onset:
            notes.append(
                {
                    "onset": round(onset, 6),
                    "offset": round(offset, 6),
                    "midi": round(float(midi_pitch), 6),
                }
            )
        onset = offset

    return {
        "model": model_dir.name,
        "sampleRate": sample_rate,
        "steps": steps,
        "boundaryThreshold": boundary_threshold,
        "presenceThreshold": presence_threshold,
        "radius": radius,
        "seed": seed,
        "notes": notes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("model_dir", type=pathlib.Path)
    parser.add_argument("output")
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--boundary-threshold", type=float, default=0.2)
    parser.add_argument("--presence-threshold", type=float, default=0.2)
    parser.add_argument("--radius", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260728)
    args = parser.parse_args()
    result = extract(
        args.audio,
        args.model_dir,
        args.steps,
        args.boundary_threshold,
        args.presence_threshold,
        args.radius,
        args.seed,
    )
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"))


if __name__ == "__main__":
    main()
