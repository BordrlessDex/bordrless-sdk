import { describe, expect, it } from 'vitest';
import { hookSideRates, rateFromRules, rateFromSummary } from './rates.ts';
import type { WorkshopReadingRule } from './workshop.ts';

const rule = (r: Partial<WorkshopReadingRule> & Pick<WorkshopReadingRule, 'on' | 'bps'>): WorkshopReadingRule => ({ when: 'Sells', to: 'pot', text: 'x', ...r });

/** B², 18 Oct 2026: 1% on buys and sells, 0% on buys and 3% on sells in a dip; hook.json caps 100 / 300; flags take no tokens. */
const DIP = {
  total: { bps: 300, text: 'Up to 3% of a sell, up to 1% of a buy' },
  summary: {
    buys: '1% of each buy, to the pot. Nothing is taken during a dip, while the price is more than 15% under where it has stood over the last 6 hours.',
    sells: '1% of each sell, to the pot. 3% during a dip, while the price is more than 15% under where it has stood over the last 6 hours.',
  },
  rules: [
    rule({ on: 'buy', when: 'Buys', bps: 100, text: '1% of each buy, to the pot' }),
    rule({ on: 'buy', when: 'Buys in a dip', bps: 0, to: 'none', text: 'Nothing is taken while the price is over 15% under its level of the last 6 hours' }),
    rule({ on: 'sell', when: 'Sells', bps: 100, text: '1% of each sell, to the pot' }),
    rule({ on: 'sell', when: 'Sells in a dip', bps: 300, text: '3% of each sell while the price is over 15% under its level of the last 6 hours, to the pot' }),
  ],
};
const CAPS = { maxBuyBps: 100, maxSellBps: 300 };

describe('hookSideRates: the rates every page draws (B², 18 Oct 2026)', () => {
  it('takes each side from the rules first, never from the prose while a rule says the side', () => {
    expect(hookSideRates(DIP)).toEqual({ buy: { bps: 100, upTo: true }, sell: { bps: 300, upTo: true } });
    expect(hookSideRates(DIP, { caps: CAPS, tokens: false })).toEqual({ buy: { bps: 100, upTo: true }, sell: { bps: 300, upTo: true } });
    // The summary alone would have said 1% on sells (its first sentence's rate).
    expect(rateFromSummary(DIP.summary.sells)).toEqual({ bps: 100, upTo: false });
    expect(rateFromRules(DIP.rules, 'sell')).toEqual({ bps: 300, upTo: true });
  });

  it('falls back to the summary sentence on a side with no rule, then to the total of a reading with neither', () => {
    expect(hookSideRates({ total: { bps: 780, text: 'Up to 7.8% of each sell' }, summary: { buys: 'Nothing is taken.', sells: 'Up to 7.8% of each sell. The bigger the sale, the more is taken: about 0.8% at 1%, 7.8% at 10%.' } })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: 780, upTo: true } });
    expect(hookSideRates({ total: { bps: 300, text: '3%' }, summary: { buys: 'A cut read from its settings.' } })).toEqual({ buy: { bps: null, upTo: false }, sell: null });
    // Rules, but none on buys: buys take nothing.
    expect(hookSideRates({ total: { bps: 300, text: '3%' }, rules: [rule({ on: 'sell', bps: 300 })] })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: 300, upTo: false } });
    // A reading written before the rules and the summary: its total on both sides.
    expect(hookSideRates({ total: { bps: 500, text: '5% of every trade' } })).toEqual({ buy: { bps: 500, upTo: false }, sell: { bps: 500, upTo: false } });
    expect(hookSideRates({ total: { bps: 800, text: 'Up to 8%' } })?.buy).toEqual({ bps: 800, upTo: true });
    // A rule whose rate the code does not bound: "a cut", whatever the summary says.
    expect(hookSideRates({ total: { bps: null, text: 'A cut' }, summary: { buys: '3% of each buy.' }, rules: [rule({ on: 'buy', bps: null })] })?.buy).toEqual({ bps: null, upTo: false });
    // Nothing says either side.
    expect(hookSideRates(null)).toBeNull();
    expect(hookSideRates({ summary: { goes: 'The pot pays holders.' } })).toBeNull();
    // A hook whose reading says only that it takes nothing: nothing on both sides.
    expect(hookSideRates({ total: { bps: 0, text: 'Nothing is taken' } })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: 0, upTo: false } });
    expect(hookSideRates({ total: { bps: 5_000, text: 'Half the pot' }, rules: [rule({ on: 'step', bps: 5_000 })] } as never)).toEqual({ buy: { bps: 5_000, upTo: false }, sell: { bps: 5_000, upTo: false } });
  });

  it('holds a side to the caps of its SOL cut: the cap when the reading says less, the floor beside a free buy as nothing', () => {
    const sells = [rule({ on: 'sell', bps: 780, text: 'About 0.8% selling 1% of the pool’s tokens, up to 7.8% at 10% or more, to the creator fee' })];
    // Flags that take no tokens: the rules describe the SOL cut, the cap bounds it; a buy cap at the floor beside a reading that takes nothing of a buy is nothing.
    expect(hookSideRates({ total: { bps: 780, text: '' }, rules: sells }, { caps: { maxBuyBps: 1, maxSellBps: 780 }, tokens: false })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: 780, upTo: true } });
    // Tokens too: the larger of the two on each side.
    const both = [rule({ on: 'trade', when: 'Buys and sells', bps: 300, text: '3%, to the pot' })];
    expect(hookSideRates({ total: { bps: 300, text: '' }, rules: both }, { caps: { maxBuyBps: 1, maxSellBps: 780 }, tokens: true })).toEqual({ buy: { bps: 300, upTo: false }, sell: { bps: 780, upTo: true } });
    // A rate nobody bounds stays its own when the hook can cut tokens; the cap is the rate when it can't.
    const open = [rule({ on: 'sell', bps: null, text: 'A rate the launcher sets, to the pot' })];
    expect(hookSideRates({ total: { bps: null, text: '' }, rules: open }, { caps: { maxBuyBps: 1, maxSellBps: 780 }, tokens: true })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: null, upTo: false } });
    expect(hookSideRates({ total: { bps: null, text: '' }, rules: open }, { caps: { maxBuyBps: 1, maxSellBps: 780 }, tokens: false })).toEqual({ buy: { bps: 0, upTo: false }, sell: { bps: 780, upTo: true } });
    // The reading says more than the cap on a hook that takes no tokens: the cap, enforced, is the rate.
    expect(hookSideRates({ total: { bps: 500, text: '' }, rules: [rule({ on: 'sell', bps: 500 })] }, { caps: { maxBuyBps: 1, maxSellBps: 300 }, tokens: false })?.sell).toEqual({ bps: 300, upTo: true });
    // No reading yet: the caps alone; a side capped at 0 says nothing.
    expect(hookSideRates(null, { caps: { maxBuyBps: 800, maxSellBps: 0 } })).toEqual({ buy: { bps: 800, upTo: true }, sell: null });
    // The summary says less than the cap: the cap, "up to".
    expect(hookSideRates({ total: { bps: 100, text: '' }, summary: { buys: '1% of each buy.', sells: '1% of each sell.' } }, { caps: CAPS, tokens: false })).toEqual({ buy: { bps: 100, upTo: false }, sell: { bps: 300, upTo: true } });
  });
});
