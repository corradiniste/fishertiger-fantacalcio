import test from "node:test";
import assert from "node:assert/strict";
import { serializeAuction, emptyAuction } from "../src/auction-state.js";
import {
  celebrationFromAssignment,
  liveChannelName,
  publishCelebration,
  publishLiveState,
  subscribeLiveState,
} from "../src/auction-live-sync.js";

const rules = {
  participants: 2,
  teamNames: ["A", "B"],
  startingCredits: 100,
  rosterSlots: { P: 1, A: 1 },
  auction: { minPrice: 1, increment: 1, reserve: 1 },
};

test("live channel name is profile-scoped", () => {
  assert.equal(liveChannelName("serie-a"), "fanta-auction-live:serie-a");
  assert.equal(liveChannelName("a/b"), "fanta-auction-live:a%2Fb");
});

test("celebrationFromAssignment builds stable seq ids and replay ids", () => {
  const player = { id: 9, nome: "Malen", ruolo: "A", squadra: "Roma" };
  const first = celebrationFromAssignment({
    player,
    teamName: "Tigers",
    owner: 2,
    price: 40,
    seq: 3,
  });
  assert.equal(first.id, "9:2:40:h3");
  assert.equal(first.club, "Roma");
  assert.equal(first.teamName, "Tigers");
  const replay = celebrationFromAssignment({
    player,
    teamName: "Tigers",
    owner: 2,
    price: 40,
    replay: true,
  });
  assert.match(replay.id, /^9:2:40:replay-/);
});

test("subscribeLiveState delivers BroadcastChannel payloads", async () => {
  if (typeof BroadcastChannel === "undefined") {
    assert.ok(true, "BroadcastChannel unavailable in this runtime");
    return;
  }
  const profileId = `test-${Date.now()}`;
  const state = emptyAuction(rules);
  state.nominator = 1;
  const received = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("no message")), 1000);
    const stop = subscribeLiveState(profileId, (payload) => {
      clearTimeout(timeout);
      stop();
      resolve(payload);
    });
    const channel = new BroadcastChannel(
      `fanta-auction-live:${encodeURIComponent(profileId)}`,
    );
    publishLiveState(channel, state, profileId);
    channel.close();
  });
  assert.equal(received.nominator, 1);
  assert.deepEqual(received.history, serializeAuction(state).history);
});

test("subscribeLiveState delivers celebration payloads", async () => {
  if (typeof BroadcastChannel === "undefined") {
    assert.ok(true, "BroadcastChannel unavailable in this runtime");
    return;
  }
  const profileId = `celeb-${Date.now()}`;
  const celebration = celebrationFromAssignment({
    player: { id: 1, nome: "X", ruolo: "A", squadra: "Napoli" },
    teamName: "Mine",
    owner: 0,
    price: 12,
    seq: 1,
  });
  const received = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("no celebrate")), 1000);
    const stop = subscribeLiveState(
      profileId,
      () => {},
      (payload) => {
        clearTimeout(timeout);
        stop();
        resolve(payload);
      },
    );
    const channel = new BroadcastChannel(
      `fanta-auction-live:${encodeURIComponent(profileId)}`,
    );
    publishCelebration(channel, celebration, profileId);
    channel.close();
  });
  assert.equal(received.playerName, "X");
  assert.equal(received.price, 12);
});
