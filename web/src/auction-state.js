export const AUCTION_STORAGE_VERSION = 2;

const integer = (value, minimum = 0) =>
  Number.isInteger(Number(value)) && Number(value) >= minimum
    ? Number(value)
    : null;

export const playerIdKey = (id) => String(id);

export const auctionStorageKey = (profileId) =>
  `fanta-auction-v${AUCTION_STORAGE_VERSION}:${encodeURIComponent(profileId || "default")}`;

const teamNames = (rules) =>
  Array.from({ length: rules.participants }, (_, index) =>
    String(
      rules.teamNames?.[index] ||
        (index === 0 ? "La mia squadra" : `Squadra ${index + 1}`),
    ),
  );

const clampNominator = (value, teamCount) => {
  const index = integer(value, 0);
  if (index == null || teamCount < 1) return 0;
  return index < teamCount ? index : 0;
};

const parseBid = (item) => {
  const team = integer(item?.team ?? item?.t, 0);
  const price = integer(item?.price ?? item?.p, 1);
  const ts = integer(item?.ts, 0) ?? Date.now();
  return team == null || price == null ? null : { team, price, ts };
};

const parseLot = (lot) => {
  if (!lot || typeof lot !== "object" || lot.playerId == null) return null;
  return { playerId: lot.playerId };
};

export const emptyAuction = (rules) => ({
  teams: teamNames(rules).map((name) => ({
    name,
    startingCredits: rules.startingCredits,
    credits: rules.startingCredits,
    roster: [],
  })),
  assigned: {},
  history: [],
  undone: [],
  nominator: 0,
  bids: [],
  lot: null,
});

export const slotsLeft = (team, rules) =>
  Object.fromEntries(
    Object.entries(rules.rosterSlots).map(([role, count]) => [
      role,
      count - (team.roster || []).filter((player) => player.ruolo === role).length,
    ]),
  );

export const legalMaxBid = (team, rules) => {
  const openSlots = Object.values(slotsLeft(team, rules)).reduce(
    (sum, count) => sum + Math.max(0, count),
    0,
  );
  return Math.max(0, team.credits - Math.max(0, openSlots - 1) * rules.auction.reserve);
};

export const isValidBid = (price, team, rules) => {
  const value = integer(price, rules.auction.minPrice);
  return (
    value != null &&
    (value - rules.auction.minPrice) % rules.auction.increment === 0 &&
    value <= legalMaxBid(team, rules)
  );
};

export const topBid = (bids = []) =>
  [...bids].sort((a, b) => b.price - a.price || b.ts - a.ts)[0] || null;

export const setNominator = (state, index) => {
  const next = clampNominator(index, state.teams.length);
  return next === state.nominator ? state : { ...state, nominator: next };
};

export const advanceNominator = (state) => {
  const count = state.teams.length;
  if (count < 1) return state;
  return {
    ...state,
    nominator: (clampNominator(state.nominator, count) + 1) % count,
  };
};

export const clearBids = (state) =>
  state.bids?.length ? { ...state, bids: [] } : state;

export const clearLot = (state) =>
  state.lot ? { ...state, lot: null } : state;

/** When no assignments yet, league starting credits override stale per-team budgets. */
export const applyRulesStartingCredits = (state, rules) => {
  if (!state || state.history?.length) return state;
  const credits = integer(rules?.startingCredits, 1);
  if (credits == null) return state;
  if (
    state.teams.every(
      (team) => team.startingCredits === credits && team.credits === credits,
    )
  ) {
    return state;
  }
  return {
    ...state,
    teams: state.teams.map((team) => ({
      ...team,
      startingCredits: credits,
      credits,
    })),
  };
};

export const addBid = (state, { team, price }, rules) => {
  const teamIndex = integer(team, 0);
  const bidPrice = integer(price, rules.auction.minPrice);
  if (teamIndex == null || teamIndex >= state.teams.length) return state;
  const squad = state.teams[teamIndex];
  if (!isValidBid(bidPrice, squad, rules)) return state;
  const current = topBid(state.bids);
  if (current && bidPrice <= current.price) return state;
  return {
    ...state,
    bids: [
      ...(state.bids || []),
      { team: teamIndex, price: bidPrice, ts: Date.now() },
    ],
  };
};

const transactionFrom = (item) => {
  const playerId = item?.playerId ?? item?.player?.id;
  const owner = integer(item?.owner);
  const price = integer(item?.price, 1);
  return playerId == null || owner == null || price == null
    ? null
    : { playerId, owner, price };
};

const teamsFromSeed = (rules, teamsSeed) => {
  const names = teamNames(rules);
  const source =
    Array.isArray(teamsSeed) && teamsSeed.length === rules.participants
      ? teamsSeed
      : null;
  return (source || names.map((name) => ({ name }))).map((team, index) => {
    const starting =
      integer(team?.startingCredits, 0) ?? integer(rules.startingCredits, 0);
    return {
      name:
        typeof team?.name === "string" && team.name
          ? team.name
          : names[index],
      startingCredits: starting ?? rules.startingCredits,
      credits: starting ?? rules.startingCredits,
      roster: [],
    };
  });
};

/**
 * Replays compact bid history into teams / assigned / history.
 * Optional teamsSeed preserves custom names and per-team starting credits.
 * Returns null when any transaction is invalid (missing player, no slot, bad price, duplicate).
 */
export const replayHistory = (history, players, rules, teamsSeed) => {
  if (!Array.isArray(history)) return null;
  const playersById = new Map(
    (players || []).map((player) => [playerIdKey(player.id), player]),
  );
  const transactions = history.map(transactionFrom);
  if (transactions.some((item) => !item)) return null;
  const state = {
    teams: teamsFromSeed(rules, teamsSeed),
    assigned: {},
    history: [],
    undone: [],
  };
  for (const transaction of transactions) {
    const player = playersById.get(playerIdKey(transaction.playerId));
    const team = state.teams[transaction.owner];
    if (
      !player ||
      !team ||
      state.assigned[playerIdKey(transaction.playerId)] ||
      !Object.hasOwn(rules.rosterSlots, player.ruolo) ||
      slotsLeft(team, rules)[player.ruolo] < 1 ||
      !isValidBid(transaction.price, team, rules)
    ) {
      return null;
    }
    const record = {
      playerId: player.id,
      owner: transaction.owner,
      price: transaction.price,
    };
    team.credits -= transaction.price;
    team.roster.push(player);
    state.assigned[playerIdKey(player.id)] = {
      owner: transaction.owner,
      price: transaction.price,
    };
    state.history.push(record);
  }
  return state;
};

/** Rebuilds runtime player references from compact, versioned transactions. */
export const rehydrateAuction = (saved, players, rules) => {
  if (!saved || typeof saved !== "object") return null;
  const isCurrent = saved.version === AUCTION_STORAGE_VERSION;
  const rawTeams = Array.isArray(saved.teams) ? saved.teams : null;
  const rawHistory = Array.isArray(saved.history) ? saved.history : null;
  const rawUndone = Array.isArray(saved.undone) ? saved.undone : [];
  if (!rawTeams || rawTeams.length !== rules.participants || !rawHistory) return null;
  const playersById = new Map((players || []).map((player) => [playerIdKey(player.id), player]));
  const transactions = rawHistory.map(transactionFrom);
  const undone = rawUndone.map(transactionFrom);
  if (transactions.some((item) => !item) || undone.some((item) => !item)) return null;
  const spent = rawTeams.map((_, index) =>
    transactions.reduce((sum, item) => sum + (item.owner === index ? item.price : 0), 0),
  );
  const teams = rawTeams.map((team, index) => {
    const credits = integer(isCurrent ? team?.startingCredits : Number(team?.credits) + spent[index], 0);
    return typeof team?.name === "string" && credits != null
      ? { name: team.name, startingCredits: credits, credits, roster: [] }
      : null;
  });
  if (teams.some((team) => !team)) return null;
  const state = replayHistory(transactions, players, rules, teams);
  if (!state) return null;
  const redoState = {
    ...state,
    teams: state.teams.map((team) => ({ ...team, roster: team.roster.slice() })),
    assigned: { ...state.assigned },
  };
  // Redo restores the newest undone transaction first, so validate that sequence.
  for (const item of undone.slice().reverse()) {
    const player = playersById.get(playerIdKey(item.playerId));
    const team = redoState.teams[item.owner];
    if (
      !player ||
      !team ||
      redoState.assigned[playerIdKey(item.playerId)] ||
      !Object.hasOwn(rules.rosterSlots, player.ruolo) ||
      slotsLeft(team, rules)[player.ruolo] < 1 ||
      !isValidBid(item.price, team, rules)
    ) return null;
    team.credits -= item.price;
    team.roster.push(player);
    redoState.assigned[playerIdKey(item.playerId)] = { owner: item.owner, price: item.price };
  }
  state.undone = undone.map((item) => ({ ...item, playerId: playersById.get(playerIdKey(item.playerId)).id }));
  const bids = Array.isArray(saved.bids)
    ? saved.bids.map(parseBid).filter(Boolean).filter((bid) => bid.team < state.teams.length)
    : [];
  state.nominator = clampNominator(saved.nominator, state.teams.length);
  state.bids = bids;
  state.lot = parseLot(saved.lot);
  return applyRulesStartingCredits(state, rules);
};

export const serializeAuction = (state) => ({
  version: AUCTION_STORAGE_VERSION,
  teams: state.teams.map(({ name, startingCredits }) => ({ name, startingCredits })),
  history: state.history.map(({ playerId, owner, price }) => ({ playerId, owner, price })),
  undone: (state.undone || []).map(({ playerId, owner, price }) => ({ playerId, owner, price })),
  nominator: clampNominator(state.nominator, state.teams.length),
  bids: (state.bids || []).map(({ team, price, ts }) => ({ t: team, p: price, ts })),
  lot: state.lot?.playerId != null ? { playerId: state.lot.playerId } : null,
});
