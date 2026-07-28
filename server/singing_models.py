#!/usr/bin/env python3
"""Local neural singing models used by the SwarLekh analysis server."""

import json
import pathlib

import numpy as np


RMVPE_LOW_CONFIDENCE = 0.2
RMVPE_HIGH_CONFIDENCE = 0.4
PRAAT_SUPPORT_THRESHOLD = 0.6


def fuse_rmvpe_with_praat(
    times,
    frequency,
    confidence,
    praat_frequency,
    praat_strength,
    praat_hop_sec,
    low_confidence=RMVPE_LOW_CONFIDENCE,
    high_confidence=RMVPE_HIGH_CONFIDENCE,
    praat_threshold=PRAAT_SUPPORT_THRESHOLD,
):
    """Keep certain RMVPE frames and require Praat support for borderline ones."""
    times = np.asarray(times, dtype=np.float64)
    frequency = np.asarray(frequency, dtype=np.float64)
    confidence = np.asarray(confidence, dtype=np.float64)
    praat_frequency = np.asarray(praat_frequency, dtype=np.float64)
    praat_strength = np.asarray(praat_strength, dtype=np.float64)

    if not (len(times) == len(frequency) == len(confidence)):
        raise ValueError("RMVPE arrays must have equal lengths")
    if len(praat_frequency) != len(praat_strength):
        raise ValueError("Praat arrays must have equal lengths")
    if len(praat_frequency) == 0:
        supported = np.zeros(len(times), dtype=bool)
    else:
        # Match JavaScript Math.round in the benchmark for exact half frames.
        support_index = np.floor(times / praat_hop_sec + 0.5).astype(np.int64)
        support_index = np.clip(support_index, 0, len(praat_frequency) - 1)
        supported = (
            (praat_frequency[support_index] > 0)
            & (praat_strength[support_index] >= praat_threshold)
        )

    keep = (confidence >= high_confidence) | (
        (confidence >= low_confidence) & supported
    )
    fused_frequency = np.where(keep, frequency, 0.0)

    # The browser's default threshold is 0.5. Map every accepted frame to
    # [0.5, 1] while preserving confidence ordering for its strictness slider.
    scale = max(1.0 - low_confidence, 1e-6)
    fused_confidence = np.where(
        keep,
        0.5 + 0.5 * np.clip((confidence - low_confidence) / scale, 0.0, 1.0),
        0.0,
    )
    return fused_frequency, fused_confidence


class RobustPitchTracker:
    """RMVPE pitch with independent Praat confirmation for uncertain frames."""

    def __init__(
        self,
        model_path=None,
        device=None,
        chunk_seconds=30.0,
        context_seconds=1.0,
    ):
        from rmvpe_onnx import RMVPE

        # Core ML can fail with "Error in building plan" after a successful
        # inference on the same model. CPU is deterministic and reliable here.
        self.model = RMVPE(model_path=model_path, device=device or "cpu")
        self.chunk_seconds = float(chunk_seconds)
        self.context_seconds = float(context_seconds)

    def predict(
        self,
        audio,
        sample_rate,
        praat_frequency,
        praat_strength,
        praat_hop_sec,
    ):
        waveform = np.asarray(audio, dtype=np.float32)
        if waveform.ndim > 1:
            waveform = waveform.mean(axis=0)
        waveform = waveform.reshape(-1)
        duration = len(waveform) / sample_rate
        times_parts = []
        frequency_parts = []
        confidence_parts = []

        for core_start in np.arange(0.0, duration, self.chunk_seconds):
            core_end = min(duration, core_start + self.chunk_seconds)
            input_start = max(0.0, core_start - self.context_seconds)
            input_end = min(duration, core_end + self.context_seconds)
            sample_start = int(round(input_start * sample_rate))
            sample_end = int(round(input_end * sample_rate))
            actual_start = sample_start / sample_rate
            local_times, frequency, confidence, _ = self.model.predict(
                audio=waveform[sample_start:sample_end],
                sr=sample_rate,
            )
            global_times = np.asarray(local_times, dtype=np.float64) + actual_start
            frequency = np.asarray(frequency, dtype=np.float64)
            confidence = np.asarray(confidence, dtype=np.float64)
            keep = global_times >= core_start - 1e-7
            if core_end < duration:
                keep &= global_times < core_end - 1e-7
            else:
                keep &= global_times <= core_end + 1e-7
            times_parts.append(global_times[keep])
            frequency_parts.append(frequency[keep])
            confidence_parts.append(confidence[keep])

        times = np.concatenate(times_parts) if times_parts else np.array([])
        frequency = (
            np.concatenate(frequency_parts) if frequency_parts else np.array([])
        )
        confidence = (
            np.concatenate(confidence_parts) if confidence_parts else np.array([])
        )
        fused_frequency, fused_confidence = fuse_rmvpe_with_praat(
            times,
            frequency,
            confidence,
            praat_frequency,
            praat_strength,
            praat_hop_sec,
        )
        hop_sec = (
            float(np.median(np.diff(times))) if len(times) > 1 else 0.01
        )
        return {
            "times": times,
            "f0": fused_frequency,
            "confidence": fused_confidence,
            "rawConfidence": confidence,
            "hopSec": hop_sec,
        }


class GameTranscriber:
    """Singing-specific note boundaries and pitches from GAME's ONNX export."""

    def __init__(
        self,
        model_dir,
        steps=2,
        boundary_threshold=0.2,
        presence_threshold=0.2,
        radius=2,
        seed=20260728,
        chunk_seconds=30.0,
        context_seconds=2.0,
    ):
        import onnxruntime as ort

        self.ort = ort
        self.model_dir = pathlib.Path(model_dir)
        with open(self.model_dir / "config.json", encoding="utf-8") as config_file:
            config = json.load(config_file)
        self.sample_rate = int(config["samplerate"])
        self.steps = steps
        self.boundary_threshold = boundary_threshold
        self.presence_threshold = presence_threshold
        self.radius = radius
        self.seed = seed
        self.chunk_seconds = float(chunk_seconds)
        self.context_seconds = float(context_seconds)

        # GAME's dynamic segmenter partitions poorly under Core ML (measured
        # at 105 s vs about 4 s on CPU for the same 33 s clip).
        providers = ["CPUExecutionProvider"]
        session_options = ort.SessionOptions()
        session_options.graph_optimization_level = (
            ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        )
        self.providers = providers
        self.session_options = session_options
        self.encoder = self._session("encoder.onnx", providers, session_options)
        self.boundaries_to_durations = self._session(
            "bd2dur.onnx", providers, session_options
        )
        self.estimator = self._session("estimator.onnx", providers, session_options)

    def _session(self, name, providers, session_options):
        return self.ort.InferenceSession(
            str(self.model_dir / name),
            sess_options=session_options,
            providers=providers,
        )

    def transcribe(self, audio, sample_rate):
        import librosa

        waveform = np.asarray(audio, dtype=np.float32)
        if waveform.ndim > 1:
            waveform = waveform.mean(axis=0)
        if sample_rate != self.sample_rate:
            waveform = librosa.resample(
                waveform,
                orig_sr=sample_rate,
                target_sr=self.sample_rate,
            )
        waveform = waveform.astype(np.float32).reshape(-1)
        audio_duration = len(waveform) / self.sample_rate
        notes = []

        for core_start in np.arange(0.0, audio_duration, self.chunk_seconds):
            core_end = min(audio_duration, core_start + self.chunk_seconds)
            input_start = max(0.0, core_start - self.context_seconds)
            input_end = min(
                audio_duration, core_end + self.context_seconds
            )
            sample_start = int(round(input_start * self.sample_rate))
            sample_end = int(round(input_end * self.sample_rate))
            actual_start = sample_start / self.sample_rate
            for note in self._transcribe_waveform(
                waveform[sample_start:sample_end]
            ):
                shifted = dict(note)
                shifted["onset"] = round(note["onset"] + actual_start, 6)
                shifted["offset"] = round(note["offset"] + actual_start, 6)
                midpoint = (shifted["onset"] + shifted["offset"]) / 2
                if midpoint < core_start - 1e-7:
                    continue
                if core_end < audio_duration and midpoint >= core_end - 1e-7:
                    continue
                if midpoint <= core_end + 1e-7:
                    notes.append(shifted)

        notes.sort(key=lambda note: (note["onset"], note["offset"]))
        return notes

    def _transcribe_waveform(self, waveform):
        waveform = np.asarray(waveform, dtype=np.float32).reshape(1, -1)
        audio_duration = waveform.shape[1] / self.sample_rate
        duration = np.array([audio_duration], dtype=np.float32)

        self.ort.set_seed(self.seed)
        # The segmenter contains ONNX random operators. A fresh lightweight
        # session after resetting the seed makes repeated analyses identical.
        segmenter = self._session(
            "segmenter.onnx", self.providers, self.session_options
        )
        x_segment, x_estimate, frame_mask = self.encoder.run(
            None,
            {"waveform": waveform, "duration": duration},
        )
        known_boundaries = np.zeros_like(frame_mask, dtype=bool)
        boundaries = known_boundaries.copy()
        language = np.array([0], dtype=np.int64)
        for step in range(self.steps):
            boundaries, = segmenter.run(
                None,
                {
                    "x_seg": x_segment,
                    "language": language,
                    "known_boundaries": known_boundaries,
                    "prev_boundaries": boundaries,
                    "t": np.array([step / self.steps], dtype=np.float32),
                    "maskT": frame_mask,
                    "threshold": np.array(
                        self.boundary_threshold, dtype=np.float32
                    ),
                    "radius": np.array(self.radius, dtype=np.int64),
                },
            )

        durations, note_mask = self.boundaries_to_durations.run(
            None,
            {"boundaries": boundaries, "maskT": frame_mask},
        )
        presence, scores = self.estimator.run(
            None,
            {
                "x_est": x_estimate,
                "boundaries": boundaries,
                "maskT": frame_mask,
                "maskN": note_mask,
                "threshold": np.array(
                    self.presence_threshold, dtype=np.float32
                ),
            },
        )

        notes = []
        onset = 0.0
        for note_duration, is_present, midi_pitch in zip(
            durations[0], presence[0], scores[0]
        ):
            offset = min(audio_duration, onset + float(note_duration))
            if is_present and offset > onset:
                midi = float(midi_pitch)
                notes.append(
                    {
                        "onset": round(onset, 6),
                        "offset": round(offset, 6),
                        "midi": round(midi, 6),
                        "frequency": round(
                            440.0 * 2.0 ** ((midi - 69.0) / 12.0), 6
                        ),
                    }
                )
            onset += float(note_duration)
            if onset >= audio_duration:
                break
        return notes
