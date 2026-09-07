import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, Gamepad2, Grid3X3, KeyRound, Lock, Network, RotateCcw, Shield, Trophy } from "lucide-react";
import type { Run } from "./api";
import type { NextTarget } from "./api";
import type { GameEvent } from "../packages/game-core/index";
import { createPuzzle } from "../packages/game-core/index";

export type GameId =
  | "block-rush" | "nim-grid" | "nim-pin" | "sequence"
  | "memory" | "nim-lock" | "vault" | "sync";

export type Result = { score: number; xp: number; time?: number };
export type RankedSubmission = {
  state: "idle" | "submitting" | "verified" | "rejected";
  score?: number;
  xp?: number;
  error?: string;
  rank?: number | null;
  previousRank?: number | null;
  playerUsername?: string;
  opponentUsername?: string | null;
  opponentScore?: number | null;
  winnerUsername?: string | null;
  previousBest?: number | null;
  improvement?: number;
  personalBest?: boolean;
  ratingDelta?: number;
  rating?: number;
  grade?: string;
  displayGrade?: string;
  nextGrade?: string | null;
  ratingToNext?: number;
  progressPercent?: number;
  streak?: number;
  nextTarget?: NextTarget | null;
};

export const GAMES: { id: GameId; name: string; subtitle: string; icon: typeof Grid3X3; difficulty: string }[] = [
  { id: "block-rush", name: "Block Rush", subtitle: "Clear connected network blocks", icon: Grid3X3, difficulty: "Easy" },
  { id: "nim-grid", name: "NIM Grid", subtitle: "Hit the active target node", icon: Gamepad2, difficulty: "Easy" },
  { id: "nim-pin", name: "NIM PIN", subtitle: "Crack the generated access code", icon: KeyRound, difficulty: "Easy" },
  { id: "sequence", name: "Key Sequence", subtitle: "Enter the signal in the right order", icon: Activity, difficulty: "Hard" },
  { id: "memory", name: "Address Memory", subtitle: "Remember a fictional address pattern", icon: Shield, difficulty: "Medium" },
  { id: "nim-lock", name: "NIM Lock", subtitle: "Align the rotating lock rings", icon: Lock, difficulty: "Hard" },
  { id: "vault", name: "NIM Vault", subtitle: "Five-ring advanced lock challenge", icon: Trophy, difficulty: "Expert" },
  { id: "sync", name: "Sync", subtitle: "Time the packet inside the target", icon: Network, difficulty: "Medium" }
];

export const RANKED_GAME_IDS: GameId[] = ["block-rush", "nim-pin", "memory", "vault", "sync"];
export const PRACTICE_GAME_IDS: GameId[] = ["nim-grid", "sequence", "nim-lock"];
export const CHALLENGE_GAME_IDS: GameId[] = ["nim-pin", "memory", "vault"];

export const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - .5);

export function GameShell({ title, onBack, children }: { title: string; onBack: () => void; children: any }) {
  return <main className="game-shell"><header className="nav"><button className="back-editorial" onClick={onBack}>&lt;- OPERATIONS</button><button className="wordmark"><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><div className="game-nav-title">{title.toUpperCase()}</div></header><section className="game-stage">{children}</section></main>;
}

export function Game({ id, run, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: {
  id: GameId;
  run: Run | null;
  rankedSubmission: RankedSubmission;
  onEvent: (event: Omit<GameEvent, "t">) => void;
  onFinish: (r: Result) => void;
  onPlayAgain?: () => void;
  onViewRankings?: () => void;
}) {
  switch (id) {
    case "block-rush": return <BlockRush ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "nim-grid": return <NimGrid ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "nim-pin": return <NimPin seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "sequence": return <Sequence seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "memory": return <Memory seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "nim-lock": return <RotatingLock count={4} limit={20000} seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} title="NIM LOCK" onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "vault": return <RotatingLock count={5} limit={10000} seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} title="NIM VAULT" onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
    case "sync": return <Sync ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish} onPlayAgain={onPlayAgain} onViewRankings={onViewRankings}/>;
  }
}

function ResultBox({ result, onRestart }: { result: Result; onRestart: () => void }) {
  return <div className="result"><div className="result-icon"><Trophy/></div><small>PRACTICE COMPLETE</small><h2>{result.score.toLocaleString()}</h2><p>+{result.xp} XP (local)</p><button className="primary" onClick={onRestart}><RotateCcw size={16}/> Play again</button></div>;
}

function RankedResult({ submission, preview, onRestart, onViewRankings }: { submission: RankedSubmission; preview: Result; onRestart: () => void; onViewRankings?: () => void }) {
  if (submission.state === "submitting") return <div className="result"><div className="result-icon"><Clock3/></div><small>SUBMITTING REPLAY</small><h2>...</h2><p>Validating run...</p></div>;
  if (submission.state === "rejected") return <div className="result"><div className="result-icon"><Shield/></div><small>RUN NOT ACCEPTED</small><h2>REJECTED</h2><p>{submission.error || "The server could not verify this replay."}</p><button className="primary" onClick={onRestart}><RotateCcw size={16}/> Try again</button></div>;
  if (submission.state === "verified") {
    const challengeComplete = submission.opponentScore !== null && submission.opponentScore !== undefined;
    const isChallenge = Object.prototype.hasOwnProperty.call(submission, "opponentScore");
    const outcome = challengeComplete ? submission.winnerUsername === submission.playerUsername ? "YOU WIN" : submission.winnerUsername ? "YOU LOSE" : "DRAW" : "WAITING FOR OPPONENT";
    const climbed = submission.previousRank && submission.rank ? submission.previousRank - submission.rank : 0;
    const shortBy = submission.nextTarget && (submission.score != null) && submission.nextTarget.pointsAway > 0 ? submission.nextTarget.pointsAway : null;
    return <div className="result result-competitive">
      <div className="result-icon"><Trophy/></div>
      <small>{challengeComplete ? "CHALLENGE COMPLETE" : "VERIFIED RESULT"}</small>
      {challengeComplete ? <div className="challenge-result"><div><span>@{submission.playerUsername}</span><b>{submission.score?.toLocaleString()}</b></div><div><span>@{submission.opponentUsername || "Opponent"}</span><b>{(submission.opponentScore ?? 0).toLocaleString()}</b></div><strong>{outcome}</strong></div> : <>
        <h2>{submission.score?.toLocaleString()}</h2>
        {submission.personalBest && <p className="result-callout">NEW PERSONAL BEST</p>}
        {climbed > 0 && <p className="result-callout">YOU CLIMBED {climbed} POSITION{climbed === 1 ? "" : "S"}.</p>}
        {shortBy !== null && !submission.personalBest && <p className="result-callout">YOU WERE {shortBy} POINTS SHORT.</p>}
        <div className="result-meta-grid">
          <div><small>PERSONAL BEST</small><b>{submission.personalBest ? "YES" : "NO"}</b></div>
          <div><small>RANK</small><b>{submission.previousRank && submission.rank ? `#${submission.previousRank} → #${submission.rank}` : submission.rank ? `#${submission.rank}` : "—"}</b></div>
          <div><small>RATING</small><b>{submission.ratingDelta ? `${submission.ratingDelta > 0 ? "+" : ""}${submission.ratingDelta}` : "0"}</b></div>
          <div><small>XP</small><b>+{submission.xp}</b></div>
          {submission.streak != null && <div><small>STREAK</small><b>{submission.streak} DAYS</b></div>}
        </div>
        {submission.nextTarget && <div className="next-target-card"><small>YOUR NEXT TARGET</small><b>#{submission.nextTarget.rank} @{submission.nextTarget.username}</b><span>+{submission.nextTarget.pointsAway} points</span></div>}
      </>}
      <div className="result-actions">
        <button className="primary" onClick={isChallenge ? () => { window.location.href = "/"; } : onRestart}><RotateCcw size={16}/> {isChallenge ? "Back to operations" : shortBy ? "Try again" : "Play again"}</button>
        {onViewRankings && <button className="ghost-btn" onClick={onViewRankings}>View rankings</button>}
      </div>
    </div>;
  }
  return <div className="result"><div className="result-icon"><Clock3/></div><small>PREVIEW</small><h2>{preview.score.toLocaleString()}</h2><p>Waiting for validation...</p></div>;
}

function rankedOrLocal(ranked: boolean, rankedSubmission: RankedSubmission, preview: Result, localRestart: () => void, onPlayAgain?: () => void, onViewRankings?: () => void) {
  const restart = onPlayAgain || localRestart;
  return ranked
    ? <RankedResult submission={rankedSubmission} preview={preview} onRestart={restart} onViewRankings={onViewRankings}/>
    : <ResultBox result={preview} onRestart={localRestart}/>;
}

function BlockRush({ ranked, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { ranked: boolean; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const colors = ["cyan", "lime", "violet"];
  const [board, setBoard] = useState(() => Array.from({ length: 88 }, () => colors[rand(3)]));
  const [score, setScore] = useState(0); const [time, setTime] = useState(30); const [done, setDone] = useState(false);
  useEffect(() => { if (done) return; const t = setInterval(() => setTime(x => { if (x <= 1) { clearInterval(t); setDone(true); onFinish({ score, xp: 150, time: 30 }); return 0 } return x - 1 }), 1000); return () => clearInterval(t) }, [done, onFinish]);
  function click(i: number) {
    if (done) return; const col = board[i]; const seen = new Set<number>(), q = [i];
    while (q.length) { const x = q.pop()!; if (seen.has(x) || board[x] !== col) continue; seen.add(x); const r = Math.floor(x / 11), c = x % 11; [x - 11, x + 11, x - 1, x + 1].forEach(n => { if (n >= 0 && n < 88 && Math.floor(n / 11) >= r - 1 && Math.floor(n / 11) <= r + 1 && Math.abs((n % 11) - c) <= 1) q.push(n) }) }
    if (seen.size < 3) return;
    onEvent({ type: "choice", value: String(seen.size) });
    const a = board.map((v, j) => seen.has(j) ? null : v).filter(Boolean) as string[];
    const next = [...Array(88 - a.length).fill(null), ...a];
    setBoard(next); setScore(s => s + seen.size * seen.size * 10);
    if (!a.length) { setDone(true); onFinish({ score: score + seen.size * seen.size * 10, xp: 150, time: 30 - time }) }
  }
  const localRestart = () => { setBoard(Array.from({ length: 88 }, () => colors[rand(3)])); setScore(0); setTime(30); setDone(false) };
  if (done) return rankedOrLocal(ranked, rankedSubmission, { score, xp: 150 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge"><GameHUD label="BLOCK RUSH" value={String(score)} timer={`${time}s`}/><div className="block-board">{board.map((c, i) => <button key={i} className={`block ${c || "empty"}`} onClick={() => click(i)}/>)}</div><p className="hint">Clear groups of 3+ matching nodes. Bigger groups = bigger score.</p></div>;
}

function NimGrid({ ranked, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { ranked: boolean; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const [active, setActive] = useState(rand(16)); const [hits, setHits] = useState(0); const [time, setTime] = useState(15); const [done, setDone] = useState(false);
  const xpForHits = hits * 20;
  useEffect(() => { if (done) return; const t = setInterval(() => setTime(x => { if (x <= .1) { setDone(true); onFinish({ score: hits * 100, xp: xpForHits, time: 15 }); return 0 } return x - .1 }), 100); return () => clearInterval(t) }, [done, hits, onFinish, xpForHits]);
  const localRestart = () => { setHits(0); setTime(15); setActive(rand(16)); setDone(false) };
  if (done) return rankedOrLocal(ranked, rankedSubmission, { score: hits * 100, xp: xpForHits }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge"><GameHUD label="NIM GRID" value={`${hits} HITS`} timer={`${time.toFixed(1)}s`}/><div className="nim-grid">{Array.from({ length: 16 }, (_, i) => <button key={i} className={i === active ? "node active" : "node"} onClick={() => { if (i === active) { onEvent({ type: "choice", value: String(i) }); setHits(h => h + 1); setActive(rand(16)) } else { setDone(true); onFinish({ score: hits * 100, xp: xpForHits, time: 15 - time }) } }}><span/></button>)}</div><p className="hint">Hit the glowing node. One wrong box ends the challenge.</p></div>;
}

function NimPin({ seed, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { seed?: string; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const initialPin = seed ? createPuzzle("nim-pin", seed) : null;
  const pin = initialPin?.gameId === "nim-pin" ? initialPin.pin : String(rand(9000) + 1000);
  const [input, setInput] = useState(""); const [time, setTime] = useState(12); const [done, setDone] = useState(false);
  useEffect(() => { if (done) return; const t = setInterval(() => setTime(x => { if (x <= .1) { setDone(true); onFinish({ score: 0, xp: 25 }); return 0 } return x - .1 }), 100); return () => clearInterval(t) }, [done, onFinish]);
  function key(k: string) { if (done) return; const n = input + k; if (n.length <= 4) setInput(n); if (n.length === 4) { onEvent({ type: "key", value: n }); if (n === pin) { const score = Math.max(100, Math.round(time * 100)); setDone(true); onFinish({ score, xp: 125, time: 12 - time }) } else { setDone(true); onFinish({ score: 0, xp: 25 }) } } }
  const localRestart = () => { setInput(""); setTime(12); setDone(false) };
  if (done) return rankedOrLocal(Boolean(seed), rankedSubmission, { score: input === pin ? Math.max(100, Math.round(time * 100)) : 0, xp: input === pin ? 125 : 25 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge narrow"><GameHUD label="NIM PIN" value="4 DIGITS" timer={`${time.toFixed(1)}s`}/><div className="pin-display">{input.padEnd(4, "_")}</div><div className="keypad">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map(k => <button key={k} onClick={() => key(k)}>{k}</button>)}</div><p className="hint">Generated challenge. No real wallet PIN is requested.</p></div>;
}

function Sequence({ seed, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { seed?: string; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const chars = "QWERASD"; const initialPuzzle = seed ? createPuzzle("sequence", seed) : null; const [seq] = useState<string[]>(() => initialPuzzle?.gameId === "sequence" ? initialPuzzle.sequence : Array.from({ length: 12 }, () => chars[rand(chars.length)])); const [input, setInput] = useState(""); const [time, setTime] = useState(7); const [done, setDone] = useState(false);
  useEffect(() => { if (done) return; const t = setInterval(() => setTime(x => { if (x <= .1) { setDone(true); onFinish({ score: 0, xp: 15 }); return 0 } return x - .1 }), 100); return () => clearInterval(t) }, [done, onFinish]);
  function press(c: string) { if (done) return; const next = input + c; onEvent({ type: "key", value: c }); if (seq.slice(0, next.length).join("") !== next) { setDone(true); onFinish({ score: 0, xp: 15 }); return } setInput(next); if (next === seq.join("")) { const score = Math.round(time * 1000); setDone(true); onFinish({ score, xp: 180, time: 7 - time }) } }
  const localRestart = () => location.reload();
  if (done) return rankedOrLocal(Boolean(seed), rankedSubmission, { score: input === seq.join("") ? Math.round(time * 1000) : 0, xp: input === seq.join("") ? 180 : 15 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge"><GameHUD label="KEY SEQUENCE" value={`${input.length}/${seq.length}`} timer={`${time.toFixed(2)}s`}/><div className="sequence">{seq.map((c, i) => <span className={i < input.length ? "seen" : ""} key={i}>{c}</span>)}</div><div className="key-row">{chars.split("").map(c => <button key={c} onClick={() => press(c)}>{c}</button>)}</div></div>;
}

function Memory({ seed, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { seed?: string; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const initialPuzzle = seed ? createPuzzle("memory", seed) : null; const [code] = useState<string[]>(() => initialPuzzle?.gameId === "memory" ? initialPuzzle.tokens : Array.from({ length: 6 }, () => ["NQ", "7F", "3A", "C2", "91", "D8"][rand(6)])); const [show, setShow] = useState(true); const [input, setInput] = useState<string[]>([]); const [done, setDone] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(false), 2500); return () => clearTimeout(t) }, []);
  const options = useMemo(() => shuffle([...code, ...Array.from({ length: 6 }, () => ["AA", "1B", "EF", "42", "09", "BC"][rand(6)])]), [code]);
  function pick(x: string) { if (done) return; const next = [...input, x]; onEvent({ type: "choice", value: x }); setInput(next); if (next.length === code.length) { const ok = next.every((v, i) => v === code[i]); setDone(true); onFinish({ score: ok ? 600 : 0, xp: ok ? 160 : 20 }) } }
  const localRestart = () => location.reload();
  if (done) return rankedOrLocal(Boolean(seed), rankedSubmission, { score: input.every((v, i) => v === code[i]) ? 600 : 0, xp: input.every((v, i) => v === code[i]) ? 160 : 20 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge narrow"><GameHUD label="ADDRESS MEMORY" value={show ? "MEMORIZE" : "REBUILD"} timer={show ? "2.5s" : "8"}/><div className="memory-code">{show ? code.map(x => <b key={x}>{x}</b>) : input.map(x => <b key={Math.random()}>{x}</b>)}</div>{!show && <div className="memory-options">{options.map((x, i) => <button key={i} onClick={() => pick(x)}>{x}</button>)}</div>}</div>;
}

function RotatingLock({ count, limit, seed, rankedSubmission, onEvent, title, onFinish, onPlayAgain, onViewRankings }: { count: number; limit: number; seed?: string; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; title: string; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const initialPuzzle = seed ? createPuzzle(title === "NIM VAULT" ? "vault" : "nim-lock", seed) : null; const [target] = useState(() => initialPuzzle && (initialPuzzle.gameId === "nim-lock" || initialPuzzle.gameId === "vault") ? initialPuzzle.targetAngles : Array.from({ length: count }, () => rand(8) * 45)); const [angles, setAngles] = useState(() => target.map(angle => seed ? (angle + 45) % 360 : angle)); const [start] = useState(Date.now()); const [done, setDone] = useState(false);
  useEffect(() => { const t = setInterval(() => { if (Date.now() - start >= limit && !done) { setDone(true); onFinish({ score: 0, xp: 20 }) } }, 100); return () => clearInterval(t) }, [done, start, limit, onFinish]);
  const solved = angles.every((a, i) => Math.abs(((a - target[i] + 540) % 360) - 180) < 12);
  useEffect(() => { if (solved && !done) { setDone(true); const left = Math.max(0, limit - (Date.now() - start)); onFinish({ score: Math.round(left / 5) + count * 100, xp: count === 5 ? 220 : 180, time: Date.now() - start }) } }, [solved, done, count, limit, onFinish, start]);
  const localRestart = () => location.reload();
  if (done) return rankedOrLocal(Boolean(seed), rankedSubmission, { score: solved ? count * 200 : 0, xp: solved ? (count === 5 ? 220 : 180) : 20 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge"><GameHUD label={title} value={`${count} LOCKS`} timer={`${Math.max(0, ((limit - (Date.now() - start)) / 1000)).toFixed(1)}s`}/><div className="locks">{angles.map((a, i) => <button key={i} className="lock-ring" style={{ transform: `rotate(${a}deg)` }} onClick={() => { onEvent({ type: "choice", value: String(i) }); setAngles(v => v.map((x, j) => j === i ? x + 45 : x)) }}><i/><span style={{ transform: `rotate(${-a}deg)` }}>o</span><em style={{ transform: `rotate(${-a}deg)` }}>^</em></button>)}</div><p className="hint">Rotate each ring until its dot aligns with the target marker.</p></div>;
}

function Sync({ ranked, rankedSubmission, onEvent, onFinish, onPlayAgain, onViewRankings }: { ranked: boolean; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void; onPlayAgain?: () => void; onViewRankings?: () => void }) {
  const [pos, setPos] = useState(0); const [dir, setDir] = useState(1); const [tries, setTries] = useState(3); const [done, setDone] = useState(false); const [score, setScore] = useState(0);
  useEffect(() => { if (done) return; const t = setInterval(() => setPos(p => { let n = p + dir * 2; if (n >= 100) { setDir(-1); n = 100 } if (n <= 0) { setDir(1); n = 0 } return n }), 30); return () => clearInterval(t) }, [dir, done]);
  function hit() { if (pos > 42 && pos < 58) { onEvent({ type: "choice", value: "hit" }); const s = score + 100; setScore(s); if (s >= 500) { setDone(true); onFinish({ score: s, xp: 150 }) } } else { onEvent({ type: "choice", value: "miss" }); const t = tries - 1; setTries(t); if (t <= 0) { setDone(true); onFinish({ score, xp: 20 }) } } }
  const localRestart = () => location.reload();
  if (done) return rankedOrLocal(ranked, rankedSubmission, { score, xp: score >= 500 ? 150 : 20 }, localRestart, onPlayAgain, onViewRankings);
  return <div className="challenge"><GameHUD label="SYNC" value={`${score} PTS`} timer={`${tries} attempts`}/><div className="sync-track"><div className="sync-target"/><div className="sync-cursor" style={{ left: `${pos}%` }}/></div><button className="primary huge" onClick={hit}>SYNC PACKET</button></div>;
}

function GameHUD({ label, value, timer }: { label: string; value: string; timer: string }) {
  return <div className="hud"><div><small>{label}</small><b>{value}</b></div><div className="timer"><Clock3 size={17}/>{timer}</div></div>;
}
