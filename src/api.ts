const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "/api" : "http://localhost:8787");

export type RunMode = "daily" | "ranked" | "practice";
export type Run = { runId: string; seed: string; gameId: string; mode: RunMode; expiresAt: string; challengeToken?: string };
export type DailyOperation = { day: string; gameId: string; startsAt: string; endsAt: string; rewardNim: number; qualificationScore: number };
export type DailyStatus = { eligible: boolean; claimed: boolean; score: number; rewardNim: number; qualificationScore: number };

export async function getDaily() {
  const response = await fetch(`${API_URL}/daily`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load daily operation");
  return await response.json() as DailyOperation;
}

export async function getDailyStatus() {
  const response = await fetch(`${API_URL}/daily/status`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load daily status");
  return await response.json() as DailyStatus;
}

export async function requestDailyReward() {
  const response = await fetch(`${API_URL}/daily/claim`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await response.json()).error || "Could not request daily reward");
  return await response.json() as { status: "pending"; rewardNim: number };
}

export async function requestNonce() {
  const response = await fetch(`${API_URL}/auth/nonce`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error("Could not start wallet login");
  return await response.json() as { nonce: string; exp: number; message: string };
}

export async function verifyLogin(payload: { message: string; signer: string; signerPublicKey: string; signature: string }) {
  const response = await fetch(`${API_URL}/auth/verify`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error((await response.json()).error || "Wallet login was rejected");
  return await response.json() as { address: string };
}

export async function logoutSession() {
  const response = await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error("Could not sign out");
}

export async function startRun(gameId: string, mode: RunMode) {
  const response = await fetch(`${API_URL}/runs/start`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gameId, mode }) });
  if (!response.ok) throw new Error((await response.json()).error || "Could not start ranked run");
  return await response.json() as Run;
}

export async function submitRun(runId: string, events: unknown[]) {
  const response = await fetch(`${API_URL}/runs/${runId}/submit`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
  if (!response.ok) throw new Error((await response.json()).error || "Run was rejected");
  return await response.json() as { score: number; xp: number; rank: number | null; best: number; previousBest?: number | null; personalBest?: boolean; improvement?: number; rating?: number; grade?: string; ratingDelta?: number; nextGrade?: string | null; nextGradeRating?: number | null; ratingToNext?: number; progressPercent?: number; ranked?: boolean };
}

export async function getLeaderboard(gameId: string, period: "daily" | "all" = "all") {
  const response = await fetch(`${API_URL}/leaderboard?game=${encodeURIComponent(gameId)}&period=${period}`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load leaderboard");
  return await response.json() as Array<{ username: string; score: number; created_at: string }>;
}

export async function getMe() {
  const response = await fetch(`${API_URL}/me`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load operator profile");
  return await response.json() as { address: string | null; username: string | null; xp: number; streak: number; rating: number; grade: string; verifiedRuns: number };
}

export type CompetitiveSummary = {
  authenticated: boolean;
  username?: string | null;
  xp?: number;
  level?: number;
  nextLevelXp?: number;
  rating?: number;
  grade?: string;
  nextGrade?: string | null;
  nextGradeRating?: number | null;
  ratingToNext?: number;
  progressPercent?: number;
  verifiedRuns?: number;
  streak?: number;
  globalRank: number | null;
  nextTarget: { rank: number; username: string; score: number; pointsAway: number } | null;
  personalBest: { score: number; runs: number; firstRun: string; latestRun: string } | null;
  daily: { gameId: string; score: number | null; rank: number | null; topScore: number | null; pointsToNext: number | null; endsAt: string } | null;
};

export async function getCompetitiveSummary(gameId: string) {
  const response = await fetch(`${API_URL}/competitive-summary?game=${encodeURIComponent(gameId)}`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load competitive summary");
  return await response.json() as CompetitiveSummary;
}

export type Achievement = { id: string; name: string; description: string; rarity: string; xp: number; unlocked: boolean; unlockedAt?: string };
export type ChallengeHistory = { challengeId: string; gameId: string; opponentUsername: string | null; yourScore: number | null; theirScore: number | null; outcome: "ACTIVE" | "DRAW" | "WIN" | "LOSS"; createdAt: string };

export async function getAchievements() {
  const response = await fetch(`${API_URL}/achievements`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load achievements");
  return await response.json() as Achievement[];
}

export async function getChallengeHistory() {
  const response = await fetch(`${API_URL}/challenges/history`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load challenge history");
  return await response.json() as ChallengeHistory[];
}

export async function updateUsername(username: string) {
  const response = await fetch(`${API_URL}/me/username`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
  const body = await response.json() as { username?: string; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not save username");
  return body as { username: string };
}

export async function trackEvent(event: "wallet_connected" | "run_started" | "run_verified" | "run_rejected" | "reward_requested", gameId?: string) {
  await fetch(`${API_URL}/analytics/event`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, gameId }),
    keepalive: true,
  }).catch(() => {});
}

export type Challenge = {
  challengeId: string;
  token: string;
  gameId: string;
  seed?: string;
  creatorUsername: string;
  opponentUsername: string | null;
  creatorScore: number | null;
  opponentScore: number | null;
  winnerUsername: string | null;
  status: "WAITING" | "IN_PROGRESS" | "COMPLETED" | "EXPIRED";
  expiresAt: string;
};

export async function createChallenge(gameId: string) {
  const response = await fetch(`${API_URL}/challenges`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gameId }) });
  if (!response.ok) throw new Error((await response.json()).error || "Could not create challenge");
  return await response.json() as Challenge & { seed: string };
}

export async function getChallenge(challengeId: string) {
  const response = await fetch(`${API_URL}/challenges/${encodeURIComponent(challengeId)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await response.json()).error || "Could not load challenge");
  return await response.json() as Challenge;
}

export async function joinChallenge(challengeId: string) {
  const response = await fetch(`${API_URL}/challenges/${encodeURIComponent(challengeId)}/join`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await response.json()).error || "Could not join challenge");
  return await response.json() as Challenge & { seed: string };
}

export async function submitChallenge(challengeId: string, events: unknown[]) {
  const response = await fetch(`${API_URL}/challenges/${encodeURIComponent(challengeId)}/submit`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
  if (!response.ok) throw new Error((await response.json()).error || "Challenge run was rejected");
  return await response.json() as { score: number; xp: number; rank?: number | null; previousBest?: number | null; improvement?: number; personalBest?: boolean; rating?: number; grade?: string; ratingDelta?: number; nextGrade?: string | null; nextGradeRating?: number | null; ratingToNext?: number; progressPercent?: number; opponentScore: number | null; opponentUsername: string | null; winnerUsername: string | null; status: Challenge["status"] };
}
