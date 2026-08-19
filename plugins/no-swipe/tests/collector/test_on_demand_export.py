import csv
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
COLLECTOR_PATH = (
    PLUGIN_ROOT
    / "skills"
    / "douyin-recommendation-rpa"
    / "scripts"
    / "douyin_rpa_collector.py"
)
SPEC = importlib.util.spec_from_file_location("no_swipe_export_collector", COLLECTOR_PATH)
COLLECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(COLLECTOR)


class OnDemandExportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db_path = self.root / "facts.sqlite"
        self.csv_path = self.root / "observations.csv"
        self.target_csv_path = self.root / "relevant.csv"

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, argv: list[str]) -> dict:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            COLLECTOR.main(argv)
        return json.loads(buffer.getvalue())

    def start_and_record(self) -> dict:
        self.run_cli(["--db", str(self.db_path), "start", "--target", "2", "--new", "--all-videos"])
        return self.run_cli([
            "--db",
            str(self.db_path),
            "record",
            "--json",
            json.dumps({
                "observation_id": "obs-1",
                "is_relevant": True,
                "feed_index": 1,
                "observed_at": "2026-08-19T12:00:00Z",
                "title": "相关内容",
            }, ensure_ascii=False),
        ])

    def test_record_does_not_write_csv(self):
        recorded = self.start_and_record()

        self.assertTrue(recorded["ok"])
        self.assertEqual(recorded["observation_id"], "obs-1")
        self.assertFalse(self.csv_path.exists())
        self.assertFalse(self.target_csv_path.exists())
        self.assertEqual(list(self.root.glob("*.csv")), [])

    def test_export_writes_csv_from_sqlite_on_demand(self):
        self.start_and_record()
        exported = self.run_cli([
            "--db",
            str(self.db_path),
            "export",
            "--csv",
            str(self.csv_path),
            "--target-csv",
            str(self.target_csv_path),
        ])

        self.assertEqual(exported["observed"], 1)
        self.assertEqual(exported["relevant"], 1)
        self.assertEqual(exported["csv"], str(self.csv_path))
        with self.csv_path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["observation_id"], "obs-1")
        self.assertEqual(rows[0]["title"], "相关内容")
        with self.target_csv_path.open(encoding="utf-8-sig", newline="") as handle:
            relevant_rows = list(csv.DictReader(handle))
        self.assertEqual(len(relevant_rows), 1)

    def test_amend_does_not_write_csv(self):
        self.start_and_record()
        amended = self.run_cli([
            "--db",
            str(self.db_path),
            "amend",
            "--observation-id",
            "obs-1",
            "--irrelevant",
        ])

        self.assertTrue(amended["ok"])
        self.assertEqual(list(self.root.glob("*.csv")), [])


if __name__ == "__main__":
    unittest.main()
