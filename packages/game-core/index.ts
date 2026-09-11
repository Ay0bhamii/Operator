export type RankedGameId =
  | "reaction" | "color" | "whack" | "flight" | "pop" | "memory" | "stack";
export type GameId = RankedGameId;

export type GameEvent = { t: number; type: "key" | "choice"; value: string };
export type Puzzle =
  | { gameId: "reaction"; delay: number }
  | { gameId: "color"; rounds: { word: number; ink: number }[]; limits: number[] }
  | { gameId: "whack"; duration: number; targets: { slot: number; from: number; to: number }[] }
  | { gameId: "flight"; pipes: { x: number; gapY: number; gap: number }[]; ground: number; ceiling: number }
  | { gameId: "pop"; duration: number; balloons: { slot: number; spawnAt: number }[] }
  | { gameId: "memory"; rounds: { colors: number[]; showMs: number }[] }
  | { gameId: "stack"; period: number; amplitude: number; phase: number; target: number; startWidth: number };
export type ReplayResult = { score: number; xp: number; valid: boolean; completed?: boolean; reason?: string };

/** Shared visual palette (indices 0-3) used by color, memory, and the client UI. */
export const COLOR_NAMES = ["RED", "GREEN", "BLUE", "GOLD"] as const;
export const COLORS = ["#e8433c", "#4cd964", "#4ba3ff", "#ffd84d"] as const;
export const WHACK_SLOTS = 9;
export const POP_SLOTS = 6;

/** Flight physics constants. Kept here so client rendering and server replay are identical. */
export const FLIGHT = {
  speed: 0.22,
  gravity: 0.0011,
  flap: -0.5,
  birdX: 80,
  startY: 300,
  groundPad: 20,
  ceiling: 10,
  gapHalf: 96,
} as const;

export function seeded(seed: string) {
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
  if (!Array.isArray(events)) return "invalid events";
  let previous = -1;
  for (const event of events) {
    if (!Number.isFinite(event.t) || event.t < 0 || event.t < previous) return "invalid event timing";
    previous = event.t;
  }
  return null;
}

export function createPuzzle(gameId: RankedGameId, seed: string): Puzzle {
  const random = seeded(`${gameId}:${seed}`);
  const tier = difficultyTier(seed);
  switch (gameId) {
    case "reaction":
      return { gameId, delay: Math.round(1200 - tier * 60 + random() * 1300) };
    case "color": {
      const count = 4 + tier;
      const rounds = Array.from({ length: count }, () => ({
        word: Math.floor(random() * 4),
        ink: Math.floor(random() * 4),
      }));
      const limits = rounds.map((_, index) => Math.max(900, 2800 - index * 220));
      return { gameId, rounds, limits };
    }
    case "whack": {
      const duration = 10_000;
      const targetCount = 10 + tier * 2;
      const targets: { slot: number; from: number; to: number }[] = [];
      for (let index = 0; index < targetCount; index += 1) {
        const slot = Math.floor(random() * WHACK_SLOTS);
        const from = Math.max(150, Math.round(150 + random() * 7200));
        targets.push({ slot, from, to: Math.min(duration - 100, from + 800 + random() * 500) });
      }
      return { gameId, duration, targets };
    }
    case "flight": {
      const count = 4 + tier;
      const gap = Math.max(150, 224 - tier * 16);
      const pipes = Array.from({ length: count }, (_, index) => ({
        x: Math.round(520 + index * 300 + random() * 60),
        gapY: Math.round(150 + random() * 280),
        gap,
      }));
      return { gameId, pipes, ground: 600 - FLIGHT.groundPad, ceiling: FLIGHT.ceiling };
    }
    case "pop": {
      const duration = 20_000;
      const count = 13 + tier * 3;
      const step = (duration - 400) / count;
      const balloons = Array.from({ length: count }, (_, index) => ({
        slot: Math.floor(random() * POP_SLOTS),
        spawnAt: Math.round(250 + index * step + random() * step * 0.4),
      }));
      return { gameId, duration, balloons };
    }
    case "memory": {
      const rounds: { colors: number[]; showMs: number }[] = [];
      for (let round = 0; round < 3 + tier; round += 1) {
        const length = 3 + round;
        rounds.push({
          colors: Array.from({ length }, () => Math.floor(random() * 4)),
          showMs: Math.round(600 + length * 130),
        });
      }
      return { gameId, rounds };
    }
    case "stack":
      return {
        gameId,
        period: Math.round(2300 - tier * 130 + random() * 600),
        amplitude: 250 + tier * 20,
        phase: random() * Math.PI * 2,
        target: 6 + tier,
        startWidth: 130,
      };
  }
}

// XP is calculated during the authoritative replay. A faster valid completion
// earns up to double the base XP; the client never supplies an XP value.
function speedXp(baseXp: number, duration: number, limit: number) {
  const remainingRatio = Math.max(0, Math.min(1, (limit - duration) / limit));
  return baseXp + Math.round(baseXp * remainingRatio);
}

function progressReward(baseXp: number, progress: number, duration: number, limit: number) {
  if (progress <= 0) return 0;
  return Math.max(1, Math.round(speedXp(baseXp, duration, limit) * Math.min(1, progress)));
}

/** Deterministic tower-stack block position. Shared by client animation and server replay. */
export function stackBlockX(puzzle: { amplitude: number; period: number; phase: number }, t: number) {
  return puzzle.amplitude * Math.sin(2 * Math.PI * t / puzzle.period + puzzle.phase);
}

/**
 * Deterministic flight simulation. `flaps` are the exact tap timestamps from the run.
 * Between taps the bird follows a ballistic parabola under constant gravity, so the
 * client renders exactly what the server verifies. Returns pipes passed + crash state.
 */
export function simulateFlight(
  puzzle: { pipes: { x: number; gapY: number; gap: number }[]; ground: number; ceiling: number },
  flaps: number[],
): { passed: number; crashed: boolean; groundDead: boolean } {
  const { ground } = puzzle;
  const birdX = FLIGHT.birdX, speed = FLIGHT.speed, g = FLIGHT.gravity, flapV = FLIGHT.flap, startY = FLIGHT.startY;
  const crossings = puzzle.pipes
    .map((pipe, index) => ({ at: (pipe.x - birdX) / speed, gapY: pipe.gapY, index }))
    .sort((a, b) => a.at - b.at);
  const flapTimes = [...flaps].sort((a, b) => a - b);
  let y: number = startY, vy = 0, passed = 0, groundDead = false, focus = 0, flapIndex = 0;
  for (const cross of crossings) {
    while (flapIndex < flapTimes.length && flapTimes[flapIndex] <= cross.at && !groundDead) {
      const dt = flapTimes[flapIndex] - focus;
      if (dt > 0) {
        const y2 = y + vy * dt + 0.5 * g * dt * dt;
        if (y2 >= ground) { groundDead = true; break; }
        y = Math.max(Math.min(y2, ground), puzzle.ceiling);
        vy = vy + g * dt;
        focus = flapTimes[flapIndex];
      }
      vy = flapV;
      flapIndex += 1;
    }
    if (groundDead) break;
    const dt = cross.at - focus;
    if (dt > 0) {
      const y2 = y + vy * dt + 0.5 * g * dt * dt;
      if (y2 >= ground) { passed = cross.index; groundDead = true; break; }
      y = Math.max(Math.min(y2, ground), puzzle.ceiling);
      vy = vy + g * dt;
      focus = cross.at;
    }
    if (Math.abs(y - cross.gapY) <= FLIGHT.gapHalf) {
      passed = cross.index + 1;
    } else {
      passed = cross.index;
      break;
    }
  }
  return { passed, crashed: !groundDead && passed < puzzle.pipes.length, groundDead };
}
const invalid = (reason: string): ReplayResult => ({ score: 0, xp: 0, valid: false, reason });
const incomplete: ReplayResult = { score: 0, xp: 0, valid: true, completed: false };

/** Authoritative replay: recomputes the entire run from the seeded puzzle and the raw
 * input timeline. The client never supplies a score - this function is the scoreboard. */
export function replay(gameId: RankedGameId, seed: string, events: GameEvent[]): ReplayResult {
  const bad = requireEvents(events);
  if (bad) return invalid(bad);
  switch (gameId) {
    case "reaction": {
      if (events.length > 1) return invalid("too many events");
      if (events.length === 1 && (events[0].type !== "choice" || events[0].value !== "go")) return invalid("invalid reaction event");
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("reaction", seed);
      if (puzzle.gameId !== "reaction") return invalid("puzzle mismatch");
      const t = events[0].t;
      if (t < puzzle.delay) return invalid("false start");
      return { score: Math.max(10, Math.min(1000, 1000 - (t - puzzle.delay))), xp: progressReward(150, 1, t, 10000), valid: true, completed: true };
    }
    case "color": {
      if (events.some(event => event.type !== "choice" || !/^[0-3]$/.test(event.value))) return invalid("invalid color event");
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("color", seed);
      if (puzzle.gameId !== "color") return invalid("puzzle mismatch");
      let correct = 0;
      let previous = 0;
      for (let index = 0; index < events.length && index < puzzle.rounds.length; index += 1) {
        if (events[index].t - previous > (puzzle.limits[index] ?? 1200) + 600) break;
        if (Number(events[index].value) !== puzzle.rounds[index].ink) break;
        correct += 1;
        previous = events[index].t;
      }
      const duration = events[events.length - 1]?.t ?? 0;
      const completed = correct === puzzle.rounds.length;
      return { score: correct * 100 + (completed ? 200 : 0), xp: progressReward(160, correct / puzzle.rounds.length, duration, 20000), valid: true, completed };
    }
    case "whack": {
      if (events.length > 60) return invalid("too many events");
      if (events.some(event => event.type !== "choice" || !/^\d$/.test(event.value))) return invalid("invalid whack event");
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("whack", seed);
      if (puzzle.gameId !== "whack") return invalid("puzzle mismatch");
      const pending = [...puzzle.targets];
      let hits = 0;
      let misses = 0;
      for (const event of events) {
        const index = pending.findIndex(target => target.slot === Number(event.value) && event.t >= target.from && event.t <= target.to + 250);
        if (index >= 0) { pending.splice(index, 1); hits += 1; } else { misses += 1; }
      }
      const duration = Math.min(events[events.length - 1]?.t ?? 0, puzzle.duration);
      return { score: Math.max(0, hits * 100 - misses * 40), xp: progressReward(160, hits / 10, duration, 10000), valid: true, completed: hits >= 10 };
    }
    case "flight": {
      if (events.length > 120) return invalid("too many events");
      if (events.some(event => event.type !== "key" || event.value !== "flap")) return invalid("invalid flight event");
      const puzzle = createPuzzle("flight", seed);
      if (puzzle.gameId !== "flight") return invalid("puzzle mismatch");
      const flaps = events.map(event => event.t);
      const flight = simulateFlight(puzzle, flaps);
      const completed = flight.passed === puzzle.pipes.length && !flight.crashed && !flight.groundDead;
      const duration = flaps[flaps.length - 1] ?? 0;
      return { score: flight.passed * 120 + (completed ? 300 : 0), xp: progressReward(180, flight.passed / puzzle.pipes.length, duration, 30000), valid: true, completed };
    }
    case "pop": {
      if (events.length > 80) return invalid("too many events");
      if (events.some(event => event.type !== "choice" || !/^\d$/.test(event.value))) return invalid("invalid pop event");
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("pop", seed);
      if (puzzle.gameId !== "pop") return invalid("puzzle mismatch");
      const pending = [...puzzle.balloons];
      let popped = 0;
      let misses = 0;
      for (const event of events) {
        const index = pending.findIndex(balloon => balloon.slot === Number(event.value) && event.t >= balloon.spawnAt && event.t <= balloon.spawnAt + 1550);
        if (index >= 0) { pending.splice(index, 1); popped += 1; } else { misses += 1; }
      }
      const duration = Math.min(events[events.length - 1]?.t ?? 0, puzzle.duration);
      const goal = Math.ceil(puzzle.balloons.length * 0.8);
      return { score: Math.max(0, popped * 80 - misses * 30), xp: progressReward(170, popped / goal, duration, 20000), valid: true, completed: popped >= goal };
    }
    case "memory": {
      if (events.some(event => event.type !== "choice" || !/^[0-3]$/.test(event.value))) return invalid("invalid memory event");
      for (let index = 1; index < events.length; index += 1) {
        if (events[index].t - events[index - 1].t < 120) return invalid("events too fast");
      }
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("memory", seed);
      if (puzzle.gameId !== "memory") return invalid("puzzle mismatch");
      let cursor = 0;
      let correctRounds = 0;
      for (const round of puzzle.rounds) {
        if (cursor + round.colors.length > events.length) break;
        const matched = round.colors.every((color, index) => Number(events[cursor + index].value) === color);
        if (!matched) break;
        cursor += round.colors.length;
        correctRounds += 1;
      }
      const duration = cursor > 0 ? events[cursor - 1].t : 0;
      const completed = correctRounds === puzzle.rounds.length;
      return { score: correctRounds * 200 + (completed ? 100 : 0), xp: progressReward(180, correctRounds / puzzle.rounds.length, duration, 40000), valid: true, completed };
    }
    case "stack": {
      if (events.length > 40) return invalid("too many events");
      if (events.some(event => event.type !== "choice" || !/^-?\d+$/.test(event.value))) return invalid("invalid stack event");
      for (let index = 1; index < events.length; index += 1) {
        if (events[index].t - events[index - 1].t < 150) return invalid("events too fast");
      }
      if (events.length === 0) return incomplete;
      const puzzle = createPuzzle("stack", seed);
      if (puzzle.gameId !== "stack") return invalid("puzzle mismatch");
      let width = puzzle.startWidth;
      let blocks = 0;
      let previousX = 0;
      for (const event of events) {
        const x = stackBlockX(puzzle, event.t);
        if (Math.abs(x - Number(event.value)) > 3) return invalid("input desync");
        const offset = Math.abs(x - previousX);
        if (offset >= width) break;
        width = Math.max(16, width - offset * 0.5);
        previousX = x;
        blocks += 1;
      }
      const duration = events[events.length - 1]?.t ?? 0;
      const completed = blocks >= puzzle.target;
      return { score: blocks * 150 + (completed ? 250 : 0), xp: progressReward(200, blocks / puzzle.target, duration, 30000), valid: true, completed };
    }
  }
}

export function dailyGame(day: string): RankedGameId {
  const rotation: RankedGameId[] = ["reaction", "color", "whack", "flight", "pop", "memory", "stack"];
  let value = 0;
  for (const character of day) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return rotation[value % rotation.length];
}
