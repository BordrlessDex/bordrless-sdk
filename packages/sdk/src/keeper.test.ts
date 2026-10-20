/** keeper.json from the SDK (docs/scripts.md "What a script may ask the keeper for"): the template's example checks as the Workshop checks it, a bad one is refused with its sentence, and a declaration saved as a file reads back the same. */
import { describe, expect, it } from 'vitest';
import { KEEPER_EXAMPLE, KEEPER_FILE, RAYDIUM_CLMM_STEP_ACCOUNTS, checkKeeperJson, isLaunchPool, isRaydiumPool, keeperJson, parseKeeperDeclaration } from './index.ts';

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
    expect(checkKeeperJson(KEEPER_EXAMPLE.replace('"ownerQuoteHolding"', '"anyone"'))).toEqual({ ok: false, problem: 'keeper.json: holdings.payTo is one of none, owner, ownerQuoteHolding, ownerTokenAccount: where each holding is paid.' });
  });

  it('takes a script that buys an SPL token on a Raydium pool and pays holders in it (19 Oct 2026)', () => {
    const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
    const checked = checkKeeperJson(JSON.stringify({ version: 1, holdings: { minBalance: '1', payTo: 'ownerTokenAccount', payMint: ZEC, perStep: { withoutSwapAccounts: 6 } }, swapAccounts: false, pools: [{ raydiumClmm: 'GPxw5YstKrcJDe9GtD3u9myrsKAyLNy8tedsoyVDyN2b', buy: ZEC }] }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.words).toBe('Each step brings up to 6 holders, paid to their A7bd…QXaS token account.');
    expect(checked.details).toContain('Each step also brings the Raydium pool GPxw…yN2b (a swap buying A7bd…QXaS for the companion address, with its price-range accounts).');
    const pool = checked.declaration.pools![0]!;
    expect(isRaydiumPool(pool) && !isLaunchPool(pool)).toBe(true);
    expect(RAYDIUM_CLMM_STEP_ACCOUNTS).toBe(19);
  });
});
