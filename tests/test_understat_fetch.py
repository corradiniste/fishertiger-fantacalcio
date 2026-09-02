"""Unit tests for Understat fetch/normalize/load (mocked HTTP)."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

from advisor import understat


SAMPLE_PLAYER = {
    "id": "101",
    "player_name": "Lautaro Martínez",
    "position": "F",
    "team_title": "Inter",
    "games": "30",
    "time": "2500",
    "goals": "20",
    "xG": "18.5",
    "xGA": "0",
    "assists": "5",
    "xA": "4.2",
    "npxG": "16.1",
    "npxA": "4.2",
    "npg": "17",
    "shots": "90",
    "key_passes": "40",
    "yellow": "3",
    "red": "0",
    "xGChain": "22.0",
    "xGBuildup": "3.5",
}


def test_normalize_player_and_derived_metrics():
    player = understat.normalize_player(SAMPLE_PLAYER)
    assert player["id"] == 101
    assert player["player_name"] == "Lautaro Martínez"
    assert player["xG"] == 18.5
    derived = understat.derive_season_metrics(player)
    assert derived["xg90"] == pytest.approx(18.5 * 90 / 2500, rel=1e-4)
    assert derived["overperformance"] == pytest.approx(1.5, rel=1e-4)
    assert understat.per90(9.0, 0) is None


def test_validate_seasons_bounds_and_dedupe():
    with patch.object(understat, "current_understat_season", return_value=2026):
        assert understat.validate_seasons([2026, 2025, 2026]) == [2026, 2025]
        with pytest.raises(ValueError, match="between"):
            understat.validate_seasons([2010])
        with pytest.raises(ValueError, match="at most"):
            understat.validate_seasons(list(range(2014, 2023)))


def test_fetch_season_warms_up_then_reads_ajax(tmp_path):
    session = MagicMock()
    warm = MagicMock()
    warm.raise_for_status = MagicMock()
    warm.status_code = 200
    data = MagicMock()
    data.raise_for_status = MagicMock()
    data.status_code = 200
    data.json.return_value = {"players": [SAMPLE_PLAYER], "teams": {}, "dates": []}
    session.request.side_effect = [warm, data]

    payload = understat.fetch_season(2025, session=session, rate_limit_s=0)
    assert payload["season"] == 2025
    assert payload["players"][0]["id"] == 101
    assert session.request.call_count == 2
    first_url = session.request.call_args_list[0].args[1]
    second_url = session.request.call_args_list[1].args[1]
    assert first_url.endswith("/league/Serie_A/2025")
    assert second_url.endswith("/getLeagueData/Serie_A/2025")
    assert session.request.call_args_list[1].kwargs["headers"]["X-Requested-With"] == "XMLHttpRequest"


def test_fetch_seasons_skips_existing_unless_force(tmp_path):
    existing = tmp_path / "understat_2025.json"
    existing.write_text(json.dumps({"players": []}), encoding="utf-8")
    with patch.object(understat, "fetch_season") as fetch:
        paths = understat.fetch_seasons([2025], tmp_path, force=False, rate_limit_s=0)
        assert paths == [existing]
        fetch.assert_not_called()

    with patch.object(
        understat,
        "fetch_season",
        return_value=understat.normalize_payload({"players": [SAMPLE_PLAYER]}, 2025),
    ) as fetch:
        paths = understat.fetch_seasons([2025], tmp_path, force=True, rate_limit_s=0)
        fetch.assert_called_once()
        assert paths[0] == existing
        payload = json.loads(existing.read_text(encoding="utf-8"))
        assert payload["players"][0]["id"] == 101


def test_fetch_seasons_writes_normalized_file(tmp_path):
    with patch.object(understat, "fetch_season", return_value=understat.normalize_payload({"players": [SAMPLE_PLAYER]}, 2024)):
        paths = understat.fetch_seasons([2024], tmp_path, force=True, rate_limit_s=0)
    assert len(paths) == 1
    payload = json.loads(paths[0].read_text(encoding="utf-8"))
    assert payload["players"][0]["player_name"] == "Lautaro Martínez"
    loaded = understat.load_understat(tmp_path, [2024, 2099])
    assert 2024 in loaded
    assert 2099 not in loaded


def test_request_retries_on_429_then_succeeds():
    session = MagicMock()
    fail = MagicMock(status_code=429)
    fail.raise_for_status = MagicMock()
    ok = MagicMock(status_code=200)
    ok.raise_for_status = MagicMock()
    session.request.side_effect = [fail, ok]
    with patch.object(understat.time, "sleep"):
        response = understat._request_with_retry(session, "GET", "https://example.test")
    assert response is ok
    assert session.request.call_count == 2
