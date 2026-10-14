/**
 * hook.json (docs/workshop.md "A hook's SOL cut"): a SOL-cut hook's caps read back in their normal form;
 * every bound refused with one sentence (the buy cap above 0, as the launchpad's `QuoteCut::valid`
 * holds it); the canonical text the approval hashes; the caps in plain words, with what a trader
 * pays once Bordrless's share is on top.
 */
import { describe, expect, it } from 'vitest';
import { HOOK_DECLARATION_LIMITS, HOOK_FILE, canonicalHookJson, hookDeclarationOf, hookDeclarationOfFiles, hookDeclarationWords, parseHookDeclaration, quoteCutDetails, quoteCutPaidBps, quoteCutWords } from './hookDeclaration.ts';

/** A hook that takes up to 8% of a buy's SOL by tiers of the buy, and nothing on sells. */
const TIERED_HOOK_JSON = '{"version":1,"quoteCut":{"maxBuyBps":800,"maxSellBps":0}}\n';

describe('parseHookDeclaration', () => {
  it('reads a SOL-cut hook’s caps in their normal form', () => {
    expect(parseHookDeclaration(TIERED_HOOK_JSON)).toEqual({ ok: true, declaration: { version: 1, quoteCut: { maxBuyBps: 800, maxSellBps: 0 } } });
    // Written any way, with spaces and its keys in another order, it is the same declaration.
    expect(parseHookDeclaration('{\n  "quoteCut": { "maxSellBps": 0, "maxBuyBps": 800 },\n  "version": 1\n}')).toEqual(parseHookDeclaration(TIERED_HOOK_JSON));
    expect(parseHookDeclaration('{"version":1,"quoteCut":{"maxBuyBps":1000,"maxSellBps":1000}}')).toMatchObject({ ok: true, declaration: { quoteCut: { maxBuyBps: 1_000, maxSellBps: 1_000 } } });
    expect(parseHookDeclaration('{"version":1,"quoteCut":{"maxBuyBps":1,"maxSellBps":300}}')).toMatchObject({ ok: true });
    expect(HOOK_FILE).toBe('hook.json');
  });

  it('refuses each bound with one sentence naming the file', () => {
    const problem = (text: string): string => {
      const parsed = parseHookDeclaration(text);
      if (parsed.ok) throw new Error(`taken: ${text}`);
      return parsed.problem;
    };
    const cut = (q: string): string => problem(`{"version":1,"quoteCut":${q}}`);
    expect(problem('{"version":2,"quoteCut":{"maxBuyBps":800,"maxSellBps":0}}')).toBe('hook.json: version is 1, the only one there is.');
    expect(problem('{"version":1}')).toMatch(/^hook\.json: quoteCut is required/);
    expect(problem('{"version":1,"quoteCut":{"maxBuyBps":800,"maxSellBps":0},"fee":1}')).toBe('hook.json: the file has no field "fee" (it takes version, quoteCut).');
    expect(problem('[1]')).toBe('hook.json: the file is one object.');
    expect(cut('{"maxBuyBps":800}')).toMatch(/maxSellBps is required/);
    expect(cut('{"maxSellBps":0}')).toMatch(/maxBuyBps is required/);
    expect(cut('{"maxBuyBps":800,"maxSellBps":0,"min":1}')).toMatch(/quoteCut has no field "min"/);
    // The launchpad asks on every buy: a buy cap of 0 is refused there (`InvalidQuoteCut`), so here too, whatever the sell cap.
    expect(cut('{"maxBuyBps":0,"maxSellBps":500}')).toMatch(/^hook\.json: quoteCut\.maxBuyBps is a whole number of basis points from 1 to 1,000 \(10%\): the launchpad asks the hook on every buy/);
    expect(cut('{"maxBuyBps":0,"maxSellBps":0}')).toMatch(/maxBuyBps .* from 1 to 1,000/);
    for (const bad of ['1001', '799.5', '"800"', '-1', 'null', 'true']) expect(cut(`{"maxBuyBps":${bad},"maxSellBps":0}`)).toMatch(/maxBuyBps is a whole number/);
    for (const bad of ['1001', '0.5', '"0"', '-1']) expect(cut(`{"maxBuyBps":800,"maxSellBps":${bad}}`)).toMatch(/maxSellBps is a whole number of basis points from 0 to 1,000/);
    expect(problem('{"version":1,')).toMatch(/^hook\.json is not JSON/);
    expect(problem(`{"version":1,"quoteCut":{"maxBuyBps":800,"maxSellBps":0}}${' '.repeat(HOOK_DECLARATION_LIMITS.bytes)}`)).toMatch(/^hook\.json is at most 1,024 bytes/);
    expect(hookDeclarationOf(null)).toEqual({ ok: false, problem: 'hook.json: the file is one object.' });
  });

  it('hashes the same declaration the same however it was written', () => {
    const a = parseHookDeclaration(TIERED_HOOK_JSON);
    const b = parseHookDeclaration('{ "quoteCut": { "maxSellBps": 0, "maxBuyBps": 800 }, "version": 1 }');
    if (!a.ok || !b.ok) throw new Error('not read');
    expect(canonicalHookJson(a.declaration)).toBe('{"quoteCut":{"maxBuyBps":800,"maxSellBps":0},"version":1}');
    expect(canonicalHookJson(b.declaration)).toBe(canonicalHookJson(a.declaration));
  });

  it('is found among a source’s files beside src/, and only there', () => {
    const lib = { path: 'src/lib.rs', content: '' };
    expect(hookDeclarationOfFiles([lib, { path: HOOK_FILE, content: TIERED_HOOK_JSON }])).toEqual({ version: 1, quoteCut: { maxBuyBps: 800, maxSellBps: 0 } });
    expect(hookDeclarationOfFiles([lib])).toBeNull();
    expect(hookDeclarationOfFiles([lib, { path: 'src/hook.json', content: TIERED_HOOK_JSON }])).toBeNull();
    expect(hookDeclarationOfFiles([lib, { path: HOOK_FILE, content: '{}' }])).toBeNull();
  });
});

describe('the SOL cut in plain words', () => {
  it('says the caps, what a trader pays with Bordrless’s share on top, and who pays none', () => {
    expect(hookDeclarationWords({ version: 1, quoteCut: { maxBuyBps: 800, maxSellBps: 0 } })).toBe('Takes up to 8% of a buy’s SOL, as its quote_cut answers each buy, and nothing on sells; it goes to the creator fee.');
    expect(quoteCutWords({ maxBuyBps: 700, maxSellBps: 250 })).toBe('Takes up to 7% of a buy’s SOL and up to 2.5% of a sell’s, as its quote_cut answers each trade; it goes to the creator fee.');
    expect(quoteCutDetails({ maxBuyBps: 800, maxSellBps: 0 })[0]).toBe('Bordrless’s 25% is charged on it as on the creator fee, so a trader pays up to 10% of a buy.');
    expect(quoteCutDetails({ maxBuyBps: 1_000, maxSellBps: 1_000 })[0]).toMatch(/up to 12\.5% of a buy and 12\.5% of a sell\.$/);
    expect([quoteCutPaidBps(800), quoteCutPaidBps(1_000), quoteCutPaidBps(1)]).toEqual([1_000, 1_250, 2]);
  });
});
