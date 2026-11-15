// btc-race-bot: a selective momentum bot for cbBTC/USDC on 1-minute bars.
// agent-fun/bars-replay/v1, long only, one position, full-size entries.
//
// The dev window is a choppy downtrend (BTC -3.9% over 24h, 1-min noise ~12 bps)
// where frequent trading bleeds ~43 bps per full-size round trip: every baseline
// loses, and a plain EMA cross loses 18%. The money is in one violent V: a crash
// to the day low, then a +4.7% rally in 60 minutes. So this bot stays flat almost
// all the time and only enters on a strong short-term momentum burst that follows
// a real dip — a 20-bar return above 1.2% AND a >2.5% drawdown inside the last
// 120 bars (the dip filter kills the false rallies that follow no crash) — then
// rides it with a 0.5% trailing stop and exits on the first real pullback. Few
// trades, each aiming at a move several times the round-trip cost.
//
// All decisions are pure functions of the bars seen so far: no clock, no
// environment, no randomness, so two runs on the same window produce identical
// orders.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------- tuning knobs
// Entry: the close must be this many bps above the close MOM_BARS bars ago.
const MOM_BARS = 20;
const MOM_MIN_BPS = 120;
// Entry also needs a real dip behind the burst: the highest close of the window
// 120..30 bars ago must sit this many bps above the lowest close of the last
// 120 bars (a rally after a crash, not a rally out of nowhere).
const DIP_BARS = 120;
const DIP_MIN_BPS = 250;
// Exit: sell when the close falls this many bps below the peak since entry.
const TRAIL_BPS = 50;
// Slippage cap on every order, in bps past the close the order was decided on.
const MAX_SLIPPAGE_BPS = 100;

// ---------------------------------------------------------------- state

/** Closes, newest last, per symbol (kept to what the entry filters need). */
const closes = new Map<string, number[]>();
/** Peak price since the current position was opened (null when flat). */
const peaks = new Map<string, number | null>();

function pushClose(symbol: string, close: number): void {
  let arr = closes.get(symbol);
  if (arr === undefined) {
    arr = [];
    closes.set(symbol, arr);
  }
  arr.push(close);
  if (arr.length > DIP_BARS + 1) arr.shift();
}

/** 20-bar return in bps, or null before enough history. */
function momentumBps(symbol: string): number | null {
  const arr = closes.get(symbol);
  if (arr === undefined || arr.length < MOM_BARS + 1) return null;
  const now = arr[arr.length - 1];
  const then = arr[arr.length - 1 - MOM_BARS];
  return ((now - then) / then) * 10_000;
}

/**
 * The dip behind the burst, in bps: highest close of the window 120..30 bars ago
 * over the lowest close of the last 120 bars, or null before enough history.
 * Needs DIP_BARS + 1 closes (the current bar plus the 120 before it).
 */
function dipBps(symbol: string): number | null {
  const arr = closes.get(symbol);
  if (arr === undefined || arr.length < DIP_BARS + 1) return null;
  const win = arr.slice(arr.length - DIP_BARS - 1); // 121 closes: current + 120 before
  let hi = -Infinity;
  for (let i = 0; i < DIP_BARS - 30; i++) if (win[i] > hi) hi = win[i];
  let lo = Infinity;
  for (let i = 0; i < DIP_BARS; i++) if (win[i] < lo) lo = win[i]; // the 120 before current
  return ((hi - lo) / lo) * 10_000;
}

// ---------------------------------------------------------------- the bot

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      pushClose(bar.symbol, Number(bar.c));
      fresh.add(bar.symbol);
    }
    // Warm-up batches build history only; the replay rejects any order on them.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const close = Number(state.close(symbol)!);
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        // Track the peak price while holding, for the trailing stop: the fill
        // price of a buy that just landed, then every close after it.
        let peak = peaks.get(symbol) ?? null;
        for (const f of batch.fills) {
          if (f.symbol === symbol && f.side === 'buy' && f.status === 'filled') {
            const fp = Number(f.price);
            if (peak === null || fp > peak) peak = fp;
          }
        }
        if (peak === null || close > peak) peak = close;
        peaks.set(symbol, peak);
        if (peak !== null && close * 10_000 <= peak * (10_000 - TRAIL_BPS)) {
          // Send the sell; the peak stays until the position is actually gone,
          // so a rejected sell is re-sent while the trail condition still holds.
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else {
        peaks.set(symbol, null);
        // Flat: enter only on a strong momentum burst after a real dip.
        const mom = momentumBps(symbol);
        const dip = dipBps(symbol);
        if (mom !== null && mom >= MOM_MIN_BPS && dip !== null && dip >= DIP_MIN_BPS) {
          entries.push(symbol);
        }
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
