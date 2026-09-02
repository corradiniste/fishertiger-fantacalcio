"""Tests for Understat refresh API endpoints."""
from __future__ import annotations

import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from advisor.league_profile import LeagueProfile
from advisor.server import create_server


class UnderstatRefreshApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.raw_dir = root / "data" / "raw"
        self.raw_dir.mkdir(parents=True)
        self.calls = []
        self.profile = json.loads((Path(__file__).parents[1] / "config/default_profile.json").read_text(encoding="utf-8"))
        self.profile["profile_id"] = "refresh-team"
        calendar_source = next(source for source in self.profile["current_sources"] if source["name"] == "league_calendar")
        calendar_source["path"] = str(root / "missing-calendar.xlsx")
        self.profile = json.loads(LeagueProfile.from_dict(self.profile).canonical_json())

        def fetcher(seasons, out_dir, force=False, progress=None, **kwargs):
            self.calls.append({"seasons": list(seasons), "force": force})
            paths = []
            for season in seasons:
                path = Path(out_dir) / f"understat_{season}.json"
                path.write_text(json.dumps({"season": season, "players": []}), encoding="utf-8")
                if progress:
                    progress({"season": season, "path": str(path), "status": "written"})
                paths.append(path)
            return paths

        def generator(profile, datasets_dir):
            path = datasets_dir / profile.profile_id / profile.season.season.replace("/", "-") / "auction_data.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"generated":true}', encoding="utf-8")
            return {"dataset_path": str(path)}

        self.server = create_server(
            ("127.0.0.1", 0),
            profiles_dir=root / "config/profiles",
            datasets_dir=root / "data/processed",
            uploads_dir=root / "data/uploads",
            generator=generator,
            understat_fetcher=fetcher,
            raw_dir=self.raw_dir,
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        body = json.dumps(self.profile).encode("utf-8")
        response, _ = self.request("PUT", "/api/profiles/refresh-team", body, {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.refresh_executor.shutdown(wait=False, cancel_futures=True)
        self.server.server_close()
        self.temp_dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response, json.loads(payload) if payload else None

    def _wait_job(self, job_id, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            response, payload = self.request("GET", f"/api/sources/refresh/status?job_id={job_id}")
            self.assertEqual(response.status, 200)
            if payload["status"] in {"completed", "failed"}:
                return payload
            time.sleep(0.05)
        self.fail(f"refresh job {job_id} did not finish")

    def test_refresh_accepts_and_completes(self):
        body = json.dumps({"seasons": [2025, 2024], "force": True}).encode("utf-8")
        response, payload = self.request("POST", "/api/sources/refresh", body, {"Content-Type": "application/json"})
        self.assertEqual(response.status, 202)
        self.assertIn(payload["status"], {"queued", "running"})
        done = self._wait_job(payload["job_id"])
        self.assertEqual(done["status"], "completed")
        self.assertEqual(self.calls[0]["seasons"], [2025, 2024])
        self.assertTrue((self.raw_dir / "understat_2025.json").exists())

    def test_rejects_invalid_and_concurrent_refresh(self):
        response, payload = self.request(
            "POST",
            "/api/sources/refresh",
            json.dumps({"seasons": [1999]}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_seasons")

        started = threading.Event()
        release = threading.Event()

        def slow_fetcher(seasons, out_dir, force=False, progress=None, **kwargs):
            started.set()
            release.wait(timeout=2)
            return []

        self.server.understat_fetcher = slow_fetcher
        response, payload = self.request(
            "POST",
            "/api/sources/refresh",
            json.dumps({"seasons": [2025]}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(response.status, 202)
        self.assertTrue(started.wait(timeout=1))
        response2, payload2 = self.request(
            "POST",
            "/api/sources/refresh",
            json.dumps({"seasons": [2024]}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(response2.status, 409)
        self.assertEqual(payload2["error"]["code"], "refresh_in_progress")
        release.set()
        self._wait_job(payload["job_id"])
