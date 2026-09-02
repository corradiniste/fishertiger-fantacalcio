import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMetric,
  hasUnderstat,
  listXg90,
  overperformanceTone,
  pickUnderstatSeason,
  sparklinePoints,
  understatSeasons,
} from "../src/understat-panel.js";

const filled = {
  id: 1,
  xg90: 0.42,
  understat_current: { id: 9, xG: 8.1, xA: 2.2, goals: 10, overperformance: 1.9, xg90: 0.42 },
  understat: {
    "2024": { id: 9, xG: 6.0, xA: 1.5, goals: 5, overperformance: -1.0, xg90: 0.3, xa90: 0.1, games: 20, time: 1600, shots: 40, key_passes: 10, npxG: 5, npxA: 1.5, xGChain: 8, xGBuildup: 2 },
    "2025": { id: 9, xG: 8.1, xA: 2.2, goals: 10, overperformance: 1.9, xg90: 0.42, xa90: 0.12, games: 28, time: 2200, shots: 70, key_passes: 18, npxG: 7, npxA: 2, xGChain: 12, xGBuildup: 3 },
  },
};

const empty = { id: 2, understat: {}, understat_current: null, xg90: null };

test("detects filled and empty understat payloads", () => {
  assert.equal(hasUnderstat(filled), true);
  assert.equal(hasUnderstat(empty), false);
  assert.deepEqual(understatSeasons(filled), ["2025", "2024"]);
  assert.equal(pickUnderstatSeason(filled), "2025");
  assert.equal(pickUnderstatSeason(filled, "2024"), "2024");
  assert.equal(listXg90(filled), 0.42);
  assert.equal(listXg90(empty), null);
});

test("formats metrics and overperformance tone", () => {
  assert.equal(formatMetric(8.123, "xG"), "8.12");
  assert.equal(formatMetric(28, "games"), "28");
  assert.equal(formatMetric(null, "xG"), "—");
  assert.equal(overperformanceTone(1.9), "over");
  assert.equal(overperformanceTone(-1.0), "under");
  assert.equal(overperformanceTone(0), "neutral");
});

test("builds sparkline points for multi-season history", () => {
  const spark = sparklinePoints(filled, "xG");
  assert.ok(spark.points.includes(","));
  assert.equal(spark.seasons.length, 2);
  assert.equal(sparklinePoints(empty, "xG").points, "");
});
