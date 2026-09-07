# 30-Second Demo: CONNECT → PLAY → VERIFIED → RANK UP

1. Open the deployed app in a browser or Nimiq Pay.
2. Connect a Nimiq wallet.
3. Enter the Daily Operation from the first screen.
4. Complete the deterministic challenge.
5. Watch the `SUBMITTING REPLAY` state become `VERIFIED RESULT`; this is the server, not the client, calculating the score.
6. Open Rankings to see the verified score.
7. Open Profile to see rating, grade, XP, and verified runs.
8. Use Friend Challenge to create a non-monetary shared-seed match.

Without a wallet, games remain practice-only and scores never enter public rankings.

For the anti-cheat proof, repeat the same run or alter its event sequence. The server rejects it because each run is bound to the authenticated wallet, consumed once, and replayed from the server-issued seed.

Daily reward requests are server-qualified and recorded as pending until an authorized payout worker settles the on-chain NIM transfer.
