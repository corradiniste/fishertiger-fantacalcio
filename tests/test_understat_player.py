"""Unit tests for Understat per-player detail fetch/cache (mocked HTTP)."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from advisor import understat_player as up


SAMPLE_RADAR = {
    "radarStats": ["xG", "xA", "Sh", "KP", "xGChain", "xGBuildup"],
    "radarPoints": [
        {"season": "2025", "xG": 82, "xA": 55, "Sh": 70, "KP": 40, "xGChain": 75, "xGBuildup": 30},
        {"season": "2024", "xG": 60, "xA": 40, "Sh": 50, "KP": 35, "xGChain": 55, "xGBuildup": 22},
    ],
}

SAMPLE_SHOT = {
    "id": "1",
    "minute": "67",
    "result": "Goal",
    "X": "0.92",
    "Y": "0.48",
    "xG": "0.41",
    "situation": "OpenPlay",
    "shotType": "RightFoot",
    "h_a": "h",
    "match_id": "99",
}

SAMPLE_MATCH = {
    "id": "10",
    "date": "2025-09-14",
    "home": "Inter",
    "away": "Milan",
    "score": "2-1",
    "position": "F",
    "time": "90",
    "shots": "4",
    "goals": "1",
    "npg": "1",
    "kp": "2",
    "assists": "0",
    "xG": "0.85",
    "NPxG": "0.85",
    "xA": "0.12",
    "NPxA": "0.12",
    "xGChain": "1.1",
    "xGBuildup": "0.2",
}


def test_validate_player_id():
    assert up.validate_player_id("10967") == 10967
    with pytest.raises(ValueError, match="positive"):
        up.validate_player_id(0)
    with pytest.raises(ValueError):
        up.validate_player_id("nope")


def test_normalize_radar_shots_matches():
    radar = up.normalize_radar(SAMPLE_RADAR)
    assert radar["stats"][0] == "xG"
    assert radar["seasons"]["2025"]["xG"] == 82.0

    shot = up.normalize_shot(SAMPLE_SHOT)
    assert shot["x"] == pytest.approx(92.0)
    assert shot["y"] == pytest.approx(48.0)
    assert shot["xg"] == pytest.approx(0.41)
    assert shot["result"] == "Goal"

    match = up.normalize_match(SAMPLE_MATCH)
    assert match["goals_h"] == 2
    assert match["goals_a"] == 1
    assert match["kp"] == 2
    assert match["xG"] == pytest.approx(0.85)


def test_fetch_radar_uses_xhr(tmp_path):
    session = MagicMock()
    warm = MagicMock(status_code=200)
    warm.raise_for_status = MagicMock()
    data = MagicMock(status_code=200)
    data.raise_for_status = MagicMock()
    data.json.return_value = SAMPLE_RADAR
    session.request.side_effect = [warm, data]

    radar = up.fetch_radar(10967, session=session)
    assert radar["seasons"]["2025"]["xA"] == 55.0
    assert session.request.call_args_list[1].args[1].endswith("/getRadarData/10967")
    assert session.request.call_args_list[1].kwargs["headers"]["X-Requested-With"] == "XMLHttpRequest"


def test_fetch_player_detail_cache_hit_and_force(tmp_path):
    cache = tmp_path / "players"
    player_dir = cache / "10967"
    player_dir.mkdir(parents=True)
    (player_dir / "radar.json").write_text(json.dumps(up.normalize_radar(SAMPLE_RADAR)), encoding="utf-8")
    (player_dir / "shots_2025.json").write_text(json.dumps([up.normalize_shot(SAMPLE_SHOT)]), encoding="utf-8")
    (player_dir / "matches.json").write_text(json.dumps([up.normalize_match(SAMPLE_MATCH)]), encoding="utf-8")

    with patch.object(up, "fetch_radar") as fetch_radar, patch.object(up, "fetch_shots") as fetch_shots, patch.object(
        up, "fetch_matches"
    ) as fetch_matches, patch.object(up, "_request_with_retry"):
        detail = up.fetch_player_detail(10967, [2025], cache_dir=cache, force=False, rate_limit_s=0)
        fetch_radar.assert_not_called()
        fetch_shots.assert_not_called()
        fetch_matches.assert_not_called()
        assert detail["radar"]["seasons"]["2025"]["xG"] == 82.0
        assert detail["shots"]["2025"][0]["result"] == "Goal"
        assert detail["matches"][0]["home"] == "Inter"
        assert "radar" in detail["cached_at"]

    with patch.object(up, "fetch_radar", return_value=up.normalize_radar(SAMPLE_RADAR)) as fetch_radar, patch.object(
        up, "fetch_shots", return_value=[up.normalize_shot(SAMPLE_SHOT)]
    ) as fetch_shots, patch.object(
        up, "fetch_matches", return_value=[up.normalize_match(SAMPLE_MATCH)]
    ) as fetch_matches, patch.object(up, "_request_with_retry"):
        detail = up.fetch_player_detail(10967, [2025], cache_dir=cache, force=True, rate_limit_s=0)
        fetch_radar.assert_called_once()
        fetch_shots.assert_called_once()
        fetch_matches.assert_called_once()
        assert "radar" in detail["fetched_parts"]


def test_fetch_player_detail_graceful_radar_failure(tmp_path):
    with patch.object(up, "fetch_radar", side_effect=RuntimeError("boom")), patch.object(
        up, "fetch_shots", return_value=[up.normalize_shot(SAMPLE_SHOT)]
    ), patch.object(
        up, "fetch_matches", return_value=[up.normalize_match(SAMPLE_MATCH)]
    ), patch.object(up, "_request_with_retry"), patch.object(up.time, "sleep"):
        detail = up.fetch_player_detail(42, [2025], cache_dir=tmp_path, force=True, rate_limit_s=0)
    assert detail["radar"] is None
    assert detail["shots"]["2025"][0]["id"] == 1
    assert len(detail["matches"]) == 1


def test_rate_limit_sleeps_between_seasons(tmp_path):
    sleeps: list[float] = []

    def fake_sleep(seconds):
        sleeps.append(seconds)

    with patch.object(up, "fetch_radar", return_value=up.normalize_radar(SAMPLE_RADAR)), patch.object(
        up, "fetch_shots", return_value=[]
    ), patch.object(up, "fetch_matches", return_value=[]), patch.object(
        up, "_request_with_retry"
    ), patch.object(up.time, "sleep", side_effect=fake_sleep):
        up.fetch_player_detail(7, [2025, 2024], cache_dir=tmp_path, force=True, rate_limit_s=1.0)
    assert sleeps  # at least one pause between network chunks
    assert all(value == 1.0 for value in sleeps)


def test_resolve_understat_id_prefers_current():
    player = {
        "understat_current": {"id": 99},
        "understat": {"2024": {"id": 11}, "2025": {"id": 99}},
    }
    assert up.resolve_understat_id(player) == 99
    assert up.resolve_understat_id({"understat": {}}) is None
