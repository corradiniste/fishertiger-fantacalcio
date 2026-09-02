import {
  auctionStorageKey,
  rehydrateAuction,
  serializeAuction,
} from "./auction-state.js";

export const liveChannelName = (profileId) =>
  `fanta-auction-live:${encodeURIComponent(profileId || "default")}`;

export const liveChannel = (profileId) => {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(liveChannelName(profileId));
  } catch {
    return null;
  }
};

export const publishLiveState = (channel, state, profileId) => {
  if (!channel || !state) return;
  try {
    channel.postMessage({
      kind: "auction-state",
      profileId,
      state: serializeAuction(state),
      ts: Date.now(),
    });
  } catch {
    /* channel closed / structured-clone failure */
  }
};

/** Build a display-ready celebration payload from an assignment. */
export const celebrationFromAssignment = ({
  player,
  teamName,
  owner,
  price,
  seq,
  replay = false,
}) => {
  const playerId = player?.id ?? null;
  const key = playerId == null ? "x" : String(playerId);
  const sequence = replay
    ? `replay-${Date.now()}`
    : seq != null
      ? `h${seq}`
      : `t${Date.now()}`;
  return {
    id: `${key}:${owner}:${price}:${sequence}`,
    playerId,
    playerName: player?.nome || "Giocatore",
    ruolo: player?.ruolo || "",
    club: player?.squadra || "",
    owner: Number(owner),
    teamName: teamName || `Squadra ${Number(owner) + 1}`,
    price: Number(price),
  };
};
export const publishCelebration = (channel, celebration, profileId) => {
  if (!channel || !celebration) return;
  try {
    channel.postMessage({
      kind: "auction-celebrate",
      profileId,
      celebration,
      ts: Date.now(),
    });
  } catch {
    /* channel closed */
  }
};

/**
 * Subscribe to live auction events for a profile.
 * onState(saved) for state sync; onCelebrate(celebration) for assignment FX.
 */
export const subscribeLiveState = (profileId, onState, onCelebrate) => {
  const channel = liveChannel(profileId);
  const storageKey = auctionStorageKey(profileId);
  const onMsg = (event) => {
    const payload = event?.data;
    if (!payload || typeof payload !== "object") return;
    if (payload.profileId != null && String(payload.profileId) !== String(profileId))
      return;
    if (payload.kind === "auction-state" && payload.state) {
      onState?.(payload.state);
      return;
    }
    if (payload.kind === "auction-celebrate" && payload.celebration) {
      onCelebrate?.(payload.celebration);
    }
  };
  channel?.addEventListener("message", onMsg);
  const onStorage = (event) => {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      onState?.(JSON.parse(event.newValue));
    } catch {
      /* ignore corrupt storage */
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    channel?.removeEventListener("message", onMsg);
    channel?.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
};

/** Rehydrate a compact live payload when players + rules are available. */
export const rehydrateLivePayload = (saved, players, rules) =>
  rehydrateAuction(saved, players, rules);
