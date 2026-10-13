/** keeper.json from the SDK (docs/scripts.md "What a script may ask the keeper for"): the template's example checks as the Workshop checks it, a bad one is refused with its sentence, and a declaration saved as a file reads back the same. */
import { describe, expect, it } from 'vitest';
import { KEEPER_EXAMPLE, KEEPER_FILE, checkKeeperJson, keeperJson, parseKeeperDeclaration } from './index.ts';

describe('checkKeeperJson', () => {
  it('takes the template’s example and says it in plain words', () => {
    const checked = checkKeeperJson(KEEPER_EXAMPLE);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.words).toBe('Each step brings up to 3 holders with under 20M tokens not yet paid this epoch, paid to their SOL holding.');
    expect(checked.details[0]).toBe('Each step also carries the launch pool’s swap accounts.');
    expect(checked.declaration.holdings?.payTo).toBe('ownerQuoteHolding');
    // Saved as a file, it reads back as the same declaration.
    const again = parseKeeperDeclaration(keeperJson(checked.declaration));
    expect(again).toEqual({ ok: true, declaration: checked.declaration });
    expect(KEEPER_FILE).toBe('keeper.json');
  });

  it('refuses what the Workshop refuses, with its sentence', () => {
    expect(checkKeeperJson('{"version":1}')).toEqual({ ok: false, problem: 'keeper.json: holdings is required: which holdings each step brings.' });
    expect(checkKeeperJson(KEEPER_EXAMPLE.replace('"ownerQuoteHolding"', '"anyone"'))).toEqual({ ok: false, problem: 'keeper.json: holdings.payTo is one of none, owner, ownerQuoteHolding: where each holding is paid.' });
  });
});
