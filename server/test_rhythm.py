import unittest

import numpy as np

from rhythm import summarize_neural_rhythm


class RhythmReconciliationTests(unittest.TestCase):
    def test_half_tempo_pulse_and_eight_matra_cycle(self):
        fine = np.arange(0.0, 90.0, 0.42)
        model_beats = fine[::2] + 0.012
        downbeats = fine[::8] + 0.018
        # A false downbeat and a missed sam should not change the dominant cycle.
        downbeats = np.delete(downbeats, 7)
        downbeats = np.sort(np.append(downbeats, fine[43] + 0.01))

        result = summarize_neural_rhythm(
            fine,
            60.0 / 0.42,
            model_beats,
            downbeats,
        )

        self.assertAlmostEqual(result["bpm"], 71.4, places=1)
        self.assertAlmostEqual(result["matraBpm"], 142.9, places=1)
        self.assertEqual(result["pulseSubdivision"], 2)
        self.assertEqual(result["cycle"], 8)
        self.assertEqual(result["taal"], "Keherwa")
        self.assertEqual(result["alt"], "Bhajani theka")
        self.assertEqual(result["conf"], "likely")
        self.assertGreater(len(result["sam"]), 12)

    def test_six_matra_cycle_is_not_doubled(self):
        fine = np.arange(0.0, 50.0, 0.5)
        result = summarize_neural_rhythm(
            fine,
            120.0,
            fine + 0.01,
            fine[::6] + 0.02,
        )

        self.assertEqual(result["cycle"], 6)
        self.assertEqual(result["taal"], "Dadra")
        self.assertEqual(result["pulseSubdivision"], 1)

    def test_inconclusive_downbeats_keep_tempo_without_naming_taal(self):
        fine = np.arange(0.0, 40.0, 0.5)
        downbeats = fine[[0, 6, 13, 23, 35, 49, 64]]
        result = summarize_neural_rhythm(
            fine,
            120.0,
            fine + 0.01,
            downbeats,
        )

        self.assertIsNone(result["cycle"])
        self.assertIsNone(result["taal"])
        self.assertAlmostEqual(result["bpm"], 120.0)


if __name__ == "__main__":
    unittest.main()
