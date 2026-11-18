import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/**
 * Strategy identification metadata for race scoring, leaderboard provenance,
 * and harness telemetry introspection.
 */
export const BOT_NAME = 'Dual-EMA-Hysteresis-cbBTC';
export const BOT_VERSION = '2.0.0';
export const STRATEGY_TYPE = 'Quantitative-Trend-Following';

/**
 * State container for an Exponential Moving Average (EMA).
 * Tracks historical warm-up samples before switching to continuous recursive exponential smoothing.
 */
export interface EmaState {
  readonly span: number;
  readonly warm: number[];
  value: number | null;
}

/**
 * Encapsulated Object-Oriented Trend-Following Strategy for cbBTC/USDC on Base (1-minute bars).
 *
 * Microstructure & Algorithmic Formulation:
 * 1. Dual EMA Filter:
 *    Maintains a fast smoothing span (14 bars) and a slow baseline span (55 bars).
 *    During initialization, an arithmetic mean warms up the accumulator. Once warmed,
 *    recursive smoothing applies: EMA_t = EMA_{t-1} + (2 / (span + 1)) * (Close_t - EMA_{t-1}).
 *
 * 2. Asymmetric Hysteresis Band (Schmitt Trigger):
 *    Standard moving average crossovers are susceptible to high-frequency whipsaws during
 *    consolidation regimes. To suppress false signals:
 *    - Long Entry requires: Fast_t > Slow_t * (1 + 14 bps) with prior bar Fast_{t-1} <= Slow_{t-1} * (1 + 14 bps).
 *    - Reversal Exit requires: Fast_t < Slow_t * (1 - 8 bps).
 *
 * 3. Dynamic High-Watermark Trailing Profit Stop:
 *    - Armed when unrealized profit reaches +80 bps from the execution entry price.
 *    - Once armed, monitors peak price: P_peak = max(P_peak, Close_t).
 *    - Triggers protective exit if price retraces 28 bps from the recorded peak.
 *
 * 4. Capital Protection Guardrails:
 *    - Hard Stop Loss: -150 bps from fill price.
 *    - Stabilization: No entries permitted during the first 120 bars to ensure moving average stability.
 *    - Session Cutoff: No entries permitted after bar 1200 to prevent unhedged holding into settlement.
 *    - Post-Trade Cooldown: Enforces a 30-bar quiet period after every position liquidation.
 */
export class BtcTrendStrategy {
  // Algorithmic Hyperparameters
  public readonly fastSpan: number = 14;
  public readonly slowSpan: number = 55;
  public readonly enterHysteresisBps: number = 14;
  public readonly exitHysteresisBps: number = 8;
  public readonly stopLossBps: number = 150;
  public readonly tpTriggerBps: number = 80;
  public readonly tpTrailingBps: number = 28;
  public readonly cooldownBars: number = 30;
  public readonly maxSlippageBps: number = 150;
  public readonly minStabilizationBars: number = 120;
  public readonly maxEntryBar: number = 1200;

  // Indicator States
  public readonly fastEma: EmaState;
  public readonly slowEma: EmaState;
  public prevFast: number | null = null;
  public prevSlow: number | null = null;

  // Execution & Position States
  public cooldown: number = 0;
  public entryPrice: number = 0;
  public highestPrice: number = 0;
  public tpArmed: boolean = false;
  public orderPending: 'buy' | 'sell' | null = null;

  constructor() {
    this.fastEma = { span: this.fastSpan, warm: [], value: null };
    this.slowEma = { span: this.slowSpan, warm: [], value: null };
  }

  /**
   * Applies an asymmetric basis point offset to a reference price.
   * @param price Reference base price
   * @param bpsOffset Basis points delta (positive for upper band, negative for lower band)
   */
  public applyBpsOffset(price: number, bpsOffset: number): number {
    return price * (1 + bpsOffset / 10000);
  }

  /**
   * Updates an EMA state with the latest closing price.
   * Uses SMA warm-up until the window size is met, then switches to recursive exponential smoothing.
   */
  public updateEma(ema: EmaState, close: number): void {
    if (ema.value !== null) {
      ema.value += (2 / (ema.span + 1)) * (close - ema.value);
      return;
    }
    ema.warm.push(close);
    if (ema.warm.length === ema.span) {
      ema.value = ema.warm.reduce((acc, curr) => acc + curr, 0) / ema.span;
    }
  }

  /**
   * Processes execution fills returned by the market simulator.
   * Updates cost basis, arms/resets trailing profit monitors, and triggers cooldown counters.
   */
  public onFills(fills: readonly any[], symbol: string): void {
    for (const fill of fills) {
      if (fill.symbol === symbol) {
        this.orderPending = null;
        if (fill.status === 'filled') {
          if (fill.side === 'buy') {
            this.entryPrice = Number(fill.price);
            this.highestPrice = this.entryPrice;
            this.tpArmed = false;
          } else if (fill.side === 'sell') {
            this.entryPrice = 0;
            this.highestPrice = 0;
            this.tpArmed = false;
            this.cooldown = this.cooldownBars;
          }
        }
      }
    }
  }

  /**
   * Evaluates active position against risk exit criteria:
   * 1. Hard Stop Loss (-150 bps)
   * 2. High-Watermark Trailing Take-Profit (-28 bps pullback from peak after +80 bps trigger)
   * 3. Trend Reversal Exit (Fast EMA < Slow EMA - 8 bps)
   */
  public evaluateExit(
    held: { qty: bigint; cost: bigint } | undefined,
    symbol: string,
    close: number
  ): SellInput | null {
    if (held !== undefined && this.entryPrice === 0 && close > 0) {
      this.entryPrice = close;
      this.highestPrice = close;
      this.tpArmed = false;
    }

    if (held !== undefined && this.orderPending === null && this.entryPrice > 0 && close > 0) {
      if (close > this.highestPrice) {
        this.highestPrice = close;
      }

      if (!this.tpArmed && this.highestPrice >= this.applyBpsOffset(this.entryPrice, this.tpTriggerBps)) {
        this.tpArmed = true;
      }

      let exitReason: string | null = null;

      if (close <= this.applyBpsOffset(this.entryPrice, -this.stopLossBps)) {
        exitReason = 'stop_loss';
      } else if (this.tpArmed && close <= this.applyBpsOffset(this.highestPrice, -this.tpTrailingBps)) {
        exitReason = 'trailing_tp';
      } else if (
        this.fastEma.value !== null &&
        this.slowEma.value !== null &&
        this.fastEma.value < this.applyBpsOffset(this.slowEma.value, -this.exitHysteresisBps)
      ) {
        exitReason = 'trend_reversal';
      }

      if (exitReason !== null) {
        this.orderPending = 'sell';
        return {
          side: 'sell',
          symbol,
          qty: held.qty,
          max_slippage_bps: this.maxSlippageBps,
        };
      }
    }

    return null;
  }

  /**
   * Evaluates flat cash state for long breakout entry:
   * Checks stabilization period, session boundaries, post-trade cooldown, and upward hysteresis crossover.
   */
  public evaluateEntry(
    batchSeq: number,
    equity: bigint,
    cash: bigint,
    caps: any,
    fees: any,
    symbol: string
  ): BuyInput | null {
    if (
      this.orderPending === null &&
      this.cooldown === 0 &&
      batchSeq >= this.minStabilizationBars &&
      batchSeq <= this.maxEntryBar &&
      this.fastEma.value !== null &&
      this.slowEma.value !== null &&
      this.prevFast !== null &&
      this.prevSlow !== null
    ) {
      const isAbove = this.fastEma.value > this.applyBpsOffset(this.slowEma.value, this.enterHysteresisBps);
      const wasAbove = this.prevFast > this.applyBpsOffset(this.prevSlow, this.enterHysteresisBps);

      if (isAbove && !wasAbove) {
        const byWeight = (BigInt(caps.max_weight_bps) * equity) / BPS;
        const slice = cash < byWeight ? cash : byWeight;

        if (slice >= BigInt(fees.min_notional_quote_units)) {
          this.orderPending = 'buy';
          return {
            side: 'buy',
            symbol,
            notional_quote_units: slice,
            max_slippage_bps: this.maxSlippageBps,
          };
        }
      }
    }

    return null;
  }

  /**
   * Dispatches 1-minute batch execution logic per bar:
   * Updates indicator series, handles fills, checks exits, and generates entry orders.
   */
  public onBar(state: any, batch: any): readonly (BuyInput | SellInput)[] {
    const symbol = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    const latestBar = state.latest.get(symbol);

    if (latestBar) {
      const close = Number(latestBar.c);
      this.updateEma(this.fastEma, close);
      this.updateEma(this.slowEma, close);
    }

    this.onFills(batch.fills, symbol);

    if (this.cooldown > 0) {
      this.cooldown--;
    }

    const held = state.positions.get(symbol);
    const close = latestBar ? Number(latestBar.c) : 0;

    // 1. Check Exit conditions for active position
    const exitOrder = this.evaluateExit(held, symbol, close);
    if (exitOrder) {
      this.prevFast = this.fastEma.value;
      this.prevSlow = this.slowEma.value;
      return [exitOrder];
    }

    // 2. Check Entry conditions when flat
    if (held === undefined) {
      const entryOrder = this.evaluateEntry(
        batch.seq,
        state.equity,
        state.cash,
        state.hello.caps,
        state.hello.fees,
        symbol
      );
      if (entryOrder) {
        this.prevFast = this.fastEma.value;
        this.prevSlow = this.slowEma.value;
        return [entryOrder];
      }
    }

    // 3. Update previous EMA values for crossover boundary tracking
    this.prevFast = this.fastEma.value;
    this.prevSlow = this.slowEma.value;

    return [];
  }
}

// Strategy instance instantiation
const strategy = new BtcTrendStrategy();

// Main event loop runner
await runBars({
  onBatch(state, batch) {
    return strategy.onBar(state, batch);
  },
});
