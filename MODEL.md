# Model Assumptions

The application is intentionally a Classic Fantacalcio advisor for Serie A.
The Serie A source calendar is validated as 20 teams, 38 matchdays and 380
matches. The fantasy league may select a shorter configured interval within
that season.

## Player projections

- Historical observations are weighted newest to oldest: 60%, 30%, 10%.
- A player marked `TITOLARE`, `BALLOTTAGGIO`, or `RISERVA` has a current
  availability prior of 85%, 55%, or 15%. When historical availability exists,
  the final probability is 65% current prior and 35% history.
- Event rates are normalized to a documented 75-minute rated appearance.
- Primary penalty takers receive a 0.12 expected-goal-per-90 uplift.
- European competitions apply a rotation discount to outfield availability.
- Fixture projections vary by opponent strength and home/away status while
  preserving the player-level seasonal mean.

## Understat fields (schema 1.1 / model 1.6)

- `player.understat` maps season start-year → aggregates (`xG`, `xA`, `npxG`,
  `npxA`, `goals`, `assists`, `shots`, `key_passes`, `xGChain`, `xGBuildup`,
  `games`, `time`, …) plus derived `xg90` / `xa90` / `npxg90` /
  `overperformance` (goals − xG) using minutes played.
- `understat_current`, top-level `xg90` / `xa90` / `npxg90` /
  `overperformance` mirror the profile’s current season when available.
- These fields are **informative only** and do not alter `event_rates`,
  projections, or Monte Carlo sampling in this model version.
- Per-player Understat detail (radar / shots / matches) is fetched lazily via
  `GET /api/players/{id}/understat` and is **not** stored in `auction_data.json`.
  Schema remains 1.1; the detail payload is UI-only context.

## Auction values

- The source FVM is preserved as `fvm_original`.
- The UI allocates configured role budgets using FVM as a relative weight.
- The default role split is P 7%, D 18%, C 25%, A 50%, with a 5% soft target
  flexibility. These are editable profile rules.

## Simulation

- Monte Carlo uses a reproducible seed and 1,000 iterations by default.
- Bench composition and the maximum number of substitutions come from
  `bench_switch` in the active profile.
- `Basic` and `Strict` replacements preserve the absent starter's role; `None`
  disables replacements. The configured formation remains unchanged.

These are model defaults, not assertions about future player performance.
