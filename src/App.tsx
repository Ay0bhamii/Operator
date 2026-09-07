import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Award, ChevronLeft, Clock3, Gamepad2, Grid3X3,
  KeyRound, Lock, Medal, Network, Play, RotateCcw, Shield,
  Sparkles, Trophy, UserRound, Zap
} from "lucide-react";
import { connectNimiq, isNimiqPay } from "./nimiq";
import {
  createChallenge,
  getDaily,
  getDailyStatus,
  getLeaderboard,
  getMe,
  joinChallenge,
  logoutSession,
  requestDailyReward,
  startRun,
  submitChallenge,
  submitRun,
  trackEvent,
  type DailyOperation,
  type DailyStatus,
  type Run
} from "./api";
import { formatCountdown, getGlobalRankText } from "./ui-format";
import type { GameEvent } from "../packages/game-core/index";
import { createPuzzle } from "../packages/game-core/index";

type GameId =
  | "block-rush" | "nim-grid" | "nim-pin" | "sequence"
  | "memory" | "nim-lock" | "vault" | "sync";

type Result = { score: number; xp: number; time?: number };
type RankedSubmission = { state: "idle" | "submitting" | "verified" | "rejected"; score?: number; xp?: number; error?: string };

const games: { id: GameId; name: string; subtitle: string; icon: any; difficulty: string }[] = [
  { id: "block-rush", name: "Block Rush", subtitle: "Clear connected network blocks", icon: Grid3X3, difficulty: "Easy" },
  { id: "nim-grid", name: "NIM Grid", subtitle: "Hit the active target node", icon: Gamepad2, difficulty: "Easy" },
  { id: "nim-pin", name: "NIM PIN", subtitle: "Crack the generated access code", icon: KeyRound, difficulty: "Easy" },
  { id: "sequence", name: "Key Sequence", subtitle: "Enter the signal in the right order", icon: Activity, difficulty: "Hard" },
  { id: "memory", name: "Address Memory", subtitle: "Remember a fictional address pattern", icon: Shield, difficulty: "Medium" },
  { id: "nim-lock", name: "NIM Lock", subtitle: "Align the rotating lock rings", icon: Lock, difficulty: "Hard" },
  { id: "vault", name: "NIM Vault", subtitle: "Five-ring advanced lock challenge", icon: Trophy, difficulty: "Expert" },
  { id: "sync", name: "Sync", subtitle: "Time the packet inside the target", icon: Network, difficulty: "Medium" }
];

const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - .5);

function App() {
  const [game,setGame]=useState<GameId|null>(null);
  const [wallet,setWallet]=useState<string|null>(null);
  const [activeRun,setActiveRun]=useState<Run|null>(null);
  const [challengeCopied,setChallengeCopied]=useState(false);
  const [challengeGame,setChallengeGame]=useState<GameId>("nim-pin");
  const [challengeToken,setChallengeToken]=useState("");
  const [challengeMessage,setChallengeMessage]=useState<string|null>(null);
  const [rewardError,setRewardError]=useState<string|null>(null);
  const [dailyStatus,setDailyStatus]=useState<DailyStatus|null>(null);
  const eventsRef=useRef<GameEvent[]>([]);
  const runStartedAt=useRef(0);
  const [rankedSubmission,setRankedSubmission]=useState<RankedSubmission>({state:"idle"});
  const [dailyOperation,setDailyOperation]=useState<DailyOperation|null>(null);
  const [leaderboard,setLeaderboard]=useState<Array<{address:string;score:number}>>([]);
  const [leaderboardGame,setLeaderboardGame]=useState<GameId>("nim-pin");
  const [verifiedBest,setVerifiedBest]=useState(0);
  const [profile,setProfile]=useState<{rating:number;grade:string;verifiedRuns:number;streak:number}|null>(null);
  const [xp,setXp]=useState(()=>Number(localStorage.getItem("nhl-xp")||0));
  const [scores,setScores]=useState<Record<string,number>>(()=>JSON.parse(localStorage.getItem("nhl-scores")||"{}"));
  const [dailyDone,setDailyDone]=useState(()=>localStorage.getItem("nhl-daily")===new Date().toISOString().slice(0,10));

  useEffect(()=>localStorage.setItem("nhl-xp",String(xp)),[xp]);
  useEffect(()=>localStorage.setItem("nhl-scores",JSON.stringify(scores)),[scores]);
  useEffect(()=>{getMe().then(profile=>{if(profile.address){setWallet(profile.address);setXp(profile.xp);setProfile(profile)}}).catch(()=>{})},[]);
  useEffect(()=>{getLeaderboard(leaderboardGame).then(rows=>setLeaderboard(rows)).catch(()=>setLeaderboard([]))},[leaderboardGame]);
  useEffect(()=>{getDaily().then(setDailyOperation).catch(()=>setDailyOperation(null))},[]);
  useEffect(()=>{if(wallet){getDailyStatus().then(setDailyStatus).catch(()=>setDailyStatus(null));} else { setDailyStatus(null);} },[wallet]);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const id=window.setInterval(()=>setNow(Date.now()),1000); return ()=>window.clearInterval(id);},[]);

  const level=Math.floor(xp/500)+1, levelXp=xp%500, best=Math.max(0,...Object.values(scores));
  const dailyGame = dailyOperation ? games.find(g=>g.id===dailyOperation.gameId) ?? games[0] : games[0];
  const dailyRemaining = dailyOperation ? Math.max(0, (new Date(dailyOperation.endsAt).getTime() - now) / 1000) : 4*60*60 + 32*60 + 18;
  const globalRank = 17;
  const pointsAway = 84;
  const [walletError,setWalletError]=useState<string|null>(null);

  function triggerFeedback(kind: "tap" | "success" | "error" = "tap") {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      const pattern = kind === "success" ? [18, 32, 18] : kind === "error" ? [34, 24, 34] : [10];
      navigator.vibrate(pattern);
    }
  }

  async function copyChallenge() {
    const shareText = "NIM PIN - Same puzzle. Same seed. One winner.\nhttps://operator.nimiq.example/challenge";
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
        getMe().then(profile=>{setXp(profile.xp);setProfile(profile)}).catch(()=>{});
      }
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Wallet connection failed");
    }
  }

  async function signOut(){
    try { await logoutSession(); } catch {}
    setWallet(null);
    setActiveRun(null);
    setRankedSubmission({state:"idle"});
    setVerifiedBest(0);
    setProfile(null);
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

  async function createFriendChallenge(){
    setChallengeMessage(null);
    if(!wallet){ setChallengeMessage("Connect your wallet to create a challenge"); return; }
    try {
      const challenge = await createChallenge(challengeGame);
      setChallengeToken(challenge.token);
      setChallengeMessage(`Share token ${challenge.token} with your friend`);
      setActiveRun({ runId: "", seed: challenge.seed, gameId: challenge.gameId, mode: "ranked", expiresAt: challenge.expiresAt, challengeToken: challenge.token });
      eventsRef.current=[];
      runStartedAt.current=performance.now();
      setGame(challenge.gameId as GameId);
    } catch(error) {
      setChallengeMessage(error instanceof Error ? error.message : "Could not create challenge");
    }
  }

  async function joinFriendChallenge(){
    setChallengeMessage(null);
    if(!wallet){ setChallengeMessage("Connect your wallet to join a challenge"); return; }
    try {
      const challenge = await joinChallenge(challengeToken.trim());
      setActiveRun({ runId: "", seed: challenge.seed, gameId: challenge.gameId, mode: "ranked", expiresAt: "", challengeToken: challenge.token });
      eventsRef.current=[];
      runStartedAt.current=performance.now();
      setGame(challenge.gameId as GameId);
    } catch(error) {
      setChallengeMessage(error instanceof Error ? error.message : "Could not join challenge");
    }
  }

  const rankedGames = ["block-rush", "nim-pin", "memory", "vault", "sync"];

  async function launchGame(id: GameId, mode: "ranked" | "daily" | "practice" = "ranked") {
    setActiveRun(null);
    setRankedSubmission({state:"idle"});
    eventsRef.current=[];
    if (wallet && rankedGames.includes(id) && mode !== "practice") {
      setActiveRun(await startRun(id, mode));
      trackEvent("run_started", id);
    }
    runStartedAt.current=performance.now();
    setGame(id);
  }

  async function finish(id:GameId,r:Result){
    if(activeRun){
      setRankedSubmission({state:"submitting"});
      try {
        const result = activeRun.challengeToken ? await submitChallenge(activeRun.challengeToken, eventsRef.current) : await submitRun(activeRun.runId, eventsRef.current);
        trackEvent("run_verified", id);
        setRankedSubmission({state:"verified",score:result.score,xp:result.xp});
        setLeaderboardGame(id);
        setVerifiedBest("best" in result ? result.best : result.score);
        setScores(x=>({...x,[id]:Math.max(x[id]||0,"best" in result ? result.best : result.score)}));
        setXp(x=>x+result.xp);
        getMe().then(profile=>{setXp(profile.xp);setProfile(profile)}).catch(()=>{});
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

  if(game) return <GameShell title={games.find(g=>g.id===game)?.name||"Game"} onBack={()=>{setGame(null);setActiveRun(null)}}><Game id={game} run={activeRun} rankedSubmission={rankedSubmission} onEvent={event=>eventsRef.current.push({...event,t:Math.round(performance.now()-runStartedAt.current)})} onFinish={r=>finish(game,r)}/></GameShell>;

  return <main className="site">
    <header className="nav"><button className="wordmark" onClick={()=>scrollTo(0,0)}><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><nav className="nav-links"><a href="#lab">Challenges</a><a href="#leaderboard">Rankings</a><a href="#profile">Profile</a></nav>{wallet ? <button className="connect" onClick={signOut}><i/>SIGN OUT</button> : <button className="connect" onClick={connect}><i/>{isNimiqPay()?"Connect Nimiq Pay":"Connect NIM"}</button>}</header>
    <section className="wallet-status">{wallet ? <><span className="wallet-live">LIVE / VERIFIED SESSION</span><span>{wallet}</span></> : walletError ? <><span className="wallet-error">WALLET CONNECTION FAILED</span><span>{walletError}</span></> : <><span>WALLET</span><span>{isNimiqPay()?"Nimiq Pay detected - ready to verify":"Connect with Nimiq Hub to play ranked"}</span></>}</section>
    <section className="hero-editorial"><div className="hero-copy"><div className="kicker"><span/>DAILY OPERATION - VERIFIED SKILL RUN</div><h1>DAILY<br/><em>{dailyGame?.name.toUpperCase() ?? "NIM PIN"}</em></h1><p>Complete today's challenge and climb the day's leaderboard before the timer resets.</p><div className="hero-actions"><button className="gold-btn" disabled={!dailyOperation} onClick={()=>dailyOperation && launchGame(dailyOperation.gameId as GameId, wallet ? "daily" : "practice")}>{wallet?"PLAY DAILY":"PRACTICE DAILY"} <b>-&gt;</b></button><a className="text-btn" href="#feature">VIEW OPERATION -&gt;</a></div></div><div className="hero-emblem"><div className="orbit a"/><div className="orbit b"/><div className="core"><img src="/logo/operator-mark.svg" alt="OPERATOR"/></div><small>DAILY / 01</small></div></section>
    <section className="season-strip"><div><small>SEASON</small><b>01</b></div><div><small>OPERATORS</small><b>-</b></div><div><small>RANKED RUNS</small><b>-</b></div><div><small>STATUS</small><b className="live">LIVE / ONLINE</b></div></section>
    <section id="feature" className="feature-section"><div className="section-label">01 <span>DAILY OPERATION</span></div><div className="feature-card daily-card"><div className="daily-content"><small>TODAY'S CHALLENGE</small><h2>{dailyGame?.name.toUpperCase() ?? "NIM PIN"}</h2><div className="daily-countdown">TIME / {formatCountdown(dailyRemaining)} remaining</div><div className="daily-meta"><span>1 attempt</span><span>Your rank: -</span></div><button className="gold-btn compact" onClick={()=>{triggerFeedback("tap"); dailyOperation && launchGame(dailyOperation.gameId as GameId, wallet ? "daily" : "practice");}}>{wallet ? "PLAY" : "PRACTICE"}</button></div></div></section>
    {wallet && <section className="lab-section"><div className="section-heading"><div><span>02</span><h2>RANKED OPERATIONS</h2></div><p>WALLET VERIFIED<br/>LEADERBOARD ELIGIBLE</p></div><div className="game-list">{games.filter(g=>rankedGames.includes(g.id)).map((g,i)=>{const Icon=g.icon;return <button className="editorial-game" key={g.id} onClick={()=>{triggerFeedback("tap"); launchGame(g.id)}}><span>0{i+1}</span><Icon size={20}/><div><b>{g.name}</b><small>{g.subtitle}</small></div><small>RANKED</small><strong>-&gt;</strong></button>})}</div></section>}
    <section id="lab" className="lab-section"><div className="section-heading"><div><span>{wallet ? "03" : "02"}</span><h2>PRACTICE LAB</h2></div><p>NO WALLET REQUIRED<br/>LOCAL SCORE ONLY</p></div><div className="game-list">{games.map((g,i)=>{const Icon=g.icon;return <button className="editorial-game" key={g.id} onClick={()=>{triggerFeedback("tap"); launchGame(g.id,"practice")}}><span>0{String(i+1).padStart(2,"0")}</span><Icon size={20}/><div><b>{g.name}</b><small>{g.subtitle}</small></div><small>PRACTICE</small><strong>-&gt;</strong></button>})}</div></section>
    <section id="leaderboard" className="leaderboard-section"><div className="section-heading"><div><span>03</span><h2>RANKINGS</h2></div><p>GLOBAL<br/>VERIFIED</p></div><div className="leaderboard-table"><div className="rank-highlight"><div className="rank-pill">{getGlobalRankText(globalRank, pointsAway)}</div><div className="rank-gap">{getGlobalRankText(globalRank, pointsAway, true)}</div><button className="challenge-player" onClick={()=>{triggerFeedback("tap"); void copyChallenge();}}>CHALLENGE PLAYER</button></div>{leaderboard.length ? leaderboard.map((row,index)=><div className="rank-row" key={row.address}><span>{String(index+1).padStart(2,"0")}</span><span>{row.address.slice(0,6)}...{row.address.slice(-3)}</span><b>{row.score.toLocaleString()}</b><i>-&gt;</i></div>) : <div className="leaderboard-empty"><b>{wallet ? "NO VERIFIED SCORES YET" : "CONNECT TO RANK"}</b><span>{wallet ? "Complete a ranked challenge to appear here." : "Guest scores stay on this device and never enter the board."}</span></div>}<div className="your-rank"><span>YOUR BEST</span><b>{wallet ? (verifiedBest || scores[leaderboardGame] || "-") : "GUEST"}</b><strong>{wallet ? "VERIFIED OPERATOR" : "VERIFICATION REQUIRED"}</strong></div></div></section>
    <section className="friend-section"><div className="section-label">04 <span>CHALLENGE A FRIEND</span></div><div className="friend-card"><div className="friend-copy"><h3>Same puzzle.</h3><h3>Same seed.</h3><h3>One winner.</h3></div><button className="copy-btn" onClick={()=>{triggerFeedback("tap"); void copyChallenge();}}>{challengeCopied ? "COPIED" : "COPY CHALLENGE"}</button></div></section>
    <section id="profile" className="profile-section"><div className="profile-card"><div className="profile-head"><div><span>05</span><small>OPERATOR PROFILE</small></div><div>LVL <b>{level}</b></div></div><div className="profile-main"><div><small>OPERATOR RATING</small><div className="big-xp">{profile?.rating?.toLocaleString()||"-"}</div><div className="xp-line"><i style={{width:`${profile ? Math.min(100,profile.rating/30) : 0}%`}}/></div><small>{profile ? `${profile.grade} GRADE - ${profile.verifiedRuns} VERIFIED RUNS` : "CONNECT WALLET TO BUILD RATING"}</small></div><div className="profile-stats"><div><small>CURRENT XP</small><b>{xp.toLocaleString()}</b></div><div><small>STREAK</small><b>{profile?.streak ? `${profile.streak} DAYS` : "-"}</b></div><div><small>PLAYER</small><b>{wallet?"NIM":"GUEST"}</b></div></div></div></div></section>
    <footer><span>OPERATOR</span><span>COMPETITIVE SKILL CHALLENGES, POWERED BY NIMIQ</span><span>NO PRIVATE KEYS ARE EVER EXPOSED</span></footer>
  </main>
}

function GameShell({title,onBack,children}:{title:string;onBack:()=>void;children:any}){return <main className="game-shell"><header className="nav"><button className="back-editorial" onClick={onBack}>&lt;- CHALLENGES</button><button className="wordmark"><img className="brand-logo" src="/logo/operator-mark.svg" alt=""/><span className="wordmark-main">OPERATOR</span><span className="wordmark-sub">BY NIMIQ</span></button><div className="game-nav-title">{title.toUpperCase()}</div></header><section className="game-stage">{children}</section></main>}

function Game({id,run,rankedSubmission,onEvent,onFinish}:{id:GameId;run:Run|null;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  switch(id) {
    case "block-rush": return <BlockRush ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
    case "nim-grid": return <NimGrid ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
    case "nim-pin": return <NimPin seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
    case "sequence": return <Sequence seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
    case "memory": return <Memory seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
    case "nim-lock": return <RotatingLock count={4} limit={20000} seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} title="NIM LOCK" onFinish={onFinish}/>;
    case "vault": return <RotatingLock count={5} limit={10000} seed={run?.seed} rankedSubmission={rankedSubmission} onEvent={onEvent} title="NIM VAULT" onFinish={onFinish}/>;
    case "sync": return <Sync ranked={Boolean(run)} rankedSubmission={rankedSubmission} onEvent={onEvent} onFinish={onFinish}/>;
  }
}

function ResultBox({result,onRestart}:{result:Result;onRestart:()=>void}) {
  return <div className="result"><div className="result-icon"><Trophy/></div><small>CHALLENGE COMPLETE</small><h2>{result.score.toLocaleString()}</h2><p>+{result.xp} XP</p><button className="primary" onClick={onRestart}><RotateCcw size={16}/> Run again</button></div>
}

function RankedResult({submission,preview,onRestart}:{submission:RankedSubmission;preview:Result;onRestart:()=>void}) {
  if (submission.state === "submitting") return <div className="result"><div className="result-icon"><Clock3/></div><small>SUBMITTING REPLAY</small><h2>...</h2><p>Validating run...</p></div>;
  if (submission.state === "rejected") return <div className="result"><div className="result-icon"><Shield/></div><small>RUN NOT ACCEPTED</small><h2>REJECTED</h2><p>{submission.error || "The server could not verify this replay."}</p><button className="primary" onClick={onRestart}><RotateCcw size={16}/> Try again</button></div>;
  if (submission.state === "verified") return <div className="result"><div className="result-icon"><Trophy/></div><small>VERIFIED RESULT</small><h2>{submission.score?.toLocaleString()}</h2><p>+{submission.xp} XP - Server validated</p><button className="primary" onClick={onRestart}><RotateCcw size={16}/> Run again</button></div>;
  return <div className="result"><div className="result-icon"><Clock3/></div><small>PREVIEW</small><h2>{preview.score.toLocaleString()}</h2><p>Waiting for validation...</p></div>;
}

function BlockRush({ranked,rankedSubmission,onEvent,onFinish}:{ranked:boolean;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const colors = ["cyan","lime","violet"];
  const [board,setBoard]=useState(()=>Array.from({length:88},()=>colors[rand(3)]));
  const initialTime=30; const [score,setScore]=useState(0); const [time,setTime]=useState(initialTime); const [done,setDone]=useState(false);
  useEffect(()=>{ if(done)return; const t=setInterval(()=>setTime(x=>{if(x<=1){clearInterval(t);setDone(true);onFinish({score,xp:150,time:30});return 0}return x-1}),1000); return()=>clearInterval(t)},[done,onFinish]);
  function click(i:number){
    if(done)return; const col=board[i]; const seen=new Set<number>(), q=[i];
    while(q.length){const x=q.pop()!; if(seen.has(x)||board[x]!==col)continue; seen.add(x); const r=Math.floor(x/11),c=x%11; [x-11,x+11,x-1,x+1].forEach(n=>{if(n>=0&&n<88&&Math.floor(n/11)>=r-1&&Math.floor(n/11)<=r+1&&Math.abs((n%11)-c)<=1)q.push(n)})}
    if(seen.size<3)return;
    onEvent({type:"choice",value:String(seen.size)});
    const a=board.map((v,j)=>seen.has(j) ? null : v).filter(Boolean) as string[];
    const next=[...Array(88-a.length).fill(null),...a];
    setBoard(next); setScore(s=>s+seen.size*seen.size*10);
    if(!a.length){setDone(true);onFinish({score:score+seen.size*seen.size*10,xp:150,time:30-time})}
  }
  if(done){const preview={score,xp:150};return ranked?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>{setBoard(Array.from({length:88},()=>colors[rand(3)]));setScore(0);setTime(30);setDone(false)}}/>:<ResultBox result={preview} onRestart={()=>{setBoard(Array.from({length:88},()=>colors[rand(3)]));setScore(0);setTime(30);setDone(false)}}/>}
  return <div className="challenge"><GameHUD label="BLOCK RUSH" value={String(score)} timer={`${time}s`}/><div className="block-board">{board.map((c,i)=><button key={i} className={`block ${c||"empty"}`} onClick={()=>click(i)}/>)}</div><p className="hint">Clear groups of 3+ matching nodes. Bigger groups = bigger score.</p></div>
}

function NimGrid({ranked,rankedSubmission,onEvent,onFinish}:{ranked:boolean;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const [active,setActive]=useState(rand(16)); const [hits,setHits]=useState(0); const [time,setTime]=useState(15); const [done,setDone]=useState(false);
  const xpForHits = hits * 20;
  useEffect(()=>{if(done)return;const t=setInterval(()=>setTime(x=>{if(x<=.1){setDone(true);onFinish({score:hits*100,xp:xpForHits,time:15});return 0}return x-.1}),100);return()=>clearInterval(t)},[done,hits,onFinish,xpForHits]);
  if(done){const preview={score:hits*100,xp:xpForHits};return ranked?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>{setHits(0);setTime(15);setActive(rand(16));setDone(false)}}/>:<ResultBox result={preview} onRestart={()=>{setHits(0);setTime(15);setActive(rand(16));setDone(false)}}/>}
  return <div className="challenge"><GameHUD label="NIM GRID" value={`${hits} HITS`} timer={`${time.toFixed(1)}s`}/><div className="nim-grid">{Array.from({length:16},(_,i)=><button key={i} className={i===active?"node active":"node"} onClick={()=>{if(i===active){onEvent({type:"choice",value:String(i)});setHits(h=>h+1);setActive(rand(16))}else{setDone(true);onFinish({score:hits*100,xp:xpForHits,time:15-time})}}}><span/></button>)}</div><p className="hint">Hit the glowing node. One wrong box ends the challenge.</p></div>
}

function NimPin({seed,rankedSubmission,onEvent,onFinish}:{seed?:string;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const initialPin = seed ? createPuzzle("nim-pin", seed) : null;
  const pin = initialPin?.gameId === "nim-pin" ? initialPin.pin : String(rand(9000)+1000);
  const [input,setInput]=useState(""); const [time,setTime]=useState(12); const [done,setDone]=useState(false);
  useEffect(()=>{if(done)return;const t=setInterval(()=>setTime(x=>{if(x<=.1){setDone(true);onFinish({score:0,xp:25});return 0}return x-.1}),100);return()=>clearInterval(t)},[done,onFinish]);
  function key(k:string){if(done)return; const n=input+k;if(n.length<=4)setInput(n); if(n.length===4){onEvent({type:"key",value:n});if(n===pin){const score=Math.max(100,Math.round(time*100));setDone(true);onFinish({score,xp:125,time:12-time})}else{setDone(true);onFinish({score:0,xp:25})}}}
  if(done){const preview={score:input===pin?Math.max(100,Math.round(time*100)):0,xp:input===pin?125:25};return seed?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>{setInput("");setTime(12);setDone(false)}}/>:<ResultBox result={preview} onRestart={()=>{setInput("");setTime(12);setDone(false)}}/>}
  return <div className="challenge narrow"><GameHUD label="NIM PIN" value="4 DIGITS" timer={`${time.toFixed(1)}s`}/><div className="pin-display">{input.padEnd(4,"_")}</div><div className="keypad">{["1","2","3","4","5","6","7","8","9","0"].map(k=><button key={k} onClick={()=>key(k)}>{k}</button>)}</div><p className="hint">Generated challenge. No real wallet PIN is requested.</p></div>
}

function Sequence({seed,rankedSubmission,onEvent,onFinish}:{seed?:string;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const chars="QWERASD"; const initialPuzzle = seed ? createPuzzle("sequence", seed) : null; const [seq]=useState<string[]>(()=>initialPuzzle?.gameId === "sequence" ? initialPuzzle.sequence : Array.from({length:12},()=>chars[rand(chars.length)])); const [input,setInput]=useState(""); const [time,setTime]=useState(7); const [done,setDone]=useState(false);
  useEffect(()=>{if(done)return;const t=setInterval(()=>setTime(x=>{if(x<=.1){setDone(true);onFinish({score:0,xp:15});return 0}return x-.1}),100);return()=>clearInterval(t)},[done,onFinish]);
  function press(c:string){if(done)return;const next=input+c;onEvent({type:"key",value:c}); if(seq.slice(0,next.length).join("")!==next){setDone(true);onFinish({score:0,xp:15});return}setInput(next);if(next===seq.join("")){const score=Math.round(time*1000);setDone(true);onFinish({score,xp:180,time:7-time})}}
  if(done){const preview={score:input===seq.join("")?Math.round(time*1000):0,xp:input===seq.join("")?180:15};return seed?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>location.reload()}/>:<ResultBox result={preview} onRestart={()=>location.reload()}/>}
  return <div className="challenge"><GameHUD label="KEY SEQUENCE" value={`${input.length}/${seq.length}`} timer={`${time.toFixed(2)}s`}/><div className="sequence">{seq.map((c,i)=><span className={i<input.length?"seen":""} key={i}>{c}</span>)}</div><div className="key-row">{chars.split("").map(c=><button key={c} onClick={()=>press(c)}>{c}</button>)}</div></div>
}

function Memory({seed,rankedSubmission,onEvent,onFinish}:{seed?:string;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const initialPuzzle = seed ? createPuzzle("memory", seed) : null; const [code]=useState<string[]>(()=>initialPuzzle?.gameId === "memory" ? initialPuzzle.tokens : Array.from({length:6},()=>["NQ","7F","3A","C2","91","D8"][rand(6)])); const [show,setShow]=useState(true); const [input,setInput]=useState<string[]>([]); const [done,setDone]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setShow(false),2500);return()=>clearTimeout(t)},[]);
  const options=useMemo(()=>shuffle([...code,...Array.from({length:6},()=>["AA","1B","EF","42","09","BC"][rand(6)])]),[code]);
  function pick(x:string){if(done)return;const next=[...input,x];onEvent({type:"choice",value:x});setInput(next);if(next.length===code.length){const ok=next.every((v,i)=>v===code[i]);setDone(true);onFinish({score:ok?600:0,xp:ok?160:20})}}
  if(done){const preview={score:input.every((v,i)=>v===code[i])?600:0,xp:input.every((v,i)=>v===code[i])?160:20};return seed?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>location.reload()}/>:<ResultBox result={preview} onRestart={()=>location.reload()}/>}
  return <div className="challenge narrow"><GameHUD label="ADDRESS MEMORY" value={show?"MEMORIZE":"REBUILD"} timer={show?"2.5s":"8"}/><div className="memory-code">{show?code.map(x=><b key={x}>{x}</b>):input.map(x=><b key={Math.random()}>{x}</b>)}</div>{!show&&<div className="memory-options">{options.map((x,i)=><button key={i} onClick={()=>pick(x)}>{x}</button>)}</div>}</div>
}

function RotatingLock({count,limit,seed,rankedSubmission,onEvent,title,onFinish}:{count:number;limit:number;seed?:string;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;title:string;onFinish:(r:Result)=>void}) {
  const initialPuzzle = seed ? createPuzzle(title === "NIM VAULT" ? "vault" : "nim-lock", seed) : null; const [target]=useState(()=>initialPuzzle && (initialPuzzle.gameId === "nim-lock" || initialPuzzle.gameId === "vault") ? initialPuzzle.targetAngles : Array.from({length:count},()=>rand(8)*45)); const [angles,setAngles]=useState(()=>target.map(angle=>seed ? (angle + 45) % 360 : angle)); const [start]=useState(Date.now()); const [done,setDone]=useState(false);
  useEffect(()=>{const t=setInterval(()=>{if(Date.now()-start>=limit&&!done){setDone(true);onFinish({score:0,xp:20})}},100);return()=>clearInterval(t)},[done,start,limit,onFinish]);
  const solved=angles.every((a,i)=>Math.abs(((a-target[i]+540)%360)-180)<12);
  useEffect(()=>{if(solved&&!done){setDone(true);const left=Math.max(0,limit-(Date.now()-start));onFinish({score:Math.round(left/5)+count*100,xp:count===5?220:180,time:Date.now()-start})}},[solved,done,count,limit,onFinish,start]);
  if(done){const preview={score:solved?count*200:0,xp:solved?(count===5?220:180):20};return seed?<RankedResult submission={rankedSubmission} preview={preview} onRestart={()=>location.reload()}/>:<ResultBox result={preview} onRestart={()=>location.reload()}/>}
  return <div className="challenge"><GameHUD label={title} value={`${count} LOCKS`} timer={`${Math.max(0,((limit-(Date.now()-start))/1000)).toFixed(1)}s`}/><div className="locks">{angles.map((a,i)=><button key={i} className="lock-ring" style={{transform:`rotate(${a}deg)`}} onClick={()=>{onEvent({type:"choice",value:String(i)});setAngles(v=>v.map((x,j)=>j===i?x+45:x))}}><i/><span style={{transform:`rotate(${-a}deg)`}}>o</span><em style={{transform:`rotate(${-a}deg)`}}>^</em></button>)}</div><p className="hint">Rotate each ring until its dot aligns with the target marker.</p></div>
}

function Sync({ranked,rankedSubmission,onEvent,onFinish}:{ranked:boolean;rankedSubmission:RankedSubmission;onEvent:(event:Omit<GameEvent,"t">)=>void;onFinish:(r:Result)=>void}) {
  const [pos,setPos]=useState(0); const [dir,setDir]=useState(1); const [tries,setTries]=useState(3); const [done,setDone]=useState(false); const [score,setScore]=useState(0);
  useEffect(()=>{if(done)return;const t=setInterval(()=>setPos(p=>{let n=p+dir*2;if(n>=100){setDir(-1);n=100}if(n<=0){setDir(1);n=0}return n}),30);return()=>clearInterval(t)},[dir,done]);
  function hit(){if(pos>42&&pos<58){onEvent({type:"choice",value:"hit"});const s=score+100;setScore(s);if(s>=500){setDone(true);onFinish({score:s,xp:150})}}else{onEvent({type:"choice",value:"miss"});const t=tries-1;setTries(t);if(t<=0){setDone(true);onFinish({score,xp:20})}}}
  if(done)return ranked?<RankedResult submission={rankedSubmission} preview={{score,xp:score>=500?150:20}} onRestart={()=>location.reload()}/>:<ResultBox result={{score,xp:score>=500?150:20}} onRestart={()=>location.reload()}/>;
  return <div className="challenge"><GameHUD label="SYNC" value={`${score} PTS`} timer={`${tries} attempts`}/><div className="sync-track"><div className="sync-target"/><div className="sync-cursor" style={{left:`${pos}%`}}/></div><button className="primary huge" onClick={hit}>SYNC PACKET</button></div>
}

function GameHUD({label,value,timer}:{label:string;value:string;timer:string}) {
  return <div className="hud"><div><small>{label}</small><b>{value}</b></div><div className="timer"><Clock3 size={17}/>{timer}</div></div>
}

export default App;
