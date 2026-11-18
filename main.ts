import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 14;
const SLOW_SPAN = 55;
const ENTER_HYST_BPS = 14;
const EXIT_HYST_BPS = 8;
const STOP_LOSS_BPS = 150;
const TP_TRIGGER_BPS = 80;
const TP_TRAILING_BPS = 28;
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 150;
const MIN_STABILIZATION_BARS = 120;
const MAX_ENTRY_BAR = 1200;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, b) => a + b, 0) / e.span;
  }
}

const fastEma: Ema = { span: FAST_SPAN, warm: [], value: null };
const slowEma: Ema = { span: SLOW_SPAN, warm: [], value: null };

let prevFast: number | null = null;
let prevSlow: number | null = null;
let cooldown = 0;

let entryPrice = 0;
let highestPrice = 0;
let tpArmed = false;
let orderPending: 'buy' | 'sell' | null = null;

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    const latestBar = state.latest.get(symbol);

    if (latestBar) {
      const close = Number(latestBar.c);
      stepEma(fastEma, close);
      stepEma(slowEma, close);
    }

    for (const fill of batch.fills) {
      if (fill.symbol === symbol) {
        orderPending = null;
        if (fill.status === 'filled') {
          if (fill.side === 'buy') {
            entryPrice = Number(fill.price);
            highestPrice = entryPrice;
            tpArmed = false;
          } else if (fill.side === 'sell') {
            entryPrice = 0;
            highestPrice = 0;
            tpArmed = false;
            cooldown = COOLDOWN_BARS;
          }
        }
      }
    }

    if (cooldown > 0) {
      cooldown--;
    }

    const held = state.positions.get(symbol);
    const close = latestBar ? Number(latestBar.c) : 0;

    if (held !== undefined && entryPrice === 0 && close > 0) {
      entryPrice = close;
      highestPrice = close;
      tpArmed = false;
    }

    if (held !== undefined && orderPending === null && entryPrice > 0 && close > 0) {
      if (close > highestPrice) {
        highestPrice = close;
      }

      if (!tpArmed && highestPrice >= entryPrice * (1 + TP_TRIGGER_BPS / 10000)) {
        tpArmed = true;
      }

      let exitReason: string | null = null;

      if (close <= entryPrice * (1 - STOP_LOSS_BPS / 10000)) {
        exitReason = 'stop_loss';
      } else if (tpArmed && close <= highestPrice * (1 - TP_TRAILING_BPS / 10000)) {
        exitReason = 'trailing_tp';
      } else if (
        fastEma.value !== null &&
        slowEma.value !== null &&
        fastEma.value < slowEma.value * (1 - EXIT_HYST_BPS / 10000)
      ) {
        exitReason = 'trend_reversal';
      }

      if (exitReason !== null) {
        orderPending = 'sell';
        prevFast = fastEma.value;
        prevSlow = slowEma.value;

        return [{
          side: 'sell',
          symbol,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }
    }

    if (
      held === undefined &&
      orderPending === null &&
      cooldown === 0 &&
      batch.seq >= MIN_STABILIZATION_BARS &&
      batch.seq <= MAX_ENTRY_BAR &&
      fastEma.value !== null &&
      slowEma.value !== null &&
      prevFast !== null &&
      prevSlow !== null
    ) {
      const isAbove = fastEma.value > slowEma.value * (1 + ENTER_HYST_BPS / 10000);
      const wasAbove = prevFast > prevSlow * (1 + ENTER_HYST_BPS / 10000);

      if (isAbove && !wasAbove) {
        const { caps, fees } = state.hello;
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        const slice = state.cash < byWeight ? state.cash : byWeight;

        if (slice >= BigInt(fees.min_notional_quote_units)) {
          orderPending = 'buy';
          prevFast = fastEma.value;
          prevSlow = slowEma.value;

          return [{
            side: 'buy',
            symbol,
            notional_quote_units: slice,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }
    }

    prevFast = fastEma.value;
    prevSlow = slowEma.value;

    return [];
  },
});
