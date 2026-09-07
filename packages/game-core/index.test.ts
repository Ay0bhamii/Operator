import assert from "node:assert/strict";
import test from "node:test";
import { createPuzzle, dailyGame, replay } from "./index.js";

test("same seed creates the same puzzle", () => {
  assert.deepEqual(createPuzzle("sequence", "abc"), createPuzzle("sequence", "abc"));
  assert.notDeepEqual(createPuzzle("nim-pin", "abc"), createPuzzle("nim-pin", "def"));
});

test("daily rotation always selects a ranked challenge", () => {
  const ranked = new Set(["block-rush", "nim-pin", "memory", "vault", "sync"]);
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) assert.equal(ranked.has(dailyGame(day)), true);
});

test("replay accepts a valid sequence and computes its own score", () => {
  const puzzle = createPuzzle("sequence", "abc");
  assert.equal(puzzle.gameId, "sequence");
  if (puzzle.gameId !== "sequence") return;
  const events = puzzle.sequence.map((value: string, index: number) => ({ t: (index + 1) * 100, type: "key" as const, value }));
  const result = replay("sequence", "abc", events);
  assert.equal(result.valid, true);
  assert.equal(result.score, 2900);
});

test("replay saves verified partial progress but rejects superhuman runs", () => {
  const puzzle = createPuzzle("nim-pin", "abc");
  if (puzzle.gameId !== "nim-pin") return;
  const wrong = replay("nim-pin", "abc", [{ t: 100, type: "key", value: "0000" }]);
  assert.deepEqual(wrong, { score: 0, xp: 0, valid: true, completed: false });
  const fast = replay("nim-pin", "abc", [{ t: 10, type: "key", value: puzzle.pin }]);
  assert.equal(fast.valid, false);
});

test("replay validates seeded locks", () => {
  const lock = createPuzzle("nim-lock", "lock-seed");
  assert.equal(lock.gameId, "nim-lock");
  if (lock.gameId === "nim-lock") {
    const events = lock.targetAngles.map((angle, index) => ({ t: (index + 1) * 120, type: "choice" as const, value: String(index) }));
    let time = 0;
    const solvedEvents = lock.targetAngles.flatMap((angle, index) => Array.from({ length: angle / 45 || 8 }, () => ({ t: (time += 100), type: "choice" as const, value: String(index) })));
    assert.equal(replay("nim-lock", "lock-seed", solvedEvents).valid, true);
    assert.equal(events.length, 4);
  }
});

test("replay validates ranked block rush and sync events", () => {
  const blocks = replay("block-rush", "block-seed", [
    { t: 100, type: "choice", value: "3" },
    { t: 200, type: "choice", value: "4" },
  ]);
  assert.deepEqual(blocks, { score: 250, xp: 299, valid: true, completed: true });
  const sync = replay("sync", "sync-seed", Array.from({ length: 5 }, (_, index) => ({
    t: (index + 1) * 100,
    type: "choice" as const,
    value: "hit",
  })));
  assert.deepEqual(sync, { score: 500, xp: 298, valid: true, completed: true });
});

test("replay rejects malformed events and saves incomplete verified events", () => {
  assert.equal(replay("block-rush", "seed", [{ t: 100, type: "choice", value: "2" }]).valid, false);
  assert.equal(replay("block-rush", "seed", [{ t: 100, type: "key", value: "3" }]).valid, false);
  const partialSync = replay("sync", "seed", Array.from({ length: 4 }, (_, index) => ({
    t: (index + 1) * 100,
    type: "choice" as const,
    value: "hit",
  })));
  assert.equal(partialSync.valid, true);
  assert.equal(partialSync.completed, false);
  assert.equal(partialSync.score, 400);
  assert.equal(replay("nim-pin", "seed", [
    { t: 200, type: "key", value: "0000" },
    { t: 100, type: "key", value: "0000" },
  ]).reason, "invalid event timing");
});

test("replay rejects events that arrive too quickly", () => {
  const puzzle = createPuzzle("memory", "seed");
  if (puzzle.gameId !== "memory") return;
  const events = puzzle.tokens.map(value => ({ t: 100, type: "choice" as const, value }));
  assert.equal(replay("memory", "seed", events).reason, "events too fast");
});
