import json

import pandas as pd
import pytest

from advisor.league_profile import SourceDeclaration
from advisor.pipeline import _resolve_source, load_identity_overrides, match_manual, weighted_history


def test_source_lookup_supports_raw_relative_and_project_relative_paths(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    source_file = raw / "source.csv"
    source_file.write_text("x\n", encoding="utf-8")

    assert _resolve_source(SourceDeclaration("teams", "source.csv", "csv"), raw) == source_file
    with pytest.raises(FileNotFoundError, match="Missing required source 'teams'"):
        _resolve_source(SourceDeclaration("teams", "missing.csv", "csv"), raw)


def test_identity_overrides_are_applied_before_matching_and_validated(tmp_path):
    archive = tmp_path / "overrides.json"
    archive.write_text(json.dumps({"overrides": [{"source": "titolari", "name": "Different", "team": "Club", "id_fantacalcio": 7, "confirmed": True}]}), encoding="utf-8")
    listone = pd.DataFrame([{"Id": 7, "Nome": "Canonical", "Squadra": "Club"}])
    manual = pd.DataFrame([{"nome": "Different", "squadra": "Club"}])

    result = match_manual(manual, listone, "titolari", load_identity_overrides(archive))

    assert result.iloc[0].id_matched == 7
    assert result.iloc[0].metodo == "override"
    archive.write_text(json.dumps({"overrides": [{"source": "titolari", "name": "Different", "team": "Club", "id_fantacalcio": 7}]}), encoding="utf-8")
    with pytest.raises(ValueError, match="confirmed=true"):
        match_manual(manual, listone, "titolari", load_identity_overrides(archive))


def test_unresolved_matches_are_explicitly_reported():
    result = match_manual(pd.DataFrame([{"nome": "Nobody", "squadra": "Club"}]), pd.DataFrame([{"Id": 1, "Nome": "Player", "Squadra": "Other"}]), "piazzati")

    assert result.iloc[0].metodo == "nessuno"
    assert result.iloc[0].diagnostic == "no confident candidate"


def test_understat_sources_are_optional_on_profile():
    from advisor.league_profile import LeagueProfile
    from pathlib import Path

    profile = LeagueProfile.load_json(Path(__file__).parents[1] / "config/default_profile.json")
    assert profile.understat_seasons() == [2026, 2025, 2024, 2023, 2022]
    assert all(source.required is False for source in profile.understat_sources)


def test_ambiguous_matches_are_explicitly_reported():
    listone = pd.DataFrame([
        {"Id": 1, "Nome": "Rossi", "Squadra": "Club"},
        {"Id": 2, "Nome": "Rossi", "Squadra": "Club"},
    ])

    result = match_manual(pd.DataFrame([{"nome": "Rossi", "squadra": "Club"}]), listone, "piazzati")

    assert result.iloc[0].metodo == "ambiguo"
    assert result.iloc[0].diagnostic == "multiple equally scored candidates"


def test_all_history_seasons_are_used_in_chronological_effective_order():
    histories = [pd.DataFrame([{"Id": 1, "Mv": value, "Pv": 1}]) for value in (5.0, 6.0, 7.0, 8.0)]

    assert weighted_history(1, histories, "Mv", weights=(0.6, 0.3, 0.1)) == pytest.approx(8 / 1.1)
