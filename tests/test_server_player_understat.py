"""Tests for GET /api/players/{id}/understat."""
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


class PlayerUnderstatApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.raw_dir = root / "data" / "raw"
        self.datasets_dir = root / "data" / "processed"
        self.raw_dir.mkdir(parents=True)
        self.calls = []
        self.profile = json.loads((Path(__file__).parents[1] / "config/default_profile.json").read_text(encoding="utf-8"))
        self.profile["profile_id"] = "detail-team"
        calendar_source = next(source for source in self.profile["current_sources"] if source["name"] == "league_calendar")
        calendar_source["path"] = str(root / "missing-calendar.xlsx")
        self.profile = json.loads(LeagueProfile.from_dict(self.profile).canonical_json())

        season_dir = self.datasets_dir / "detail-team" / self.profile["season"]["season"].replace("/", "-")
        season_dir.mkdir(parents=True)
        auction = {
            "schema_version": "1.1",
            "meta": {"profile": {"profile_id": "detail-team"}},
            "players": [
                {
                    "id": 5841,
                    "nome": "Svilar",
                    "understat": {"2025": {"id": 10967, "xG": 0.1}, "2026": {"id": 10967, "xG": 0.0}},
                    "understat_current": {"id": 10967},
                },
                {"id": 2, "nome": "NoMatch", "understat": {}},
            ],
        }
        (season_dir / "auction_data.json").write_text(json.dumps(auction), encoding="utf-8")

        def fetcher(understat_id, seasons, *, cache_dir=None, force=False, **kwargs):
            self.calls.append({"understat_id": understat_id, "seasons": list(seasons), "force": force})
            time.sleep(0.05)
            return {
                "player_id": understat_id,
                "radar": {"stats": ["xG"], "seasons": {"2025": {"xG": 80}}},
                "shots": {"2025": [{"id": 1, "x": 90, "y": 50, "xg": 0.3, "result": "Goal", "situation": "OpenPlay"}]},
                "matches": [{"id": 9, "date": "2025-01-01", "home": "A", "away": "B", "goals_h": 1, "goals_a": 0}],
                "fetched_at": "2026-01-01T00:00:00Z",
                "cached_at": [],
            }

        self.server = create_server(
            ("127.0.0.1", 0),
            profiles_dir=root / "config/profiles",
            datasets_dir=self.datasets_dir,
            uploads_dir=root / "data/uploads",
            understat_player_fetcher=fetcher,
            raw_dir=self.raw_dir,
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        body = json.dumps(self.profile).encode("utf-8")
        response, _ = self.request("PUT", "/api/profiles/detail-team", body, {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.refresh_executor.shutdown(wait=False, cancel_futures=True)
        self.server.player_detail_executor.shutdown(wait=False, cancel_futures=True)
        self.server.server_close()
        self.temp_dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response, json.loads(payload) if payload else None

    def test_returns_detail_for_matched_player(self):
        response, payload = self.request(
            "GET",
            "/api/players/5841/understat?profile_id=detail-team&seasons=2025,2024&force=1",
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["fantacalcio_id"], 5841)
        self.assertEqual(payload["understat_id"], 10967)
        self.assertEqual(payload["radar"]["seasons"]["2025"]["xG"], 80)
        self.assertEqual(self.calls[0]["seasons"], [2025, 2024])
        self.assertTrue(self.calls[0]["force"])

    def test_404_without_understat_id(self):
        response, payload = self.request("GET", "/api/players/2/understat?profile_id=detail-team")
        self.assertEqual(response.status, 404)
        self.assertEqual(payload["error"]["code"], "no_understat_id")

    def test_400_without_profile_id_or_bad_seasons(self):
        response, payload = self.request("GET", "/api/players/5841/understat")
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile")
        response, payload = self.request(
            "GET",
            "/api/players/5841/understat?profile_id=detail-team&seasons=nope",
        )
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_seasons")

    def test_serializes_concurrent_same_player(self):
        results = []

        def hit():
            response, payload = self.request(
                "GET",
                "/api/players/5841/understat?profile_id=detail-team&seasons=2025",
            )
            results.append((response.status, payload.get("understat_id")))

        threads = [threading.Thread(target=hit) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual({status for status, _ in results}, {200})
        self.assertEqual(len(self.calls), 3)
