import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, Clock3, Crosshair, Flame, Gamepad, Gauge, Hammer, Layers, MousePointerClick, Palette, Plane, Play, Shield, Sparkles, Trophy, Zap,
} from "lucide-react";
import { connectNimiq, isNimiqPay } from "./nimiq";
import {
  createChallenge,
  getChallenge,
  getDaily,
  getDailyStatus,
  getDashboard,
  getCompetitiveSummary,
  getAchievements,
  getChallengeHistory,
  getLeaderboard,
  getMe,
  joinChallenge,
  logoutSession,
  requestDailyReward,
  startRun,
  submitChallenge,
  submitRun,
  trackEvent,
  updateUsername,
  type DailyOperation,
  type DailyStatus,
  type Challenge,
  type CompetitiveSummary,
  type Achievement,
  type ChallengeHistory,
  type Run
} from "./api";
import type { Dashboard, RankedPeriod } from "./api";
import { formatCountdown, getGlobalRankText } from "./ui-format";
import type { GameEvent } from "../packages/game-core/index";
import { COLORS, COLOR_NAMES, createPuzzle, FLIGHT, simulateFlight, stackBlockX } from "../packages/game-core/index";

type GameId = "reaction" | "color" | "whack" | "flight" | "pop" | "memory" | "stack";

type Result = { score: number; xp: number; time?: number };
type RankedSubmission = { state: "idle" | "submitting" | "verified" | "rejected"; score?: number; xp?: number; completed?: boolean; error?: string; streakBonusXp?: number; streakBonusLabel?: string | null; proofId?: string; proofCode?: string; proofText?: string; stakeLabel?: string | null; rank?: number | null; playerUsername?: string; opponentUsername?: string | null; opponentScore?: number | null; winnerUsername?: string | null; previousBest?: number | null; improvement?: number; personalBest?: boolean; ratingDelta?: number; rating?: number; grade?: string; nextGrade?: string | null; ratingToNext?: number; progressPercent?: number };

const games: { id: GameId; name: string; subtitle: string; icon: any; difficulty: string }[] = [
  { id: "reaction", name: "NIM Reaction", subtitle: "Tap the instant the target appears", icon: Zap, difficulty: "Easy" },
  { id: "color", name: "NIM Color", subtitle: "Tap the ink color, ignore the word", icon: Palette, difficulty: "Medium" },
  { id: "whack", name: "NIM Whack", subtitle: "Hit every target in ten seconds", icon: Hammer, difficulty: "Easy" },
  { id: "flight", name: "NIM Flight", subtitle: "Guide the coin through every gate", icon: Plane, difficulty: "Hard" },
  { id: "pop", name: "NIM Pop", subtitle: "Pop the balloons before they fade", icon: MousePointerClick, difficulty: "Easy" },
  { id: "memory", name: "NIM Memory", subtitle: "Replay the growing color pattern", icon: Brain, difficulty: "Medium" },
  { id: "stack", name: "NIM Stack", subtitle: "Drop every block on the tower", icon: Layers, difficulty: "Expert" },
];

const gameBriefings: Record<GameId, { objective: string; controls: string; tip: string }> = {
  reaction: { objective: "Tap once, as soon as the target lights up.", controls: "One tap inside the playfield.", tip: "Tapping before the target appears is a false start." },
  color: { objective: "Match the ink color, not the written word.", controls: "Tap RED, GREEN, BLUE, or GOLD.", tip: "Speed rises every round—trust the color." },
  whack: { objective: "Hit every target before ten seconds end.", controls: "Tap each lit pad.", tip: "Clear pads early instead of waiting for expiry." },
  flight: { objective: "Flap through every sky gate without crashing.", controls: "Tap FLAP to climb; release to fall.", tip: "Short rhythmic taps beat long panicked bursts." },
  pop: { objective: "Pop every balloon in twenty seconds.", controls: "Tap each balloon once.", tip: "Work left to right so none expire unnoticed." },
  memory: { objective: "Watch the sequence, then reproduce it exactly.", controls: "Tap the four color pads in order.", tip: "Say the colors aloud while they show." },
  stack: { objective: "Drop every moving block onto the tower.", controls: "Tap DROP when the block is centered.", tip: "Centered drops keep the tower wide and safe." },
};

const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - .5);

function App() {
  const challengePath = window.location.pathname.match(/^\/challenge\/([^/]+)\/?$/);
  const [game,setGame]=useState<GameId|null>(null);
  const [briefing,setBriefing]=useState<{ id: GameId; mode: "ranked" | "daily" } | null>(null);
  const [wallet,setWallet]=useState<string|null>(null);
  const [activeRun,setActiveRun]=useState<Run|null>(null);
  const [challengeCopied,setChallengeCopied]=useState(false);
  const [challengeGame,setChallengeGame]=useState<GameId>("reaction");
  const [challengeToken,setChallengeToken]=useState("");
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [challengeLink,setChallengeLink]=useState("");
  const [challengeMessage,setChallengeMessage]=useState<string|null>(null);
  const [rewardError,setRewardError]=useState<string|null>(null);
  const [dailyStatus,setDailyStatus]=useState<DailyStatus|null>(null);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [dashboardLoading,setDashboardLoading]=useState(true);
  const [view,setView]=useState<"operations"|"rankings"|"profile">("operations");
  const [rankingPeriod,setRankingPeriod]=useState<RankedPeriod>("all");
  const eventsRef=useRef<GameEvent[]>([]);
  const runStartedAt=useRef(0);
  // A game can finish from both its last interaction and its timer in the same render.
  // Keep completion server-authoritative, but never submit the same signed run twice.
  const submittingRunRef=useRef<string|null>(null);
  const [rankedSubmission,setRankedSubmission]=useState<RankedSubmission>({state:"idle"});
  const [dailyOperation,setDailyOperation]=useState<DailyOperation|null>(null);
  const [leaderboard,setLeaderboard]=useState<Array<{username:string;score:number;rank:number;isYou?:boolean}>>([]);
  const [leaderboardGame,setLeaderboardGame]=useState<GameId>("reaction");
  const [verifiedBest,setVerifiedBest]=useState(0);
  const [profile,setProfile]=useState<{username:string|null;rating:number;grade:string;displayGrade?:string;verifiedRuns:number;streak:number;title?:string|null;badge?:string|null}|null>(null);
  const [competitiveSummary,setCompetitiveSummary]=useState<CompetitiveSummary|null>(null);
  const [achievements,setAchievements]=useState<Achievement[]>([]);
  const [challengeHistory,setChallengeHistory]=useState<ChallengeHistory[]>([]);
  const [xp,setXp]=useState(()=>Number(localStorage.getItem("nhl-xp")||0));
  const [scores,setScores]=useState<Record<string,number>>(()=>{
    try {
      const stored = JSON.parse(localStorage.getItem("nhl-scores") || "{}");
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    } catch { return {}; }
  });
  const [stakeInput,setStakeInput]=useState("");
  const [dailyDone,setDailyDone]=useState(()=>localStorage.getItem("nhl-daily")===new Date().toISOString().slice(0,10));

  useEffect(()=>localStorage.setItem("nhl-xp",String(xp)),[xp]);
  useEffect(()=>localStorage.setItem("nhl-scores",JSON.stringify(scores)),[scores]);
  useEffect(()=>{getMe().then(profile=>{if(profile.address){setWallet(profile.address);setXp(profile.xp);setProfile(profile);if(!profile.username)setUsernamePrompt(true)}}).catch(()=>{})},[]);
  useEffect(()=>{getLeaderboard(leaderboardGame, rankingPeriod).then(rows=>setLeaderboard(rows)).catch(()=>setLeaderboard([]))},[leaderboardGame,rankingPeriod]);
  useEffect(()=>{if(wallet){getCompetitiveSummary(leaderboardGame).then(setCompetitiveSummary).catch(()=>setCompetitiveSummary(null));} else setCompetitiveSummary(null)},[wallet,leaderboardGame]);
  useEffect(()=>{if(wallet){getAchievements().then(setAchievements).catch(()=>setAchievements([]));getChallengeHistory().then(setChallengeHistory).catch(()=>setChallengeHistory([]));} else {setAchievements([]);setChallengeHistory([])}},[wallet]);
  useEffect(()=>{getDaily().then(setDailyOperation).catch(()=>setDailyOperation(null))},[]);
  useEffect(()=>{if(wallet){getDailyStatus().then(setDailyStatus).catch(()=>setDailyStatus(null));} else { setDailyStatus(null);} },[wallet]);
  useEffect(()=>{
    setDashboardLoading(true);
    getDashboard().then(setDashboard).catch(()=>setDashboard(null)).finally(()=>setDashboardLoading(false));
  },[wallet]);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const id=window.setInterval(()=>setNow(Date.now()),1000); return ()=>window.clearInterval(id);},[]);

  const displayXp=dashboard?.operator?.xp ?? competitiveSummary?.xp ?? xp;
  const level=competitiveSummary?.level ?? Math.floor(displayXp/500)+1, levelXp=displayXp%500, best=Math.max(0,...Object.values(scores));
  const dailyGame = dailyOperation ? games.find(g=>g.id===dailyOperation.gameId) ?? games[0] : games[0];
  const dailyRemaining = dailyOperation ? Math.max(0, (new Date(dailyOperation.endsAt).getTime() - now) / 1000) : 4*60*60 + 32*60 + 18;
  const globalRank = dashboard?.operator?.globalRank ?? competitiveSummary?.globalRank;
  const pointsAway = dashboard?.nextTarget?.pointsAway ?? competitiveSummary?.nextTarget?.pointsAway ?? null;
  const [walletError,setWalletError]=useState<string|null>(null);
  const [authPrompt,setAuthPrompt]=useState(false);
  const [pendingRankedGame,setPendingRankedGame]=useState<GameId|null>(null);
  const [pendingRankedMode,setPendingRankedMode]=useState<"ranked"|"daily">("ranked");
  const [pendingChallengeId,setPendingChallengeId]=useState<string|null>(null);
  const [usernamePrompt,setUsernamePrompt]=useState(false);
  const [usernameInput,setUsernameInput]=useState("");
  const [usernameError,setUsernameError]=useState<string|null>(null);
  const [usernameSaving,setUsernameSaving]=useState(false);

  function triggerFeedback(kind: "tap" | "success" | "error" = "tap") {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      const pattern = kind === "success" ? [18, 32, 18] : kind === "error" ? [34, 24, 34] : [10];
      navigator.vibrate(pattern);
    }
  }

  async function copyChallenge() {
    const shareText = challengeLink || "Create a challenge first";
    try {
      await navigator.clipboard.writeText(shareText);
      setChallengeCopied(true);
      triggerFeedback("success");
      window.setTimeout(() => setChallengeCopied(false), 1200);
    } catch {
      setChallengeCopied(false);
      triggerFeedback("error");
    }
  }

  async function connect(){
    setWalletError(null);
    try {
      const a=await connectNimiq();
      if(a){
        setWallet(a);
        trackEvent("wallet_connected");
        getMe().then(profile=>{setXp(profile.xp);setProfile(profile);if(!profile.username)setUsernamePrompt(true)}).catch(()=>{});
      }
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Wallet connection failed");
    }
  }

  useEffect(()=>{
    if(!wallet || !pendingRankedGame || !profile) return;
    if(!profile.username){setUsernamePrompt(true);return;}
    const id=pendingRankedGame;
    const mode=pendingRankedMode;
    setPendingRankedGame(null);
    void launchGame(id,mode);
  },[wallet,pendingRankedGame,pendingRankedMode,profile]);

  async function signOut(){
    try { await logoutSession(); } catch {}
    setWallet(null);
    setActiveRun(null);
    setRankedSubmission({state:"idle"});
    setVerifiedBest(0);
    setProfile(null);
    setUsernamePrompt(false);
    setUsernameInput("");
    setUsernameError(null);
    setWalletError(null);
    setRewardError(null);
  }

  async function requestReward(){
    setRewardError(null);
    try {
      await requestDailyReward();
      trackEvent("reward_requested");
      setDailyStatus(status => status ? { ...status, eligible: false, claimed: true } : status);
    } catch (error) {
      setRewardError(error instanceof Error ? error.message : "Could not request daily reward");
    }
  }

  async function createFriendChallenge(gameId: GameId = challengeGame){
    setChallengeMessage(null);
    if(!wallet){ setChallengeMessage("Connect your wallet to create a challenge"); return; }
    if(!profile?.username){ setUsernamePrompt(true); setChallengeMessage("Choose a username before creating a challenge"); return; }
    try {
      const honorStake = stakeInput.trim() ? stakeInput.trim() : undefined;
      const challenge = await createChallenge(gameId, honorStake);
      const link = `${window.location.origin}/challenge/${challenge.challengeId}`;
      setChallenge(challenge);
      setChallengeToken(challenge.token);
      setChallengeLink(link);
      setStakeInput("");
      setChallengeMessage(challenge.stakeLabel ? `Challenge created with honor stake: ${challenge.stakeLabel}. Share the link.` : "Challenge created. Share the link with your friend.");
    } catch(error) {
      setChallengeMessage(error instanceof Error ? error.message : "Could not create challenge");
    }
  }

  async function rematch(gameId: string){
    setChallengeGame(gameId as GameId);
    setChallenge(null);
    setChallengeMessage(null);
    await createFriendChallenge(gameId as GameId);
  }

  async function joinFriendChallenge(){
    setChallengeMessage(null);
    if(!wallet){ setChallengeMessage("Connect your wallet to join a challenge"); return; }
    try {
      const challenge = await joinChallenge(challengeToken.trim());
      setChallenge(challenge);
      setActiveRun({ runId: "", seed: challenge.seed, gameId: challenge.gameId, mode: "ranked", expiresAt: "", challengeToken: challenge.token });
      submittingRunRef.current=null;
      eventsRef.current=[];
      runStartedAt.current=performance.now();
      setGame(challenge.gameId as GameId);
    } catch(error) {
      setChallengeMessage(error instanceof Error ? error.message : "Could not join challenge");
    }
  }

  async function startChallenge(challengeId: string){
    setChallengeMessage(null);
    if(!wallet){setChallengeMessage("Connect your wallet to play this challenge");return;}
    if(!profile?.username){setPendingChallengeId(challengeId);setUsernamePrompt(true);return;}
    try{
      const joined=await joinChallenge(challengeId);
      setChallenge(joined);
      setActiveRun({ runId: "", seed: joined.seed, gameId: joined.gameId, mode: "ranked", expiresAt: joined.expiresAt, challengeToken: joined.challengeId });
      submittingRunRef.current=null;
      eventsRef.current=[];
      runStartedAt.current=performance.now();
      setGame(joined.gameId as GameId);
    }catch(error){setChallengeMessage(error instanceof Error ? error.message : "Could not start challenge");}
  }

  const rankedGames = ["reaction", "color", "whack", "flight", "pop", "memory", "stack"];

  async function launchGame(id: GameId, mode: "ranked" | "daily" = "ranked") {
    setBriefing({ id, mode });
  }

  async function beginGame(id: GameId, mode: "ranked" | "daily" = "ranked") {
    setActiveRun(null);
    setRankedSubmission({state:"idle"});
    submittingRunRef.current=null;
    eventsRef.current=[];
    if (wallet && rankedGames.includes(id)) {
      setActiveRun(await startRun(id, mode));
      trackEvent("run_started", id);
    }
    runStartedAt.current=performance.now();
    setGame(id);
  }

  function requestRankedGame(id: GameId, mode: "ranked"|"daily" = "ranked") {
    if(!wallet){
      setPendingRankedGame(id);
      setPendingRankedMode(mode);
      setAuthPrompt(true);
      return;
    }
    if(!profile?.username){
      setPendingRankedGame(id);
      setPendingRankedMode(mode);
      setUsernamePrompt(true);
      return;
    }
    void launchGame(id,mode);
  }

  async function saveUsername(){
    const username=usernameInput.trim();
    if(!/^[A-Za-z0-9_-]{3,20}$/.test(username)){
      setUsernameError("Use 3-20 letters, numbers, _ or -.");
      return;
    }
    setUsernameSaving(true);
    setUsernameError(null);
    try{
      await updateUsername(username);
      const updated=await getMe();
      setProfile(updated);
      getLeaderboard(leaderboardGame).then(setLeaderboard).catch(()=>{});
      setUsernameInput("");
      setUsernamePrompt(false);
      const id=pendingRankedGame;
      const mode=pendingRankedMode;
      setPendingRankedGame(null);
      if(id) void launchGame(id,mode);
      const challengeId=pendingChallengeId;
      setPendingChallengeId(null);
      if(challengeId) void startChallenge(challengeId);
    }catch(error){
      setUsernameError(error instanceof Error ? error.message : "Could not save username");
    }finally{
      setUsernameSaving(false);
    }
  }

  async function finish(id:GameId,r:Result){
    if(activeRun){
      const submissionKey=activeRun.challengeToken || activeRun.runId;
      if(submittingRunRef.current===submissionKey) return;
      submittingRunRef.current=submissionKey;
      setRankedSubmission({state:"submitting"});
      try {
        const result = activeRun.challengeToken ? await submitChallenge(activeRun.challengeToken, eventsRef.current) : await submitRun(activeRun.runId, eventsRef.current);
        if(activeRun.challengeToken) getChallenge(activeRun.challengeToken).then(setChallenge).catch(()=>{});
        trackEvent("run_verified", id);
        setRankedSubmission({state:"verified",score:result.score,xp:result.xp,completed:"completed" in result ? result.completed : true,rank:result.rank,streakBonusXp:"streakBonusXp" in result ? result.streakBonusXp : undefined,streakBonusLabel:"streakBonusLabel" in result ? result.streakBonusLabel : undefined,proofId:"proofId" in result ? result.proofId : undefined,proofCode:"proofCode" in result ? result.proofCode : undefined,proofText:"proofText" in result ? result.proofText : undefined,stakeLabel:"stakeLabel" in result ? (result as any).stakeLabel ?? null : undefined,previousBest:result.previousBest,improvement:result.improvement,personalBest:result.personalBest,ratingDelta:result.ratingDelta,rating:result.rating,grade:result.grade,nextGrade:result.nextGrade,ratingToNext:result.ratingToNext,progressPercent:result.progressPercent,playerUsername:profile?.username || "You",...(activeRun.challengeToken && "opponentScore" in result ? {opponentUsername:result.opponentUsername,opponentScore:result.opponentScore,winnerUsername:result.winnerUsername} : {})});
        setLeaderboardGame(id);
        setVerifiedBest("best" in result ? result.best : result.score);
        setScores(x=>({...x,[id]:Math.max(x[id]||0,"best" in result ? result.best : result.score)}));
        setXp(x=>x+result.xp);
        getMe().then(profile=>{setXp(profile.xp);setProfile(profile);if(!profile.username)setUsernamePrompt(true)}).catch(()=>{});
        getCompetitiveSummary(id).then(setCompetitiveSummary).catch(()=>{});
        if(activeRun.mode === "daily"){
          setDailyDone(true);
          localStorage.setItem("nhl-daily",new Date().toISOString().slice(0,10));
          setDailyStatus(status => status ? { ...status, eligible: result.score >= 500, claimed: false, score: result.score } : status);
        }
      } catch(error) {
        trackEvent("run_rejected", id);
        setRankedSubmission({state:"rejected",error:error instanceof Error?error.message:"Run was not accepted"});
      }
      return;
    }
    setScores(x=>({...x,[id]:Math.max(x[id]||0,r.score)}));
    setXp(x=>x+r.xp);
  }

  if(game) return <GameShell title={games.find(g=>g.id===game)?.name||"Game"} onBack={()=>{setGame(null);setActiveRun(null)}}><Game id={game} startedAt={runStartedAt.current} run={activeRun} rankedSubmission={rankedSubmission} onEvent={event=>eventsRef.current.push({...event,t:Math.round(performance.now()-runStartedAt.current)})} onFinish={r=>finish(game,r)}/></GameShell>;

  if(challengePath) return <><ChallengePage challengeId={decodeURIComponent(challengePath[1])} wallet={wallet} onConnect={connect} onStart={startChallenge}/>{usernamePrompt && wallet && <UsernameSetupModal input={usernameInput} error={usernameError} saving={usernameSaving} onInput={value=>{setUsernameInput(value);setUsernameError(null)}} onClose={()=>setUsernamePrompt(false)} onSave={()=>void saveUsername()}/>}</>;

  const operator = dashboard?.operator;
  const dashboardDaily = dashboard?.daily;
  const dashboardGames = dashboard?.games || [];
  const liveChallenges = dashboard?.challenges || [];

  return <main className="site command-site">
    <header className="nav command-nav operator-nav"><button className="wordmark" onClick={()=>{setView("operations");scrollTo(0,0)}}><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><nav className="nav-links command-links"><button className={view==="operations" ? "active" : ""} onClick={()=>setView("operations")}>HOME</button><button onClick={()=>{setView("operations");setTimeout(()=>document.getElementById("ranked")?.scrollIntoView({behavior:"smooth"}),0)}}>GAMES</button><button className={view==="rankings" ? "active" : ""} onClick={()=>setView("rankings")}>LEADERBOARD</button><button className={view==="profile" ? "active" : ""} onClick={()=>setView("profile")}>REWARDS</button></nav>{wallet ? <button className="connect operator-connect" onClick={signOut}><i/>{profile?.username || "OPERATOR"}</button> : <button className="connect" onClick={connect}><i/>{isNimiqPay()?"Connect Nimiq Pay":"CONNECT WALLET"}</button>}</header>
    <section className="wallet-status">{wallet ? <><span className="wallet-live">LIVE / VERIFIED SESSION</span><span>{wallet}</span></> : walletError ? <><span className="wallet-error">WALLET CONNECTION FAILED</span><span>{walletError}</span></> : <><span>WALLET</span><span>{isNimiqPay()?"Nimiq Pay detected - ready to verify":"Connect with Nimiq Hub to play ranked"}</span></>}</section>
    {view === "operations" && <>
    <section className={`operator-status ${dashboardLoading ? "is-loading" : ""}`}><div><span className="eyebrow">OPERATOR STATUS · THE FIRST SKILL PLATFORM WHERE RANK IS PROVEN, NOT CLAIMED</span><h1>{operator?.username || profile?.username || "GUEST OPERATOR"}</h1>{operator?.badge ? <span className="verified-badge">VERIFIED {operator.badge}</span> : wallet ? <span className="verified-badge pending">PROVE IT · FINISH A RANKED RUN</span> : <span className="verified-badge pending">GUEST · CONNECT TO VERIFY</span>}{operator?.title && <em className="operator-title">{operator.title}</em>}<p>{dashboardLoading ? "SYNCING VERIFIED DATA" : operator?.displayGrade || profile?.displayGrade || "UNRANKED"}</p></div><div className="status-stat"><small>GLOBAL RANK</small><b>{operator?.globalRank ? `#${operator.globalRank}` : "—"}</b></div><div className="status-stat"><small>RATING</small><b>{operator?.rating?.toLocaleString() || "—"}</b></div><div className="status-stat"><small>LEVEL / XP</small><b>{operator ? `${operator.level} / ${operator.xp.toLocaleString()}` : "—"}</b></div><div className="status-stat"><small>STREAK</small><b>{operator?.streak ? `🔥 ${operator.streak} DAYS` : "—"}</b></div></section>
    <section className="hero-editorial operations-hero operator-hero"><div className="hero-copy"><div className="kicker"><span/>FEATURED GAME · VERIFIED SKILL RUN</div><div className="hero-badge"><Sparkles size={14}/> PLAY. COMPETE. EARN.</div><h1>{dashboardDaily?.completed ? "MISSION\nCOMPLETE" : "LEVEL UP\nYOUR"}<br/><em>{dailyGame?.name.toUpperCase() ?? "NIM REACTION"}</em></h1><p>{dashboardDaily?.completed ? "Your score is on the board. Improve it only if the daily rules permit another attempt." : wallet ? "Your daily skill test is ready. Make the run count." : "Connect your Nimiq wallet to start a verified run and claim your place on the board."}</p><div className="onboarding-strip"><span>1 CONNECT WALLET</span><span>2 SET A VERIFIED SCORE</span><span>3 CLAIM YOUR RANK</span></div><div className="hero-actions"><button className="gold-btn" disabled={!dailyOperation} onClick={()=>dailyOperation && (wallet ? requestRankedGame(dailyOperation.gameId as GameId,"daily") : requestRankedGame(dailyOperation.gameId as GameId,"daily"))}><Play size={15} fill="currentColor"/> {dashboardDaily?.completed ? "PLAY AGAIN" : "PLAY NOW"}</button></div></div><div className="operation-console operator-console"><div className="console-art"><Gamepad size={62}/><span>DAILY DROP</span></div><span>ENDS IN</span><b>{formatCountdown(dailyRemaining)}</b><div><small>YOUR BEST</small><strong>{dashboardDaily?.score?.toLocaleString() || "—"}</strong></div><div><small>DAILY RANK</small><strong>{dashboardDaily?.rank ? `#${dashboardDaily.rank}` : "—"}</strong></div></div></section>
    <section className="season-strip"><div><small>SEASON</small><b>01</b></div><div><small>OPERATORS</small><b>-</b></div><div><small>RANKED RUNS</small><b>-</b></div><div><small>STATUS</small><b className="live">LIVE / ONLINE</b></div></section>
    <section id="feature" className="feature-section"><div className="section-label">01 <span>TODAY'S OPERATION</span></div><div className="feature-card daily-card"><div className="daily-content"><small>ONE VERIFIED ATTEMPT</small><h2>{dailyGame?.name.toUpperCase() ?? "NIM REACTION"}</h2><div className="daily-countdown">ENDS IN / {formatCountdown(dailyRemaining)}</div><div className="daily-meta"><span>YOUR SCORE: {competitiveSummary?.daily?.score?.toLocaleString() || "-"}</span><span>DAILY RANK: {competitiveSummary?.daily?.rank ? `#${competitiveSummary.daily.rank}` : "-"}</span><span>TOP SCORE: {competitiveSummary?.daily?.topScore?.toLocaleString() || "-"}</span><span>STREAK BONUS: {operator?.streakBonus?.bonusXp ? `+${operator.streakBonus.bonusXp} XP` : "WIN 3 DAILY STREAKS"}</span></div><p className="daily-target">{competitiveSummary?.daily?.pointsToNext ? `Beat the next player by ${competitiveSummary.daily.pointsToNext} points.` : "Complete today's operation to enter the daily board."}</p><button className="gold-btn compact" onClick={()=>{triggerFeedback("tap"); dailyOperation && (wallet ? requestRankedGame(dailyOperation.gameId as GameId,"daily") : requestRankedGame(dailyOperation.gameId as GameId,"daily"));}}>{wallet ? "PLAY TODAY'S OPERATION" : "SIGN IN TO PLAY"}</button></div></div></section>
    <section id="ranked" className="lab-section"><div className="section-heading"><div><span>02</span><h2>POPULAR GAMES</h2></div><p>{wallet ? "WALLET VERIFIED" : "SIGN IN TO COMPETE"}<br/>{wallet ? "RESULTS COUNT" : "RESULTS STAY LOCKED"}</p></div><div className="game-list">{games.filter(g=>rankedGames.includes(g.id)).map((g,i)=>{const Icon=g.icon;const stat=dashboardGames.find(d=>d.gameId===g.id);return <button className={`editorial-game ${wallet ? "" : "ranked-locked"}${dailyGame?.id===g.id?" daily-flag-on":""}`} key={g.id} onClick={()=>{triggerFeedback("tap"); requestRankedGame(g.id)}}>{dailyGame?.id===g.id?<em className="daily-chip">DAILY DROP</em>:null}<span>0{i+1}</span><Icon size={20}/><div><b>{g.name}</b><small>{g.subtitle}</small></div><div className="card-stats">{stat?.best?<b>BEST {stat.best.toLocaleString()}</b>:<b className="dim">NO VERIFIED RUN</b>}{stat?.rank?<span>RANK #{stat.rank}</span>:<span className="dim">—</span>}</div><small>{wallet ? "RANKED" : "SIGN IN TO PLAY"}</small><strong>-&gt;</strong></button>})}</div></section>
    <section id="leaderboard" className="leaderboard-section"><div className="section-heading"><div><span>03</span><h2>RANKINGS</h2></div><p>GLOBAL<br/>VERIFIED</p></div><div className="leaderboard-table"><div className="rank-highlight"><div className="rank-pill">{globalRank ? getGlobalRankText(globalRank, pointsAway ?? 0) : "CONNECT TO SEE YOUR RANK"}</div><div className="rank-gap">{competitiveSummary?.nextTarget ? `${competitiveSummary.nextTarget.pointsAway} points to pass @${competitiveSummary.nextTarget.username}` : "Complete a verified run to set your rank."}</div><button className="challenge-player" onClick={()=>{triggerFeedback("tap"); void copyChallenge();}}>CHALLENGE PLAYER</button></div>{leaderboard.length ? leaderboard.map((row,index)=><div className="rank-row" key={`${row.username}-${index}`}><span>{String(index+1).padStart(2,"0")}</span><span>{row.username}</span><b>{row.score.toLocaleString()}</b><i>-&gt;</i></div>) : <div className="leaderboard-empty"><b>{wallet ? "NO VERIFIED SCORES YET" : "CONNECT TO RANK"}</b><span>{wallet ? "Complete a ranked challenge to appear here." : "Guest scores stay on this device and never enter the board."}</span></div>}<div className="your-rank"><span>YOUR BEST</span><b>{wallet ? (competitiveSummary?.personalBest?.score || verifiedBest || scores[leaderboardGame] || "-") : "GUEST"}</b><strong>{wallet ? "VERIFIED OPERATOR" : "VERIFICATION REQUIRED"}</strong></div></div></section>
    <section className="friend-section"><div className="section-label">04 <span>CHALLENGE A FRIEND</span></div><div className="friend-card"><div className="friend-copy"><div className="stake-row"><label>HONOR STAKE (OPTIONAL, OFF-CHAIN)</label><input value={stakeInput} onChange={event => setStakeInput(event.target.value)} placeholder="e.g. Winner picks dinner" maxLength={24}/></div><h3>Same puzzle.</h3><h3>Same seed.</h3><h3>One winner.</h3><p>{challengeMessage || (challenge ? challenge.status === "WAITING" ? "Waiting for opponent..." : `${challenge.opponentUsername || "Opponent"} joined. Beat their score.` : "Compete asynchronously with a friend.")}</p></div><div className="friend-actions">{!challenge && <button className="copy-btn" onClick={()=>void createFriendChallenge()}>CREATE CHALLENGE</button>}{challenge && <><small>CHALLENGE CREATED</small><input className="challenge-link" value={challengeLink} readOnly/><button className="copy-btn" onClick={()=>{triggerFeedback("tap"); void copyChallenge();}}>{challengeCopied ? "CHALLENGE COPIED" : "COPY CHALLENGE"}</button></>}</div></div></section>
    <section id="profile" className="profile-section"><div className="profile-card"><div className="profile-head"><div><span>05</span><small>OPERATOR PROFILE</small></div><div>LVL <b>{level}</b></div></div><div className="profile-main"><div><small>OPERATOR RATING</small><div className="big-xp">{(competitiveSummary?.rating ?? profile?.rating)?.toLocaleString()||"-"}</div><div className="xp-line"><i style={{width:`${competitiveSummary?.progressPercent ?? (profile ? Math.min(100,profile.rating/30) : 0)}%`}}/></div><small>{competitiveSummary?.grade || (profile ? `${profile.grade}` : "CONNECT WALLET TO BUILD RATING")}</small>{competitiveSummary?.nextGrade && <p className="rating-target">{competitiveSummary.ratingToNext} RATING TO {competitiveSummary.nextGrade}</p>}</div><div className="profile-stats"><div><small>USERNAME</small><b>{profile?.username || "UNNAMED PLAYER"}</b>{wallet && <button className="profile-edit" onClick={()=>{setUsernameInput(profile?.username || "");setUsernameError(null);setUsernamePrompt(true)}}>EDIT</button>}</div><div><small>CURRENT XP</small><b>{displayXp.toLocaleString()}</b></div><div><small>STREAK</small><b>{competitiveSummary?.streak || profile?.streak ? `${competitiveSummary?.streak || profile?.streak} DAYS` : "-"}</b></div></div></div></div></section>
    <section className="spotlight-strip"><div className="section-label">OPERATOR OF THE WEEK · COMMUNITY SPOTLIGHT</div><div className="spotlight-grid">{(dashboard?.weeklySpotlight || []).length ? (dashboard?.weeklySpotlight || []).map(item => <div className="spotlight-card" key={item.username}><span>RANK #{item.rank}</span><b>@{item.username}</b><strong>{item.bestScore.toLocaleString()} PTS · {item.runs} RUNS</strong></div>) : <p className="empty-retention">No verified runs in the last 7 days. Be the first Operator of the Week.</p>}</div></section><section className="retention-grid"><div className="retention-panel"><div className="section-label">06 <span>ACHIEVEMENTS</span></div><div className="achievement-list">{achievements.map(item=><div className={`achievement-row ${item.unlocked ? "achievement-unlocked" : "achievement-locked"}`} key={item.id}><span className="achievement-mark">{item.unlocked ? "*" : "-"}</span><div><b>{item.name}</b><small>{item.description}</small>{item.unlockedAt && <small>UNLOCKED {new Date(item.unlockedAt).toLocaleDateString()}</small>}</div><em>{item.rarity}</em></div>)}{!achievements.length && <p className="empty-retention">Connect your wallet to track achievements.</p>}</div></div><div className="retention-panel"><div className="section-label">07 <span>RECENT CHALLENGES</span></div><div className="challenge-history">{challengeHistory.slice(0,5).map(item=><div className="history-row" key={item.challengeId}><div><b>@{item.opponentUsername || "Unnamed Player"}</b><small>{item.yourScore !== null && item.theirScore !== null ? `${item.yourScore.toLocaleString()} - ${item.theirScore.toLocaleString()}` : "WAITING"}</small></div><strong className={`history-${item.outcome.toLowerCase()}`}>{item.outcome}</strong>{item.outcome !== "ACTIVE" && <button className="profile-edit" onClick={()=>void rematch(item.gameId)}>REMATCH</button>}</div>)}{!challengeHistory.length && <p className="empty-retention">Create a challenge to start your rivalry history.</p>}</div></div></section>
    </>}
    {view === "rankings" && <section className="page-view rankings-view"><div className="page-heading"><span className="eyebrow">COMPETITIVE INTELLIGENCE</span><h1>RANKINGS</h1><p>Verified results only. Your position is highlighted wherever you compete.</p></div><div className="ranking-controls"><div>{(["all","daily","weekly","season"] as RankedPeriod[]).map(period=><button key={period} className={rankingPeriod===period ? "selected" : ""} onClick={()=>setRankingPeriod(period)}>{period === "all" ? "GLOBAL" : period.toUpperCase()}</button>)}</div><select value={leaderboardGame} onChange={event=>setLeaderboardGame(event.target.value as GameId)}><option value="all">ALL GAMES</option>{games.filter(game=>rankedGames.includes(game.id)).map(game=><option key={game.id} value={game.id}>{game.name.toUpperCase()}</option>)}</select></div><div className="rankings-grid"><aside className="rankings-insight"><span className="eyebrow">YOUR POSITION</span><b>{operator?.globalRank ? `#${operator.globalRank}` : "—"}</b><strong>{operator?.rating?.toLocaleString() || "Connect to compete"}</strong><p>{dashboard?.nextTarget ? `${dashboard.nextTarget.pointsAway} rating points to #${dashboard.nextTarget.rank}, ${dashboard.nextTarget.username}.` : "Complete a ranked run to enter the global board."}</p></aside><div className="leaderboard-table ranking-full">{leaderboard.length ? leaderboard.map((row,index)=><div className={`rank-row ${row.isYou ? "is-you" : ""}`} key={`${row.username}-${index}`}><span>#{row.rank || index + 1}</span><span>{row.isYou ? "YOU · " : ""}{row.username}</span><b>{row.score.toLocaleString()}</b><i>{row.isYou ? "CURRENT" : ""}</i></div>) : <div className="leaderboard-empty"><b>NO RESULTS FOR THIS VIEW</b><span>Try another period or make the first verified run.</span></div>}</div></div></section>}
    {view === "profile" && <section className="page-view profile-view"><div className="profile-identity"><span className="eyebrow">COMPETITIVE IDENTITY · PROVEN ON NIMIQ, NOT CLAIMED</span><h1>{operator?.username || profile?.username || "GUEST OPERATOR"}</h1>{(operator?.badge || profile?.badge) ? <span className="verified-badge">VERIFIED {(operator?.badge || profile?.badge) as string}</span> : <span className="verified-badge pending">UNVERIFIED · FINISH A RANKED RUN</span>}{(operator?.title || profile?.title) && <em className="operator-title">{(operator?.title || profile?.title) as string}</em>}<div><b>{operator?.displayGrade || "UNRANKED"}</b><strong>{operator?.rating?.toLocaleString() || "—"} RATING</strong></div><p>{operator?.streakBonus?.label ? `${operator.streakBonus.label} · ` : ""}{operator?.streak ? `🔥 ${operator.streak} day streak` : "Your competitive record begins with a verified run."}</p>{wallet && <button className="profile-edit" onClick={()=>{setUsernameInput(profile?.username || "");setUsernameError(null);setUsernamePrompt(true)}}>EDIT USERNAME</button>}</div><div className="profile-data-grid"><div className="data-card"><span>STATISTICS</span><div className="stat-grid"><p><small>GAMES PLAYED</small><b>{dashboard?.stats?.gamesPlayed ?? 0}</b></p><p><small>CHALLENGE WINS</small><b>{dashboard?.stats?.wins ?? 0}</b></p><p><small>WIN RATE</small><b>{dashboard?.stats?.winRate !== null && dashboard?.stats?.winRate !== undefined ? `${dashboard.stats.winRate}%` : "—"}</b></p><p><small>BEST SCORE</small><b>{dashboard?.stats?.bestScore?.toLocaleString() ?? "—"}</b></p></div></div><div className="data-card"><span>SPECIALTIES</span>{dashboard?.specialties?.length ? dashboard.specialties.slice(0,4).map(item=><p className="specialty" key={item.gameId}><b>{games.find(game=>game.id===item.gameId)?.name || item.gameId}</b><strong>#{item.rank} · {item.best?.toLocaleString()}</strong></p>) : <p className="empty-retention">Your best games will appear after verified runs.</p>}</div><div className="data-card"><span>ACHIEVEMENTS · {dashboard?.achievements.unlocked ?? 0}/{dashboard?.achievements.total ?? 0}</span>{dashboard?.achievements.items.filter(item=>item.unlocked).slice(0,4).map(item=><p className="specialty" key={item.id}><b>✦ {item.name}</b><strong>{item.rarity}</strong></p>) || <p className="empty-retention">Connect to track progress.</p>}</div><div className="data-card"><span>MATCH HISTORY</span>{dashboard?.matchHistory?.length ? dashboard.matchHistory.slice(0,5).map((item,index)=><p className="specialty" key={`${item.createdAt}-${index}`}><b>{games.find(game=>game.id===item.gameId)?.name || item.gameId}</b><strong>{item.score.toLocaleString()} · +{item.xp} XP</strong></p>) : <p className="empty-retention">No verified runs yet.</p>}</div></div></section>}
    <nav className="mobile-nav"><button className={view==="operations" ? "active" : ""} onClick={()=>setView("operations")}>HOME</button><button className={view==="operations" ? "" : ""} onClick={()=>{setView("operations");setTimeout(()=>document.getElementById("ranked")?.scrollIntoView({behavior:"smooth"}),0)}}>GAMES</button><button className={view==="rankings" ? "active" : ""} onClick={()=>setView("rankings")}>RANK</button><button className={view==="profile" ? "active" : ""} onClick={()=>setView("profile")}>PROFILE</button></nav>
    <footer><span>OPERATOR</span><span>COMPETITIVE SKILL CHALLENGES, POWERED BY NIMIQ</span><span>NO PRIVATE KEYS ARE EVER EXPOSED</span></footer>
    {briefing && <GameBriefing game={games.find(game=>game.id===briefing.id)!} mode={briefing.mode} briefing={gameBriefings[briefing.id]} rating={profile?.rating} onClose={()=>setBriefing(null)} onStart={()=>{const selected=briefing;setBriefing(null);void beginGame(selected.id,selected.mode)}}/>}
    {authPrompt && <div className="auth-backdrop" role="presentation" onClick={()=>setAuthPrompt(false)}><div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" onClick={event=>event.stopPropagation()}><button className="auth-close" aria-label="Close sign-in prompt" onClick={()=>setAuthPrompt(false)}>X</button><small>RANKED ACCESS</small><h2 id="auth-title">Sign in to play Ranked</h2><p>Connect your Nimiq wallet to submit this result to the verified leaderboard.</p><button className="gold-btn" onClick={()=>{setAuthPrompt(false); void connect();}}>CONNECT WALLET -&gt;</button></div></div>}
    {usernamePrompt && wallet && <div className="auth-backdrop" role="presentation"><div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="username-title"><button className="auth-close" aria-label="Close username setup" onClick={()=>setUsernamePrompt(false)}>LATER</button><small>LEADERBOARD IDENTITY</small><h2 id="username-title">Choose your username</h2><p>This is the name other players will see on the leaderboard.</p><input className="username-input" value={usernameInput} onChange={event=>{setUsernameInput(event.target.value);setUsernameError(null)}} placeholder="Enter username" maxLength={20} autoFocus/><small>3-20 letters, numbers, _ or -</small>{usernameError && <div className="username-error">{usernameError}</div>}<button className="gold-btn username-submit" disabled={usernameSaving} onClick={()=>void saveUsername()}>{usernameSaving ? "SAVING..." : "CONTINUE -&gt;"}</button></div></div>}
  </main>
}

function UsernameSetupModal({input,error,saving,onInput,onClose,onSave}:{input:string;error:string|null;saving:boolean;onInput:(value:string)=>void;onClose:()=>void;onSave:()=>void}) {
  return <div className="auth-backdrop" role="presentation"><div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="username-title"><button className="auth-close" aria-label="Close username setup" onClick={onClose}>LATER</button><small>LEADERBOARD IDENTITY</small><h2 id="username-title">Choose your username</h2><p>This is the name other players will see on the leaderboard.</p><input className="username-input" value={input} onChange={event=>onInput(event.target.value)} placeholder="Enter username" maxLength={20} autoFocus/><small>3-20 letters, numbers, _ or -</small>{error && <div className="username-error">{error}</div>}<button className="gold-btn username-submit" disabled={saving} onClick={onSave}>{saving ? "SAVING..." : "CONTINUE -&gt;"}</button></div></div>;
}

function GameBriefing({game,mode,briefing,rating,onClose,onStart}:{game:(typeof games)[number];mode:"ranked"|"daily";briefing:{objective:string;controls:string;tip:string};rating?:number;onClose:()=>void;onStart:()=>void}) {
  const tier = mode === "daily" ? "DAILY STANDARD" : rating && rating >= 2400 ? "ELITE" : rating && rating >= 1900 ? "ADVANCED" : rating && rating >= 1500 ? "STANDARD" : "OPERATOR";
  const Icon = game.icon;
  return <div className="auth-backdrop briefing-backdrop" role="presentation"><section className="briefing-modal" role="dialog" aria-modal="true" aria-labelledby="briefing-title"><button className="auth-close" aria-label="Close game briefing" onClick={onClose}>LATER</button><div className="briefing-icon"><Icon size={28}/></div><small>MISSION BRIEFING · {tier}</small><h2 id="briefing-title">{game.name.toUpperCase()}</h2><p className="briefing-subtitle">{game.subtitle}</p><div className="briefing-steps"><div><span>01</span><p><b>OBJECTIVE</b>{briefing.objective}</p></div><div><span>02</span><p><b>CONTROLS</b>{briefing.controls}</p></div><div><span>03</span><p><b>OPERATOR TIP</b>{briefing.tip}</p></div></div><p className="briefing-proof">This run is server-seeded and replay-verified. Your score is calculated after you finish.</p><button className="gold-btn briefing-start" onClick={onStart}>START VERIFIED RUN <b>-&gt;</b></button></section></div>;
}

function ChallengePage({challengeId,wallet,onConnect,onStart}:{challengeId:string;wallet:string|null;onConnect:()=>void;onStart:(challengeId:string)=>Promise<void>}) {
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{getChallenge(challengeId).then(setChallenge).catch(error=>setError(error instanceof Error ? error.message : "Could not load challenge"))},[challengeId]);
  if(error) return <main className="game-shell"><section className="challenge-page"><small>CHALLENGE</small><h1>Challenge unavailable</h1><p>{error}</p><a className="gold-btn" href="/">BACK TO OPERATOR</a></section></main>;
  if(!challenge) return <main className="game-shell"><section className="challenge-page"><small>LOADING CHALLENGE</small><h1>Same puzzle.</h1><p>Loading the server-owned challenge...</p></section></main>;
  return <main className="game-shell"><header className="nav"><a className="back-editorial" href="/">&lt;- OPERATOR</a><button className="wordmark"><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><div className="game-nav-title">CHALLENGE</div></header><section className="challenge-page"><small>CHALLENGE FROM</small><h1>@{challenge.creatorUsername}</h1><div className="challenge-mantra"><b>Same puzzle.</b><b>Same seed.</b><b>Beat their score.</b></div><p>{challenge.status === "COMPLETED" ? `Winner: ${challenge.winnerUsername ? `@${challenge.winnerUsername}` : "Draw"}` : challenge.status === "IN_PROGRESS" ? "Your friend has joined. Submit your best run." : "Waiting for you to join this challenge."}</p>{challenge.status !== "COMPLETED" && <button className="gold-btn" onClick={()=>{if(wallet) void onStart(challengeId); else onConnect();}}>{wallet ? "START CHALLENGE" : "SIGN IN TO PLAY"} -&gt;</button>}<div className="challenge-results">{challenge.creatorScore !== null && <div><span>@{challenge.creatorUsername}</span><b>{challenge.creatorScore.toLocaleString()}</b></div>}{challenge.opponentScore !== null && <div><span>@{challenge.opponentUsername || "Opponent"}</span><b>{challenge.opponentScore.toLocaleString()}</b></div>}</div></section></main>;
}

function GameShell({title,onBack,children}:{title:string;onBack:()=>void;children:any}){return <main className="game-shell"><header className="nav"><button className="back-editorial" onClick={onBack}>&lt;- OPERATIONS</button><button className="wordmark"><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><div className="game-nav-title verified-nav"><Shield size={13}/> VERIFIED REPLAY · {title.toUpperCase()}</div></header><section className="game-stage">{children}</section></main>}

function Game({id,startedAt,run,rankedSubmission,onEvent,onFinish}:{id:GameId;startedAt:number;run:Run|null;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const shared = { seed: run?.seed, startedAt, rankedSubmission, onEvent, onFinish };
  switch(id) {
    case "reaction": return <Reaction {...shared}/>;
    case "color": return <ColorStreak {...shared}/>;
    case "whack": return <Whack {...shared}/>;
    case "flight": return <Flight {...shared}/>;
    case "pop": return <Pop {...shared}/>;
    case "memory": return <Memory {...shared}/>;
    case "stack": return <StackTower {...shared}/>;
  }
}

function ResultBox({result,onRestart}:{result:Result;onRestart?:()=>void}) {
  void onRestart;
  return <div className="result"><div className="result-icon"><Trophy/></div><small>CHALLENGE COMPLETE</small><h2>{result.score.toLocaleString()}</h2><p>+{result.xp} XP</p><p className="result-hint">Return to operations to play a new challenge.</p></div>
}

function RankedResult({submission,preview,onRestart}:{submission:RankedSubmission;preview:Result;onRestart?:()=>void}) {
  if (submission.state === "submitting") return <div className="result"><div className="result-icon"><Clock3/></div><small>SUBMITTING REPLAY</small><h2>...</h2><p>Validating run...</p></div>;
  if (submission.state === "rejected") return <div className="result"><div className="result-icon"><Shield/></div><small>RUN NOT ACCEPTED</small><h2>REJECTED</h2><p>{submission.error || "The server could not verify this replay."}</p><p className="result-hint">Ranked runs are single-use. Start a new verified run from operations.</p></div>;
  if (submission.state === "verified") {
    const challengeComplete = submission.opponentScore !== null && submission.opponentScore !== undefined;
    const isChallenge = Object.prototype.hasOwnProperty.call(submission,"opponentScore");
    const outcome = challengeComplete ? submission.winnerUsername === submission.playerUsername ? "YOU WIN" : submission.winnerUsername ? "YOU LOSE" : "DRAW" : "WAITING FOR OPPONENT";
    return <div className="result"><div className="result-icon"><Trophy/></div><small>{challengeComplete ? "CHALLENGE COMPLETE" : submission.completed === false ? "VERIFIED PARTIAL RESULT" : "VERIFIED RESULT"}</small><div className="proof-card"><span>PROOF CARD · CRYPTOGRAPHICALLY VERIFIED, NOT CLAIMED</span>{submission.proofText ? <b>{submission.proofText}</b> : <b>Verified on Nimiq via OPERATOR</b>}{submission.proofCode && <i>PROOF {submission.proofCode}</i>}<button className="copy-btn" onClick={() => { const text = submission.proofText || "Verified on Nimiq via OPERATOR"; if (navigator.clipboard) void navigator.clipboard.writeText(text); }}>COPY PROOF</button></div>{challengeComplete ? <div className="challenge-result"><div><span>@{submission.playerUsername}</span><b>{submission.score?.toLocaleString()}</b></div><div><span>@{submission.opponentUsername || "Opponent"}</span><b>{(submission.opponentScore ?? 0).toLocaleString()}</b></div><strong>{outcome}</strong></div> : <><h2>{submission.score?.toLocaleString()}</h2>{submission.completed === false && <p className="result-callout">RUN ENDED — VERIFIED PROGRESS SAVED</p>}{submission.personalBest ? <><p className="result-callout">NEW PERSONAL BEST {submission.improvement && submission.improvement > 0 ? `+${submission.improvement} points` : ""}</p><div className="best-comparison"><span>PREVIOUS: {(submission.previousBest ?? 0).toLocaleString()}</span><b>NEW: {(submission.score ?? 0).toLocaleString()}</b></div></> : <p>BEST: {(submission.previousBest ?? submission.score ?? 0).toLocaleString()} - {Math.abs(submission.improvement || 0)} points to improve</p>}<p>+{submission.xp} XP{submission.streakBonusXp ? ` (${submission.streakBonusLabel || `STREAK +${submission.streakBonusXp} XP`})` : ""} {submission.ratingDelta ? `- ${submission.ratingDelta > 0 ? "+" : ""}${submission.ratingDelta} RATING` : ""}</p><p>{submission.rank ? `GLOBAL RANK #${submission.rank}` : "RANKING UPDATED"} {submission.nextGrade && submission.ratingToNext ? `- ${submission.ratingToNext} TO ${submission.nextGrade}` : ""}</p></>}<p className="result-hint">Verified runs are single-use. Return to operations for your next challenge.</p></div>;
  }
  return <div className="result"><div className="result-icon"><Clock3/></div><small>PREVIEW</small><h2>{preview.score.toLocaleString()}</h2><p>Waiting for validation...</p></div>;
}

type GameProps = { seed?: string; startedAt: number; rankedSubmission: RankedSubmission; onEvent: (event: Omit<GameEvent, "t">) => void; onFinish: (r: Result) => void };

/* ---- NIM REACTION ------------------------------------------------------- */
function Reaction({seed,startedAt,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [puzzle]=useState(()=> seed ? createPuzzle("reaction", seed) : null);
  const [delay]=useState(()=> puzzle && puzzle.gameId === "reaction" ? puzzle.delay : 1100 + rand(1400));
  const [phase,setPhase]=useState<"wait"|"live">("wait");
  const [jolt,setJolt]=useState(0);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const base = startedAt || performance.now();
  useEffect(()=>{
    if(phase!=="wait") return;
    const id = window.setTimeout(()=>setPhase("live"), Math.max(0, base + delay - performance.now()));
    return ()=>window.clearTimeout(id);
  },[phase,delay,base]);
  const fill = Math.max(0, Math.min(1, (performance.now() - base) / delay));
  function hit(){
    if(outcome) return;
    if(phase==="wait"){
      setJolt(j=>j+1);
      return;
    }
    const t = Math.round(performance.now()-base);
    onEvent({type:"choice",value:"go"});
    const score = Math.max(10, Math.min(1000, 1000-(t-delay)));
    setOutcome({score,xp:160});
    onFinish({score,xp:160,time:t});
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  return <div className="challenge narrow"><GameHUD label="NIM REACTION" value={phase==="live"?"TAP NOW":"GET READY..."} timer="one shot"/><button key={jolt} className={`reaction-pad ${phase}${jolt?" jolted":""}`} onClick={hit}><Gauge size={44}/><b>{phase==="live"?"TAP":"WAIT FOR IT"}</b><small>{phase==="live"?"node is live":"arming pad…"}</small><i className="reaction-fill" style={{width:`${(phase==="live"?100:fill*100).toFixed(1)}%`}}/></button><p className="hint">{jolt&&phase==="wait"?"Too early — the pad re-arms. Wait for the node.":"One click the instant the node lights up. False starts re-arm the pad."}</p></div>;
}
/* ---- NIM COLOR ----------------------------------------------------------- */
function ColorStreak({seed,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [data]=useState(()=>{
    const puzzle = seed ? createPuzzle("color", seed) : null;
    if(puzzle && puzzle.gameId === "color") return { rounds: puzzle.rounds, limits: puzzle.limits };
    return { rounds: Array.from({length:6},()=>({word:rand(4),ink:rand(4)})), limits: Array.from({length:6},(_,i)=>Math.max(650,1400-i*60)) };
  });
  const [round,setRound]=useState(0);
  const [correct,setCorrect]=useState(0);
  const [flash,setFlash]=useState<{kind:"hit"|"miss";index:number}|null>(null);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const [deadline,setDeadline]=useState(()=>performance.now()+data.limits[0]+400);
  const pendingRef=useRef(false);
  const [,setTick]=useState(0);
  const done = outcome !== null;
  useEffect(()=>{ if(done) return; const id=setInterval(()=>setTick(x=>x+1),80); return ()=>clearInterval(id); },[done]);
  useEffect(()=>{ if(done || pendingRef.current) return; if(performance.now()>deadline) stop(); });
  function stop(){
    if(outcome || pendingRef.current) return;
    pendingRef.current=true;
    const preview={score:correct*100,xp:120};
    setOutcome(preview);
    onFinish(preview);
  }
  function pick(index:number){
    if(outcome||pendingRef.current||round>=data.rounds.length) return;
    onEvent({type:"choice",value:String(index)});
    if(index===data.rounds[round].ink){
      const next=correct+1;
      setCorrect(next);
      setFlash({kind:"hit",index});
      pendingRef.current=true;
      window.setTimeout(()=>{ pendingRef.current=false; setFlash(null); },150);
      if(round+1>=data.rounds.length){ const preview={score:next*100+200,xp:160}; setOutcome(preview); onFinish(preview); }
      else { setRound(round+1); setDeadline(performance.now()+data.limits[round+1]+400); }
    } else {
      setFlash({kind:"miss",index});
      pendingRef.current=true;
      window.setTimeout(()=>{ pendingRef.current=false; stop(); },280);
    }
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  const current=data.rounds[Math.min(round,data.rounds.length-1)];
  const left=Math.max(0,deadline-performance.now());
  const limit=data.limits[Math.min(round,data.limits.length-1)] ?? 1200;
  return <div className="challenge narrow"><GameHUD label="NIM COLOR" value={`ROUND ${round+1}/${data.rounds.length} · ${correct} STREAK`} timer={`${(left/1000).toFixed(1)}s`}/><div className="color-pips">{Array.from({length:data.rounds.length},(_,p)=><i key={p} className={p<correct?"on":""}/>)}</div><div className="stroop-card"><span style={{color:COLORS[current.ink]}}>{COLOR_NAMES[current.word]}</span></div><div className="stroop-choices">{COLOR_NAMES.map((name,index)=>{const cls=flash&&index===flash.index?(flash.kind==="hit"?" cf-hit":" cf-miss"):"";return <button key={name} className={`stroop-btn${cls}`} onClick={()=>pick(index)}>{name}</button>;})}</div><div className="stroop-timer"><i style={{width:`${Math.min(100,left/limit*100)}%`}}/></div><p className="hint">{flash?.kind==="miss"?"Wrong ink — streak over.":`Tap the ink color, not the word. ${correct} perfect so far.`}</p></div>;
}
/* ---- NIM WHACK ----------------------------------------------------------- */
function Whack({seed,startedAt,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [targets]=useState(()=>{
    const puzzle = seed ? createPuzzle("whack", seed) : null;
    if(puzzle && puzzle.gameId === "whack") return [...puzzle.targets].sort((a,b)=>a.from-b.from);
    return Array.from({length:12},(_,i)=>({slot:rand(9),from:400+i*550,to:400+i*550+900}));
  });
  const base = startedAt || performance.now();
  const [,setTick]=useState(0);
  const [hits,setHits]=useState(0);
  const [misses,setMisses]=useState(0);
  const [cursor,setCursor]=useState(0);
  const [burst,setBurst]=useState<number|null>(null);
  const [flash,setFlash]=useState<number|null>(null);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const finishedRef=useRef(false);
  const done=outcome!==null;
  useEffect(()=>{ if(done) return; const id=setInterval(()=>setTick(x=>x+1),60); return ()=>clearInterval(id); },[done]);
  const elapsed=performance.now()-base;
  useEffect(()=>{ if(done||finishedRef.current) return; if(elapsed>=10000){ finishedRef.current=true; const preview={score:Math.max(0,hits*100-misses*40),xp:hits>=10?160:120}; setOutcome(preview); onFinish(preview); } });
  useEffect(()=>{ if(!done && cursor<targets.length && elapsed>targets[cursor].to+120){ setCursor(cursor+1); } });
  useEffect(()=>{ if(burst!==null) window.setTimeout(()=>setBurst(null),190); else if(flash!==null) window.setTimeout(()=>setFlash(null),190); });
  const visible = cursor < targets.length && elapsed >= targets[cursor].from && elapsed <= targets[cursor].to + 120 ? targets[cursor] : null;
  function swing(slot:number){
    if(done||finishedRef.current) return;
    onEvent({type:"choice",value:String(slot)});
    if(visible && slot===visible.slot){ setHits(h=>h+1); setBurst(slot); setCursor(c=>c+1); }
    else { setMisses(m=>m+1); setFlash(slot); }
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  const accuracy = hits+misses>0 ? Math.round(hits/(hits+misses)*100) : 100;
  return <div className="challenge"><GameHUD label="NIM WHACK" value={`${hits} HITS`} timer={`${Math.max(0,(10000-elapsed)/1000).toFixed(1)}s · ${accuracy}% ACC`}/><div className="whack-grid">{Array.from({length:9},(_,slot)=>{ const mole=visible&&visible.slot===slot; return <button key={slot} className={`whack-hole${mole?" mole":""}${burst===slot?" burst":""}${burst===null&&flash===slot?" miss-flash":""}`} onClick={()=>swing(slot)}>{mole?<Crosshair/>:""}</button>; })}</div><p className="hint">Hit the lit pad. Empty swings dent your accuracy.</p></div>;
}
/* ---- NIM POP ------------------------------------------------------------- */
function Pop({seed,startedAt,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [balloons]=useState(()=>{
    const puzzle = seed ? createPuzzle("pop", seed) : null;
    if(puzzle && puzzle.gameId === "pop") return puzzle.balloons;
    return Array.from({length:16},(_,i)=>({slot:rand(6),spawnAt:300+i*1150}));
  });
  const base = startedAt || performance.now();
  const [,setTick]=useState(0);
  const [popped,setPopped]=useState<number[]>([]);
  const [misses,setMisses]=useState(0);
  const [combo,setCombo]=useState(0);
  const [burst,setBurst]=useState<{idx:number;slot:number;t:number}|null>(null);
  const [flashSlot,setFlashSlot]=useState<number|null>(null);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const finishedRef=useRef(false);
  const done=outcome!==null;
  useEffect(()=>{ if(done) return; const id=setInterval(()=>setTick(x=>x+1),70); return ()=>clearInterval(id); },[done]);
  const elapsed=performance.now()-base;
  useEffect(()=>{ if(done||finishedRef.current) return; if(elapsed>=20000){ finishedRef.current=true; const goal=Math.ceil(balloons.length*0.8); const preview={score:Math.max(0,popped.length*80-misses*30),xp:popped.length>=goal?170:120}; setOutcome(preview); onFinish(preview); } });
  useEffect(()=>{ if(burst!==null) window.setTimeout(()=>setBurst(null),320); else if(flashSlot!==null) window.setTimeout(()=>setFlashSlot(null),190); });
  const visible = balloons.map((balloon,index)=>({balloon,index})).filter(({balloon,index})=>!popped.includes(index)&&elapsed>=balloon.spawnAt&&elapsed<=balloon.spawnAt+1300);
  function pop(idx:number,slot:number){
    if(done||finishedRef.current) return;
    onEvent({type:"choice",value:String(slot)});
    if(visible.some(v=>v.index===idx)){ setPopped(p=>[...p,idx]); setBurst({idx,slot,t:Date.now()}); setCombo(c=>c+1); setFlashSlot(null); }
    else { setMisses(m=>m+1); setCombo(1); setFlashSlot(slot); }
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  return <div className="challenge"><GameHUD label="NIM POP" value={`${popped.length} POPPED`} timer={`${Math.max(0,(20000-elapsed)/1000).toFixed(1)}s`}/><div className="pop-stage">{Array.from({length:6},(_,slot)=>{ const lane=visible.filter(v=>v.balloon.slot===slot); const fading=burst&&burst.slot===slot&&Date.now()-burst.t<320&&!popped.includes(burst.idx); return <div key={slot} className={`pop-lane${flashSlot===slot?" lane-flash":""}`}>{lane.map(({balloon,index})=><button key={index} className="pop-balloon" onClick={()=>pop(index,balloon.slot)}/>)}{fading?<i className="pop-burst"/>:null}</div>; })}</div><div className="pop-combo">{combo>=2?`COMBO ×${combo}`:""}</div><p className="hint">Pop balloons before they fade. Chain pops to build a combo.</p></div>;
}
/* ---- NIM FLIGHT ---------------------------------------------------------- */
function Flight({seed,startedAt,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [puzzle]=useState(()=> seed ? createPuzzle("flight", seed) : null);
  const [world]=useState(()=>{
    if(puzzle && puzzle.gameId === "flight") return { pipes: puzzle.pipes, ground: puzzle.ground, ceiling: puzzle.ceiling };
    return { pipes: Array.from({length:5},(_,i)=>({x:520+i*300+rand(60),gapY:150+rand(280),gap:208})), ground: 600-FLIGHT.groundPad, ceiling: FLIGHT.ceiling };
  });
  const base = startedAt || performance.now();
  const stars = useMemo(()=>Array.from({length:16},()=>({top:8+Math.random()*66,left:Math.random()*100,size:1.5+Math.random()*2.2,dur:3+Math.random()*4,delay:Math.random()*4})),[]);
  const simRef=useRef<{ flaps: number[]; processed: number; y: number; vy: number; focus: number }>({ flaps: [], processed: 0, y: FLIGHT.startY, vy: 0, focus: 0 });
  const [birdY,setBirdY]=useState<number>(FLIGHT.startY);
  const [tilt,setTilt]=useState(-25);
  const [clock,setClock]=useState(0);
  const [passed,setPassed]=useState(0);
  const [toast,setToast]=useState<{n:number;t:number}|null>(null);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const finishedRef=useRef(false);
  const passedRef=useRef(0);
  const done=outcome!==null;
  useEffect(()=>{
    if(done) return;
    let raf=0;
    const step=()=>{
      const s=simRef.current;
      const t=Math.round(performance.now()-base);
      while(s.processed<s.flaps.length&&s.flaps[s.processed]<=t){
        const dt=s.flaps[s.processed]-s.focus;
        if(dt>0){ s.y=s.y+s.vy*dt+0.5*FLIGHT.gravity*dt*dt; s.vy=s.vy+FLIGHT.gravity*dt; s.focus=s.flaps[s.processed]; }
        s.vy=FLIGHT.flap;
        s.processed+=1;
      }
      const dt=t-s.focus;
      if(dt>0){ s.y=s.y+s.vy*dt+0.5*FLIGHT.gravity*dt*dt; s.vy=s.vy+FLIGHT.gravity*dt; s.focus=t; }
      s.y=Math.min(Math.max(s.y,world.ceiling),world.ground);
      const verdict=simulateFlight(world,s.flaps.filter(f=>f<=t));
      setBirdY(s.y);
      setTilt(Math.max(-42, Math.min(38, s.vy*34)));
      setClock(t);
      setPassed(verdict.passed);
      if(verdict.passed>passedRef.current){
        passedRef.current=verdict.passed;
        setToast({n:verdict.passed,t:Date.now()});
      }
      if((verdict.crashed||verdict.groundDead)&&!finishedRef.current){
        finishedRef.current=true;
        const preview={score:verdict.passed*120+(verdict.passed===world.pipes.length?300:0),xp:verdict.passed>=world.pipes.length?180:120,time:t};
        setOutcome(preview);
        onFinish(preview);
        return;
      }
      raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
    return ()=>cancelAnimationFrame(raf);
  },[done,base,world,onFinish]);
  useEffect(()=>{ if(toast) window.setTimeout(()=>setToast(null),520); });
  function flap(){
    if(done||finishedRef.current) return;
    simRef.current.flaps.push(Math.round(performance.now()-base));
    onEvent({type:"key",value:"flap"});
  }
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{ if(event.code==="Space"&&!event.repeat){ event.preventDefault(); flap(); } };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  });
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  const scaleY=400/(world.ground-world.ceiling);
  return <div className="challenge"><GameHUD label="NIM FLIGHT" value={`${passed}/${world.pipes.length} GATES`} timer="tap to flap"/><div className="flight-stage" onClick={flap}>{stars.map((s,i)=><i key={i} className="flight-star" style={{top:`${s.top}%`,left:`${s.left}%`,width:`${s.size}px`,height:`${s.size}px`,animationDuration:`${s.dur}s`,animationDelay:`${s.delay}s`}}/>)}{world.pipes.map((pipe,index)=>{ const screenX=pipe.x-clock*FLIGHT.speed; if(screenX<-80||screenX>560) return null; return <div key={index}><div className="flight-pipe top" style={{left:`${screenX}px`,height:`${(pipe.gapY-FLIGHT.gapHalf-world.ceiling)*scaleY}px`}}/><div className="flight-pipe bottom" style={{left:`${screenX}px`,top:`${(pipe.gapY+FLIGHT.gapHalf-world.ceiling)*scaleY}px`,bottom:0}}/></div>; })}<div className="flight-bird" style={{top:`${(((birdY-world.ceiling)/(world.ground-world.ceiling))*100).toFixed(1)}%`,marginTop:0,transform:`translateY(-50%) rotate(${tilt}deg)`}}><Flame size={16}/></div><div className="flight-ground"/>{toast?<span key={toast.t} className="pass-toast">+{toast.n} GATE</span>:null}</div><button className="primary huge" onClick={flap}>FLAP</button><p className="hint">Tap or press space to climb. Thread every gate without crashing.</p></div>;
}
/* ---- NIM MEMORY ---------------------------------------------------------- */
function Memory({seed,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [rounds]=useState(()=>{
    const puzzle = seed ? createPuzzle("memory", seed) : null;
    if(puzzle && puzzle.gameId === "memory") return puzzle.rounds;
    return Array.from({length:5},(_,r)=>({colors:Array.from({length:3+r},()=>rand(4)),showMs:600+(3+r)*130}));
  });
  const [round,setRound]=useState(0);
  const [lit,setLit]=useState(-2);
  const [inputCount,setInputCount]=useState(0);
  const [correctRounds,setCorrectRounds]=useState(0);
  const [flash,setFlash]=useState<number|null>(null);
  const [wrong,setWrong]=useState<number|null>(null);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const pausedRef=useRef(false);
  const done=outcome!==null;
  const roundData=rounds[Math.min(round,rounds.length-1)];
  useEffect(()=>{
    if(done) return;
    let shown=0;
    setLit(0);
    const step=Math.max(140,Math.round(roundData.showMs/roundData.colors.length));
    const id=setInterval(()=>{
      shown+=1;
      if(shown>=roundData.colors.length){ setLit(-1); clearInterval(id); }
      else setLit(shown);
    },step);
    return ()=>clearInterval(id);
  },[round,done]);
  useEffect(()=>{ if(flash!==null) window.setTimeout(()=>setFlash(null),160); });
  useEffect(()=>{ if(wrong!==null) window.setTimeout(()=>setWrong(null),320); });
  function tap(index:number){
    if(done||lit>=0||pausedRef.current) return;
    onEvent({type:"choice",value:String(index)});
    if(index===roundData.colors[inputCount]){
      setFlash(index);
      if(inputCount+1>=roundData.colors.length){
        const next=correctRounds+1;
        setCorrectRounds(next);
        if(round+1>=rounds.length){ const preview={score:next*200+100,xp:180}; setOutcome(preview); onFinish(preview); }
        else { setRound(round+1); setInputCount(0); }
      } else setInputCount(inputCount+1);
    } else {
      setWrong(index);
      pausedRef.current=true;
      window.setTimeout(()=>{ pausedRef.current=false; const preview={score:correctRounds*200,xp:120}; setOutcome(preview); onFinish(preview); },320);
    }
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  const showColor=lit>=0?roundData.colors[lit]:-1;
  return <div className="challenge narrow"><GameHUD label="NIM MEMORY" value={`ROUND ${round+1}/${rounds.length}`} timer={lit>=0?"WATCH":"REPEAT"}/><div className="memory-pips">{Array.from({length:roundData.colors.length},(_,p)=><i key={p} className={p<inputCount?"on":""}/>)}</div><div className="memory-tiles">{COLORS.map((color,index)=>{const cls=index===showColor?" lit":index===flash?" flash-hit":index===wrong?" flash-wrong":"";return <button key={color} className={`memory-tile${cls}`} style={{background:color}} onClick={()=>tap(index)}/>;})}</div><p className="hint">{lit>=0?"Memorize the sequence...":`Repeat it — ${inputCount}/${roundData.colors.length} entered`}</p></div>;
}
/* ---- NIM STACK ----------------------------------------------------------- */
function StackTower({seed,startedAt,rankedSubmission,onEvent,onFinish}:GameProps) {
  const [p]=useState(()=>{
    const puzzle = seed ? createPuzzle("stack", seed) : null;
    if(puzzle && puzzle.gameId === "stack") return puzzle;
    return { gameId: "stack" as const, period: 2400, amplitude: 260, phase: Math.random()*Math.PI*2, target: 8, startWidth: 130 };
  });
  const base = startedAt || performance.now();
  const [,setTick]=useState(0);
  const [tower,setTower]=useState<Array<{x:number;width:number}>>([]);
  const [width,setWidth]=useState(p.startWidth);
  const [landed,setLanded]=useState(-1);
  const [whiff,setWhiff]=useState(0);
  const [outcome,setOutcome]=useState<Result|null>(null);
  const finishedRef=useRef(false);
  const done=outcome!==null;
  useEffect(()=>{ if(done) return; let raf=0; const loop=()=>{ setTick(x=>x+1); raf=requestAnimationFrame(loop); }; raf=requestAnimationFrame(loop); return ()=>cancelAnimationFrame(raf); },[done]);
  useEffect(()=>{ if(landed>=0) window.setTimeout(()=>setLanded(-1),240); });
  useEffect(()=>{ if(whiff) window.setTimeout(()=>setWhiff(0),280); });
  const elapsed=performance.now()-base;
  const x=stackBlockX(p,elapsed);
  function drop(){
    if(done||finishedRef.current) return;
    const nowX=stackBlockX(p,performance.now()-base);
    onEvent({type:"choice",value:String(Math.round(nowX))});
    const prevX=tower.length?tower[tower.length-1].x:0;
    const offset=Math.abs(nowX-prevX);
    if(offset>=width){
      setWhiff(w=>w+1);
      finishedRef.current=true;
      const preview={score:tower.length*150,xp:tower.length>=p.target?200:120};
      window.setTimeout(()=>{ setOutcome(preview); onFinish(preview); },300);
      return;
    }
    const nextWidth=Math.max(16,width-offset*0.5);
    setTower(v=>[...v,{x:nowX,width:nextWidth}]);
    setWidth(nextWidth);
    setLanded(tower.length);
    if(tower.length+1>=p.target){ finishedRef.current=true; const preview={score:(tower.length+1)*150+250,xp:200}; setOutcome(preview); onFinish(preview); }
  }
  if(outcome) return seed?<RankedResult submission={rankedSubmission} preview={outcome} onRestart={()=>location.reload()}/>:<ResultBox result={outcome} onRestart={()=>location.reload()}/>;
  return <div className="challenge"><GameHUD label="NIM STACK" value={`${tower.length}/${p.target} BLOCKS`} timer={`BASE ${Math.round(width)}`}/><div className="stack-stage" onClick={drop}><i key={whiff} className={`stack-guide${whiff?" shake":""}`}/><div className="stack-tower">{tower.map((block,index)=><div key={index} className={`stack-block${index===landed?" landed":""}`} style={{width:`${block.width}px`,left:`calc(50% + ${block.x}px - ${block.width/2}px)`,bottom:`${index*26}px`}}/>)}</div><div className="stack-block stack-moving" style={{width:`${width}px`,left:`calc(50% + ${x}px - ${width/2}px)`,bottom:`${tower.length*26}px`}}/></div><button className="primary huge" onClick={drop}>DROP</button><p className="hint">Drop when the moving block sits over the tower. Misses shave your base.</p></div>;
}

function GameHUD({label,value,timer}:{label:string;value:string;timer:string}) {
  return <div className="hud"><div><small>{label}</small><b>{value}</b></div><div className="timer"><Clock3 size={17}/>{timer}</div></div>
}

export default App;
