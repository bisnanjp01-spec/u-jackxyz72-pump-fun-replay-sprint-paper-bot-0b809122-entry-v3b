# Pump.fun Replay Sprint — Paper Bot (entry v3b)

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bisnanjp01-spec/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry-v3b/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bisnanjp01-spec/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry-v3b/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

## Strategy: Early Completer + Continuous Pyramid

Most pump.fun coins die fast; the rare few that migrate (complete) are the big
winners. This bot attacks the **size** side of that asymmetry:

- **Enter early.** When a coin's real SOL reserve crosses a low threshold
  (2 SOL) with net-buy flow over the last few slots, take a small starter
  (0.02 SOL, capped by the 1%-of-real-reserve rule). The low bar means many
  candidates; breadth comes from fast turnover.
- **Pyramid continuously.** While the coin is alive and rising, add small
  amounts as the real reserve grows — only while the price is above the last
  add (and above entry) and flow is still net-buy — up to a 2 SOL total cost
  per position. A coin whose reserve runs 2 → 85 SOL lets a 0.02 SOL starter
  scale into a 2 SOL position while its price runs several ×.
- **Cut losers fast.** Prove-it cut (price has not risen enough ~20 slots
  after entry, or the reserve stalled low), a 25% stop-loss on realised
  value, and a time exit free the 5 position slots for the next coins.
- **Bank winners in tranches** at +100% / +300% / +700% of realised value
  (25% of tokens each); the rest rides a **wide 50% trailing stop** armed at
  +100%, wide enough to survive early volatility and to hold through to
  migration, where the harness force-closes holders at the migration price.

Sells are sized so the constant-product quote stays inside the real reserve,
so large pyramid positions exit in chunks instead of being rejected outright.
Deterministic throughout: no clock, no env, no randomness.
