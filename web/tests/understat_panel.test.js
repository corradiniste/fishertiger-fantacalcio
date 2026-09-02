import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMetric,
  formatMatchRow,
  filterShots,
  flattenShots,
  hasUnderstat,
  listXg90,
  matchHistoryRows,
  overperformanceTone,
  pickUnderstatSeason,
  projectShot,
  radarPolygon,
  sparklinePoints,
  understatIdFor,
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
  assert.equal(listXg90(filled), 0.42);
  assert.equal(listXg90(empty), null);
  assert.equal(understatIdFor(filled), 9);
  assert.equal(understatIdFor(empty), null);
});

test("formats metrics and overperformance tone", () => {
  assert.equal(formatMetric(8.123, "xG"), "8.12");
  assert.equal(formatMetric(28, "games"), "28");
  assert.equal(formatMetric(null, "xA"), "—");
  assert.equal(overperformanceTone(1.2), "over");
  assert.equal(overperformanceTone(-0.8), "under");
  assert.equal(overperformanceTone(0), "neutral");
});

test("builds sparkline points for multi-season history", () => {
  const spark = sparklinePoints(filled, "xG");
  assert.ok(spark.points.includes(","));
  assert.equal(spark.seasons.length, 2);
  assert.equal(sparklinePoints(empty, "xG").points, "");
});

test("radarPolygon projects season metrics to SVG points", () => {
  const radar = {
    stats: ["xG", "xA", "Sh"],
    seasons: { "2025": { xG: 100, xA: 50, Sh: 0 } },
  };
  const poly = radarPolygon(radar, "2025", 200, 20);
  assert.equal(poly.axes.length, 3);
  assert.ok(poly.points.split(" ").length === 3);
  assert.ok(poly.points.includes(","));
});

test("projectShot and filterShots", () => {
  const projected = projectShot({ x: 100, y: 50, xg: 0.5, result: "Goal", situation: "OpenPlay" });
  assert.equal(projected.fill, "#1f7a45");
  assert.ok(projected.r > 1);
  assert.ok(projected.cy < 10);

  const flat = flattenShots({
    "2025": [
      { id: 1, result: "Goal", situation: "OpenPlay", x: 90, y: 40, xg: 0.2 },
      { id: 2, result: "MissedShots", situation: "Penalty", x: 95, y: 50, xg: 0.7 },
    ],
    "2024": [{ id: 3, result: "Goal", situation: "FromCorner", x: 80, y: 30, xg: 0.1 }],
  });
  assert.equal(flat.length, 3);
  const filtered = filterShots(flat, {
    seasons: ["2025"],
    situations: ["OpenPlay"],
    results: ["Goal"],
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 1);
});

test("matchHistoryRows sorts and formatMatchRow formats IT cells", () => {
  const rows = matchHistoryRows([
    { id: 2, date: "2025-02-01", home: "A", away: "B", goals_h: 1, goals_a: 0, goals: 1, xG: 0.4, assists: 0, xA: 0.1, position: "F", time: 90, shots: 3, kp: 1 },
    { id: 1, date: "2025-03-01", home: "C", away: "D", goals_h: 2, goals_a: 2, goals: 0, xG: 0.2, assists: 1, xA: 0.8, position: "F", time: 75, shots: 1, kp: 2 },
  ]);
  assert.equal(rows[0].id, 1);
  const formatted = formatMatchRow(rows[0]);
  assert.equal(formatted.score, "2-2");
  assert.equal(formatted.xG, "0.20");
  assert.equal(formatted.xA, "0.80");
  assert.ok(formatted.date.includes(" "));
});
