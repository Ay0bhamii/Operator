export type RankedGameId = "block-rush" | "nim-pin" | "sequence" | "memory" | "nim-lock" | "vault" | "sync";
export type GameId = RankedGameId | "block-rush" | "nim-grid" | "sync";

export type GameEvent = { t: number; type: "key" | "choice"; value: string };
export type Puzzle =
  | { gameId: "nim-pin"; pin: string }
  | { gameId: "sequence"; sequence: string[] }
  | { gameId: "memory"; tokens: string[] }
  | { gameId: "nim-lock" | "vault"; targetAngles: number[] };
export type ReplayResult = { score: number; xp: number; valid: boolean; reason?: string };

const sequenceChars = "QWERASD";
const memoryTokens = ["NQ", "7F", "3A", "C2", "91", "D8"];

function seeded(seed: string) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Difficulty is encoded into a server-issued seed, so the client and replay verifier
 * always derive the identical challenge without trusting a client-selected level. */
export function difficultyTier(seed: string) {
  const match = seed.match(/^t([1-4]):/);
  return match ? Number(match[1]) : 2;
}

function requireEvents(events: GameEvent[]) {
  if (!Array.isArray(events) || events.length === 0) return "no events";
  let previous = -1;
  for (const event of events) {
    if (!Number.isFinite(event.t) || event.t < 0 || event.t < previous) return "invalid event timing";
    previous = event.t;
  }
  return null;
}

export function createPuzzle(gameId: Exclude<RankedGameId, "block-rush" | "sync">, seed: string): Puzzle {
  const random = seeded(`${gameId}:${seed}`);
  const tier = difficultyTier(seed);
  if (gameId === "nim-pin") {
    return { gameId, pin: Array.from({ length: 2 + tier }, () => String(Math.floor(random() * 10))).join("") };
  }
  if (gameId === "sequence") {
    return { gameId, sequence: Array.from({ length: 8 + tier * 2 }, () => sequenceChars[Math.floor(random() * sequenceChars.length)]) };
  }
  if (gameId === "nim-lock" || gameId === "vault") {
    return { gameId, targetAngles: Array.from({ length: gameId === "vault" ? 3 + tier : 2 + tier }, () => Math.floor(random() * 8) * 45) };
  }
  return { gameId, tokens: Array.from({ length: 4 + tier }, () => memoryTokens[Math.floor(random() * memoryTokens.length)]) };
}

export function replay(gameId: RankedGameId, seed: string, events: GameEvent[]): ReplayResult {
  const timingError = requireEvents(events);
  if (timingError) return { score: 0, xp: 0, valid: false, reason: timingError };
  if (gameId === "block-rush") {
    if (events.some(event => event.type !== "choice" || !/^\d+$/.test(event.value))) return { score: 0, xp: 0, valid: false, reason: "invalid block event" };
    const groups = events.map(event => Number(event.value));
    if (groups.some(group => group < 3 || group > 88)) return { score: 0, xp: 0, valid: false, reason: "invalid block group" };
    const score = groups.reduce((total, group) => total + group * group * 10, 0);
    return { score, xp: 150, valid: true };
  }
  if (gameId === "sync") {
    if (events.some(event => event.type !== "choice" || !/^(hit|miss)$/.test(event.value))) return { score: 0, xp: 0, valid: false, reason: "invalid sync event" };
    const hits = events.filter(event => event.value === "hit").length;
    if (hits < 5) return { score: 0, xp: 0, valid: false, reason: "sync challenge incomplete" };
    return { score: hits * 100, xp: 150, valid: true };
  }
  const puzzle = createPuzzle(gameId, seed);
  const minimumGap = gameId === "sequence" ? 70 : gameId === "nim-lock" || gameId === "vault" ? 100 : 80;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].t - events[index - 1].t < minimumGap) return { score: 0, xp: 0, valid: false, reason: "events too fast" };
  }
  const values = events.map(event => event.value);
  if (puzzle.gameId === "nim-lock" || puzzle.gameId === "vault") {
    const clicks = Array.from({ length: puzzle.targetAngles.length }, () => 0);
    for (const event of events) {
      if (event.type !== "choice" || !/^\d+$/.test(event.value)) return { score: 0, xp: 0, valid: false, reason: "invalid ring event" };
      const ring = Number(event.value);
      if (ring < 0 || ring >= clicks.length) return { score: 0, xp: 0, valid: false, reason: "invalid ring" };
      clicks[ring] += 1;
    }
    const valid = clicks.every((count, index) => Math.abs(((count * 45 - puzzle.targetAngles[index] + 540) % 360) - 180) < 12);
    if (!valid) return { score: 0, xp: 0, valid: false, reason: "wrong solution" };
    const duration = events[events.length - 1].t;
    const limit = puzzle.gameId === "vault" ? 10000 : 20000;
    return { score: Math.max(100, Math.round((limit - duration) / 5) + clicks.length * 100), xp: puzzle.gameId === "vault" ? 220 : 180, valid: true };
  }
  const target = puzzle.gameId === "nim-pin" ? [puzzle.pin] : puzzle.gameId === "sequence" ? puzzle.sequence : puzzle.gameId === "memory" ? puzzle.tokens : [];
  const valid = values.length === target.length && values.every((value, index) => value === target[index]);
  if (!valid) return { score: 0, xp: 0, valid: false, reason: "wrong solution" };
  const duration = events[events.length - 1].t;
  if (duration < target.length * minimumGap) return { score: 0, xp: 0, valid: false, reason: "duration below minimum" };
  const limit = gameId === "nim-pin" ? 12000 : gameId === "sequence" ? 7000 : 2500;
  const score = Math.max(100, Math.round((limit - duration) / (gameId === "sequence" ? 2 : 4)));
  return { score, xp: gameId === "sequence" ? 180 : gameId === "nim-pin" ? 125 : 160, valid: true };
}

export function dailyGame(day: string): RankedGameId {
  const rotation: RankedGameId[] = ["block-rush", "nim-pin", "memory", "vault", "sync"];
  let value = 0;
  for (const character of day) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return rotation[value % rotation.length];
}
