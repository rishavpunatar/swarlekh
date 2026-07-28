import unittest

import numpy as np

from singing_models import fuse_rmvpe_with_praat


class PitchFusionTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
