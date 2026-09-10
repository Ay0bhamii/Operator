# OPERATOR

**Competitive skill challenges, powered by Nimiq.**

OPERATOR is a competitive skill platform where scores are not trusted—they are cryptographically authenticated and server-verified. Nimiq provides the player identity and Web3 reward layer around a fast, off-chain competitive game engine.

## What it is

OPERATOR is a browser and Nimiq Pay skill platform. Each challenge is a fast test of memory, timing, sequence recognition, or precision. Players can practice locally as guests or connect a Nimiq wallet to enter ranked runs.

The product promise is simple: the first skill platform where your rank is cryptographically proven — not claimed. Don’t just play. Prove it. The product promise in detail: **don�t just play. Prove it.**

## Why Nimiq is essential

Nimiq is not a decorative wallet button. It gives every ranked operator a portable, cryptographically proven identity without passwords, seed phrases, or private keys entering the app. Hub and Nimiq Pay sign the login nonce; the server verifies the signing address, binds the run to that operator, and uses the same identity for leaderboard ownership, achievements, challenge results, and qualified daily NIM reward claims.

Gameplay stays off-chain deliberately: input events are replayed on the server for instant results and low cost. Only qualified rewards are prepared for a payout worker and must be recorded with a Nimiq transaction hash before they are shown as settled.

## How it works

```text
Connect Nimiq wallet
    -> sign one login nonce
    -> server verifies signature and creates an httpOnly session
    -> server issues a unique run ID and deterministic seed
    -> player submits replay events
    -> server replays the seed and computes the score
    -> verified result is stored in the rankings
```

The client never submits an authoritative score. It submits events from a server-issued run.

## Judge demo: prove the anti-cheat model

Use this 30-second sequence:

1. **CONNECT** — sign one Nimiq nonce and show the authenticated operator identity.
2. **PLAY** — start a ranked Daily Operation; the server issues the run ID and deterministic seed.
3. **VERIFIED** — finish the game and show `SUBMITTING REPLAY` followed by `VERIFIED RESULT`.
4. **RANK UP** — open Rankings/Profile to show server-calculated score, rating, XP, streak, and placement.
5. **REJECT** — replay the same run, alter event timing/order, or try to submit a made-up score. The API accepts no score field, consumes each run once, recomputes the result from events, and rejects invalid or reused submissions.

## 5 verified competitive games

These verified competitive challenges have deterministic seeded puzzles and server replay validators:

- **NIM PIN:** enter the seeded four-digit code.
- **Key Sequence:** enter the seeded signal in order.
- **Address Memory:** memorize and rebuild the seeded token pattern.
- **NIM Lock:** align four seeded rings.
- **NIM Cipher:** decode a seeded message using its displayed Caesar shift.

The daily rotation and competitive ladder focus on this polished, trusted set rather than carrying weaker practice-only variants.

## Ranked verification architecture

The shared replay core lives in `packages/game-core` and is used by the API. It provides deterministic `createPuzzle(gameId, seed)` and `replay(gameId, seed, events)` functions.

The API in `server/index.ts` provides:

- `POST /auth/nonce` to issue a short-lived 32-byte login nonce.
- `POST /auth/verify` to verify the Nimiq signed message and create a session.
- `GET /daily` to publish the current UTC daily game without exposing its seed.
- `POST /runs/start` to issue a server-owned run ID and seed.
- `POST /runs/:id/submit` to consume a run once, replay events, and calculate score.
- `GET /leaderboard` for verified score rows.
- `GET /me` for authenticated operator progress.

The server rejects expired sessions, expired or reused nonces, mismatched addresses, reused runs, invalid event timing, wrong solutions, and superhuman durations. It stores practice submissions separately from ranked scores.

## Nimiq Pay integration

- **Browser:** `@nimiq/hub-api` opens Nimiq Hub and signs the login nonce.
- **Nimiq Pay:** `@nimiq/mini-app-sdk` uses the injected provider and signs the same login nonce.
- **Session:** the API derives and validates the signer address, then sets an httpOnly session cookie.

The wallet is used for identity and authentication. It does not sign client-selected scores.

## Friend challenges

Connected operators can create a challenge token for a ranked game. A friend joins with the same puzzle and same seed, and both replays are validated independently before scores are compared.

## Security model

- One-time login nonce with a five-minute expiry.
- Ed25519 signature verification using `@nimiq/core`.
- Public key to Nimiq address validation.
- Server-owned HMAC daily seeds.
- Unique run IDs bound to the authenticated address.
- Consume-before-replay submission protection.
- Server-side replay and timing validation.
- One daily score per address, game, and UTC day.
- Guest practice is local-only.
- No seed phrase or private key is requested or exposed.
- Endpoint-specific rate limiting with standard retry headers.
- Production requires Postgres; SQLite is a local-development fallback only.
- Leaderboard, history, run-expiry, session-expiry, challenge, and analytics indexes support the live query paths.
- API failures are emitted as structured server logs without returning internal details to players.

## Local development

Install dependencies:

```bash
npm install
```

Start the frontend:

```bash
npm run dev
```

Set `DATABASE_URL` in `.env` to a Postgres connection string for a durable app, or leave `DATABASE_FILE` in place for the local SQLite fallback. The app will automatically use Postgres when `DATABASE_URL` exists and falls back to SQLite otherwise.

Start the local API in a second terminal:

```bash
npm run api
```

The frontend runs at `http://localhost:5173` and the API at `http://localhost:8787`.

Checks:

```bash
npm run build
npm run typecheck:server
npm test
```

## Production deployment

The repository includes a Vercel frontend build and serverless adapter in `api/index.ts`. `vercel.json` rewrites `/api/*` to that adapter.

Required environment variables:

```text
VITE_API_URL=https://your-app.vercel.app/api
VITE_HUB_URL=https://hub.nimiq.com
WEB_ORIGIN=https://your-app.vercel.app
COOKIE_SAME_SITE=None
SESSION_SECRET=<long-random-secret>
DAILY_SECRET=<long-random-secret>
DATABASE_URL=<postgres-connection-string>
DATABASE_FILE=/tmp/arcade.sqlite
```

The app prefers Postgres when `DATABASE_URL` is configured, but it also falls back to SQLite when it is not. This keeps Vercel and local demos working while a proper Postgres store is added. Set `Secure` cookies and use HTTPS for both the frontend and API, especially when the Mini App is hosted inside Nimiq Pay.

## What changed for Cycle 2 judges

- Verified Operator badge/title unlock only after wallet-signed ranked runs; profile and hero show competitive identity.
- Every verified run returns a shareable Proof Card (`proofText` + `proofCode`) with copy support on the result screen.
- Daily streaks now award bonus XP (3/7/14/30-day tiers), visible before and after Daily Operation runs.
- Friend challenges support an optional off-chain honor stake label (`stakeLabel`); settlement stays social/community-side.
- Operator of the Week spotlight ranks the last 7 days of verified runs; onboarding now reads Play as Guest → Beat the board → Connect wallet to claim rank.

## Judge demo (45–60 seconds)

1. Open Home: guest onboarding strip, Daily Operation countdown, and today’s featured game.
2. Play as Guest, then Connect wallet and finish one ranked Daily Operation run.
3. Show SUBMITTING REPLAY → VERIFIED RESULT, then Copy Proof from the Proof Card.
4. Open Rankings/Profile: Verified badge/title, streak bonus, rating/XP, placement, and Operator of the Week.
5. Replay the same run or alter events: the API consumes each run once, recomputes from events, and rejects invalid/reused submissions.

## Roadmap

- Add deeper progression, unlocks, and seasonal rewards.
- Expand observability, rate limits, and end-to-end auth/run tests.
- Consider tournament rewards only after the economy and anti-cheat model are audited.

## Screenshots and demo

Run the app locally with `npm run dev` to view the OPERATOR interface. The current design uses a premium navy command-center layout with cyan network interactions, yellow achievement highlights, a featured Daily Operation, verified rankings, and an operator profile.

Brand assets are in `public/logo/`, with the browser icon at `public/favicon.svg`:

- `operator-primary.svg` � primary lockup for the dark interface.
- `operator-horizontal.svg` � navbar and banner lockup.
- `operator-mark.svg` � cyan network mark with yellow operator node.
- `operator-wordmark.svg` � wordmark-only treatment.
- `operator-dark.svg` � full-color lockup for light backgrounds.
- `operator-light.svg` � full-color lockup for dark backgrounds.
- `operator-monochrome.svg` � one-color fallback.
- `operator-icon.svg` � app and favicon icon.

For a hackathon demo, show this sequence:

1. Open the OPERATOR landing page.
2. Connect with Nimiq Hub or open the Mini App in Nimiq Pay.
3. Start a ranked run for one of the five supported competitive challenges.
4. Complete the challenge and show the `SUBMITTING REPLAY` state.
5. Show the `VERIFIED RESULT` or `RUN NOT ACCEPTED` state.
6. Open Rankings to show only server-backed entries.
