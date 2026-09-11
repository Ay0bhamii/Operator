import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { createHmac, randomBytes } from "node:crypto";
import { Hash, PublicKey, Signature } from "@nimiq/core";
import { createPuzzle, dailyGame, replay, type GameEvent, type RankedGameId } from "../packages/game-core/index.js";

const app = new Hono();
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const pgDb = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
}) : null;
const sqliteDb = pgDb ? null : new Database(process.env.DATABASE_FILE || "operator.sqlite");
const db = {
  async query(sql: string, params: unknown[] = []) {
    if (pgDb) return pgDb.query(sql, params);
    if (!sqliteDb) throw new Error("Database is not configured");
    const sqliteSql = sql.replace(/\$\d+/g, "?");
    const lower = sql.trim().toLowerCase();
    if (lower.startsWith("create ") || lower.startsWith("drop ") || lower.startsWith("alter ")) {
      sqliteDb.exec(sqliteSql);
      return { rows: [], rowCount: 0 } as { rows: any[]; rowCount?: number };
    }
    if (lower.startsWith("select")) {
      const stmt = sqliteDb.prepare(sqliteSql);
      return { rows: stmt.all(...params) as any[] } as { rows: any[]; rowCount?: number };
    }
    const stmt = sqliteDb.prepare(sqliteSql);
    const result = stmt.run(...params);
    return { rows: [], rowCount: Number(result.changes ?? 0) } as { rows: any[]; rowCount?: number };
  },
};
const sessionSecret = process.env.SESSION_SECRET || "development-only-change-me";
const dailySecret = process.env.DAILY_SECRET || "development-daily-secret";
const rankedGames = new Set<RankedGameId>(["reaction", "color", "whack", "flight", "pop", "memory", "stack"]);
const challengeGames = new Set<RankedGameId>(["reaction", "whack", "stack"]);
const gameLimits: Record<string, number> = { reaction: 30000, color: 30000, whack: 30000, flight: 60000, pop: 30000, memory: 60000, stack: 60000 };
const achievementDefinitions = [
  ["first-blood", "FIRST BLOOD", "Complete your first verified ranked run.", "COMMON", 25],
  ["no-signal", "NO SIGNAL", "Score 1,000 or more in one game.", "COMMON", 25],
  ["consistent", "CONSISTENT", "Complete 3 Daily Operations.", "UNCOMMON", 40],
  ["operator", "OPERATOR", "Maintain a 7-day daily streak.", "RARE", 50],
  ["disciplined", "DISCIPLINED", "Maintain a 14-day daily streak.", "RARE", 75],
  ["unstoppable", "UNSTOPPABLE", "Maintain a 30-day daily streak.", "EPIC", 100],
  ["elite", "ELITE", "Reach GOLD rating.", "RARE", 75],
  ["platinum-status", "PLATINUM STATUS", "Reach PLATINUM rating.", "EPIC", 100],
  ["diamond-hands", "DIAMOND HANDS", "Reach DIAMOND rating.", "EPIC", 150],
  ["specialist", "SPECIALIST", "Set a top-10 score in one game.", "RARE", 75],
  ["repeat-offender", "REPEAT OFFENDER", "Set 3 personal bests.", "UNCOMMON", 50],
  ["rival", "RIVAL", "Win your first friend challenge.", "UNCOMMON", 40],
  ["dominant", "DOMINANT", "Win 5 friend challenges.", "RARE", 100],
  ["legend", "LEGEND", "Maintain a 100-day daily streak.", "LEGENDARY", 250],
] as const;

await db.query(`
CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, username TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS login_nonces (nonce TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT, seed TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS scores (id SERIAL PRIMARY KEY, address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT, score INTEGER NOT NULL, xp INTEGER NOT NULL, duration_ms INTEGER NOT NULL, run_id TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS reward_claims (address TEXT NOT NULL, day TEXT NOT NULL, amount_nim INTEGER NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (address, day));
CREATE TABLE IF NOT EXISTS analytics_events (id SERIAL PRIMARY KEY, event TEXT NOT NULL, game_id TEXT, address TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS friend_challenges (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, game_id TEXT NOT NULL, creator_address TEXT NOT NULL, opponent_address TEXT, seed TEXT NOT NULL, creator_score INTEGER, opponent_score INTEGER, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS achievements (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, rarity TEXT NOT NULL, xp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS player_achievements (address TEXT NOT NULL, achievement_id TEXT NOT NULL, unlocked_at TIMESTAMPTZ NOT NULL, xp INTEGER NOT NULL, PRIMARY KEY (address, achievement_id));
CREATE UNIQUE INDEX IF NOT EXISTS scores_daily_unique ON scores(address, game_id, day) WHERE mode = 'daily';
CREATE INDEX IF NOT EXISTS scores_leaderboard_idx ON scores(game_id, mode, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS scores_player_history_idx ON scores(address, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS scores_daily_board_idx ON scores(game_id, day, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS runs_address_expiry_idx ON runs(address, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS challenges_players_idx ON friend_challenges(creator_address, opponent_address, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events(created_at DESC);
`);

try { await db.query("ALTER TABLE addresses ADD COLUMN username TEXT"); } catch {}
try { await db.query("CREATE UNIQUE INDEX IF NOT EXISTS addresses_username_unique ON addresses(LOWER(username)) WHERE username IS NOT NULL"); } catch {}
try { await db.query("ALTER TABLE friend_challenges ADD COLUMN stake_label TEXT"); } catch {}
for (const [id, name, description, rarity, xp] of achievementDefinitions) {
  await db.query("INSERT INTO achievements(id, name, description, rarity, xp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING", [id, name, description, rarity, xp]);
}

const now = () => Date.now();
const iso = (value: number) => new Date(value).toISOString();
const text = (value: string) => new TextEncoder().encode(value);
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=${process.env.COOKIE_SAME_SITE || "Lax"}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const signSession = (id: string) => createHmac("sha256", sessionSecret).update(id).digest("hex");
const seedFor = (day: string, gameId: string) => createHmac("sha256", dailySecret).update(`${day}:${gameId}`).digest("hex").slice(0, 32);

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
const ratePolicy = (path: string) => path.startsWith("/auth/") ? { limit: 15, windowMs: 10 * 60_000 } : path.includes("/submit") ? { limit: 30, windowMs: 60_000 } : path === "/runs" || path === "/runs/start" || path === "/challenges" ? { limit: 30, windowMs: 60_000 } : { limit: 180, windowMs: 60_000 };

function clientKey(c: any) {
  return c.req.header("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function gradeFor(rating: number) {
  return rating >= 2400 ? "DIAMOND" : rating >= 1900 ? "PLATINUM" : rating >= 1500 ? "GOLD" : rating >= 1200 ? "SILVER" : "BRONZE";
}

function ratingProgress(rating: number) {
  const thresholds = [{ grade: "SILVER", rating: 1200 }, { grade: "GOLD", rating: 1500 }, { grade: "PLATINUM", rating: 1900 }, { grade: "DIAMOND", rating: 2400 }];
  const next = thresholds.find(item => rating < item.rating);
  if (!next) return { nextGrade: null, nextGradeRating: null, ratingToNext: 0, progressPercent: 100 };
  const currentFloor = thresholds.filter(item => item.rating <= rating).at(-1)?.rating ?? 1000;
  return { nextGrade: next.grade, nextGradeRating: next.rating, ratingToNext: next.rating - rating, progressPercent: Math.round(((rating - currentFloor) / (next.rating - currentFloor)) * 100) };
}

const seasonStart = process.env.SEASON_START || `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
const rankedGameList = [...rankedGames];

function displayGrade(rating: number) {
  const grade = gradeFor(rating);
  const bands = [
    { grade: "BRONZE", min: 1000, next: 1200 },
    { grade: "SILVER", min: 1200, next: 1500 },
    { grade: "GOLD", min: 1500, next: 1900 },
    { grade: "PLATINUM", min: 1900, next: 2400 },
    { grade: "DIAMOND", min: 2400, next: 3000 },
  ];
  const band = bands.find(item => item.grade === grade) ?? bands[0];
  const span = Math.max(1, band.next - band.min);
  const t = Math.min(0.999, Math.max(0, (rating - band.min) / span));
  const roman = t < 1 / 3 ? "III" : t < 2 / 3 ? "II" : "I";
  return `${grade} ${roman}`;
}

function difficultyForRating(rating: number) {
  if (rating >= 2400) return { tier: 4, label: "ELITE", description: "Maximum complexity. Precision and recall are both tested." };
  if (rating >= 1900) return { tier: 3, label: "ADVANCED", description: "Longer patterns and tighter execution." };
  if (rating >= 1500) return { tier: 2, label: "STANDARD", description: "The full competitive ruleset." };
  return { tier: 1, label: "OPERATOR", description: "A welcoming verified challenge to learn the system." };
}

function levelFor(xp: number) {
  const perLevel = 500;
  return { xp, level: Math.floor(xp / perLevel) + 1, xpIntoLevel: xp % perLevel, xpForLevel: perLevel, nextLevelXp: perLevel - (xp % perLevel) };
}

async function xpFor(address: string) {
  const row = (await db.query("SELECT COALESCE((SELECT SUM(xp) FROM scores WHERE address = $1 AND mode IN ('daily','ranked')), 0) + COALESCE((SELECT SUM(xp) FROM player_achievements WHERE address = $2), 0) AS xp", [address, address])).rows[0];
  return Number(row?.xp ?? 0);
}

async function ratingBoard() {
  const rows = (await db.query("SELECT s.address, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, COUNT(*) AS verified_runs, COALESCE(AVG(s.score), 0) AS average_score, MAX(s.score) AS best_score FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.mode IN ('daily','ranked') GROUP BY s.address, a.username")).rows as Array<{ address: string; username: string; verified_runs: number; average_score: number; best_score: number }>;
  return rows.map(row => {
    const verifiedRuns = Number(row.verified_runs);
    const rating = Math.min(3000, 1000 + Math.round(Number(row.average_score) / 10) + verifiedRuns * 5);
    return { address: row.address, username: row.username, rating, grade: gradeFor(rating), displayGrade: displayGrade(rating), verifiedRuns, bestScore: Number(row.best_score) };
  }).sort((a, b) => b.rating - a.rating || a.username.localeCompare(b.username));
}

function nearbySlice<T>(rows: T[], index: number, span = 2) {
  if (index < 0) return rows.slice(0, Math.min(5, rows.length)).map((row, i) => ({ row, rank: i + 1, isYou: false }));
  const start = Math.max(0, index - span);
  const end = Math.min(rows.length, index + span + 1);
  return rows.slice(start, end).map((row, i) => ({ row, rank: start + i + 1, isYou: start + i === index }));
}

async function scoreboard(gameId: string | "all", period: "all" | "daily" | "weekly" | "season") {
  const day = new Date().toISOString().slice(0, 10);
  const weeklyFrom = iso(now() - 7 * 86_400_000);
  if (period === "all" && gameId === "all") {
    return (await ratingBoard()).map((row, index) => ({ rank: index + 1, username: row.username, address: row.address, score: row.rating, created_at: null as string | null }));
  }
  const gameFilter = gameId === "all" ? "" : " AND s.game_id = $1";
  const params: unknown[] = gameId === "all" ? [] : [gameId];
  if (period === "daily") {
    const dailyGameId = gameId === "all" ? dailyGame(day) : gameId;
    const rows = (await db.query("SELECT s.address, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, s.score, s.created_at FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.mode = 'daily' AND s.day = $2 ORDER BY s.score DESC, s.created_at ASC LIMIT 50", [dailyGameId, day])).rows as Array<{ address: string; username: string; score: number; created_at: string }>;
    return rows.map((row, index) => ({ rank: index + 1, username: row.username, address: row.address, score: Number(row.score), created_at: row.created_at }));
  }
  const since = period === "weekly" ? weeklyFrom : period === "season" ? seasonStart : null;
  if (since) {
    params.push(since);
    const sinceIndex = params.length;
    const rows = (await db.query(`SELECT s.address, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, MAX(s.score) AS score, MIN(s.created_at) AS created_at FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.mode IN ('daily','ranked')${gameFilter} AND s.created_at >= $${sinceIndex} GROUP BY s.address, a.username ORDER BY score DESC, created_at ASC LIMIT 50`, params)).rows as Array<{ address: string; username: string; score: number; created_at: string }>;
    return rows.map((row, index) => ({ rank: index + 1, username: row.username, address: row.address, score: Number(row.score), created_at: row.created_at }));
  }
  const rows = (await db.query(`SELECT s.address, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, MAX(s.score) AS score, MIN(s.created_at) AS created_at FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.mode IN ('daily','ranked')${gameFilter} GROUP BY s.address, a.username ORDER BY score DESC, created_at ASC LIMIT 50`, params)).rows as Array<{ address: string; username: string; score: number; created_at: string }>;
  return rows.map((row, index) => ({ rank: index + 1, username: row.username, address: row.address, score: Number(row.score), created_at: row.created_at }));
}

async function nextTargetFor(board: Array<{ address: string; username: string; score: number }>, address: string, yourScore: number) {
  const index = board.findIndex(row => row.address === address);
  if (index <= 0) return null;
  const next = board[index - 1];
  return { rank: index, username: next.username, score: Number(next.score), pointsAway: Number(next.score) - yourScore };
}

function titleFor(verifiedRuns: number, rating: number, streak: number) {
  if (verifiedRuns <= 0) return "UNVERIFIED GUEST";
  if (rating >= 2400 || streak >= 30) return "ELITE OPERATOR";
  if (rating >= 1900 || streak >= 14) return "SENIOR OPERATOR";
  if (rating >= 1500 || verifiedRuns >= 10) return "VERIFIED OPERATOR";
  return "JUNIOR OPERATOR";
}
function badgeFor(verifiedRuns: number, rating: number) {
  if (verifiedRuns <= 0) return null;
  if (rating >= 2400) return "DIAMOND";
  if (rating >= 1900) return "PLATINUM";
  if (rating >= 1500) return "GOLD";
  if (verifiedRuns >= 3) return "VERIFIED";
  return "ROOKIE";
}
function proofCodeFor(proofId: string) {
  return createHmac("sha256", sessionSecret).update("proof:" + proofId).digest("hex").slice(0, 12).toUpperCase();
}
function proofTextFor(gameId: string, score: number, rank: number | null, proofId: string) {
  const rankText = rank ? " - Rank #" + rank : "";
  return "I scored " + Number(score).toLocaleString() + " on " + gameId + rankText + " - Verified on Nimiq via OPERATOR [" + proofCodeFor(proofId) + "]";
}
function streakBonusFor(streak: number) {
  if (streak >= 30) return { bonusXp: 100, label: "30-day streak: +100 XP" };
  if (streak >= 14) return { bonusXp: 50, label: "14-day streak: +50 XP" };
  if (streak >= 7) return { bonusXp: 25, label: "7-day streak: +25 XP" };
  if (streak >= 3) return { bonusXp: 10, label: "3-day streak: +10 XP" };
  return { bonusXp: 0, label: null as string | null };
}
function cleanStakeLabel(value: unknown) {
  const v = String(value || "").trim().slice(0, 24);
  if (!v) return null;
  if (!/^[A-Za-z0-9 ._-]{1,24}$/.test(v)) return null;
  return v;
}
async function weeklySpotlight() {
  const cutoff = iso(now() - 7 * 86_400_000);
  const rows = (await db.query("SELECT s.address, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, MAX(s.score) AS best, COUNT(*) AS runs FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.mode IN ('daily','ranked') AND s.created_at >= $1 GROUP BY s.address, a.username ORDER BY best DESC, runs DESC LIMIT 3", [cutoff])).rows as Array<{ address: string; username: string; best: number; runs: number }>;
  return rows.map((row, index) => ({ rank: index + 1, username: row.username, bestScore: Number(row.best), runs: Number(row.runs) }));
}
async function ratingFor(address: string) {
  const row = (await db.query("SELECT COUNT(*) AS verified_runs, COALESCE(AVG(score), 0) AS average_score FROM scores WHERE address = $1 AND mode IN ('daily','ranked')", [address])).rows[0];
  const verifiedRuns = Number(row?.verified_runs ?? 0);
  const rating = Math.min(3000, 1000 + Math.round(Number(row?.average_score ?? 0) / 10) + verifiedRuns * 5);
  return { rating, grade: gradeFor(rating), verifiedRuns };
}

async function streakFor(address: string) {
  const rows = (await db.query("SELECT DISTINCT day FROM scores WHERE address = $1 AND mode = 'daily' AND day IS NOT NULL ORDER BY day DESC LIMIT 100", [address])).rows as Array<{ day: string }>;
  if (!rows.length) return 0;
  const completed = new Set(rows.map(row => String(row.day).slice(0, 10)));
  let cursor = new Date(`${rows[0].day}T00:00:00.000Z`);
  let streak = 0;
  while (completed.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

async function unlockAchievement(address: string, achievementId: string) {
  const definition = achievementDefinitions.find(item => item[0] === achievementId);
  if (!definition) return false;
  const inserted = await db.query("INSERT INTO player_achievements(address, achievement_id, unlocked_at, xp) VALUES ($1, $2, $3, $4) ON CONFLICT (address, achievement_id) DO NOTHING", [address, achievementId, iso(now()), definition[4]]);
  return (inserted.rowCount ?? 0) > 0;
}

async function awardRankedAchievements(address: string, score: number, personalBest: boolean, rank: number | null, mode: string) {
  await unlockAchievement(address, "first-blood");
  if (score >= 1000) await unlockAchievement(address, "no-signal");
  if (personalBest) {
    const runs = (await db.query("SELECT COUNT(*) AS count FROM scores WHERE address = $1 AND mode IN ('daily','ranked')", [address])).rows[0];
    if (Number(runs?.count ?? 0) >= 3) await unlockAchievement(address, "repeat-offender");
  }
  if (rank !== null && rank <= 10) await unlockAchievement(address, "specialist");
  const rating = await ratingFor(address);
  if (rating.rating >= 1500) await unlockAchievement(address, "elite");
  if (rating.rating >= 1900) await unlockAchievement(address, "platinum-status");
  if (rating.rating >= 2400) await unlockAchievement(address, "diamond-hands");
  if (mode === "daily") {
    const days = (await db.query("SELECT COUNT(DISTINCT day) AS count FROM scores WHERE address = $1 AND mode = 'daily'", [address])).rows[0];
    if (Number(days?.count ?? 0) >= 3) await unlockAchievement(address, "consistent");
    const streak = await streakFor(address);
    if (streak >= 7) await unlockAchievement(address, "operator");
    if (streak >= 14) await unlockAchievement(address, "disciplined");
    if (streak >= 30) await unlockAchievement(address, "unstoppable");
    if (streak >= 50) await unlockAchievement(address, "elite");
    if (streak >= 100) await unlockAchievement(address, "legend");
  }
}

function verifyNimiqMessage(message: string, signer: string, publicKeyHex: string, signatureHex: string) {
  const publicKey = PublicKey.deserialize(Buffer.from(publicKeyHex, "hex"));
  const signature = Signature.deserialize(Buffer.from(signatureHex, "hex"));
  const payloads = [
    text(`\x16Nimiq Signed Message:\n${message.length}${message}`),
    text(`Nimiq Signed Message:\n${message.length}${message}`),
    text(message),
  ];
  if (!payloads.some(payload => publicKey.verify(signature, Hash.computeSha256(payload)))) return false;
  const derived = publicKey.toAddress().toUserFriendlyAddress().split(" ").join("").toUpperCase();
  return derived === signer.split(" ").join("").toUpperCase();
}

async function sessionAddress(c: any): Promise<string | null> {
  const raw = c.req.header("Cookie")?.match(/operator_session=([^;]+)/)?.[1];
  if (!raw) return null;
  const [id, mac] = raw.split(".");
  if (!id || mac !== signSession(id)) return null;
  const { rows } = await db.query("SELECT address, expires_at FROM sessions WHERE id = $1", [id]);
  const row = rows[0] as { address: string; expires_at: string } | undefined;
  if (!row || Date.parse(row.expires_at) <= now()) return null;
  return row.address;
}

app.use("/*", cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173", credentials: true }));
app.use("/*", async (c, next) => {
  const policy = ratePolicy(new URL(c.req.url).pathname);
  const timestamp = now();
  const key = `${clientKey(c)}:${policy.limit}:${policy.windowMs}`;
  const bucket = rateBuckets.get(key);
  const active = !bucket || bucket.resetAt <= timestamp ? { count: 0, resetAt: timestamp + policy.windowMs } : bucket;
  active.count += 1;
  rateBuckets.set(key, active);
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, entry] of rateBuckets) if (entry.resetAt <= timestamp) rateBuckets.delete(bucketKey);
  }
  c.header("X-RateLimit-Limit", String(policy.limit));
  c.header("X-RateLimit-Remaining", String(Math.max(0, policy.limit - active.count)));
  if (active.count > policy.limit) {
    c.header("Retry-After", String(Math.ceil((active.resetAt - timestamp) / 1000)));
    return c.json({ error: "rate limit exceeded; retry shortly" }, 429);
  }
  await next();
});
app.onError((error, c) => {
  console.error(JSON.stringify({ event: "operator_api_error", path: new URL(c.req.url).pathname, message: error instanceof Error ? error.message : "unknown error" }));
  return c.json({ error: "internal server error" }, 500);
});
app.get("/health", c => c.json({ ok: true }));

app.post("/analytics/event", async c => {
  let body: { event?: string; gameId?: string } = {};
  try { body = await c.req.json<{ event?: string; gameId?: string }>(); } catch {}
  const allowed = new Set(["wallet_connected", "run_started", "run_verified", "run_rejected", "reward_requested"]);
  if (!body.event || !allowed.has(body.event)) return c.json({ error: "invalid analytics event" }, 400);
  const address = await sessionAddress(c);
  await db.query("INSERT INTO analytics_events(event, game_id, address, created_at) VALUES ($1, $2, $3, $4)", [body.event, body.gameId || null, address, iso(now())]);
  return c.json({ ok: true });
});

app.post("/challenges", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ error: "ranked session required" }, 401);
  const body = await c.req.json<{ gameId?: RankedGameId; stakeLabel?: unknown }>();
  if (!body.gameId || !challengeGames.has(body.gameId)) return c.json({ error: "game is not challenge-capable" }, 400);
  const creator = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  if (!creator?.username) return c.json({ error: "username required before creating a challenge" }, 409);
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(8).toString("base64url");
  const seed = randomBytes(16).toString("hex");
  const created = now();
  const stakeLabel = cleanStakeLabel((body as any).stakeLabel);
  await db.query("INSERT INTO friend_challenges(id, token, game_id, creator_address, seed, created_at, expires_at, stake_label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, token, body.gameId, address, seed, iso(created), iso(created + 24 * 60 * 60_000), stakeLabel]);
  return c.json({ challengeId: id, token, gameId: body.gameId, seed, creatorUsername: creator.username, opponentUsername: null, creatorScore: null, opponentScore: null, winnerUsername: null, status: "WAITING", stakeLabel, expiresAt: iso(created + 24 * 60 * 60_000) });
});

app.get("/challenges/history", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json([]);
  const rows = (await db.query("SELECT f.id, f.game_id, f.creator_address, f.opponent_address, f.creator_score, f.opponent_score, f.created_at, f.stake_label, ca.username AS creator_username, oa.username AS opponent_username FROM friend_challenges f LEFT JOIN addresses ca ON ca.address = f.creator_address LEFT JOIN addresses oa ON oa.address = f.opponent_address WHERE f.creator_address = $1 OR f.opponent_address = $2 ORDER BY f.created_at DESC LIMIT 20", [address, address])).rows as any[];
  return c.json(rows.map(row => { const creatorScore = row.creator_score === null ? null : Number(row.creator_score); const opponentScore = row.opponent_score === null ? null : Number(row.opponent_score); const youAreCreator = row.creator_address === address; const yourScore = youAreCreator ? creatorScore : opponentScore; const theirScore = youAreCreator ? opponentScore : creatorScore; return { challengeId: row.id, gameId: row.game_id, opponentUsername: youAreCreator ? row.opponent_username : row.creator_username, yourScore, theirScore, outcome: yourScore === null || theirScore === null ? "ACTIVE" : yourScore === theirScore ? "DRAW" : yourScore > theirScore ? "WIN" : "LOSS", createdAt: row.created_at, stakeLabel: row.stake_label ?? null }; }));
});

app.get("/challenges/:token", async c => {
  const challengeId = c.req.param("token");
  const row = (await db.query("SELECT f.id, f.token, f.game_id, f.creator_address, f.opponent_address, f.creator_score, f.opponent_score, f.created_at, f.expires_at, f.stake_label, ca.username AS creator_username, oa.username AS opponent_username FROM friend_challenges f LEFT JOIN addresses ca ON ca.address = f.creator_address LEFT JOIN addresses oa ON oa.address = f.opponent_address WHERE f.id = $1 OR f.token = $2", [challengeId, challengeId])).rows[0] as any;
  if (!row || Date.parse(row.expires_at) <= now()) return c.json({ error: "challenge not found or expired" }, 404);
  const status = row.creator_score !== null && row.opponent_score !== null ? "COMPLETED" : row.opponent_address ? "IN_PROGRESS" : "WAITING";
  const winnerUsername = status === "COMPLETED" ? row.creator_score === row.opponent_score ? null : row.creator_score > row.opponent_score ? row.creator_username : row.opponent_username : null;
  return c.json({ challengeId: row.id, token: row.id, gameId: row.game_id, creatorUsername: row.creator_username || "Unnamed Player", opponentUsername: row.opponent_username || null, creatorScore: row.creator_score, opponentScore: row.opponent_score, winnerUsername, status, stakeLabel: row.stake_label ?? null, createdAt: row.created_at, expiresAt: row.expires_at });
});

app.post("/challenges/:token/join", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ error: "ranked session required" }, 401);
  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  if (!account?.username) return c.json({ error: "username required before joining a challenge" }, 409);
  const challengeId = c.req.param("token");
  const row = (await db.query("SELECT * FROM friend_challenges WHERE id = $1 OR token = $2", [challengeId, challengeId])).rows[0] as any;
  if (!row || Date.parse(row.expires_at) <= now()) return c.json({ error: "challenge not found or expired" }, 404);
  if (row.creator_address === address) return c.json({ challengeId: row.id, token: row.id, gameId: row.game_id, seed: row.seed, creatorUsername: account.username, opponentUsername: null, creatorScore: row.creator_score, opponentScore: row.opponent_score, winnerUsername: null, status: row.creator_score !== null && row.opponent_score !== null ? "COMPLETED" : "WAITING", expiresAt: row.expires_at });
  if (row.opponent_address && row.opponent_address !== address) return c.json({ error: "challenge already joined" }, 409);
  await db.query("UPDATE friend_challenges SET opponent_address = $1 WHERE id = $2 AND opponent_address IS NULL", [address, row.id]);
  return c.json({ challengeId: row.id, token: row.id, gameId: row.game_id, seed: row.seed, creatorUsername: row.creator_username || "Unnamed Player", opponentUsername: account.username, creatorScore: row.creator_score, opponentScore: row.opponent_score, winnerUsername: null, status: "IN_PROGRESS", expiresAt: row.expires_at });
});

app.post("/challenges/:token/submit", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ error: "ranked session required" }, 401);
  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  if (!account?.username) return c.json({ error: "username required before submitting a challenge" }, 409);
  const challengeId = c.req.param("token");
  const row = (await db.query("SELECT * FROM friend_challenges WHERE id = $1 OR token = $2", [challengeId, challengeId])).rows[0] as any;
  if (!row || Date.parse(row.expires_at) <= now()) return c.json({ error: "challenge not found or expired" }, 404);
  if (row.creator_address !== address && row.opponent_address !== address) return c.json({ error: "wallet is not part of this challenge" }, 403);
  if (row.creator_address !== address && !row.opponent_address) return c.json({ error: "join the challenge before submitting" }, 409);
  const body = await c.req.json<{ events?: GameEvent[] }>();
  const result = replay(row.game_id, row.seed, body.events || []);
  if (!result.valid) return c.json({ error: result.reason || "invalid replay" }, 400);
  const column = row.creator_address === address ? "creator_score" : "opponent_score";
  if (row[column] !== null) return c.json({ error: "challenge attempt already submitted" }, 409);
  await db.query(`UPDATE friend_challenges SET ${column} = $1 WHERE id = $2 AND ${column} IS NULL`, [result.score, row.id]);
  const latest = (await db.query("SELECT f.creator_score, f.opponent_score, ca.username AS creator_username, oa.username AS opponent_username FROM friend_challenges f LEFT JOIN addresses ca ON ca.address = f.creator_address LEFT JOIN addresses oa ON oa.address = f.opponent_address WHERE f.id = $1", [row.id])).rows[0] as any;
  const complete = latest.creator_score !== null && latest.opponent_score !== null;
  const winnerUsername = complete ? latest.creator_score === latest.opponent_score ? null : latest.creator_score > latest.opponent_score ? latest.creator_username : latest.opponent_username : null;
  if (complete && winnerUsername === account.username) {
    await unlockAchievement(address, "rival");
    const wins = (await db.query("SELECT COUNT(*) AS count FROM friend_challenges WHERE (creator_address = $1 AND creator_score > opponent_score) OR (opponent_address = $1 AND opponent_score > creator_score)", [address])).rows[0];
    if (Number(wins?.count ?? 0) >= 5) await unlockAchievement(address, "dominant");
  }
  const proofId = row.id + ":" + address;
  return c.json({ score: result.score, xp: result.xp, proofId, proofCode: proofCodeFor(proofId), proofText: proofTextFor(row.game_id, result.score, null, proofId), stakeLabel: row.stake_label ?? null, opponentScore: row.creator_address === address ? latest.opponent_score : latest.creator_score, opponentUsername: row.creator_address === address ? latest.opponent_username : latest.creator_username, winnerUsername, status: complete ? "COMPLETED" : "IN_PROGRESS" });
});

app.post("/auth/nonce", async c => {
  const nonce = randomBytes(32).toString("hex");
  const expires = now() + 5 * 60_000;
  await db.query("INSERT INTO login_nonces VALUES ($1, $2, $3, NULL)", [nonce, iso(now()), iso(expires)]);
  return c.json({ nonce, exp: Math.floor(expires / 1000), message: `NIM-LAB LOGINv1\nnonce:${nonce}\nexp:${Math.floor(expires / 1000)}` });
});

app.post("/auth/verify", async c => {
  const body = await c.req.json<{ message?: string; signer?: string; signerPublicKey?: string; signature?: string }>();
  if (!body.message || !body.signer || !body.signerPublicKey || !body.signature) return c.json({ error: "complete signed login required" }, 400);
  const nonceMatch = body.message.match(/^NIM-LAB LOGINv1\nnonce:([0-9a-f]{64})\nexp:(\d+)$/);
  const row = nonceMatch ? (await db.query("SELECT * FROM login_nonces WHERE nonce = $1", [nonceMatch[1]])).rows[0] : undefined;
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= now() || Number(nonceMatch?.[2]) !== Math.floor(Date.parse(row.expires_at) / 1000)) return c.json({ error: "invalid or expired nonce" }, 401);
  try {
    if (!verifyNimiqMessage(body.message, body.signer, body.signerPublicKey, body.signature)) return c.json({ error: "invalid signature" }, 401);
  } catch { return c.json({ error: "invalid signature encoding" }, 401); }
  await db.query("UPDATE login_nonces SET consumed_at = $1 WHERE nonce = $2 AND consumed_at IS NULL", [iso(now()), nonceMatch![1]]);
  const address = body.signer.split(" ").join("").toUpperCase();
  await db.query("INSERT INTO addresses(address, created_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING", [address, iso(now())]);
  const id = randomBytes(24).toString("hex");
  await db.query("INSERT INTO sessions VALUES ($1, $2, $3)", [id, address, iso(now() + 30 * 24 * 60 * 60_000)]);
  c.header("Set-Cookie", cookie("operator_session", `${id}.${signSession(id)}`, 30 * 24 * 60 * 60));
  return c.json({ address });
});

app.post("/auth/logout", async c => {
  const raw = c.req.header("Cookie")?.match(/operator_session=([^;]+)/)?.[1];
  const id = raw?.split(".")[0];
  if (id) await db.query("DELETE FROM sessions WHERE id = $1", [id]);
  c.header("Set-Cookie", cookie("operator_session", "", 0));
  return c.json({ ok: true });
});

app.get("/daily", c => { const day = new Date().toISOString().slice(0, 10); return c.json({ day, gameId: dailyGame(day), startsAt: `${day}T00:00:00.000Z`, endsAt: `${new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString()}`, rewardNim: 5, qualificationScore: 500 }); });

app.get("/daily/status", async c => {
  const address = await sessionAddress(c);
  const day = new Date().toISOString().slice(0, 10);
  const rewardNim = 5;
  const qualificationScore = 500;
  if (!address) return c.json({ eligible: false, claimed: false, score: 0, rewardNim, qualificationScore });
  const scoreRow = (await db.query("SELECT COALESCE(MAX(score), 0) AS score FROM scores WHERE address = $1 AND game_id = $2 AND day = $3 AND mode = 'daily'", [address, dailyGame(day), day])).rows[0];
  const claim = (await db.query("SELECT status FROM reward_claims WHERE address = $1 AND day = $2", [address, day])).rows[0];
  const score = Number(scoreRow?.score ?? 0);
  return c.json({ eligible: score >= qualificationScore && !claim, claimed: Boolean(claim), score, rewardNim, qualificationScore });
});

app.post("/daily/claim", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ error: "ranked session required" }, 401);
  const day = new Date().toISOString().slice(0, 10);
  const rewardNim = 5;
  const qualificationScore = 500;
  const scoreRow = (await db.query("SELECT COALESCE(MAX(score), 0) AS score FROM scores WHERE address = $1 AND game_id = $2 AND day = $3 AND mode = 'daily'", [address, dailyGame(day), day])).rows[0];
  if (Number(scoreRow?.score ?? 0) < qualificationScore) return c.json({ error: "daily qualification not reached" }, 403);
  await db.query("INSERT INTO reward_claims(address, day, amount_nim, status, created_at) VALUES ($1, $2, $3, 'pending', $4) ON CONFLICT (address, day) DO NOTHING", [address, day, rewardNim, iso(now())]);
  return c.json({ status: "pending", rewardNim });
});

app.post("/runs", async c => {
  const address = await sessionAddress(c); if (!address) return c.json({ error: "ranked session required" }, 401);
  const body = await c.req.json<{ gameId?: RankedGameId; mode?: "daily" | "ranked" | "practice" }>();
  if (!body.gameId || !rankedGames.has(body.gameId) || !body.mode) return c.json({ error: "game is not ranked-capable" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  if (body.mode === "daily" && dailyGame(day) !== body.gameId) return c.json({ error: "not today's daily game" }, 409);
  if (body.mode === "daily") {
    const existing = await db.query("SELECT 1 FROM scores WHERE address = $1 AND game_id = $2 AND day = $3 AND mode = 'daily'", [address, body.gameId, day]);
    if (existing.rows.length) return c.json({ error: "daily attempt already used" }, 409);
  }
  const id = randomBytes(16).toString("hex"); const started = now(); const expires = started + gameLimits[body.gameId] + 120_000;
  const difficulty = body.mode === "daily" ? { tier: 2, label: "DAILY", description: "A shared standard challenge for every operator today." } : difficultyForRating((await ratingFor(address)).rating);
  const rawSeed = body.mode === "daily" ? seedFor(day, body.gameId) : randomBytes(16).toString("hex");
  const seed = `t${difficulty.tier}:${rawSeed}`;
  await db.query("INSERT INTO runs VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)", [id, address, body.gameId, body.mode, body.mode === "daily" ? day : null, seed, iso(started), iso(expires)]);
  return c.json({ runId: id, seed, gameId: body.gameId, mode: body.mode, expiresAt: iso(expires), difficulty });
});

app.post("/runs/start", async c => {
  const url = new URL(c.req.url); url.pathname = "/runs";
  return app.fetch(new Request(url, c.req.raw));
});

app.post("/runs/:id/submit", async c => {
  const address = await sessionAddress(c); if (!address) return c.json({ error: "ranked session required" }, 401);
  const run = (await db.query("SELECT * FROM runs WHERE id = $1 AND address = $2", [c.req.param("id"), address])).rows[0] as any;
  if (!run) return c.json({ error: "run not found" }, 404);
  if (run.consumed_at) return c.json({ error: "run already submitted" }, 409);
  if (Date.parse(run.expires_at) < now()) return c.json({ error: "run expired" }, 410);

  // Parse the body BEFORE consuming the run, so a malformed request can't burn the player's attempt.
  let body: { events?: GameEvent[] };
  try {
    body = await c.req.json<{ events?: GameEvent[] }>();
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }

  const claimed = await db.query("UPDATE runs SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL", [iso(now()), run.id]);
  if ((claimed.rowCount ?? 0) === 0) return c.json({ error: "run already submitted" }, 409);

  const events = body.events || []; const duration = events.length ? events[events.length - 1].t : 0;
  const serverDuration = now() - Date.parse(run.started_at);
  if (serverDuration < 100 || serverDuration > gameLimits[run.game_id as RankedGameId] + 120_000) return c.json({ error: "invalid server duration" }, 400);
  if (duration > gameLimits[run.game_id as RankedGameId]) return c.json({ error: "run duration exceeded" }, 400);
  const result = replay(run.game_id, run.seed, events);
  if (!result.valid) return c.json({ error: result.reason || "invalid replay" }, 400);
  if (run.mode === "practice") return c.json({ score: result.score, xp: result.xp, ranked: false });

  const previousBestRow = await db.query("SELECT MAX(score) AS best FROM scores WHERE address = $1 AND game_id = $2 AND mode IN ('daily','ranked')", [address, run.game_id]);
  const previousBest = previousBestRow.rows[0]?.best === null ? null : Number(previousBestRow.rows[0]?.best ?? 0);
  const previousBoard = await scoreboard(run.game_id, "all");
  const previousRank = previousBoard.find(row => row.address === address)?.rank ?? null;
  const ratingBefore = await ratingFor(address);
  const created = iso(now());
  try {
    await db.query(
      "INSERT INTO scores(address, game_id, mode, day, score, xp, duration_ms, run_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [address, run.game_id, run.mode, run.day, result.score, result.xp, duration, run.id, created],
    );
  } catch { return c.json({ error: "daily score already exists" }, 409); }

  // Real best score and rank, instead of the old placeholder values.
  const bestRow = await db.query(
    "SELECT MAX(score) AS best FROM scores WHERE address = $1 AND game_id = $2 AND mode IN ('daily','ranked')",
    [address, run.game_id],
  );
  const best = Number(bestRow.rows[0]?.best ?? result.score);
  const rankRow = await db.query(
    `SELECT COUNT(*) + 1 AS rank FROM (
       SELECT address, MAX(score) AS best_score FROM scores
       WHERE game_id = $1 AND mode IN ('daily','ranked') GROUP BY address
     ) ranked WHERE ranked.best_score > $2`,
    [run.game_id, best],
  );
  const rank = Number(rankRow.rows[0]?.rank ?? null);
  const verifiedStreak = await streakFor(address);
  const streakBonus = run.mode === "daily" ? streakBonusFor(verifiedStreak) : { bonusXp: 0, label: null as string | null };
  const awardedXp = result.xp + streakBonus.bonusXp;
  if (streakBonus.bonusXp > 0) {
    await db.query("UPDATE scores SET xp = $1 WHERE run_id = $2", [awardedXp, run.id]);
  }
  const ratingAfter = await ratingFor(address);
  await awardRankedAchievements(address, result.score, previousBest === null || result.score > previousBest, rank, run.mode);
  const board = await scoreboard(run.game_id, "all");
  const nextTarget = await nextTargetFor(board.map(row => ({ address: row.address, username: row.username, score: row.score })), address, best);
  const streak = await streakFor(address);

  const proofId = run.id;
  return c.json({ score: result.score, xp: awardedXp, streakBonusXp: streakBonus.bonusXp, streakBonusLabel: streakBonus.label, verifiedStreak, verifiedStreakDay: run.mode === "daily" ? run.day : null, proofId, proofCode: proofCodeFor(proofId), proofText: proofTextFor(run.game_id, result.score, rank, proofId), completed: result.completed ?? true, rank, previousRank, best, previousBest, personalBest: previousBest === null || result.score > previousBest, improvement: previousBest === null ? result.score : result.score - previousBest, rating: ratingAfter.rating, grade: ratingAfter.grade, displayGrade: displayGrade(ratingAfter.rating), ratingDelta: ratingAfter.rating - ratingBefore.rating, streak, nextTarget, ...ratingProgress(ratingAfter.rating) });
});

app.get("/leaderboard", async c => {
  const game = c.req.query("game") || "all";
  const periodRaw = c.req.query("period") || "all";
  const period = periodRaw === "daily" || periodRaw === "weekly" || periodRaw === "season" ? periodRaw : "all";
  if (game !== "all" && !rankedGames.has(game as RankedGameId)) return c.json([]);
  const address = await sessionAddress(c);
  const rows = await scoreboard(game === "all" ? "all" : game, period);
  return c.json(rows.map(row => ({ username: row.username, score: row.score, created_at: row.created_at, rank: row.rank, isYou: Boolean(address && row.address === address) })));
});

app.get("/dashboard", async c => {
  const address = await sessionAddress(c);
  const day = new Date().toISOString().slice(0, 10);
  const dailyGameId = dailyGame(day);
  const endsAt = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
  const achievementRows = (await db.query("SELECT id, name, description, rarity, xp FROM achievements ORDER BY id")).rows as Array<{ id: string; name: string; description: string; rarity: string; xp: number }>;
  const publicBoard = await ratingBoard();
  const gameBests = (await db.query("SELECT address, game_id, MAX(score) AS best FROM scores WHERE mode IN ('daily','ranked') GROUP BY address, game_id")).rows as Array<{ address: string; game_id: string; best: number }>;
  const ranksByGame: Record<string, Array<{ address: string; best: number }>> = {};
  for (const row of gameBests) {
    (ranksByGame[row.game_id] ??= []).push({ address: row.address, best: Number(row.best) });
  }
  for (const list of Object.values(ranksByGame)) list.sort((a, b) => b.best - a.best);

  function standing(gameId: string, player: string | null) {
    const list = ranksByGame[gameId] || [];
    if (!player) return { best: null as number | null, rank: null as number | null };
    const index = list.findIndex(row => row.address === player);
    if (index < 0) return { best: null, rank: null };
    return { best: list[index].best, rank: index + 1 };
  }

  const games = rankedGameList.map(gameId => ({ gameId, ...standing(gameId, address), ranked: true, challengeCapable: challengeGames.has(gameId) }));
  const dailyRows = (await db.query("SELECT s.address, s.score, COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.day = $2 AND s.mode = 'daily' ORDER BY s.score DESC, s.created_at ASC", [dailyGameId, day])).rows as Array<{ address: string; score: number; username: string }>;
  const dailyIndex = address ? dailyRows.findIndex(row => row.address === address) : -1;
  const dailySelf = dailyIndex < 0 ? null : dailyRows[dailyIndex];
  const dailyAbove = dailyIndex > 0 ? dailyRows[dailyIndex - 1] : null;

  if (!address) {
    return c.json({
      authenticated: false,
      operator: null,
      daily: { gameId: dailyGameId, endsAt, score: null, rank: null, completed: false, topScore: dailyRows[0] ? Number(dailyRows[0].score) : null, pointsToNext: null },
      games,
      nearbyPlayers: nearbySlice(publicBoard, -1).map(item => ({ rank: item.rank, username: item.row.username, score: item.row.rating, isYou: false })),
      nextTarget: null,
      challenges: [],
      achievements: { unlocked: 0, total: achievementRows.length, items: achievementRows.map(row => ({ ...row, unlocked: false })) },
      matchHistory: [],
      specialties: [],
      stats: null,
      streakDays: [],
      weeklySpotlight: await weeklySpotlight(),
    });
  }

  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  const xp = await xpFor(address);
  const stats = await ratingFor(address);
  const streak = await streakFor(address);
  const boardIndex = publicBoard.findIndex(row => row.address === address);
  const globalRank = boardIndex < 0 ? null : boardIndex + 1;
  const nearbyPlayers = nearbySlice(publicBoard, boardIndex).map(item => ({ rank: item.rank, username: item.row.username, score: item.row.rating, isYou: item.isYou }));
  const yourRating = stats.rating;
  const next = globalRank && globalRank > 1 ? publicBoard[globalRank - 2] : null;
  const unlocked = (await db.query("SELECT achievement_id, unlocked_at FROM player_achievements WHERE address = $1", [address])).rows as Array<{ achievement_id: string; unlocked_at: string }>;
  const unlockedMap = new Map(unlocked.map(row => [row.achievement_id, row.unlocked_at]));
  const challengeRows = (await db.query("SELECT f.id, f.game_id, f.creator_address, f.opponent_address, f.creator_score, f.opponent_score, f.created_at, f.expires_at, f.stake_label, ca.username AS creator_username, oa.username AS opponent_username FROM friend_challenges f LEFT JOIN addresses ca ON ca.address = f.creator_address LEFT JOIN addresses oa ON oa.address = f.opponent_address WHERE f.creator_address = $1 OR f.opponent_address = $2 ORDER BY f.created_at DESC LIMIT 20", [address, address])).rows as any[];
  const challenges = challengeRows.map(row => {
    const creatorScore = row.creator_score === null ? null : Number(row.creator_score);
    const opponentScore = row.opponent_score === null ? null : Number(row.opponent_score);
    const youAreCreator = row.creator_address === address;
    const yourScore = youAreCreator ? creatorScore : opponentScore;
    const theirScore = youAreCreator ? opponentScore : creatorScore;
    const incoming = !youAreCreator && yourScore === null;
    return { challengeId: row.id, gameId: row.game_id, opponentUsername: youAreCreator ? row.opponent_username : row.creator_username, yourScore, theirScore, outcome: yourScore === null || theirScore === null ? "ACTIVE" : yourScore === theirScore ? "DRAW" : yourScore > theirScore ? "WIN" : "LOSS", createdAt: row.created_at, expiresAt: row.expires_at, stakeLabel: row.stake_label ?? null, incoming };
  });
  const challengeWins = challenges.filter(item => item.outcome === "WIN").length;
  const challengeDecided = challenges.filter(item => item.outcome === "WIN" || item.outcome === "LOSS" || item.outcome === "DRAW").length;
  const history = (await db.query("SELECT game_id, mode, score, xp, created_at FROM scores WHERE address = $1 AND mode IN ('daily','ranked') ORDER BY created_at DESC LIMIT 20", [address])).rows as Array<{ game_id: string; mode: string; score: number; xp: number; created_at: string }>;
  const bestAll = (await db.query("SELECT COALESCE(MAX(score), 0) AS best FROM scores WHERE address = $1 AND mode IN ('daily','ranked')", [address])).rows[0];
  const dailyDays = (await db.query("SELECT DISTINCT day FROM scores WHERE address = $1 AND mode = 'daily' AND day IS NOT NULL ORDER BY day DESC LIMIT 14", [address])).rows as Array<{ day: string }>;
  const completedDays = new Set(dailyDays.map(row => String(row.day).slice(0, 10)));
  const streakDays = Array.from({ length: 7 }, (_, i) => {
    const cursor = new Date(Date.parse(`${day}T00:00:00.000Z`) - i * 86_400_000).toISOString().slice(0, 10);
    return { day: cursor, completed: completedDays.has(cursor) };
  }).reverse();
  const specialties = rankedGameList.map(gameId => ({ gameId, ...standing(gameId, address) })).filter(item => item.rank !== null);
  const dailyCompleted = Boolean(dailySelf);
  const prompts: string[] = [];
  if (next) prompts.push(`${Number(next.rating) - yourRating} points to #${globalRank! - 1}`);
  if (dailySelf) prompts.push(`You're now #${dailyIndex + 1} today.`);
  if (streak > 0 && !dailyCompleted) prompts.push("Your streak is at risk.");
  if (globalRank && globalRank > 20 && globalRank <= 23) prompts.push(`You're ${globalRank - 20} places away from the Top 20.`);

  return c.json({
    authenticated: true,
    operator: {
      username: account?.username || null,
      title: titleFor(stats.verifiedRuns, stats.rating, streak),
      badge: badgeFor(stats.verifiedRuns, stats.rating),
      streakBonus: streakBonusFor(streak),
      rating: stats.rating,
      grade: stats.grade,
      displayGrade: displayGrade(stats.rating),
      verifiedRuns: stats.verifiedRuns,
      ...levelFor(xp),
      streak,
      globalRank,
      ...ratingProgress(stats.rating),
    },
    daily: { gameId: dailyGameId, endsAt, score: dailySelf ? Number(dailySelf.score) : null, rank: dailySelf ? dailyIndex + 1 : null, completed: dailyCompleted, topScore: dailyRows[0] ? Number(dailyRows[0].score) : null, pointsToNext: dailyAbove && dailySelf ? Number(dailyAbove.score) - Number(dailySelf.score) : null },
    games,
    nearbyPlayers,
    nextTarget: next ? { rank: globalRank! - 1, username: next.username, score: next.rating, pointsAway: next.rating - yourRating } : null,
    challenges,
    achievements: { unlocked: unlocked.length, total: achievementRows.length, items: achievementRows.map(row => ({ ...row, unlocked: unlockedMap.has(row.id), unlockedAt: unlockedMap.get(row.id) })) },
    matchHistory: history.map(row => ({ gameId: row.game_id, mode: row.mode, score: Number(row.score), xp: Number(row.xp), createdAt: row.created_at })),
    specialties,
    stats: {
      gamesPlayed: stats.verifiedRuns,
      wins: challengeWins,
      winRate: challengeDecided ? Math.round((challengeWins / challengeDecided) * 100) : null,
      bestScore: Number(bestAll?.best ?? 0),
      xp,
    },
    streakDays,
    weeklySpotlight: await weeklySpotlight(),
    prompts,
  });
});

app.get("/me", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ address: null, username: null, xp: 0, streak: 0, rating: 0, grade: "UNRANKED", verifiedRuns: 0 });
  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  const row = (await db.query("SELECT COALESCE((SELECT SUM(xp) FROM scores WHERE address = $1 AND mode IN ('daily','ranked')), 0) + COALESCE((SELECT SUM(xp) FROM player_achievements WHERE address = $2), 0) AS xp", [address, address])).rows[0];
  const xp = Number(row?.xp ?? 0);
  const stats = await ratingFor(address);
  const meStreak = await streakFor(address);
  return c.json({ address, username: account?.username || null, streak: meStreak, rating: stats.rating, grade: stats.grade, displayGrade: displayGrade(stats.rating), verifiedRuns: stats.verifiedRuns, title: titleFor(stats.verifiedRuns, stats.rating, meStreak), badge: badgeFor(stats.verifiedRuns, stats.rating), ...levelFor(xp), ...ratingProgress(stats.rating) });
});

app.get("/competitive-summary", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ authenticated: false, globalRank: null, nextTarget: null, personalBest: null, daily: null, streak: 0 });
  const game = c.req.query("game") || "reaction";
  if (!rankedGames.has(game as RankedGameId)) return c.json({ error: "game is not ranked-capable" }, 400);
  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  const xpRow = (await db.query("SELECT COALESCE((SELECT SUM(xp) FROM scores WHERE address = $1 AND mode IN ('daily','ranked')), 0) + COALESCE((SELECT SUM(xp) FROM player_achievements WHERE address = $2), 0) AS xp", [address, address])).rows[0];
  const xp = Number(xpRow?.xp ?? 0);
  const stats = await ratingFor(address);
  const bestRow = (await db.query("SELECT MAX(score) AS best, COUNT(*) AS runs, MIN(created_at) AS first_run, MAX(created_at) AS latest_run FROM scores WHERE address = $1 AND game_id = $2 AND mode IN ('daily','ranked')", [address, game])).rows[0];
  const ranking = (await db.query("SELECT s.address, MAX(s.score) AS score, MIN(s.created_at) AS created_at, a.username FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.mode IN ('daily','ranked') GROUP BY s.address, a.username ORDER BY score DESC, created_at ASC", [game])).rows as Array<{ address: string; score: number; created_at: string; username?: string | null }>;
  const currentRankIndex = ranking.findIndex(row => row.address === address);
  const globalRank = currentRankIndex < 0 ? null : currentRankIndex + 1;
  const next = globalRank && globalRank > 1 ? ranking[globalRank - 2] : null;
  const day = new Date().toISOString().slice(0, 10);
  const dailyGameId = dailyGame(day);
  const dailyRows = (await db.query("SELECT s.address, s.score, a.username FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.day = $2 AND s.mode = 'daily' ORDER BY s.score DESC, s.created_at ASC", [dailyGameId, day])).rows as Array<{ address: string; score: number; username?: string | null }>;
  const dailyIndex = dailyRows.findIndex(row => row.address === address);
  const dailySelf = dailyIndex < 0 ? null : dailyRows[dailyIndex];
  const dailyAbove = dailyIndex > 0 ? dailyRows[dailyIndex - 1] : null;
  return c.json({ authenticated: true, username: account?.username || null, xp, level: Math.floor(xp / 500) + 1, nextLevelXp: 500 - (xp % 500), rating: stats.rating, grade: stats.grade, ...ratingProgress(stats.rating), verifiedRuns: stats.verifiedRuns, streak: await streakFor(address), globalRank, nextTarget: next ? { rank: globalRank! - 1, username: next.username || "Unnamed Player", score: Number(next.score), pointsAway: Number(next.score) - Number(bestRow?.best ?? 0) } : null, personalBest: bestRow?.best === null ? null : { score: Number(bestRow.best), runs: Number(bestRow.runs), firstRun: bestRow.first_run, latestRun: bestRow.latest_run }, daily: { gameId: dailyGameId, score: dailySelf ? Number(dailySelf.score) : null, rank: dailySelf ? dailyIndex + 1 : null, topScore: dailyRows[0] ? Number(dailyRows[0].score) : null, pointsToNext: dailyAbove && dailySelf ? Number(dailyAbove.score) - Number(dailySelf.score) : null, endsAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() } });
});

app.get("/achievements", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json([]);
  return c.json((await db.query("SELECT a.id, a.name, a.description, a.rarity, a.xp, p.unlocked_at AS unlockedAt FROM achievements a LEFT JOIN player_achievements p ON p.achievement_id = a.id AND p.address = $1 ORDER BY a.id", [address])).rows.map((row: any) => ({ ...row, unlocked: Boolean(row.unlockedAt) })));
});

app.put("/me/username", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ error: "ranked session required" }, 401);
  let body: { username?: string } = {};
  try { body = await c.req.json<{ username?: string }>(); } catch { return c.json({ error: "invalid request body" }, 400); }
  const username = body.username?.trim() || "";
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) return c.json({ error: "Username must be 3-20 characters using letters, numbers, _ or -" }, 400);
  const existing = (await db.query("SELECT address FROM addresses WHERE LOWER(username) = LOWER($1) AND address <> $2", [username, address])).rows[0];
  if (existing) return c.json({ error: "Username already taken" }, 409);
  try {
    await db.query("UPDATE addresses SET username = $1 WHERE address = $2", [username, address]);
  } catch {
    return c.json({ error: "Username already taken" }, 409);
  }
  return c.json({ username });
});

if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) serve({ fetch: app.fetch, port: Number(process.env.PORT || 8787) });
export default app;
