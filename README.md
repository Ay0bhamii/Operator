# OPERATOR

**Competitive skill challenges, powered by Nimiq.**

> Don’t just play. Prove it.

OPERATOR is a skill-based competitive platform where scores are cryptographically authenticated and server-verified.  
Nimiq provides portable player identity — no passwords, no seed phrases, no trusted client scores.

**Live demo:** [operator-nimiq.vercel.app](https://operator-nimiq.vercel.app)

---

### What is OPERATOR?

A fast, browser + Nimiq Pay skill platform featuring short competitive challenges testing memory, timing, sequence recognition, and precision.

Players can:
- Practice locally as a guest
- Connect a Nimiq wallet for ranked runs
- Compete on daily challenges and leaderboards
- Challenge friends with the same seeded puzzle

Five verified competitive games power the daily rotation: **NIM PIN**, **Key Sequence**, **Address Memory**, **NIM Lock**, and **NIM Cipher** — deterministic seeded puzzles with server replay validators.

---

### Why Nimiq is essential

Nimiq is not a decorative wallet button.

- Wallet signature creates a verified operator identity
- Server binds every ranked run to that identity
- Same identity powers leaderboards, achievements, and future rewards
- Works with both **Nimiq Hub** and **Nimiq Pay Mini App**

Gameplay stays off-chain for speed. Only verified results and qualified rewards touch the chain.

---

### How ranking actually works (Anti-Cheat)

```text
1. Connect Nimiq wallet → sign one login nonce
2. Server verifies signature and creates secure session
3. Server issues unique Run ID + deterministic seed
4. Player submits input events (not a score)
5. Server replays the events against the seed
6. Only the server-calculated score is accepted
```

The client never submits a score. Each run is bound to the authenticated operator, consumed once, and recomputed from recorded events — altered or reused submissions are rejected.

---

### Cycle 2: verified identity & rewards

- Verified Operator badge/title unlock only after wallet-signed ranked runs.
- Every verified run returns a shareable **Proof Card** (`proofText` + `proofCode`) with copy support on the result screen.
- Daily streaks award bonus XP (3/7/14/30-day tiers), visible before and after Daily Operation runs.
- **Operator of the Week** spotlight ranks the last 7 days of verified runs.
- Friend challenge honor stakes (`stakeLabel`) stay off-chain and settle socially.
