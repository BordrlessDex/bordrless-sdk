/**
 * keeper.json (docs/scripts.md "What a script may ask the keeper for"): Whale Bait's declaration and
 * Lossback's written in the schema and read back in their normal form; every bound refused with one
 * sentence; the canonical text the approval hashes; the declaration in plain words.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP_SECS, KEEPER_FILE, KEEPER_LIMITS, canonicalKeeperJson, isBase58Key, isRaydiumPool, keeperDeclarationOf, keeperDetails, keeperLaunchTerms, keeperPerStep, keeperStepSecs, keeperWords, parseKeeperDeclaration, type KeeperDeclaration } from './keeper.ts';

/**
 * Whale Bait (F:\whale-bait, REPORT.md): every holder at 1 base unit and under 20,000,000 tokens
 * (6 decimals), whose receipt (hook data byte 1, a u32 of floor(t / 300) the hook stamps) is not of
 * the script's epoch (floor(now / epoch_secs), epoch_secs a u32 at byte 41 of its state, 300 by
 * default, a whole multiple of 300), each paid to its owner's bridged-SOL holding; 3 a step with the
 * launch pool's swap accounts (the script sells the whales' cuts), 6 without.
 */
const WHALE_BAIT_KEEPER_JSON = `{
  "version": 1,
  "holdings": {
    "minBalance": "1",
    "maxBalance": "19999999999999",
    "hookData": {
      "offset": 1,
      "width": 4,
      "compare": "ne",
      "against": { "epoch": { "secs": { "state": { "offset": 41, "width": 4 } }, "fieldUnitSecs": 300 } }
    },
    "payTo": "ownerQuoteHolding",
    "perStep": { "withSwapAccounts": 3, "withoutSwapAccounts": 6 }
  },
  "swapAccounts": true,
  "roundSecs": { "state": { "offset": 41, "width": 4 } }
}
`;

/** Lossback (the code registry's `LOSS_COVER_DECLARATION`), as far as data says it: the least holding (u64 at byte 43 of `CoverState`), the entry price (hook data byte 2, u64) above the pool's, 7 with their owners, the payout accounts, the round (u32 at byte 63). Its mirror math and its measuring rounds stay code. */
const LOSSBACK_KEEPER_JSON = `{
  "version": 1,
  "holdings": {
    "minBalance": { "state": { "offset": 43, "width": 8 } },
    "hookData": { "offset": 2, "width": 8, "compare": "gt", "against": "poolPrice" },
    "payTo": "owner",
    "perStep": { "withoutSwapAccounts": 7 }
  },
  "swapAccounts": false,
  "payouts": true,
  "roundSecs": { "state": { "offset": 63, "width": 4 } }
}`;

const declarationOf = (text: string): KeeperDeclaration => {
  const parsed = parseKeeperDeclaration(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.declaration;
};

const problemOf = (value: unknown): string => {
  const parsed = typeof value === 'string' ? parseKeeperDeclaration(value) : keeperDeclarationOf(value);
  if (parsed.ok) throw new Error(`taken: ${JSON.stringify(value)}`);
  return parsed.problem;
};

const whale = (): Record<string, unknown> => JSON.parse(WHALE_BAIT_KEEPER_JSON) as Record<string, unknown>;
const holdings = (over: Record<string, unknown>): Record<string, unknown> => ({ ...whale(), holdings: { ...(whale().holdings as object), ...over } });

describe('keeper.json', () => {
  it('reads Whale Bait’s declaration into its normal form', () => {
    const d = declarationOf(WHALE_BAIT_KEEPER_JSON);
    expect(d).toEqual({
      version: 1,
      holdings: {
        minBalance: '1',
        maxBalance: '19999999999999',
        hookData: { offset: 1, width: 4, compare: 'ne', against: { epoch: { secs: { state: { offset: 41, width: 4 } }, fieldUnitSecs: 300 } } },
        payTo: 'ownerQuoteHolding',
        perStep: { withSwapAccounts: 3, withoutSwapAccounts: 6 },
      },
      swapAccounts: true,
      hookAccounts: false,
      payouts: false,
      roundSecs: { state: { offset: 41, width: 4 } },
    });
    expect(keeperPerStep(d)).toBe(3);
    expect(keeperWords(d)).toBe('Each step brings up to 3 holders with under 20M tokens not yet paid this epoch, paid to their SOL holding.');
    expect(keeperDetails(d)).toEqual([
      'Each step also carries the launch pool’s swap accounts.',
      'Without the swap accounts a step would bring up to 6.',
      'An epoch is the 32-bit number at byte 41 of the script’s state in seconds; the hook data counts units of 300 seconds.',
      'A round of the keeper’s (what it says once a round: a wait, nobody to bring) is the 32-bit number at byte 41 of the script’s state in seconds.',
    ]);
    // The normal form is a declaration too, and reads back as itself.
    expect(declarationOf(JSON.stringify(d))).toEqual(d);
  });

  it('reads Lossback’s declaration, as far as data says it', () => {
    const d = declarationOf(LOSSBACK_KEEPER_JSON);
    expect(d).toEqual({
      version: 1,
      holdings: { minBalance: { state: { offset: 43, width: 8 } }, maxBalance: null, hookData: { offset: 2, width: 8, compare: 'gt', against: 'poolPrice' }, payTo: 'owner', perStep: { withSwapAccounts: null, withoutSwapAccounts: 7 } },
      swapAccounts: false,
      hookAccounts: false,
      payouts: true,
      roundSecs: { state: { offset: 63, width: 4 } },
    });
    expect(keeperWords(d)).toBe('Each step brings up to 7 holders with at least the balance its state sets whose price in its hook data is above the pool’s price now, paid to their wallet.');
    expect(keeperDetails(d)[0]).toBe('Each step also carries the companion’s payout accounts.');
  });

  it('says constants, epochs and holdings alone in plain words', () => {
    const constEpoch = declarationOf(JSON.stringify(holdings({ minBalance: '5000000000', maxBalance: null, hookData: { offset: 1, width: 4, compare: 'ne', against: { epoch: { secs: 300 } } } })));
    expect(keeperWords(constEpoch)).toBe('Each step brings up to 3 holders with at least 5,000 tokens not yet paid this 5-minute epoch, paid to their SOL holding.');
    const alone = declarationOf(JSON.stringify({ ...holdings({ payTo: 'none', maxBalance: '1000000', hookData: { offset: 0, width: 1, compare: 'eq', against: { const: '7' } } }), swapAccounts: false }));
    expect(keeperWords(alone)).toBe('Each step brings up to 6 holdings with at most 1 token whose hook data (bytes 0 to 0) is equal to 7.');
    const wallet = declarationOf(JSON.stringify(holdings({ payTo: 'owner', minBalance: 2, maxBalance: '20500000000000', hookData: { offset: 1, width: 4, compare: 'lt', against: { epoch: { secs: 3_600 } } } })));
    expect(keeperWords(wallet)).toBe('Each step brings up to 3 holders with at least 0.000002 tokens and at most 20.5M tokens last marked before this 1-hour epoch, paid to their wallet.');
    expect(keeperWords(declarationOf(JSON.stringify(holdings({ hookData: null, maxBalance: null }))))).toBe('Each step brings up to 3 holders, paid to their SOL holding.');
  });

  it('hashes one canonical text however the declaration was written', () => {
    const a = declarationOf(WHALE_BAIT_KEEPER_JSON);
    // The same declaration: keys in another order, amounts as numbers, the defaults written out.
    const b = declarationOf(JSON.stringify({ roundSecs: { state: { width: 4, offset: 41 } }, payouts: false, hookAccounts: false, swapAccounts: true, holdings: { perStep: { withoutSwapAccounts: 6, withSwapAccounts: 3 }, payTo: 'ownerQuoteHolding', hookData: { against: { epoch: { fieldUnitSecs: 300, secs: { state: { offset: 41, width: 4 } } } }, compare: 'ne', width: 4, offset: 1 }, maxBalance: 19_999_999_999_999, minBalance: 1 }, version: 1 }));
    expect(canonicalKeeperJson(b)).toBe(canonicalKeeperJson(a));
    expect(canonicalKeeperJson(a)).not.toMatch(/\s/);
    expect(canonicalKeeperJson(declarationOf(JSON.stringify(holdings({ minBalance: '2' }))))).not.toBe(canonicalKeeperJson(a));
  });

  it('refuses a file that is not one, with one sentence naming the field', () => {
    expect(problemOf('{ "version": 1, ')).toBe(`${KEEPER_FILE} is not JSON: check its quotes, commas and brackets (no comments, no trailing commas).`);
    expect(problemOf(`{"version":1,"x":"${'a'.repeat(KEEPER_LIMITS.bytes)}"}`)).toBe('keeper.json is at most 4,096 bytes; this one is 4,116.');
    expect(problemOf([])).toBe('keeper.json: the file is one object.');
    expect(problemOf({ ...whale(), version: 2 })).toBe('keeper.json: version is 1, the only one there is.');
    expect(problemOf({ ...whale(), extra: true })).toBe('keeper.json: the file has no field "extra" (it takes version, holdings, swapAccounts, hookAccounts, mintWritable, payouts, roundSecs, wallets, stepSecs, stateLen, initData, launcherShareBps, payoutTerms, view, pools).');
    expect(problemOf({ ...whale(), holdings: undefined })).toBe('keeper.json: holdings is required: which holdings each step brings.');
    expect(problemOf({ ...whale(), swapAccounts: 'yes' })).toBe('keeper.json: swapAccounts is true or false.');
    expect(problemOf({ ...whale(), hookAccounts: 1 })).toBe('keeper.json: hookAccounts is true or false.');
    expect(problemOf({ ...whale(), mintWritable: 'yes' })).toBe('keeper.json: mintWritable is true or false.');
    expect(problemOf(holdings({ minBalance: '0' }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number of base units from 1 to 18,446,744,073,709,551,615/);
    expect(problemOf(holdings({ minBalance: '18446744073709551616' }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number/);
    expect(problemOf(holdings({ minBalance: 1.5 }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number/);
    expect(problemOf(holdings({ minBalance: 2 ** 60 }))).toMatch(/written as a string of digits/);
    expect(problemOf(holdings({ minBalance: undefined }))).toBe('keeper.json: holdings.minBalance is required: the least balance that counts, base units.');
    expect(problemOf(holdings({ minBalance: '5', maxBalance: '4' }))).toBe('keeper.json: holdings.maxBalance is at least holdings.minBalance.');
    expect(problemOf(holdings({ minBalance: { state: { offset: 10_237, width: 4 } } }))).toBe('keeper.json: holdings.minBalance.state.offset is a whole number from 0 to 10,236: where the field starts in the script’s state.');
    expect(problemOf(holdings({ minBalance: { state: { offset: 8, width: 3 } } }))).toBe('keeper.json: holdings.minBalance.state.width is 1, 2, 4 or 8: the field’s bytes, unsigned little-endian.');
    expect(problemOf(holdings({ minBalance: { field: 8 } }))).toBe('keeper.json: holdings.minBalance has no field "field" (it takes state).');
    expect(problemOf(holdings({ payTo: 'treasury' }))).toBe('keeper.json: holdings.payTo is one of none, owner, ownerQuoteHolding, ownerTokenAccount: where each holding is paid.');
    expect(problemOf(holdings({ perStep: { withSwapAccounts: 17 } }))).toBe('keeper.json: holdings.perStep.withSwapAccounts is a whole number from 1 to 16.');
    expect(problemOf(holdings({ perStep: { withoutSwapAccounts: 6 } }))).toBe('keeper.json: holdings.perStep.withSwapAccounts is required while swapAccounts is true.');
    expect(problemOf({ ...whale(), swapAccounts: false, holdings: { ...(whale().holdings as object), perStep: { withSwapAccounts: 3 } } })).toBe('keeper.json: holdings.perStep.withoutSwapAccounts is required while swapAccounts is false.');
    expect(problemOf({ ...whale(), payouts: true })).toBe('keeper.json: with payouts the companion pays each holding’s owner itself: holdings.payTo is owner (or none for a step that only measures).');
    expect(problemOf({ ...whale(), roundSecs: 5 })).toBe('keeper.json: roundSecs is a whole number of seconds from 10 to 31,536,000 (a year), or { "state": { "offset", "width" } }.');
  });

  it('reads the wallets a step brings for wallet answers, with holdings or alone, and leaves them out of the normal form when none', () => {
    const TEAM = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const alone = declarationOf(JSON.stringify({ version: 1, swapAccounts: false, wallets: [TEAM, { state: { offset: 40 } }] }));
    expect(alone).toEqual({ version: 1, holdings: null, swapAccounts: false, hookAccounts: false, payouts: false, roundSecs: null, wallets: [TEAM, { state: { offset: 40 } }] });
    expect(declarationOf(JSON.stringify(alone))).toEqual(alone);
    expect(keeperPerStep(alone)).toBe(0);
    expect(keeperWords(alone)).toBe('Each step brings up to 2 wallets the script may pay SOL to, while its launcher allows wallet payouts.');
    expect(keeperDetails(alone)).toEqual([`The wallets (with the companion’s payout terms): ${TEAM}, the public key at byte 40 of the script’s state.`]);
    // Beside holdings: both said.
    const both = declarationOf(JSON.stringify({ ...holdings({ hookData: null, maxBalance: null }), wallets: [TEAM] }));
    expect(both.holdings?.payTo).toBe('ownerQuoteHolding');
    expect(keeperWords(both)).toBe('Each step brings up to 3 holders, paid to their SOL holding. Each step brings up to 1 wallet the script may pay SOL to, while its launcher allows wallet payouts.');
    // None (absent, null or empty): no field, so a declaration approved before wallets hashes as it did.
    const whaleD = declarationOf(WHALE_BAIT_KEEPER_JSON);
    expect('wallets' in whaleD).toBe(false);
    for (const none of [null, []]) expect(canonicalKeeperJson(declarationOf(JSON.stringify({ ...whale(), wallets: none })))).toBe(canonicalKeeperJson(whaleD));
    expect(canonicalKeeperJson(both)).not.toBe(canonicalKeeperJson(declarationOf(JSON.stringify(holdings({ hookData: null, maxBalance: null })))));
    // Refused: no holdings and no wallets, too many, not a key, the default key or a program, twice, out of the state.
    expect(problemOf({ version: 1, swapAccounts: false, holdings: null })).toMatch(/^keeper\.json: holdings is \{/);
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [] })).toBe('keeper.json: holdings is required: which holdings each step brings.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: Array.from({ length: KEEPER_LIMITS.wallets + 1 }, (_, i) => ({ state: { offset: 32 * i } })) })).toBe('keeper.json: wallets is a list of at most 12 wallets, each an address ("<base58>") or { "state": { "offset" } }: a public key in the script’s state.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: TEAM })).toMatch(/^keeper\.json: wallets is a list of at most 12/);
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [TEAM.slice(0, -1) + '0'] })).toBe('keeper.json: wallets[0] is an address in base58 (32 bytes).');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: ['1111111111111111111111111111111111'] })).toBe('keeper.json: wallets[0] is an address in base58 (32 bytes).');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [TEAM, '11111111111111111111111111111111'] })).toBe('keeper.json: wallets[1] is the default key or a Bordrless program: the companion never pays it.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: ['6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo'] })).toMatch(/wallets\[0\] is the default key or a Bordrless program/);
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [TEAM, TEAM] })).toBe('keeper.json: wallets[1] is named twice.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [{ state: { offset: 8 } }, { state: { offset: 8 } }] })).toBe('keeper.json: wallets[1] is named twice.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [{ state: { offset: 10_209 } }] })).toBe('keeper.json: wallets[0].state.offset is a whole number from 0 to 10,208: where a public key (32 bytes) starts in the script’s state.');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [{ state: { offset: 8, width: 32 } }] })).toBe('keeper.json: wallets[0].state has no field "width" (it takes offset).');
    expect(problemOf({ version: 1, swapAccounts: false, wallets: [7] })).toBe('keeper.json: wallets[0] is an address ("<base58>") or { "state": { "offset" } }.');
  });

  it('reads a base58 public key as 32 bytes exactly', () => {
    expect(isBase58Key('11111111111111111111111111111111')).toBe(true);
    expect(isBase58Key('6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo')).toBe(true);
    expect(isBase58Key('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isBase58Key('1111111111111111111111111111111')).toBe(false);
    expect(isBase58Key('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(isBase58Key('0OIl1111111111111111111111111111')).toBe(false);
  });

  it('holds the hook-data filter to the 64 bytes a holding keeps and to what it can be compared with', () => {
    const filter = (f: Record<string, unknown>): Record<string, unknown> => holdings({ hookData: { offset: 1, width: 4, compare: 'ne', against: 'poolPrice', ...f } });
    expect(declarationOf(JSON.stringify(filter({ offset: 56, width: 8 }))).holdings!.hookData).toEqual({ offset: 56, width: 8, compare: 'ne', against: 'poolPrice' });
    expect(problemOf(filter({ offset: 57, width: 8 }))).toBe('keeper.json: holdings.hookData.offset is a whole number from 0 to 56: a holding keeps 64 bytes of hook data.');
    expect(problemOf(filter({ width: 16 }))).toBe('keeper.json: holdings.hookData.width is 1, 2, 4 or 8: the field’s bytes, unsigned little-endian.');
    expect(problemOf(filter({ compare: 'neq' }))).toBe('keeper.json: holdings.hookData.compare is one of eq, ne, lt, lte, gt, gte.');
    expect(problemOf(filter({ against: 'spot' }))).toBe('keeper.json: holdings.hookData.against is "poolPrice", { "const": "<base units>" } or { "epoch": { "secs", "fieldUnitSecs" } }.');
    expect(problemOf(filter({ against: { const: '1', epoch: { secs: 300 } } }))).toMatch(/holdings\.hookData\.against is "poolPrice"/);
    expect(problemOf(filter({ against: { const: { state: { offset: 0, width: 8 } } } }))).toBe('keeper.json: holdings.hookData.against.const is a string of digits: a constant, not a field of the state.');
    expect(problemOf(filter({ against: { epoch: { secs: 300, fieldUnitSecs: 0 } } }))).toMatch(/^keeper\.json: holdings\.hookData\.against\.epoch\.fieldUnitSecs is a whole number of seconds from 1/);
    expect(problemOf(filter({ against: { epoch: { secs: 300, every: 2 } } }))).toBe('keeper.json: holdings.hookData.against.epoch has no field "every" (it takes secs, fieldUnitSecs).');
    expect(problemOf(filter({ mask: 1 }))).toBe('keeper.json: holdings.hookData has no field "mask" (it takes offset, width, compare, against).');
    expect(declarationOf(JSON.stringify(filter({ against: { const: '0' } }))).holdings!.hookData?.against).toEqual({ const: '0' });
    expect(declarationOf(JSON.stringify(filter({ against: { epoch: { secs: 300 } } }))).holdings!.hookData?.against).toEqual({ epoch: { secs: 300, fieldUnitSecs: null } });
  });

  it('takes the launcher’s fixed share of the fee from the builder (launcherShareBps, 0 to 9,500; LiquidityTek, 15 Oct 2026), left out of the normal form when absent', () => {
    const fixed = declarationOf(JSON.stringify({ ...whale(), launcherShareBps: 2_500 }));
    expect(fixed.launcherShareBps).toBe(2_500);
    expect(keeperLaunchTerms(fixed).launcherShareBps).toBe(2_500);
    expect(keeperLaunchTerms(declarationOf(JSON.stringify(whale()))).launcherShareBps).toBeNull();
    expect(canonicalKeeperJson(declarationOf(JSON.stringify(whale())))).not.toContain('launcherShareBps');
    expect(keeperDetails(fixed)).toContain('Every launch keeps 25% of each trade’s fee for the launcher, fixed; the pot gets the rest.');
    expect(declarationOf(JSON.stringify({ ...whale(), launcherShareBps: 9_500 })).launcherShareBps).toBe(9_500);
    expect(problemOf({ ...whale(), launcherShareBps: 9_501 })).toContain('launcherShareBps is the launcher’s share');
    expect(problemOf({ ...whale(), launcherShareBps: 25.5 })).toContain('launcherShareBps');
  });

  it('takes how often a step runs from the builder (stepSecs, 10 s to a day), left out of the normal form when absent', () => {
    const fast = declarationOf(JSON.stringify({ ...whale(), stepSecs: 10 }));
    expect(fast.stepSecs).toBe(10);
    expect(canonicalKeeperJson(fast)).toContain('"stepSecs":10');
    // A declaration without it hashes as it did before the field.
    expect(canonicalKeeperJson(declarationOf(WHALE_BAIT_KEEPER_JSON))).not.toContain('stepSecs');
    expect(problemOf({ ...whale(), stepSecs: 5 })).toBe('keeper.json: stepSecs is how often a step runs: a whole number of seconds from 10 to 86,400 (a day).');
    expect(problemOf({ ...whale(), stepSecs: 30.5 })).toMatch(/^keeper.json: stepSecs is how often a step runs/);
    expect(keeperDetails(fast)).toContain('A step runs every 10 seconds.');
  });

  it('works out a step: the declared one, else a thirtieth of a fixed round within the bounds, else a minute', () => {
    expect(keeperStepSecs({ stepSecs: 45, roundSecs: 300 })).toBe(45);
    expect(keeperStepSecs({ roundSecs: 300 })).toBe(10);
    expect(keeperStepSecs({ roundSecs: 120 })).toBe(10);
    expect(keeperStepSecs({ roundSecs: 3_600 })).toBe(120);
    expect(keeperStepSecs({ roundSecs: { state: { offset: 41, width: 4 } } })).toBe(DEFAULT_STEP_SECS);
    expect(keeperStepSecs(null)).toBe(DEFAULT_STEP_SECS);
    expect(keeperLaunchTerms(declarationOf(WHALE_BAIT_KEEPER_JSON))).toEqual({ stepSecs: DEFAULT_STEP_SECS, wallets: false, stateLen: 1_024, initData: '', payouts: false, launcherShareBps: null, payoutTerms: null });
    expect(keeperLaunchTerms({ ...declarationOf(WHALE_BAIT_KEEPER_JSON), roundSecs: 300, wallets: ['11111111111111111111111111111111'] })).toEqual({ stepSecs: 10, wallets: true, stateLen: 1_024, initData: '', payouts: false, launcherShareBps: null, payoutTerms: null });
  });
});

describe('the payout terms a script declares (payoutTerms, 16 Oct 2026)', () => {
  it('takes the four whole numbers within the companion program’s bounds, carries them to the launch terms and the details, and refuses the rest', () => {
    const terms = { stepBps: 1_000, holdingBps: 10_000, windowBps: 2_500, windowSecs: 86_400 };
    const d = declarationOf(JSON.stringify({ ...whale(), payoutTerms: terms }));
    expect(d.payoutTerms).toEqual(terms);
    expect(keeperLaunchTerms(d).payoutTerms).toEqual(terms);
    expect(keeperLaunchTerms(declarationOf(JSON.stringify(whale()))).payoutTerms).toBeNull();
    expect(canonicalKeeperJson(declarationOf(JSON.stringify(whale())))).not.toContain('payoutTerms');
    expect(keeperDetails(d)).toContain('Its payout terms: a step pays at most 10% of the pot, one holding or wallet at most 100% of a step, and a window of 86,400 seconds at most 25% of the pot.');
    for (const bad of [{ ...terms, stepBps: 0 }, { ...terms, holdingBps: 10_001 }, { ...terms, windowSecs: 5 }, { ...terms, windowSecs: 1.5 }, { stepBps: 1_000 }, 7]) expect(problemOf({ ...whale(), payoutTerms: bad })).toContain('payoutTerms');
    expect(problemOf({ ...whale(), payoutTerms: { ...terms, extra: 1 } })).toBe('keeper.json: payoutTerms has no field "extra" (it takes stepBps, holdingBps, windowBps, windowSecs).');
  });

describe('mintWritable', () => {
  it('is off unless set, kept only when true, and said in the details', () => {
    const off = keeperDeclarationOf(whale());
    const on = keeperDeclarationOf({ ...whale(), mintWritable: true });
    expect(on.ok).toBe(true);
    expect(off.ok && off.declaration.mintWritable).toBeFalsy();
    expect(on.ok && on.declaration.mintWritable).toBe(true);
    if (on.ok) expect(keeperDetails(on.declaration).join(' ')).toContain('mint is passed writable');
  });
});

});

describe('view (the figures a coin’s page shows live, 16 Oct 2026)', () => {
  const base = { version: 1, holdings: null, swapAccounts: false, wallets: ['HZ32BY2FGHJrFDxjJRPNncW8BsWNxqxMqQPhFTypwBJ6'] };
  const problemOf = (v: unknown): string | null => { const p = keeperDeclarationOf(v); return p.ok ? null : p.problem; };
  it('reads each figure: its label, the script’s state or a hook account by its seeds, the bytes and how they read; left out of the normal form when empty', () => {
    const view = [
      { label: ' Round ends ', account: { hook: ['state', 'mint'] }, offset: 88, width: 8, as: 'time' },
      { label: 'Leader', account: { hook: ['state', 'mint'] }, offset: 48, width: 32, as: 'wallet' },
      { label: 'Steps', account: 'script', offset: 0, width: 4, as: 'number' },
    ];
    const p = keeperDeclarationOf({ ...base, view });
    expect(p.ok && p.declaration.view).toEqual([{ ...view[0], label: 'Round ends' }, view[1], view[2]]);
    const none = keeperDeclarationOf({ ...base, view: [] });
    expect(none.ok && 'view' in none.declaration).toBe(false);
  });
  it('refuses more than six figures, a wrong width, an unknown reading, bad seeds and a long label, each in one sentence', () => {
    const f = (over: Record<string, unknown>) => ({ ...base, view: [{ label: 'Pot', account: 'script', offset: 0, width: 8, as: 'lamports', ...over }] });
    expect(problemOf({ ...base, view: Array.from({ length: 7 }, () => ({ label: 'x', account: 'script', offset: 0, width: 8, as: 'number' })) })).toBe('keeper.json: view is a list of at most 6 figures a coin’s page shows from the script’s accounts.');
    expect(problemOf(f({ width: 3 }))).toBe('keeper.json: view[0].width is the figure’s bytes: 1, 2, 4 or 8 (32 for a wallet, with "as": "wallet").');
    expect(problemOf(f({ as: 'wallet', width: 8 }))).toBe('keeper.json: view[0].width is 32 for a wallet.');
    expect(problemOf(f({ as: 'money' }))).toBe('keeper.json: view[0].as is how the figure reads: number, lamports, tokens, bps, time, secs, wallet, flag.');
    expect(problemOf(f({ account: { hook: [] } }))).toBe('keeper.json: view[0].account.hook is the seeds of the hook’s account under its program: 1 to 4 strings of at most 32 bytes, "mint" for the coin’s mint.');
    expect(problemOf(f({ label: 'x'.repeat(25) }))).toBe('keeper.json: view[0].label is the figure’s name, 1 to 24 characters.');
    expect(problemOf(f({ offset: -1 }))).toBe('keeper.json: view[0].offset is where the figure’s bytes start: a whole number from 0 to 10,240.');
  });
});

describe('pools (DEX pools a step brings beside the launch pool, 17 Oct 2026)', () => {
  const WBORDR = 'APpT4aqDoXAVz6S9wVWCJdqayFcs4tvfj5jToffVncwv';
  const pools = (list: unknown) => keeperDeclarationOf({ ...whale(), pools: list });

  it('reads each pool by its two mints and fee tier (25 bps and no liquidity by default, bridged SOL as "sol"), says it in the details, and leaves it out of the normal form when empty', () => {
    const r = pools([{ base: 'coin', quote: WBORDR, liquidity: true }, { base: WBORDR, quote: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i', feeBps: 100 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declaration.pools).toEqual([{ base: 'coin', quote: WBORDR, feeBps: 25, liquidity: true }, { base: WBORDR, quote: 'sol', feeBps: 100, liquidity: false }]);
    const details = keeperDetails(r.declaration).join(' ');
    expect(details).toContain('the DEX pool of the coin and the mint APpT…ncwv at a 0.25% LP fee, with its LP mint and LP holdings');
    expect(details).toContain('the DEX pool of the mint APpT…ncwv and SOL at a 1% LP fee.');
    expect(canonicalKeeperJson(r.declaration)).toContain('"pools":[{"base":"coin","feeBps":25,"liquidity":true,"quote":"APpT');
    const none = pools([]);
    expect(none.ok && 'pools' in none.declaration).toBe(false);
  });

  it('refuses SOL as a base, the launch pool, a pool of one mint, a fee past the DEX’s most, a bad mint, a repeat, an unknown field and more than three, each in one sentence', () => {
    const problem = (list: unknown): string => {
      const r = pools(list);
      return r.ok ? '' : r.problem;
    };
    expect(problem([{ base: 'sol', quote: 'coin' }])).toContain('never "sol"');
    expect(problem([{ base: 'coin', quote: 'sol' }])).toContain('launch pool');
    expect(problem([{ base: WBORDR, quote: WBORDR }])).toContain('the same mint');
    // Any fee the DEX takes, not only the site's tiers (a builder's wBORDR/SOL pool is at 30 bps, 17 Oct 2026).
    expect(problem([{ base: WBORDR, quote: 'sol', feeBps: 30 }])).toBe('');
    expect(problem([{ base: 'coin', quote: WBORDR, feeBps: 9_001 }])).toContain('0 to 9,000');
    expect(problem([{ base: 'coin', quote: WBORDR, feeBps: 2.5 }])).toContain('whole number');
    expect(problem([{ base: 'coin', quote: 'nope' }])).toContain('base58');
    expect(problem([{ base: 'coin', quote: WBORDR }, { base: 'coin', quote: WBORDR, liquidity: true }])).toContain('named twice');
    expect(problem([{ base: 'coin', quote: WBORDR, swap: true }])).toContain('no field "swap"');
    expect(problem([1, 2, 3, 4])).toContain('at most 3');
  });
});

/** Raydium's ZEC/WSOL concentrated-liquidity pool and wrapped Zcash (8 decimals, SPL Token), the owner's pair of 19 Oct 2026. */
const ZEC_POOL = 'GPxw5YstKrcJDe9GtD3u9myrsKAyLNy8tedsoyVDyN2b';
const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
const WSOL = 'So11111111111111111111111111111111111111112';

describe('pools: a Raydium pool (19 Oct 2026)', () => {
  const pools = (list: unknown) => keeperDeclarationOf({ ...whale(), pools: list });
  const problem = (list: unknown): string => {
    const r = pools(list);
    return r.ok ? '' : r.problem;
  };

  it('reads { raydiumClmm, buy } beside the other kinds, says it in the details, and keeps it as written in the normal form', () => {
    const r = pools([{ raydiumClmm: ZEC_POOL, buy: ZEC }, { launch: '5xpzVZYLvY7Fg29vUTgM5hJvECBZfYWVz2m8E7rJspwi' }, { raydiumClmm: 'H5L9tQ9FvBsANeotkWJWBt9SSQggfcjZG6vqFg5vzC3Q', buy: WSOL }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declaration.pools).toEqual([{ raydiumClmm: ZEC_POOL, buy: ZEC }, { launch: '5xpzVZYLvY7Fg29vUTgM5hJvECBZfYWVz2m8E7rJspwi' }, { raydiumClmm: 'H5L9tQ9FvBsANeotkWJWBt9SSQggfcjZG6vqFg5vzC3Q', buy: WSOL }]);
    expect(isRaydiumPool(r.declaration.pools![0]!)).toBe(true);
    expect(isRaydiumPool(r.declaration.pools![1]!)).toBe(false);
    const details = keeperDetails(r.declaration);
    expect(details).toContain('Each step also brings the Raydium pool GPxw…yN2b (a swap buying A7bd…QXaS for the companion address, with its price-range accounts).');
    expect(details).toContain('Each step also brings the Raydium pool H5L9…zC3Q (a swap buying wrapped SOL for the companion address, with its price-range accounts).');
    expect(canonicalKeeperJson(r.declaration)).toContain(`"pools":[{"buy":"${ZEC}","raydiumClmm":"${ZEC_POOL}"}`);
    // The normal form reads back as itself.
    expect(keeperDeclarationOf(JSON.parse(JSON.stringify(r.declaration)))).toEqual(r);
  });

  it('refuses a pool or a mint that is not a key, the coin, a program, bridged SOL, a missing buy, a repeat, an unknown field and a fourth pool, each in one sentence', () => {
    expect(problem([{ raydiumClmm: 'nope', buy: ZEC }])).toBe('keeper.json: pools[0].raydiumClmm is the Raydium pool’s address, in base58.');
    expect(problem([{ raydiumClmm: '6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo', buy: ZEC }])).toContain('not the default key, a Bordrless program or a mint');
    expect(problem([{ raydiumClmm: ZEC_POOL }])).toBe('keeper.json: pools[0].buy is required: the mint the script buys on that pool, one of its two.');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: 'coin' }])).toContain('pools[0].buy is never the coin');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: 'zec' }])).toContain('pools[0].buy is an SPL mint’s address in base58');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i' }])).toContain('not the default key, a Bordrless program or Bordrless’s bridged SOL');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: '11111111111111111111111111111111' }])).toContain('not the default key');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: ZEC_POOL }])).toContain('not the pool itself');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: ZEC }, { raydiumClmm: ZEC_POOL, buy: WSOL }])).toBe('keeper.json: pools[1] is named twice.');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: ZEC, minOut: 1 }])).toContain('pools[0] has no field "minOut"');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: ZEC, launch: ZEC }])).toContain('pools[0] has no field "launch"');
    expect(problem([{ raydiumClmm: ZEC_POOL, buy: ZEC }, { launch: ZEC }, { base: 'coin', quote: ZEC }, { raydiumClmm: 'H5L9tQ9FvBsANeotkWJWBt9SSQggfcjZG6vqFg5vzC3Q', buy: WSOL }])).toContain('at most 3');
  });
});

describe('holdings paid in an SPL token (payTo ownerTokenAccount, 19 Oct 2026)', () => {
  const zec = (over: Record<string, unknown> = {}): Record<string, unknown> => holdings({ hookData: null, maxBalance: null, payTo: 'ownerTokenAccount', payMint: ZEC, ...over });

  it('reads payMint with ownerTokenAccount, says it, and leaves it out of every other declaration’s normal form', () => {
    const d = declarationOf(JSON.stringify(zec()));
    expect(d.holdings).toEqual({ minBalance: '1', maxBalance: null, hookData: null, payTo: 'ownerTokenAccount', payMint: ZEC, perStep: { withSwapAccounts: 3, withoutSwapAccounts: 6 } });
    expect(keeperWords(d)).toBe('Each step brings up to 3 holders, paid to their A7bd…QXaS token account.');
    expect(keeperWords(declarationOf(JSON.stringify(zec({ payMint: WSOL }))))).toBe('Each step brings up to 3 holders, paid to their wrapped SOL token account.');
    expect(canonicalKeeperJson(d)).toContain(`"payMint":"${ZEC}"`);
    expect(declarationOf(JSON.stringify(d))).toEqual(d);
    // Whale Bait's normal form and hash as before: no payMint field.
    const whaleD = declarationOf(WHALE_BAIT_KEEPER_JSON);
    expect('payMint' in whaleD.holdings!).toBe(false);
    expect(canonicalKeeperJson(whaleD)).not.toContain('payMint');
    expect(canonicalKeeperJson(declarationOf(JSON.stringify(holdings({ payMint: null }))))).toBe(canonicalKeeperJson(whaleD));
  });

  it('refuses ownerTokenAccount without payMint, payMint with any other payTo, a bad mint, and payouts beside it', () => {
    expect(problemOf(zec({ payMint: undefined }))).toBe('keeper.json: holdings.payMint is required with payTo ownerTokenAccount: the SPL mint each holder is paid in.');
    expect(problemOf(holdings({ payMint: ZEC }))).toBe('keeper.json: holdings.payMint goes only with payTo ownerTokenAccount: it names the mint of the token account each holder is paid in.');
    expect(problemOf(zec({ payMint: 'zec' }))).toContain('holdings.payMint is an SPL mint’s address in base58');
    expect(problemOf(zec({ payMint: 'coin' }))).toContain('holdings.payMint is never the coin');
    expect(problemOf(zec({ payMint: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i' }))).toContain('Bordrless’s bridged SOL');
    expect(problemOf({ ...zec(), swapAccounts: false, payouts: true })).toBe('keeper.json: with payouts the companion pays each holding’s owner itself: holdings.payTo is owner (or none for a step that only measures).');
    expect(problemOf(zec({ payTo: 'ownerTokenAccount', payMint: ZEC, extra: 1 }))).toBe('keeper.json: holdings has no field "extra" (it takes minBalance, maxBalance, hookData, payTo, payMint, perStep).');
  });
});

describe('pools: another coin’s launch pool (18 Oct 2026)', () => {
  const BCAT = '5xpzVZYLvY7Fg29vUTgM5hJvECBZfYWVz2m8E7rJspwi';
  const WBORDR = 'APpT4aqDoXAVz6S9wVWCJdqayFcs4tvfj5jToffVncwv';
  const pools = (list: unknown) => keeperDeclarationOf({ ...whale(), pools: list });

  it('reads { launch, to } beside plain pools, says it in the details, and keeps only what was said in the normal form', () => {
    const r = pools([{ launch: BCAT, to: 'launcher' }, { base: 'coin', quote: WBORDR, liquidity: true }, { launch: WBORDR }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declaration.pools).toEqual([{ launch: BCAT, to: 'launcher' }, { base: 'coin', quote: WBORDR, feeBps: 25, liquidity: true }, { launch: WBORDR }]);
    const details = keeperDetails(r.declaration).join(' ');
    expect(details).toContain('the launch pool of the coin 5xpz…spwi (its launchpad swap accounts for the companion address), with the launcher’s holding of that coin for the swap’s recipient.');
    expect(details).toContain('the launch pool of the coin APpT…ncwv (its launchpad swap accounts for the companion address).');
    expect(canonicalKeeperJson(r.declaration)).toContain('"pools":[{"launch":"5xpz');
  });

  it('refuses the coin’s own launch pool, a bad mint, SOL or a program, a repeat, a wrong "to" and an unknown field, each in one sentence', () => {
    const problem = (list: unknown): string => {
      const r = pools(list);
      return r.ok ? '' : r.problem;
    };
    expect(problem([{ launch: 'coin' }])).toContain('never the coin’s own launch pool');
    expect(problem([{ launch: 'nope' }])).toContain('in base58');
    expect(problem([{ launch: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i' }])).toContain('not SOL');
    expect(problem([{ launch: BCAT }, { launch: BCAT, to: 'launcher' }])).toContain('named twice');
    expect(problem([{ launch: BCAT, to: 'holders' }])).toContain('"launcher"');
    expect(problem([{ launch: BCAT, liquidity: true }])).toContain('no field "liquidity"');
  });
});
