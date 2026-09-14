import assert from "node:assert/strict";
import test from "node:test";
import { createPuzzle, dailyGame, replay, simulateFlight, stackBlockX } from "./index.js";

test("same seed creates the same puzzle", () => {
  assert.deepEqual(createPuzzle("reaction", "abc"), createPuzzle("reaction", "abc"));
  assert.notDeepEqual(createPuzzle("stack", "abc"), createPuzzle("stack", "def"));
});

test("daily rotation always selects a ranked challenge", () => {
  const ranked = new Set(["reaction", "color", "whack", "flight", "pop", "memory", "stack"]);
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]) assert.equal(ranked.has(dailyGame(day)), true);
});

test("reaction: valid click scores, false start rejected, silence incomplete", () => {
  const puzzle = createPuzzle("reaction", "seed-reaction");
  if (puzzle.gameId !== "reaction") return;
  const good = replay("reaction", "seed-reaction", [{ t: puzzle.delay + 180, type: "choice", value: "go" }]);
  assert.equal(good.valid, true);
  assert.equal(good.completed, true);
  assert.equal(good.score > 0 && good.score <= 1000, true);
  const early = replay("reaction", "seed-reaction", [{ t: Math.max(0, puzzle.delay - 5), type: "choice", value: "go" }]);
  assert.equal(early.valid, false);
  const idle = replay("reaction", "seed-reaction", []);
  assert.equal(idle.valid, true);
  assert.equal(idle.score, 0);
  assert.equal(idle.completed, false);
});

test("color: correct streak completes, wrong ink stops the run", () => {
  const puzzle = createPuzzle("color", "seed-color");
  if (puzzle.gameId !== "color") return;
  const events = puzzle.rounds.map((round, index) => ({ t: 400 * (index + 1), type: "choice" as const, value: String(round.ink) }));
  const result = replay("color", "seed-color", events);
  assert.equal(result.valid, true);
  assert.equal(result.completed, true);
  assert.equal(result.score, puzzle.rounds.length * 100 + 200);
  const broken = events.map((event, index) => index === 1 ? { t: event.t, type: "choice" as const, value: String((puzzle.rounds[1].ink + 1) % 4) } : event);
  const partial = replay("color", "seed-color", broken);
  assert.equal(partial.valid, true);
  assert.equal(partial.completed, false);
  assert.equal(partial.score, 100);
});

test("whack: windowed hits score and wild swings are penalised", () => {
  const puzzle = createPuzzle("whack", "seed-whack");
  if (puzzle.gameId !== "whack") return;
  const ordered = [...puzzle.targets].sort((a, b) => a.from - b.from).slice(0, 10);
  const events = ordered.map((target, index) => ({ t: target.from + 10 + index * 40, type: "choice" as const, value: String(target.slot) }));
  const result = replay("whack", "seed-whack", events);
  assert.equal(result.valid, true);
  assert.equal(result.completed, true);
  assert.equal(result.score, 1000);
  const spam = replay("whack", "seed-whack", Array.from({ length: 60 }, (_, index) => ({ t: 100 + index * 150, type: "choice" as const, value: String(index % 9) })));
  assert.equal(spam.valid, true);
  assert.equal(spam.score < 1000, true);
});

test("pop: every scheduled balloon can be popped exactly once", () => {
  const puzzle = createPuzzle("pop", "seed-pop");
  if (puzzle.gameId !== "pop") return;
  const ordered = [...puzzle.balloons].sort((a, b) => a.spawnAt - b.spawnAt);
  const events = ordered.map((balloon, index) => ({ t: balloon.spawnAt + 5 + index * 30, type: "choice" as const, value: String(balloon.slot) }));
  const result = replay("pop", "seed-pop", events);
  assert.equal(result.valid, true);
  assert.equal(result.completed, true);
  assert.equal(result.score, ordered.length * 80);
  assert.equal(replay("pop", "seed-pop", []).completed, false);
});

test("memory: full sequence completes, wrong tile keeps partial progress", () => {
  const puzzle = createPuzzle("memory", "seed-memory");
  if (puzzle.gameId !== "memory") return;
  let t = 500;
  const events = puzzle.rounds.flatMap(round => round.colors.map(color => ({ t: (t += 250), type: "choice" as const, value: String(color) })));
  const result = replay("memory", "seed-memory", events);
  assert.equal(result.valid, true);
  assert.equal(result.completed, true);
  assert.equal(result.score, puzzle.rounds.length * 200 + 100);
  const tooFast = puzzle.rounds[0].colors.map(color => ({ t: 100, type: "choice" as const, value: String(color) }));
  assert.equal(replay("memory", "seed-memory", tooFast).reason, "events too fast");
});

test("flight: taps replay into pipes passed and wild inputs are rejected", () => {
  assert.equal(replay("flight", "seed-flight", []).completed, false);
  assert.equal(replay("flight", "seed-flight", [{ t: 200, type: "key", value: "nope" }]).valid, false);
  const flaps = Array.from({ length: 40 }, (_, index) => 300 + index * 300);
  const run = replay("flight", "seed-flight", flaps.map(t => ({ t, type: "key" as const, value: "flap" })));
  assert.equal(run.valid, true);
});

test("stack: perfectly timed drops build a complete verified tower", () => {
  const puzzle = createPuzzle("stack", "seed-stack");
  if (puzzle.gameId !== "stack") return;
  let t0 = 300;
  const events: Array<{ t: number; type: "choice"; value: string }> = [];
  for (let block = 0; block < puzzle.target; block += 1) {
    const k = Math.ceil((2 * Math.PI * t0 / puzzle.period + puzzle.phase) / Math.PI);
    const t = Math.round(((k * Math.PI - puzzle.phase) * puzzle.period) / (2 * Math.PI));
    events.push({ t, type: "choice", value: String(Math.round(stackBlockX(puzzle, t))) });
    t0 = t + 200;
  }
  const result = replay("stack", "seed-stack", events);
  assert.equal(result.valid, true);
  assert.equal(result.completed, true);
  assert.equal(result.score, puzzle.target * 150 + 250);
});

test("replay rejects malformed event timelines", () => {
  assert.equal(replay("reaction", "seed", [{ t: 200, type: "choice", value: "go" }, { t: 100, type: "choice", value: "go" }]).reason, "invalid event timing");
  assert.equal(replay("reaction", "seed", [{ t: 100, type: "key", value: "go" }]).valid, false);
  assert.equal(replay("whack", "seed", Array.from({ length: 61 }, (_, index) => ({ t: 100 + index * 150, type: "choice" as const, value: "3" }))).reason, "too many events");
});

test("flight: a bird that never flaps falls to the ground and cannot finish", () => {
  const idle = replay("flight", "seed-flight", [{ t: 8000, type: "key", value: "flap" }]);
  assert.equal(idle.valid, true);
  assert.equal(idle.completed, false);
  assert.equal(idle.score, 0);
  // Even a late flap cannot grant a passed pipe once the bird hits the floor.
  const noFlap = replay("flight", "seed-flight", []);
  assert.equal(noFlap.completed, false);
});

test("flight: live horizon verdict never projects a future ground death", () => {
  const puzzle = createPuzzle("flight", "seed-flight");
  if (puzzle.gameId !== "flight") return;
  // One flap right at the start: the bird is still safely mid-air on frame 32ms.
  const live = simulateFlight(puzzle, [16], 32);
  assert.equal(live.groundDead, false, "horizon must ignore gates the bird has not reached yet");
  // The full-stream projection (what the server replays) does see the landing.
  const full = simulateFlight(puzzle, [16]);
  assert.equal(full.groundDead, true);
});

test("flight: rapid flapping clamps at the ceiling and never grounds the bird", () => {
  // A machine-gun flap pattern rides the ceiling instead of flying off-screen or
  // falling to the floor; the run stays valid and only ends when a pipe wall is hit.
  const puzzle = createPuzzle("flight", "seed-flight");
  if (puzzle.gameId !== "flight") return;
  const flaps = Array.from({ length: 60 }, (_, index) => 100 + index * 180);
  const run = replay("flight", "seed-flight", flaps.map(t => ({ t, type: "key" as const, value: "flap" })));
  assert.equal(run.valid, true);
  assert.equal(run.completed, false);
  const sim = simulateFlight(puzzle, flaps);
  assert.equal(sim.groundDead, false);
  assert.equal(sim.crashed, true);
});

test("stack: dropped value that desyncs from the moving block is rejected", () => {
  const puzzle = createPuzzle("stack", "seed-stack");
  if (puzzle.gameId !== "stack") return;
  const t = 300;
  const x = Math.round(stackBlockX(puzzle, t));
  const desync = replay("stack", "seed-stack", [{ t, type: "choice", value: String(x + 5) }]);
  assert.equal(desync.valid, false);
  assert.equal(desync.reason, "input desync");
});

test("stack: two drops closer than 150ms are rejected as too fast", () => {
  const puzzle = createPuzzle("stack", "seed-stack");
  if (puzzle.gameId !== "stack") return;
  const t = 300;
  const x = Math.round(stackBlockX(puzzle, t));
  const fast = replay("stack", "seed-stack", [
    { t: 100, type: "choice" as const, value: String(x) },
    { t: 200, type: "choice" as const, value: String(x) },
  ]);
  assert.equal(fast.valid, false);
  assert.equal(fast.reason, "events too fast");
});

test("pop: clicking a balloon long after its window is a miss, not a score", () => {
  const puzzle = createPuzzle("pop", "seed-pop");
  if (puzzle.gameId !== "pop") return;
  const balloon = puzzle.balloons[0];
  const late = replay("pop", "seed-pop", [{ t: balloon.spawnAt + 2000, type: "choice", value: String(balloon.slot) }]);
  assert.equal(late.valid, true);
  assert.equal(late.completed, false);
  assert.equal(late.score, 0);
});

test("memory: matching only the first round keeps partial progress", () => {
  const puzzle = createPuzzle("memory", "seed-memory");
  if (puzzle.gameId !== "memory") return;
  const firstRound = puzzle.rounds[0].colors.map((color, index) => ({ t: 500 + index * 250, type: "choice" as const, value: String(color) }));
  const partial = replay("memory", "seed-memory", firstRound);
  assert.equal(partial.valid, true);
  assert.equal(partial.completed, false);
  assert.equal(partial.score, 200);
  assert.equal(partial.xp > 0, true);
});

test("difficulty tier is encoded in the seed and changes the puzzle", () => {
  const easy = createPuzzle("color", "t1:seed"),
    hard = createPuzzle("color", "t4:seed");
  if (easy.gameId !== "color" || hard.gameId !== "color") return;
  assert.equal(easy.rounds.length < hard.rounds.length, true);
  const reactionEasy = createPuzzle("reaction", "t1:r"),
    reactionHard = createPuzzle("reaction", "t4:r");
  if (reactionEasy.gameId !== "reaction" || reactionHard.gameId !== "reaction") return;
  assert.equal(reactionEasy.delay > reactionHard.delay, true);
});

test("replay is deterministic: the same events on the same seed always agree", () => {
  const event = [{ t: 500, type: "choice" as const, value: "go" }];
  const first = replay("reaction", "lock-seed", event);
  const second = replay("reaction", "lock-seed", event);
  assert.equal(first.score, second.score);
  assert.equal(first.xp, second.xp);
  assert.equal(first.valid, second.valid);
  assert.equal(replay("reaction", "lock-seed", event).score, replay("reaction", "lock-seed", event).score);
});
