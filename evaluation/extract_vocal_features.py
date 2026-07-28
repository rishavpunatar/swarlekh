#!/usr/bin/env python3
"""Extract the same isolated-vocal features used by SwarLekh's local server."""

import argparse
import json

import librosa
import numpy as np
import parselmouth
import soundfile as sf


SAMPLE_RATE = 16000
HOP_SEC = 0.004


def extract(audio_path):
    audio, input_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    vocal = audio.mean(axis=1)
    if input_rate != SAMPLE_RATE:
        vocal = librosa.resample(
            vocal, orig_sr=input_rate, target_sr=SAMPLE_RATE
        )
    vocal = vocal.astype(np.float64)

    sound = parselmouth.Sound(vocal, sampling_frequency=SAMPLE_RATE)
    quick = sound.to_pitch_cc(
        time_step=0.01, pitch_floor=75.0, pitch_ceiling=1200.0
    )
    quick_f0 = quick.selected_array["frequency"]
    quick_f0 = quick_f0[quick_f0 > 0]
    floor = (
        float(np.clip(0.8 * np.percentile(quick_f0, 5), 75.0, 200.0))
        if quick_f0.size
        else 120.0
    )

    pitch = sound.to_pitch_cc(
        time_step=HOP_SEC,
        pitch_floor=floor,
        pitch_ceiling=1200.0,
        very_accurate=True,
    )
    f0 = np.nan_to_num(pitch.selected_array["frequency"])
    strength = np.nan_to_num(pitch.selected_array["strength"])
    periodicity = np.where(f0 > 0, np.clip(strength, 0.0, 1.0), 0.0)

    hop_samples = int(round(HOP_SEC * SAMPLE_RATE))
    rms = np.zeros(len(f0), dtype=np.float32)
    for index in range(len(f0)):
        start = index * hop_samples
        frame = vocal[start : start + 1024]
        if len(frame) == 1024:
            rms[index] = float(np.sqrt(np.mean(frame * frame)))
    loud = np.percentile(rms[rms > 0], 90) if np.any(rms > 0) else 0.0
    energy_threshold = max(0.08 * loud, 1e-4)
    keep = (periodicity > 0.01) & (rms > energy_threshold)
    f0 = np.where(keep, f0, 0.0)

    onsets = librosa.onset.onset_detect(
        y=vocal.astype(np.float32),
        sr=SAMPLE_RATE,
        hop_length=160,
        units="time",
        backtrack=True,
    )

    return {
        "f0": [round(float(value), 2) for value in f0],
        "clarity": [round(float(value), 3) for value in periodicity],
        "rms": [round(float(value), 5) for value in rms],
        "onsets": [round(float(value), 3) for value in onsets],
        "hopSec": HOP_SEC,
        "praatFrameOffsetSec": round(float(pitch.x1), 6),
        "pitchFloorHz": round(floor, 2),
        "sampleRate": SAMPLE_RATE,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    args = parser.parse_args()
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(extract(args.audio), output, separators=(",", ":"))


if __name__ == "__main__":
    main()
