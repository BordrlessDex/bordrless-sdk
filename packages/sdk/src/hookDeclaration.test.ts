/** hook.json from the SDK (docs/workshop.md "A hook's SOL cut"): the example checks as the Workshop checks it, a bad one is refused with its sentence, and a declaration saved as a file reads back the same. */
import { describe, expect, it } from 'vitest';
import { HOOK_FILE, HOOK_JSON_EXAMPLE, checkHookJson, hookJson, parseHookDeclaration } from './index.ts';

describe('checkHookJson', () => {
  it('takes the example and says it in plain words', () => {
    const checked = checkHookJson(HOOK_JSON_EXAMPLE);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.declaration).toEqual({ version: 1, quoteCut: { maxBuyBps: 800, maxSellBps: 0 } });
    expect(checked.words).toBe('Takes up to 8% of a buy’s SOL, as its quote_cut answers each buy, and nothing on sells; it goes to the creator fee.');
    expect(checked.details[0]).toBe('Bordrless’s 25% is charged on it as on the creator fee, so a trader pays up to 10% of a buy.');
    // Saved as a file, it reads back as the same declaration; its caps are what launch.createQuoteCutConfig takes.
    expect(parseHookDeclaration(hookJson(checked.declaration))).toEqual({ ok: true, declaration: checked.declaration });
    expect(HOOK_FILE).toBe('hook.json');
  });

  it('refuses what the Workshop refuses, with its sentence', () => {
    expect(checkHookJson('{"version":1}')).toMatchObject({ ok: false, problem: expect.stringMatching(/^hook\.json: quoteCut is required/) });
    expect(checkHookJson(HOOK_JSON_EXAMPLE.replace('800', '0'))).toMatchObject({ ok: false, problem: expect.stringMatching(/maxBuyBps is a whole number of basis points from 1 to 1,000/) });
  });
});
