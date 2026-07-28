import sys
import types
import unittest
from unittest.mock import patch

import numpy as np

from singing_models import (
    GameTranscriber,
    RobustPitchTracker,
    fuse_rmvpe_with_praat,
)


class PitchFusionTests(unittest.TestCase):
    def test_rmvpe_defaults_to_stable_cpu_provider(self):
        calls = {}

        class FakeRMVPE:
            def __init__(self, model_path=None, device=None):
                calls["model_path"] = model_path
                calls["device"] = device

        fake_module = types.SimpleNamespace(RMVPE=FakeRMVPE)
        with patch.dict(sys.modules, {"rmvpe_onnx": fake_module}):
            RobustPitchTracker(model_path="/tmp/rmvpe.onnx")

        self.assertEqual(calls["model_path"], "/tmp/rmvpe.onnx")
        self.assertEqual(calls["device"], "cpu")

    def test_rmvpe_chunks_long_audio_and_joins_global_times(self):
        lengths = []

        class FakeRMVPE:
            def predict(self, audio, sr):
                lengths.append(len(audio))
                times = np.arange(0.0, len(audio) / sr, 1.0)
                frequency = np.full(len(times), 220.0)
                confidence = np.full(len(times), 0.8)
                return times, frequency, confidence, None

        tracker = RobustPitchTracker.__new__(RobustPitchTracker)
        tracker.model = FakeRMVPE()
        tracker.chunk_seconds = 30.0
        tracker.context_seconds = 1.0
        result = tracker.predict(
            np.zeros(65 * 100, dtype=np.float32),
            100,
            np.full(66, 220.0),
            np.ones(66),
            1.0,
        )

        self.assertEqual(len(lengths), 3)
        self.assertLessEqual(max(lengths), 32 * 100)
        np.testing.assert_allclose(result["times"], np.arange(65))
        self.assertAlmostEqual(result["hopSec"], 1.0)

    def test_high_confidence_frames_do_not_need_praat(self):
        f0, confidence = fuse_rmvpe_with_praat(
            [0.0],
            [220.0],
            [0.8],
            [0.0],
            [0.0],
            0.004,
        )
        self.assertEqual(f0.tolist(), [220.0])
        self.assertGreaterEqual(confidence[0], 0.5)

    def test_praat_confirms_only_borderline_frames(self):
        f0, confidence = fuse_rmvpe_with_praat(
            [0.0, 0.01, 0.02],
            [220.0, 221.0, 222.0],
            [0.3, 0.3, 0.1],
            [220.0, 220.0, 220.0, 220.0, 220.0, 220.0],
            [0.7, 0.7, 0.1, 0.1, 0.1, 0.1],
            0.004,
        )
        np.testing.assert_array_equal(f0, [220.0, 0.0, 0.0])
        self.assertGreaterEqual(confidence[0], 0.5)
        self.assertEqual(confidence[1], 0.0)
        self.assertEqual(confidence[2], 0.0)


class GameChunkingTests(unittest.TestCase):
    def test_game_chunks_long_audio_and_offsets_regions(self):
        lengths = []
        transcriber = GameTranscriber.__new__(GameTranscriber)
        transcriber.sample_rate = 100
        transcriber.chunk_seconds = 30.0
        transcriber.context_seconds = 2.0

        def fake_transcribe(waveform):
            lengths.append(len(waveform))
            return [{
                "onset": 2.0,
                "offset": 3.0,
                "midi": 60.0,
                "frequency": 261.625565,
            }]

        transcriber._transcribe_waveform = fake_transcribe
        notes = transcriber.transcribe(
            np.zeros(65 * 100, dtype=np.float32),
            100,
        )

        self.assertEqual(len(lengths), 3)
        self.assertLessEqual(max(lengths), 34 * 100)
        self.assertEqual(
            [(note["onset"], note["offset"]) for note in notes],
            [(2.0, 3.0), (30.0, 31.0), (60.0, 61.0)],
        )


if __name__ == "__main__":
    unittest.main()
