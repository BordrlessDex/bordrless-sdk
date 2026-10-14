/**
 * keeper.json (docs/scripts.md "What a script may ask the keeper for"): Whale Bait's declaration and
 * Lossback's written in the schema and read back in their normal form; every bound refused with one
 * sentence; the canonical text the approval hashes; the declaration in plain words.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP_SECS, KEEPER_FILE, KEEPER_LIMITS, canonicalKeeperJson, isBase58Key, keeperDeclarationOf, keeperDetails, keeperLaunchTerms, keeperPerStep, keeperStepSecs, keeperWords, parseKeeperDeclaration, type KeeperDeclaration } from './keeper.ts';

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
    expect(problemOf({ ...whale(), extra: true })).toBe('keeper.json: the file has no field "extra" (it takes version, holdings, swapAccounts, hookAccounts, payouts, roundSecs, wallets, stepSecs, stateLen, initData).');
    expect(problemOf({ ...whale(), holdings: undefined })).toBe('keeper.json: holdings is required: which holdings each step brings.');
    expect(problemOf({ ...whale(), swapAccounts: 'yes' })).toBe('keeper.json: swapAccounts is true or false.');
    expect(problemOf({ ...whale(), hookAccounts: 1 })).toBe('keeper.json: hookAccounts is true or false.');
    expect(problemOf(holdings({ minBalance: '0' }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number of base units from 1 to 18,446,744,073,709,551,615/);
    expect(problemOf(holdings({ minBalance: '18446744073709551616' }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number/);
    expect(problemOf(holdings({ minBalance: 1.5 }))).toMatch(/^keeper\.json: holdings\.minBalance is a whole number/);
    expect(problemOf(holdings({ minBalance: 2 ** 60 }))).toMatch(/written as a string of digits/);
    expect(problemOf(holdings({ minBalance: undefined }))).toBe('keeper.json: holdings.minBalance is required: the least balance that counts, base units.');
    expect(problemOf(holdings({ minBalance: '5', maxBalance: '4' }))).toBe('keeper.json: holdings.maxBalance is at least holdings.minBalance.');
    expect(problemOf(holdings({ minBalance: { state: { offset: 10_237, width: 4 } } }))).toBe('keeper.json: holdings.minBalance.state.offset is a whole number from 0 to 10,236: where the field starts in the script’s state.');
    expect(problemOf(holdings({ minBalance: { state: { offset: 8, width: 3 } } }))).toBe('keeper.json: holdings.minBalance.state.width is 1, 2, 4 or 8: the field’s bytes, unsigned little-endian.');
    expect(problemOf(holdings({ minBalance: { field: 8 } }))).toBe('keeper.json: holdings.minBalance has no field "field" (it takes state).');
    expect(problemOf(holdings({ payTo: 'treasury' }))).toBe('keeper.json: holdings.payTo is one of none, owner, ownerQuoteHolding: where each holding is paid.');
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
    expect(keeperLaunchTerms(declarationOf(WHALE_BAIT_KEEPER_JSON))).toEqual({ stepSecs: DEFAULT_STEP_SECS, wallets: false, stateLen: 1_024, initData: '', payouts: false });
    expect(keeperLaunchTerms({ ...declarationOf(WHALE_BAIT_KEEPER_JSON), roundSecs: 300, wallets: ['11111111111111111111111111111111'] })).toEqual({ stepSecs: 10, wallets: true, stateLen: 1_024, initData: '', payouts: false });
  });
});
