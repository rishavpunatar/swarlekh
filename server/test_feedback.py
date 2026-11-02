import json
import tempfile
import unittest
from pathlib import Path
from feedback import save_feedback


def example():
    note = dict(t0=0, t1=.5, k=0)
    return dict(purpose='expert-correction', reviewed=True, file=dict(sha256='a'*64, duration=2),
                saHz=220, notes=[note], corrections=[], analysis=dict(f0=[220], hopSec=.01),
                baseline=dict(saHz=220, notes=[dict(note, k=2)]))


class FeedbackTests(unittest.TestCase):
    def test_revisions_are_durable_and_retries_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            payload = example()
            identifier = save_feedback(payload, td)
            payload['exportedAt'] = 'later'
            self.assertEqual(save_feedback(payload, td), identifier)
            saved = json.loads((Path(td) / (identifier+'.json')).read_text())
            self.assertEqual(saved['baseline']['notes'][0]['k'], 2)
            self.assertEqual(saved['notes'][0]['k'], 0)
            payload['notes'][0]['k'] = 4
            self.assertNotEqual(save_feedback(payload, td), identifier)
            self.assertEqual(len(list(Path(td).glob('*.json'))), 2)

    def test_invalid_examples_do_not_create_records(self):
        for key, value in [('reviewed', False), ('baseline', None), ('notes', [dict(t0=0,t1=3,k=0)])]:
            with tempfile.TemporaryDirectory() as td:
                payload = example(); payload[key] = value
                with self.assertRaises(ValueError): save_feedback(payload, td)
                self.assertEqual(list(Path(td).iterdir()), [])


if __name__ == '__main__': unittest.main()
