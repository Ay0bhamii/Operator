import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { createHmac, randomBytes } from "node:crypto";
import { Hash, PublicKey, Signature } from "@nimiq/core";
import { createPuzzle, dailyGame, replay, type GameEvent, type RankedGameId } from "../packages/game-core/index.js";

const app = new Hono();
const pgDb = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
}) : null;
const sqliteDb = pgDb ? null : new Database(process.env.DATABASE_FILE || "arcade.sqlite");
const db = {
  async query(sql: string, params: unknown[] = []) {
    if (pgDb) return pgDb.query(sql, params);
    if (!sqliteDb) throw new Error("Database is not configured");
    const sqliteSql = sql.replace(/\$\d+/g, "?");
    const lower = sql.trim().toLowerCase();
    if (lower.startsWith("create ") || lower.startsWith("drop ") || lower.startsWith("alter ") || lower.startsWith("delete ")) {
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
const rankedGames = new Set<RankedGameId>(["block-rush", "nim-pin", "memory", "vault", "sync"]);
const challengeGames = new Set<RankedGameId>(["nim-pin", "memory", "vault"]);
const gameLimits: Record<string, number> = { "block-rush": 30000, "nim-pin": 12000, memory: 2500, vault: 10000, sync: 30000 };

await db.query(`
CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, username TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS login_nonces (nonce TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT, seed TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS scores (id SERIAL PRIMARY KEY, address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT, score INTEGER NOT NULL, xp INTEGER NOT NULL, duration_ms INTEGER NOT NULL, run_id TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS reward_claims (address TEXT NOT NULL, day TEXT NOT NULL, amount_nim INTEGER NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (address, day));
CREATE TABLE IF NOT EXISTS analytics_events (id SERIAL PRIMARY KEY, event TEXT NOT NULL, game_id TEXT, address TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS friend_challenges (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, game_id TEXT NOT NULL, creator_address TEXT NOT NULL, opponent_address TEXT, seed TEXT NOT NULL, creator_score INTEGER, opponent_score INTEGER, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS scores_daily_unique ON scores(address, game_id, day) WHERE mode = 'daily';
`);

try { await db.query("ALTER TABLE addresses ADD COLUMN username TEXT"); } catch {}
try { await db.query("CREATE UNIQUE INDEX IF NOT EXISTS addresses_username_unique ON addresses(LOWER(username)) WHERE username IS NOT NULL"); } catch {}

const now = () => Date.now();
const iso = (value: number) => new Date(value).toISOString();
const text = (value: string) => new TextEncoder().encode(value);
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=${process.env.COOKIE_SAME_SITE || "Lax"}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const signSession = (id: string) => createHmac("sha256", sessionSecret).update(id).digest("hex");
const seedFor = (day: string, gameId: string) => createHmac("sha256", dailySecret).update(`${day}:${gameId}`).digest("hex").slice(0, 32);

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
  const raw = c.req.header("Cookie")?.match(/arcade_session=([^;]+)/)?.[1];
  if (!raw) return null;
  const [id, mac] = raw.split(".");
  if (!id || mac !== signSession(id)) return null;
  const { rows } = await db.query("SELECT address, expires_at FROM sessions WHERE id = $1", [id]);
  const row = rows[0] as { address: string; expires_at: string } | undefined;
  if (!row || Date.parse(row.expires_at) <= now()) return null;
  return row.address;
}

app.use("/*", cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173", credentials: true }));
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
  const body = await c.req.json<{ gameId?: RankedGameId }>();
  if (!body.gameId || !challengeGames.has(body.gameId)) return c.json({ error: "game is not challenge-capable" }, 400);
  const creator = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  if (!creator?.username) return c.json({ error: "username required before creating a challenge" }, 409);
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(8).toString("base64url");
  const seed = randomBytes(16).toString("hex");
  const created = now();
  await db.query("INSERT INTO friend_challenges(id, token, game_id, creator_address, seed, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, token, body.gameId, address, seed, iso(created), iso(created + 24 * 60 * 60_000)]);
  return c.json({ challengeId: id, token: id, gameId: body.gameId, seed, creatorUsername: creator.username, opponentUsername: null, creatorScore: null, opponentScore: null, winnerUsername: null, status: "WAITING", expiresAt: iso(created + 24 * 60 * 60_000) });
});

app.get("/challenges/:token", async c => {
  const challengeId = c.req.param("token");
  const row = (await db.query("SELECT f.id, f.token, f.game_id, f.creator_address, f.opponent_address, f.creator_score, f.opponent_score, f.created_at, f.expires_at, ca.username AS creator_username, oa.username AS opponent_username FROM friend_challenges f LEFT JOIN addresses ca ON ca.address = f.creator_address LEFT JOIN addresses oa ON oa.address = f.opponent_address WHERE f.id = $1 OR f.token = $2", [challengeId, challengeId])).rows[0] as any;
  if (!row || Date.parse(row.expires_at) <= now()) return c.json({ error: "challenge not found or expired" }, 404);
  const status = row.creator_score !== null && row.opponent_score !== null ? "COMPLETED" : row.opponent_address ? "IN_PROGRESS" : "WAITING";
  const winnerUsername = status === "COMPLETED" ? row.creator_score === row.opponent_score ? null : row.creator_score > row.opponent_score ? row.creator_username : row.opponent_username : null;
  return c.json({ challengeId: row.id, token: row.id, gameId: row.game_id, creatorUsername: row.creator_username || "Unnamed Player", opponentUsername: row.opponent_username || null, creatorScore: row.creator_score, opponentScore: row.opponent_score, winnerUsername, status, createdAt: row.created_at, expiresAt: row.expires_at });
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
  return c.json({ score: result.score, xp: result.xp, opponentScore: row.creator_address === address ? latest.opponent_score : latest.creator_score, opponentUsername: row.creator_address === address ? latest.opponent_username : latest.creator_username, winnerUsername, status: complete ? "COMPLETED" : "IN_PROGRESS" });
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
  c.header("Set-Cookie", cookie("arcade_session", `${id}.${signSession(id)}`, 30 * 24 * 60 * 60));
  return c.json({ address });
});

app.post("/auth/logout", async c => {
  const raw = c.req.header("Cookie")?.match(/arcade_session=([^;]+)/)?.[1];
  const id = raw?.split(".")[0];
  if (id) await db.query("DELETE FROM sessions WHERE id = $1", [id]);
  c.header("Set-Cookie", cookie("arcade_session", "", 0));
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
  const id = randomBytes(16).toString("hex"); const started = now(); const expires = started + gameLimits[body.gameId] + 15_000;
  const seed = body.mode === "daily" ? seedFor(day, body.gameId) : randomBytes(16).toString("hex");
  await db.query("INSERT INTO runs VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)", [id, address, body.gameId, body.mode, body.mode === "daily" ? day : null, seed, iso(started), iso(expires)]);
  return c.json({ runId: id, seed, gameId: body.gameId, mode: body.mode, expiresAt: iso(expires) });
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
  if (serverDuration < 100 || serverDuration > gameLimits[run.game_id as RankedGameId] + 15_000) return c.json({ error: "invalid server duration" }, 400);
  if (duration > gameLimits[run.game_id as RankedGameId]) return c.json({ error: "run duration exceeded" }, 400);
  const result = replay(run.game_id, run.seed, events);
  if (!result.valid) return c.json({ error: result.reason || "invalid replay" }, 400);
  if (run.mode === "practice") return c.json({ score: result.score, xp: result.xp, ranked: false });

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

  return c.json({ score: result.score, xp: result.xp, rank, best });
});

app.get("/leaderboard", async c => {
  const game = c.req.query("game"); const period = c.req.query("period") === "daily" ? "daily" : "all";
  if (!game) return c.json([]);
  const rows = period === "daily"
    ? (await db.query("SELECT COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, s.score, s.created_at FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.mode = 'daily' ORDER BY s.score DESC, s.created_at ASC LIMIT 50", [game])).rows
    : (await db.query("SELECT COALESCE(NULLIF(a.username, ''), 'Unnamed Player') AS username, MAX(s.score) AS score, MIN(s.created_at) AS created_at FROM scores s LEFT JOIN addresses a ON a.address = s.address WHERE s.game_id = $1 AND s.mode IN ('daily','ranked') GROUP BY s.address, a.username ORDER BY score DESC, created_at ASC LIMIT 50", [game])).rows;
  return c.json(rows);
});

app.get("/me", async c => {
  const address = await sessionAddress(c);
  if (!address) return c.json({ address: null, username: null, xp: 0, streak: 0, rating: 0, grade: "UNRANKED", verifiedRuns: 0 });
  const account = (await db.query("SELECT username FROM addresses WHERE address = $1", [address])).rows[0] as { username?: string | null } | undefined;
  const { rows } = await db.query("SELECT COALESCE(SUM(xp), 0) AS xp, COUNT(*) AS verified_runs, COALESCE(AVG(score), 0) AS average_score FROM scores WHERE address = $1 AND mode IN ('daily','ranked')", [address]);
  const xp = Number(rows[0].xp);
  const verifiedRuns = Number(rows[0].verified_runs);
  const rating = Math.min(3000, 1000 + Math.round(Number(rows[0].average_score) / 10) + verifiedRuns * 5);
  const grade = rating >= 2400 ? "DIAMOND" : rating >= 1900 ? "PLATINUM" : rating >= 1500 ? "GOLD" : rating >= 1200 ? "SILVER" : "BRONZE";
  return c.json({ address, username: account?.username || null, xp, streak: 0, rating, grade, verifiedRuns });
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
