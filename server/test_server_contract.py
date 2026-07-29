import unittest

from server import ANALYSIS_VERSION, app


class ServerContractTests(unittest.TestCase):
    def test_health_requires_the_modern_singing_pipeline(self):
        with app.test_client() as client:
            response = client.get("/")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["analysisVersion"], ANALYSIS_VERSION)
        self.assertGreaterEqual(payload["analysisVersion"], 4)
        self.assertEqual(payload["analyzer"], "rmvpe+praat+game")


if __name__ == "__main__":
    unittest.main()
