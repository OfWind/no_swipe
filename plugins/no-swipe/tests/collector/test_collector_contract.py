import importlib.util
import json
import time
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
COLLECTOR_PATH = (
    PLUGIN_ROOT
    / "skills"
    / "douyin-recommendation-rpa"
    / "scripts"
    / "douyin_rpa_collector.py"
)
SPEC = importlib.util.spec_from_file_location("no_swipe_collector", COLLECTOR_PATH)
COLLECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(COLLECTOR)


class CollectorContractTest(unittest.TestCase):
    def setUp(self):
        self.session = {"session_id": "session-1", "started_epoch": time.time()}

    def test_relevance_must_be_supplied_by_profile_classifier(self):
        with self.assertRaisesRegex(ValueError, "is_relevant"):
            COLLECTOR.normalized_record(
                {"title": "内容", "feed_index": 1}, self.session, 1, None
            )

    def test_collector_preserves_explicit_classification_evidence(self):
        row = COLLECTOR.normalized_record(
            {
                "feed_index": 1,
                "is_relevant": True,
                "interest_score": 6,
                "matched_keywords": ["用户画像主题"],
                "dwell_seconds": 2.5,
            },
            self.session,
            1,
            1,
        )
        self.assertEqual(row["is_relevant"], 1)
        self.assertEqual(json.loads(row["matched_keywords"]), ["用户画像主题"])
        self.assertEqual(row["interest_score"], 6.0)

    def test_collector_preserves_utc_observed_at(self):
        row = COLLECTOR.normalized_record(
            {
                "feed_index": 1,
                "is_relevant": True,
                "observed_at": "2026-08-13T12:00:00Z",
            },
            self.session,
            1,
            1,
        )

        self.assertEqual(row["observed_at"], "2026-08-13T12:00:00Z")

    def test_collector_defaults_to_utc(self):
        row = COLLECTOR.normalized_record(
            {"feed_index": 1, "is_relevant": True},
            self.session,
            1,
            1,
        )

        self.assertTrue(row["observed_at"].endswith("Z"))

    def test_collector_accepts_timezone_less_observed_at(self):
        row = COLLECTOR.normalized_record(
            {
                "feed_index": 1,
                "is_relevant": True,
                "observed_at": "2026-08-13T12:00:00",
            },
            self.session,
            1,
            1,
        )

        self.assertEqual(row["observed_at"], "2026-08-13T12:00:00")


if __name__ == "__main__":
    unittest.main()
