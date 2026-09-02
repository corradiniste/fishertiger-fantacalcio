import test from "node:test";
import assert from "node:assert/strict";
import {
  addBid,
  advanceNominator,
  clearBids,
  emptyAuction,
  legalMaxBid,
  rehydrateAuction,
  replayHistory,
  serializeAuction,
  setNominator,
  topBid,
} from "../src/auction-state.js";

const rules = {
  participants: 2,
  teamNames: ["Mine", "Other"],
  startingCredits: 20,
  rosterSlots: { P: 1, A: 1 },
  auction: { minPrice: 2, increment: 2, reserve: 2 },
};
const players = [
  { id: 1, ruolo: "P" },
  { id: 2, ruolo: "A" },
];

test("rehydrates compact transactions and preserves player references", () => {
  const saved = {
    version: 2,
    teams: [
      { name: "Mine", startingCredits: 20 },
      { name: "Other", startingCredits: 20 },
    ],
    history: [{ playerId: 1, owner: 0, price: 4 }],
    undone: [],
  };
  const state = rehydrateAuction(saved, players, rules);
  assert.equal(state.teams[0].roster[0], players[0]);
  assert.deepEqual(serializeAuction(state).history, saved.history);
  assert.equal(state.nominator, 0);
  assert.deepEqual(state.bids, []);
  assert.equal(state.lot, null);
});

test("round-trips nominator, bids and lot with compact bid keys", () => {
  const seed = emptyAuction(rules);
  seed.nominator = 1;
  seed.lot = { playerId: 2 };
  seed.bids = [
    { team: 0, price: 4, ts: 100 },
    { team: 1, price: 6, ts: 200 },
  ];
  const saved = serializeAuction(seed);
  assert.deepEqual(saved.bids, [
    { t: 0, p: 4, ts: 100 },
    { t: 1, p: 6, ts: 200 },
  ]);
  assert.equal(saved.nominator, 1);
  assert.deepEqual(saved.lot, { playerId: 2 });
  const state = rehydrateAuction(saved, players, rules);
  assert.equal(state.nominator, 1);
  assert.deepEqual(state.lot, { playerId: 2 });
  assert.deepEqual(state.bids, seed.bids);
});

test("defaults missing live fields for legacy saves", () => {
  const saved = {
    version: 2,
    teams: [
      { name: "Mine", startingCredits: 20 },
      { name: "Other", startingCredits: 20 },
    ],
    history: [],
    undone: [],
  };
  const state = rehydrateAuction(saved, players, rules);
  assert.equal(state.nominator, 0);
  assert.deepEqual(state.bids, []);
  assert.equal(state.lot, null);
});

test("rejects corrupt or incompatible auction state", () => {
  assert.equal(rehydrateAuction({ teams: [], history: [] }, players, rules), null);
  assert.equal(
    rehydrateAuction(
      {
        version: 2,
        teams: [
          { name: "Mine", startingCredits: 20 },
          { name: "Other", startingCredits: 20 },
        ],
        history: [{ playerId: 99, owner: 0, price: 4 }],
      },
      players,
      rules,
    ),
    null,
  );
});

test("reserves credits for remaining configured slots", () => {
  assert.equal(legalMaxBid(emptyAuction(rules).teams[0], rules), 18);
});

test("addBid validates price and requires a raise", () => {
  let state = emptyAuction(rules);
  state = addBid(state, { team: 0, price: 4 }, rules);
  assert.equal(topBid(state.bids).price, 4);
  const rejected = addBid(state, { team: 1, price: 4 }, rules);
  assert.equal(rejected, state);
  state = addBid(state, { team: 1, price: 6 }, rules);
  assert.equal(topBid(state.bids).team, 1);
  assert.equal(topBid(state.bids).price, 6);
});

test("setNominator, advanceNominator and clearBids", () => {
  let state = emptyAuction(rules);
  state = setNominator(state, 1);
  assert.equal(state.nominator, 1);
  state = advanceNominator(state);
  assert.equal(state.nominator, 0);
  state = {
    ...state,
    bids: [{ team: 0, price: 4, ts: 1 }],
    lot: { playerId: 1 },
  };
  state = clearBids(state);
  assert.deepEqual(state.bids, []);
  assert.deepEqual(state.lot, { playerId: 1 });
});

test("selecting a lot keeps playerId after clearing bids", () => {
  let state = emptyAuction(rules);
  state = { ...state, bids: [{ team: 0, price: 4, ts: 1 }] };
  state = { ...clearBids(state), lot: { playerId: 2 } };
  assert.deepEqual(state.bids, []);
  assert.deepEqual(state.lot, { playerId: 2 });
});

test("empty history adopts rules.startingCredits over stale saved budgets", () => {
  const saved = {
    version: 2,
    teams: [
      { name: "Mine", startingCredits: 750 },
      { name: "Other", startingCredits: 750 },
    ],
    history: [],
    undone: [{ playerId: 1, owner: 0, price: 4 }],
  };
  const state = rehydrateAuction(saved, players, {
    ...rules,
    startingCredits: 600,
  });
  assert.equal(state.teams[0].startingCredits, 600);
  assert.equal(state.teams[0].credits, 600);
  assert.equal(state.teams[1].credits, 600);
});

test("history keeps saved startingCredits even if rules differ", () => {
  const saved = {
    version: 2,
    teams: [
      { name: "Mine", startingCredits: 750 },
      { name: "Other", startingCredits: 750 },
    ],
    history: [{ playerId: 1, owner: 0, price: 4 }],
    undone: [],
  };
  const state = rehydrateAuction(saved, players, {
    ...rules,
    startingCredits: 600,
  });
  assert.equal(state.teams[0].startingCredits, 750);
  assert.equal(state.teams[0].credits, 746);
});

test("replayHistory rebuilds teams and assigned from valid history", () => {
  const state = replayHistory(
    [
      { playerId: 1, owner: 0, price: 4 },
      { playerId: 2, owner: 1, price: 6 },
    ],
    players,
    rules,
  );
  assert.equal(state.teams[0].credits, 16);
  assert.equal(state.teams[1].credits, 14);
  assert.equal(state.teams[0].roster[0], players[0]);
  assert.equal(state.teams[1].roster[0], players[1]);
  assert.deepEqual(state.assigned["1"], { owner: 0, price: 4 });
  assert.deepEqual(state.assigned["2"], { owner: 1, price: 6 });
  assert.deepEqual(state.history, [
    { playerId: 1, owner: 0, price: 4 },
    { playerId: 2, owner: 1, price: 6 },
  ]);
  assert.deepEqual(state.undone, []);
});

test("replayHistory preserves custom team names and starting credits", () => {
  const state = replayHistory(
    [{ playerId: 1, owner: 0, price: 4 }],
    players,
    rules,
    [
      { name: "Alpha", startingCredits: 30 },
      { name: "Beta", startingCredits: 30 },
    ],
  );
  assert.equal(state.teams[0].name, "Alpha");
  assert.equal(state.teams[1].name, "Beta");
  assert.equal(state.teams[0].startingCredits, 30);
  assert.equal(state.teams[0].credits, 26);
});

test("replayHistory rejects non-increment prices", () => {
  assert.equal(
    replayHistory([{ playerId: 1, owner: 0, price: 5 }], players, rules),
    null,
  );
});

test("replayHistory rejects prices above legalMaxBid", () => {
  assert.equal(
    replayHistory([{ playerId: 1, owner: 0, price: 20 }], players, rules),
    null,
  );
});

test("replayHistory rejects already assigned players", () => {
  assert.equal(
    replayHistory(
      [
        { playerId: 1, owner: 0, price: 4 },
        { playerId: 1, owner: 1, price: 4 },
      ],
      players,
      rules,
    ),
    null,
  );
});
