// Pump.fun Replay Sprint — paper bot, entry v3b.
// Family: "Early Completer + Continuous Pyramid".
//
// Enter early: a coin whose real SOL reserve crosses a LOW threshold with
// net-buy flow gets a small starter (capped by the 1%-of-real-reserve rule).
// Then scale continuously: add small amounts as the reserve grows while the
// price keeps rising above the last add, up to a per-position cost cap, so a
// 0.02 SOL starter can become a 2-3 SOL position while the price runs several x.
// Losers are cut fast (prove-it / stop-loss / time exit) to free the 5 slots.
// Winners are banked in tranches at big multiples; the rest rides a WIDE
// trailing stop so it can hold through to migration (CompleteEvent force-closes
// holders at the migration price).
//
// Two deliberate adaptations to the pyramid design:
// - The prove-it cut is judged on PRICE vs entry and only inside a ONE-TIME
//   window after proveItSlots, not as a standing rule: pyramid adds dilute
//   the value ratio toward 1.0 (new money buys at the current, higher price),
//   so a value-based / standing prove-it would false-trigger and cut a
//   winner right after scaling into it. Price is immune to that.
// - Sells are sized so the constant-product quote stays inside the real
//   reserve (a sell whose quote exceeds the real reserve is rejected
//   outright), so large pyramid positions exit in chunks instead of failing.
//
// UNITS (read this before sweeping): every *Pct param is a PERCENT -
// 100 means +100% (2x), 50 means +50% (1.5x), 85 means an 85% retrace.
// The code divides them by 100. The ONLY exception is addReserveGrowthPct,
// which is a FRACTION (0.03 = 3% reserve growth). Sweep overrides must use
// PERCENT for the *Pct params (e.g. {"trailPct": 75}), not fractions.
//
// Revision 9 - BEST-KNOWN DEFAULTS (net +4.8702 on the dev window):
// prove-it is a one-time checkpoint at 60 slots / +20% (latch), trail 25%
// retrace armed at +50% price, banks +50%/+300%/+700% value (25% each),
// conviction-gated pyramid adds (price >= 2.5x entry, reserve growth 3%,
// flow >= 0.4, 2-slot gap) of 0.5 SOL up to 5 SOL cost, entry at 2 SOL
// reserve with buy-share >= 0.75 inside a 60-slot window, tight 800bps
// slippage, max hold 1200 slots. The design converged here after ~70
// variants: net is CHjgAurR (+5.43, a 12.15x slow completer held 389 slots,
// 13 adds, 4.97 SOL deployed) + DWAJccSe (+0.18 at 1201 slots) minus
// ~-0.78 of loser bleed over ~282 small losing trips. It is a
// one-big-winner design; the stress test decides whether that winner
// generalises or is a single-coin artefact.
//
// Deterministic: no clock, no env, no Math.random. All state lives in the
// createBot closure and is updated from batch events / fills only.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import { pathToFileURL } from 'node:url';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// UNITS (read this before sweeping): every *Pct param is a PERCENT -
// 100 means +100% (2x), 50 means +50% (1.5x), 85 means an 85% retrace.
// The code divides them by 100. The ONLY exception is addReserveGrowthPct,
// which is a FRACTION (0.03 = 3% reserve growth). addMinPriceMult is a
// multiple (2 = price doubled). Sweep overrides must use PERCENT for the
// *Pct params (e.g. {"trailPct": 75}), not fractions. (Rev5 fixed a 100x
// units bug: pre-rev5 defaults were hair-trigger and all pre-rev5 sweep
// rows ran in that regime - they are NOT comparable to rev5+ rows.)

export interface BotParams {
  entryReserveSol: number;
  entryWindowSlots: number;
  entryBandMult: number;
  flowWindowSlots: number;
  minBuyShare: number;
  initialSizeSol: number;
  pyramidAddSol: number;
  pyramidMinGapSlots: number;
  pyramidMaxCostSol: number;
  pyramidRequireAboveEntry: boolean;
  addMinBuyShare: number;
  addMinPriceMult: number;
  addReserveGrowthPct: number;
  proveItSlots: number;
  proveItWindowSlots: number;
  proveItPct: number;
  proveItReserveSol: number;
  stopLossPct: number;
  stopLossGraceSlots: number;
  bank1Pct: number;
  bank1Frac: number;
  bank2Pct: number;
  bank2Frac: number;
  bank3Pct: number;
  bank3Frac: number;
  trailArmPct: number;
  trailPct: number;
  maxHoldSlots: number;
  timeExitPct: number;
  slippageBps: number;
  sellSlippageBps: number;
  maxEntriesPerBatch: number;
}

export const DEFAULT_PARAMS: BotParams = {
  entryReserveSol: 2,
  entryWindowSlots: 60,
  entryBandMult: 3,
  flowWindowSlots: 10,
  minBuyShare: 0.75,
  initialSizeSol: 0.02,
  pyramidAddSol: 0.5,
  pyramidMinGapSlots: 2,
  pyramidMaxCostSol: 5,
  pyramidRequireAboveEntry: true,
  addMinBuyShare: 0.4,
  addMinPriceMult: 2.5,
  addReserveGrowthPct: 0.03,
  proveItSlots: 60,
  proveItWindowSlots: 10,
  proveItPct: 20,
  proveItReserveSol: 2.5,
  stopLossPct: 50,
  stopLossGraceSlots: 30,
  bank1Pct: 50,
  bank1Frac: 0.25,
  bank2Pct: 300,
  bank2Frac: 0.25,
  bank3Pct: 700,
  bank3Frac: 0.25,
  trailArmPct: 50,
  trailPct: 25,
  maxHoldSlots: 1200,
  timeExitPct: 20,
  slippageBps: 800,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
};

const LAM = LAMPORTS_PER_SOL;
const MIN_BUY_LAM = 10_000_000n; // 0.01 SOL — smallest buy that counts as a round trip
const FEE_BPS = 125n; // protocol 95 + creator 30 fallback, bps

const solToLam = (s: number): bigint => BigInt(Math.round(s * 1e9));
const lamToSol = (l: bigint): number => Number(l) / 1e9;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Net SOL (lamports) a sell of `tokens` realises right now, after curve fees + tx fee. */
function sellNowNet(vq: bigint, vt: bigint, tokens: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vq <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const proceeds = q - ceilDiv(q * FEE_BPS, 10000n);
  return proceeds > txFee ? proceeds - txFee : 0n;
}

/**
 * Largest token amount whose constant-product quote stays within 95% of the
 * real reserve (a sell whose quote exceeds the real reserve is rejected
 * outright), so a big position exits in chunks instead of failing.
 */
function maxSellTokens(vq: bigint, vt: bigint, rq: bigint, want: bigint): bigint {
  if (want <= 0n) return 0n;
  if (vq <= rq) return want;
  const tMax = (rq * vt) / (vq - rq);
  const tSafe = (tMax * 95n) / 100n;
  return want < tSafe ? want : tSafe;
}

/** priceA > priceB, prices as (vq, vt) pairs, exact bigint cross-multiplication. */
const priceGt = (vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint): boolean =>
  vqA * vtB > vqB * vtA;

/** (vqA/vtA) / (vqB/vtB) as a float. */
const priceRatio = (vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint): number =>
  Number(vqA) / Number(vtA) / (Number(vqB) / Number(vtB));

interface FlowPoint {
  slot: number;
  buy: bigint;
  sell: bigint;
}

interface MintTrack {
  flow: FlowPoint[];
  firstCrossSlot: number | null;
  complete: boolean;
  done: boolean;
  entered: boolean;
  sawPosition: boolean;
  entrySlot: number;
  entryVq: bigint;
  entryVt: bigint;
  lastAddSlot: number;
  lastAddVq: bigint;
  lastAddVt: bigint;
  rqAtLastAdd: bigint;
  peakVq: bigint;
  peakVt: bigint;
  trailArmed: boolean;
  proveItDone: boolean;
  banked1: boolean;
  banked2: boolean;
  banked3: boolean;
  spent: bigint;
}

function freshTrack(): MintTrack {
  return {
    flow: [],
    firstCrossSlot: null,
    complete: false,
    done: false,
    entered: false,
    sawPosition: false,
    entrySlot: 0,
    entryVq: 0n,
    entryVt: 1n,
    lastAddSlot: 0,
    lastAddVq: 0n,
    lastAddVt: 1n,
    rqAtLastAdd: 0n,
    peakVq: 0n,
    peakVt: 1n,
    trailArmed: false,
    proveItDone: false,
    banked1: false,
    banked2: false,
    banked3: false,
    spent: 0n,
  };
}

export function createBot(overrides: Partial<BotParams> = {}) {
  const p: BotParams = { ...DEFAULT_PARAMS, ...overrides };
  const entryThresholdLam = solToLam(p.entryReserveSol);
  const initialSizeLam = solToLam(p.initialSizeSol);
  const pyramidAddLam = solToLam(p.pyramidAddSol);
  const maxCostLam = solToLam(p.pyramidMaxCostSol);
  const proveItReserveLam = solToLam(p.proveItReserveSol);

  const tracks = new Map<string, MintTrack>();
  const trackFor = (mint: string): MintTrack => {
    let t = tracks.get(mint);
    if (!t) {
      t = freshTrack();
      tracks.set(mint, t);
    }
    return t;
  };

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = state.slot;
    const txFee = state.txFeeLamports();
    let reserved = 0n;
    const freeCash = (): bigint => state.freeCashLamports() - reserved;

    const pendingMints = new Set<string>();
    for (const po of state.pending.values()) pendingMints.add(po.order.mint);

    // 1. Fills: track filled buy spend per mint (drives the pyramid cost cap).
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy') {
        const t = tracks.get(f.mint);
        if (t) t.spent += BigInt(f.quote_lamports);
      }
    }

    // 2. Events: per-mint buy/sell flow, reserve-crossing slot, touched mints.
    const touched: string[] = [];
    const touchedSet = new Set<string>();
    const touch = (mint: string): void => {
      if (!touchedSet.has(mint)) {
        touchedSet.add(mint);
        touched.push(mint);
      }
    };
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        trackFor(e.mint);
      } else if (e.event === 'TradeEvent') {
        const t = trackFor(e.mint);
        const sol = BigInt(e.sol_amount);
        t.flow.push({ slot: e.slot, buy: e.is_buy ? sol : 0n, sell: e.is_buy ? 0n : sol });
        const rq = BigInt(e.real_quote_reserves);
        if (t.firstCrossSlot === null && rq >= entryThresholdLam) t.firstCrossSlot = e.slot;
        touch(e.mint);
      } else {
        trackFor(e.mint).complete = true;
      }
    }
    for (const mint of touched) {
      const t = tracks.get(mint)!;
      const cutoff = slot - p.flowWindowSlots;
      if (t.flow.length > 0 && t.flow[0]!.slot <= cutoff) {
        t.flow = t.flow.filter((f) => f.slot > cutoff);
      }
    }

    const flowShare = (t: MintTrack): number => {
      let buy = 0n;
      let sell = 0n;
      const cutoff = slot - p.flowWindowSlots;
      for (const f of t.flow) {
        if (f.slot > cutoff) {
          buy += f.buy;
          sell += f.sell;
        }
      }
      const total = buy + sell;
      return total > 0n ? Number(buy) / Number(total) : 0;
    };

    // 3. Lifecycle: a position that is gone with nothing in flight is done.
    // An entry buy that was rejected/failed (never became a position) may retry.
    for (const [mint, t] of tracks) {
      if (!t.entered) continue;
      if (state.positions.has(mint)) {
        t.sawPosition = true;
        continue;
      }
      if (pendingMints.has(mint)) continue;
      if (t.sawPosition) t.done = true;
      t.entered = false;
    }

    // 4. Entries: real reserve crossed the low threshold recently, still in
    // the early band, net-buy flow, free position slot, free cash.
    let entriesThisBatch = 0;
    for (const mint of touched) {
      if (entriesThisBatch >= p.maxEntriesPerBatch || orders.length >= 16) break;
      const t = tracks.get(mint)!;
      if (t.done || t.entered || t.complete) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const rq = curve.real_quote_reserves;
      if (rq < entryThresholdLam || rq > entryThresholdLam * BigInt(p.entryBandMult)) continue;
      if (t.firstCrossSlot === null) t.firstCrossSlot = slot;
      if (slot - t.firstCrossSlot > p.entryWindowSlots) continue;
      if (flowShare(t) < p.minBuyShare) continue;
      if (pendingMints.has(mint)) continue;
      if (state.committedPositionCount() + entriesThisBatch >= 5) continue;
      let size = initialSizeLam;
      const cap = state.maxBuyLamports(mint);
      if (size > cap) size = cap;
      const afford = freeCash() - txFee;
      if (size > afford) size = afford;
      if (size < MIN_BUY_LAM) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.slippageBps });
      reserved += size + txFee;
      entriesThisBatch++;
      t.entered = true;
      t.sawPosition = false;
      t.spent = 0n;
      t.entrySlot = slot;
      t.entryVq = curve.virtual_quote_reserves;
      t.entryVt = curve.virtual_token_reserves;
      t.lastAddSlot = slot;
      t.lastAddVq = curve.virtual_quote_reserves;
      t.lastAddVt = curve.virtual_token_reserves;
      t.rqAtLastAdd = curve.real_quote_reserves;
      t.peakVq = curve.virtual_quote_reserves;
      t.peakVt = curve.virtual_token_reserves;
      t.trailArmed = false;
      t.proveItDone = false;
      t.banked1 = false;
      t.banked2 = false;
      t.banked3 = false;
    }

    // 5. Position management: one action per mint per batch, in priority order.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= 16) break;
      if (pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const t = trackFor(mint);
      if (!t.entered) {
        // Defensive: a position exists without entry bookkeeping.
        t.entered = true;
        t.sawPosition = true;
        t.entrySlot = slot;
        t.entryVq = curve.virtual_quote_reserves;
        t.entryVt = curve.virtual_token_reserves;
        t.lastAddSlot = slot;
        t.lastAddVq = curve.virtual_quote_reserves;
        t.lastAddVt = curve.virtual_token_reserves;
        t.rqAtLastAdd = curve.real_quote_reserves;
        t.peakVq = curve.virtual_quote_reserves;
        t.peakVt = curve.virtual_token_reserves;
      }
      const tokens = pos.token_amount;
      const cost = pos.cost_lamports;
      if (tokens <= 0n || cost <= 0n) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const rq = curve.real_quote_reserves;
      const value = sellNowNet(vq, vt, tokens, txFee);
      const valueRatio = Number(value) / Number(cost);
      const heldSlots = slot - t.entrySlot;

      // Track the marginal-price peak for the trailing stop.
      if (priceGt(vq, vt, t.peakVq, t.peakVt)) {
        t.peakVq = vq;
        t.peakVt = vt;
      }
      const priceVsEntry = priceRatio(vq, vt, t.entryVq, t.entryVt);
      if (priceVsEntry >= 1 + p.trailArmPct / 100) t.trailArmed = true;

      const sellAll = (): boolean => {
        const amount = maxSellTokens(vq, vt, rq, tokens);
        if (amount <= 0n) return false;
        // A sell whose net proceeds do not cover the tx fee is rejected
        // zero_amount by the market; do not waste the order.
        if (sellNowNet(vq, vt, amount, txFee) <= 0n) return false;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        reserved += txFee;
        return true;
      };
      const sellFrac = (frac: number): boolean => {
        const want = (tokens * BigInt(Math.round(frac * 10000))) / 10000n;
        const amount = maxSellTokens(vq, vt, rq, want);
        if (amount <= 0n) return false;
        if (sellNowNet(vq, vt, amount, txFee) <= 0n) return false;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        reserved += txFee;
        return true;
      };

      // Stop-loss on PRICE vs entry (not on realised value): pyramid adds
      // dilute the value ratio toward 1.0, so a value-based stop fires on a
      // winner that retraced from its peak after scaling in, while a
      // price-based stop only fires if the market price itself collapses
      // below (1 - stopLossPct) of the entry price. This is a collapse
      // backstop; the prove-it window is the main loser cutter and the trail
      // is the main winner exit. Only live after the grace period.
      if (heldSlots >= p.stopLossGraceSlots && priceVsEntry <= 1 - p.stopLossPct / 100) {
        sellAll();
        continue;
      }
      // Wide trailing stop on marginal price (immune to pyramid dilution).
      if (t.trailArmed && priceRatio(vq, vt, t.peakVq, t.peakVt) <= 1 - p.trailPct / 100) {
        sellAll();
        continue;
      }
      // Prove-it cut: a ONE-TIME checkpoint, evaluated at the first batch
      // where heldSlots >= proveItSlots and never again. Revision 8: the
      // STANDING version cut slow grinders the first time they oscillated
      // below the threshold after passing it (the other slow completers
      // exited at +57-109 slots for +0.05-0.10 instead of riding to their
      // +345-2205 slot peaks). A one-time checkpoint keeps a coin that has
      // proven itself (+10% at 30 slots) free to oscillate afterwards, while
      // still cutting losers at the checkpoint. (The earlier WINDOWED version
      // never fired because batches skip slots and heldSlots jumps over the
      // window; the latch avoids that too - it fires at the first batch at
      // or past proveItSlots, whenever that lands.)
      if (!t.proveItDone && heldSlots >= p.proveItSlots) {
        t.proveItDone = true;
        if (
          priceVsEntry < 1 + p.proveItPct / 100 ||
          (rq < proveItReserveLam && valueRatio < 1 + p.trailArmPct / 100)
        ) {
          sellAll();
          continue;
        }
      }
      // Time exit: held too long without enough gain.
      if (heldSlots > p.maxHoldSlots && valueRatio < 1 + p.timeExitPct / 100) {
        sellAll();
        continue;
      }
      // Bank tranches on realised value.
      if (!t.banked1 && valueRatio >= 1 + p.bank1Pct / 100) {
        if (sellFrac(p.bank1Frac)) t.banked1 = true;
        continue;
      }
      if (!t.banked2 && valueRatio >= 1 + p.bank2Pct / 100) {
        if (sellFrac(p.bank2Frac)) t.banked2 = true;
        continue;
      }
      if (!t.banked3 && valueRatio >= 1 + p.bank3Pct / 100) {
        if (sellFrac(p.bank3Frac)) t.banked3 = true;
        continue;
      }
      // Continuous pyramid, CONVICTION-gated: add ONLY once the price has
      // doubled from entry (a confirmed runner). The starter is a scout; the
      // pyramid is conviction capital and must not deploy on a coin that has
      // merely drifted up. Without this gate, rev5 added to 0.5-2 SOL on coins
      // that then collapsed for -0.16..-0.48 SOL per trip. With the gate, a
      // coin that never doubles can lose at most the ~0.02 starter + fees.
      // Other gates: real reserve grown since the last add, flow still
      // net-buy, gap respected, inside the per-position cost cap.
      const growthNum = rq * 100n;
      const growthDen = t.rqAtLastAdd > 0n ? t.rqAtLastAdd : 1n;
      const reserveGrew =
        t.rqAtLastAdd <= 0n || growthNum >= growthDen * BigInt(Math.round((1 + p.addReserveGrowthPct) * 100));
      if (
        slot - t.lastAddSlot >= p.pyramidMinGapSlots &&
        priceVsEntry >= p.addMinPriceMult &&
        reserveGrew &&
        (!p.pyramidRequireAboveEntry || priceGt(vq, vt, t.entryVq, t.entryVt)) &&
        flowShare(t) >= p.addMinBuyShare
      ) {
        let add = pyramidAddLam;
        const cap = state.maxBuyLamports(mint);
        if (add > cap) add = cap;
        const afford = freeCash() - txFee;
        if (add > afford) add = afford;
        if (add >= MIN_BUY_LAM && t.spent + add <= maxCostLam) {
          orders.push({ side: 'buy', mint, quote_lamports: add, max_slippage_bps: p.slippageBps });
          reserved += add + txFee;
          t.lastAddSlot = slot;
          t.lastAddVq = vq;
          t.lastAddVt = vt;
          t.rqAtLastAdd = rq;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runBot(createBot(DEFAULT_PARAMS));
}
