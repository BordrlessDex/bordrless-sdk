/**
 * The leg math (docs/token-quotes.md §1): the supply split into legs, each leg's virtual quote opening
 * the coin at $5,000 in its token (a `ScaledUiAmount` token's multiplier divided out), its price in
 * whole tokens, and SOL in either form refused.
 */
import { describe, expect, it } from 'vitest';
import { NATIVE_MINT } from './programs.ts';
import { NATIVE_MINT_2022, OPENING_MCAP_USD, TOKEN_SUPPLY, isSolMint, legPrice, legPriceWhole, legShares, legVirtualQuote } from './index.ts';

describe('the legs', () => {
  it('split the supply evenly, the last taking what the division leaves', () => {
    expect(legShares(1)).toEqual([TOKEN_SUPPLY]);
    const three = legShares(3);
    expect(three.reduce((a, b) => a + b, 0n)).toBe(TOKEN_SUPPLY);
    expect(three[2]! - three[0]!).toBe(TOKEN_SUPPLY - 3n * (TOKEN_SUPPLY / 3n));
    expect(() => legShares(0)).toThrow(RangeError);
    expect(() => legShares(7)).toThrow(RangeError);
  });

  it('open the coin at $5,000 in every token; a scaled token’s raw unit is worth its price times the multiplier', () => {
    const [half] = legShares(2);
    expect(legVirtualQuote(half!, 1, 6)).toBe(2_500_000_000n);
    // Its whole token reads raw × 1.25 / 10^8: each raw unit is worth more, so fewer of them open the leg.
    const plain = legVirtualQuote(half!, 367.12, 8);
    const scaled = legVirtualQuote(half!, 367.12, 8, OPENING_MCAP_USD, TOKEN_SUPPLY, 1.25);
    expect(Number(scaled)).toBeCloseTo(Number(plain) / 1.25, -1);
    // The opening price in whole tokens, the multiplier applied, is the same dollars either way.
    const plainPrice = legPriceWhole(legPrice(0n, plain, half!), 8) * 367.12;
    const scaledPrice = legPriceWhole(legPrice(0n, scaled, half!), 8, 6, 1.25) * 367.12;
    expect(scaledPrice).toBeCloseTo(plainPrice, 9);
    expect(plainPrice * 1e9).toBeCloseTo(OPENING_MCAP_USD, 0);
    expect(() => legVirtualQuote(half!, 1, 6, OPENING_MCAP_USD, TOKEN_SUPPLY, 0)).toThrow(RangeError);
  });

  it('never take SOL in either form as a quote', () => {
    expect([isSolMint(NATIVE_MINT), isSolMint(NATIVE_MINT_2022), isSolMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')]).toEqual([true, true, false]);
  });
});
