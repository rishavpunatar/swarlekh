import io
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf
import torch

import server
from server import ANALYSIS_VERSION, API_VERSION, app

SITE = 'https://rishavpunatar.github.io'
EVIL = 'https://evil.example'


def wav_bytes(seconds=1.0, sr=16000, channels=1):
    t = np.arange(int(seconds * sr)) / sr
    tone = 0.3 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    data = np.stack([tone] * channels, axis=1)
    buffer = io.BytesIO()
    sf.write(buffer, data, sr, format='WAV')
    return buffer.getvalue()


class ServerContractTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_health_requires_the_modern_singing_pipeline(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["analysisVersion"], ANALYSIS_VERSION)
        self.assertGreaterEqual(payload["analysisVersion"], 5)
        self.assertEqual(payload["analyzer"], "rmvpe+praat+game")
        self.assertEqual(payload["api"], API_VERSION)
        self.assertFalse(payload["busy"])

    def test_allowed_origins_get_cors_and_private_network_headers(self):
        for origin in (SITE, 'http://localhost:8731', 'http://127.0.0.1:4173'):
            response = self.client.options('/analyze', headers={
                'Origin': origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Private-Network': 'true',
            })
            self.assertEqual(response.status_code, 200, origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Private-Network'), 'true')

    def test_foreign_origins_are_refused_before_any_work(self):
        with patch.object(server, 'decode_audio') as decode:
            simple = self.client.post('/analyze', data=wav_bytes(),
                                      headers={'Origin': EVIL, 'Content-Type': 'text/plain'})
            preflight = self.client.options('/analyze', headers={
                'Origin': EVIL, 'Access-Control-Request-Method': 'POST'})
            health = self.client.get('/', headers={'Origin': EVIL})
            spoofed = self.client.get('/', headers={'Origin': SITE + '.evil.example'})
            null_origin = self.client.post('/cancel', headers={'Origin': 'null'})
        decode.assert_not_called()
        for response in (simple, preflight, health, spoofed, null_origin):
            self.assertEqual(response.status_code, 403)
            self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))

    def test_upload_size_is_limited(self):
        self.assertLessEqual(app.config['MAX_CONTENT_LENGTH'], 4 * 1024 ** 3)
        with patch.dict(app.config, {'MAX_CONTENT_LENGTH': 1000}):
            response = self.client.post('/analyze', data=b'x' * 5000)
        self.assertEqual(response.status_code, 413)
        self.assertIn('too large', response.get_json()['error'])

    def test_undecodable_upload_is_a_clear_client_error(self):
        response = self.client.post('/analyze', data=b'definitely not audio')
        self.assertEqual(response.status_code, 415)
        self.assertIn('audio', response.get_json()['error'])

    @unittest.skipUnless(shutil.which('ffmpeg') or os.path.exists('/opt/homebrew/bin/ffmpeg'),
                         'ffmpeg not installed')
    def test_m4a_decodes_through_ffmpeg(self):
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'tone.wav')
            dst = os.path.join(td, 'tone.m4a')
            with open(src, 'wb') as handle:
                handle.write(wav_bytes(1.0, 44100, 2))
            subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', src,
                            '-c:a', 'aac', dst], check=True)
            with open(dst, 'rb') as handle:
                raw = handle.read()
        audio, sr = server.decode_audio(raw)
        self.assertEqual(audio.shape[1], 2)
        self.assertAlmostEqual(audio.shape[0] / sr, 1.0, delta=0.1)

    def test_status_and_cancel_when_idle(self):
        status = self.client.get('/status').get_json()
        self.assertFalse(status['busy'])
        self.assertIsNone(status['job'])
        cancel = self.client.post('/cancel').get_json()
        self.assertFalse(cancel['cancelled'])

    def test_cancel_stops_a_running_analysis_and_status_reports_it(self):
        started = threading.Event()
        release = threading.Event()

        def slow_analysis(job, x):
            job.set('separating', 0.25, note='test')
            started.set()
            while not release.wait(0.01):
                job.check()
            return {}

        results = {}
        with patch.object(server, 'run_analysis', side_effect=slow_analysis):
            worker = threading.Thread(target=lambda: results.update(
                response=app.test_client().post('/analyze?job=abc123', data=wav_bytes())))
            worker.start()
            self.assertTrue(started.wait(10))
            status = self.client.get('/status?job=abc123').get_json()
            self.assertTrue(status['busy'])
            self.assertEqual(status['job']['id'], 'abc123')
            self.assertEqual(status['job']['stage'], 'separating')
            self.assertGreater(status['job']['progress'], 0.02)
            cancel = self.client.post('/cancel?job=abc123').get_json()
            self.assertTrue(cancel['cancelled'])
            worker.join(10)
            release.set()
        self.assertEqual(results['response'].status_code, 409)
        self.assertTrue(results['response'].get_json()['cancelled'])
        self.assertFalse(self.client.get('/status').get_json()['busy'])

    def test_separated_vocals_cache_round_trips_and_prunes(self):
        with tempfile.TemporaryDirectory() as td, patch.object(server, 'CACHE_DIR', td):
            voc = torch.linspace(-0.5, 0.5, 44100)[None]
            server.save_cached_vocals('a' * 64, 'roformer', voc)
            loaded, separator = server.load_cached_vocals('a' * 64, 44100)
            self.assertEqual(separator, 'roformer')
            self.assertLess(float((loaded - voc).abs().max()), 1e-5)
            missing, _ = server.load_cached_vocals('b' * 64, 44100)
            self.assertIsNone(missing)
            server.save_cached_vocals('c' * 64, 'demucs', voc)
            server.prune_cache(limit=1)
            self.assertEqual(os.listdir(td), [])


if __name__ == "__main__":
    unittest.main()
