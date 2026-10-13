/** Payees and wallet payouts as a launch request names them (2026-10-13, docs/payees-and-wallet-payouts.md): read, then held to the companion program's rules in the launch form's words. */
import { describe, expect, it } from 'vitest';
import { MAX_PAYEES, NO_RULES, payeesLeaveBps, payeesProblem, payeesRequestOf, scriptProblem, scriptRequestOf, walletPayoutsProblem } from './policy.ts';

const W = ['7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'];
const LAUNCHER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
const split = { beneficiaryBps: 4_000 };

describe('payees in a launch request', () => {
  it('are read from companion.payees: none when absent, null or empty; malformed unless each is an address and a whole number', () => {
    expect(payeesRequestOf({ split })).toBeNull();
    expect(payeesRequestOf({ split, payees: null })).toBeNull();
    expect(payeesRequestOf({ split, payees: [] })).toBeNull();
    expect(payeesRequestOf('x')).toBeNull();
    expect(payeesRequestOf({ split, payees: [{ wallet: W[0], bps: 2_500, extra: 1 }] })).toEqual([{ wallet: W[0], bps: 2_500 }]);
    for (const bad of [{}, 'x', [1], [{ wallet: W[0] }], [{ wallet: 'not an address', bps: 1 }], [{ wallet: W[0], bps: '100' }], [{ wallet: W[0], bps: 0.5 }]]) expect(payeesRequestOf({ split, payees: bad }), JSON.stringify(bad)).toBe('malformed');
  });

  it('take 1 to 10 wallets, each 0.01% to 100% of the launcher’s part, 100% in all at most', () => {
    expect(payeesProblem([{ wallet: W[0]!, bps: 1 }], split, LAUNCHER)).toBeNull();
    expect(payeesProblem([{ wallet: W[0]!, bps: 6_000 }, { wallet: W[1]!, bps: 4_000 }], split, LAUNCHER)).toBeNull();
    expect(payeesProblem([], split, LAUNCHER)).toBe(`Up to ${MAX_PAYEES} wallets can share your part.`);
    expect(payeesProblem([{ wallet: W[0]!, bps: 0 }], split, LAUNCHER)).toBe('Each wallet gets 0.01% to 100% of your part.');
    expect(payeesProblem([{ wallet: W[0]!, bps: 10_001 }], split, LAUNCHER)).toBe('Each wallet gets 0.01% to 100% of your part.');
    expect(payeesProblem([{ wallet: W[0]!, bps: 6_000 }, { wallet: W[1]!, bps: 4_001 }], split, LAUNCHER)).toBe('The wallets’ shares add up to more than 100% of your part.');
    expect(payeesLeaveBps([{ bps: 2_500 }, { bps: 1_000 }])).toBe(6_500);
    expect(payeesLeaveBps([])).toBe(10_000);
  });

  it('refuse a wallet named twice, the launcher, the default key, the companion’s own accounts, and a split with no part for the launcher', () => {
    expect(payeesProblem([{ wallet: W[0]!, bps: 100 }, { wallet: W[0]!, bps: 100 }], split, LAUNCHER)).toBe('Name each wallet once.');
    expect(payeesProblem([{ wallet: LAUNCHER, bps: 100 }], split, LAUNCHER)).toMatch(/other than your own/);
    expect(payeesProblem([{ wallet: '11111111111111111111111111111111', bps: 100 }], split, LAUNCHER)).toMatch(/not a wallet/);
    expect(payeesProblem([{ wallet: W[2]!, bps: 100 }], split, LAUNCHER, [W[2]!])).toBe('A wallet can’t be the hook’s own account.');
    expect(payeesProblem([{ wallet: W[0]!, bps: 100 }], { beneficiaryBps: 0 }, LAUNCHER)).toMatch(/leaves you none/);
  });
});

describe('wallet payouts in a launch request', () => {
  const script = { potBps: 6_000, program: W[0]!, interval: 60, initData: '', stateLen: 0 };
  const payout = { stepBps: 1_000, holdingBps: 10_000, windowBps: 2_500, windowSecs: 86_400 };

  it('read a script’s payout terms, and refuse terms that are not four whole numbers', () => {
    expect(scriptRequestOf({ script })).toEqual(script);
    expect(scriptRequestOf({ script: { ...script, payout } })).toEqual({ ...script, payout });
    expect(scriptRequestOf({ script: { ...script, payout: { ...payout, windowSecs: '60' } } })).toBe('malformed');
    expect(scriptRequestOf({ script: { ...script, payout: 'yes' } })).toBe('malformed');
  });

  it('hold the terms to the program’s bounds', () => {
    const split = { buybackBps: 0, holdersBps: 0, beneficiaryBps: 4_000 };
    expect(scriptProblem({ ...script, payout }, split, NO_RULES, 100)).toBeNull();
    for (const bad of [{ ...payout, stepBps: 0 }, { ...payout, holdingBps: 10_001 }, { ...payout, windowSecs: 9 }, { ...payout, windowSecs: 86_401 }]) expect(scriptProblem({ ...script, payout: bad }, split, NO_RULES, 100), JSON.stringify(bad)).toMatch(/payout limits/);
  });

  it('are taken only for a custom hook’s script with payout terms', () => {
    expect(walletPayoutsProblem(false, null)).toBeNull();
    expect(walletPayoutsProblem(true, { payout })).toBeNull();
    expect(walletPayoutsProblem(true, null)).toBe('Only a custom hook’s script can pay wallets.');
    expect(walletPayoutsProblem(true, {})).toBe('A script pays wallets only within payout limits: set them.');
  });
});
