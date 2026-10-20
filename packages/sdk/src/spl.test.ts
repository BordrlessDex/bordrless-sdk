/**
 * The SPL helpers (docs/token-quotes.md): token accounts and mints of both programs read from their
 * bytes, Token-2022's extensions from the TLV after the padding, the quote mint policy of §2.3 on
 * each extension case, and `TransferChecked`'s layout.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM, TOKEN_PROGRAM } from './addresses.ts';
import { TOKEN_2022_ACCOUNT_EXTENSION, TOKEN_2022_EXTENSION, cpiGuardLocked, memoTransferRequired, quoteMintPolicy, readMintExtensions, readSplMintAccount, readTokenAccount, scaledUiMultiplierOf, splProgramName, splProgramOf, transferChecked } from './spl.ts';

const k = (): PublicKey => Keypair.generate().publicKey;

/** A mint's 82 bytes: authorities as COption<Pubkey>, supply, decimals, initialized. */
function mintBase(o: { mintAuthority?: PublicKey | null; freezeAuthority?: PublicKey | null; supply?: bigint; decimals?: number; initialized?: boolean } = {}): Buffer {
  const b = Buffer.alloc(82);
  if (o.mintAuthority) {
    b.writeUInt32LE(1, 0);
    o.mintAuthority.toBuffer().copy(b, 4);
  }
  b.writeBigUInt64LE(o.supply ?? 1_000_000n, 36);
  b[44] = o.decimals ?? 6;
  b[45] = o.initialized === false ? 0 : 1;
  if (o.freezeAuthority) {
    b.writeUInt32LE(1, 46);
    o.freezeAuthority.toBuffer().copy(b, 50);
  }
  return b;
}

/** A Token-2022 mint with `extensions`: the base, padding to 165, the type byte 1, then TLV. */
function mint2022(base: Buffer, extensions: { type: number; data: Buffer }[], trailingZeros = 0): Buffer {
  const tlv = extensions.map((e) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(e.type, 0);
    head.writeUInt16LE(e.data.length, 2);
    return Buffer.concat([head, e.data]);
  });
  return Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), ...tlv, Buffer.alloc(trailingZeros)]);
}

const keyBytes = (key: PublicKey | null): Buffer => (key ? key.toBuffer() : Buffer.alloc(32));
const ext = {
  transferFee: () => ({ type: TOKEN_2022_EXTENSION.transferFeeConfig, data: Buffer.alloc(108) }),
  closeAuthority: (who: PublicKey | null) => ({ type: TOKEN_2022_EXTENSION.mintCloseAuthority, data: keyBytes(who) }),
  defaultState: (state: number) => ({ type: TOKEN_2022_EXTENSION.defaultAccountState, data: Buffer.from([state]) }),
  nonTransferable: () => ({ type: TOKEN_2022_EXTENSION.nonTransferable, data: Buffer.alloc(0) }),
  interestBearing: () => ({ type: TOKEN_2022_EXTENSION.interestBearingConfig, data: Buffer.alloc(52) }),
  permanentDelegate: (who: PublicKey | null) => ({ type: TOKEN_2022_EXTENSION.permanentDelegate, data: keyBytes(who) }),
  transferHook: (authority: PublicKey | null, program: PublicKey | null) => ({ type: TOKEN_2022_EXTENSION.transferHook, data: Buffer.concat([keyBytes(authority), keyBytes(program)]) }),
  confidentialFee: () => ({ type: TOKEN_2022_EXTENSION.confidentialTransferFeeConfig, data: Buffer.alloc(129) }),
  metadataPointer: () => ({ type: 18, data: Buffer.alloc(64) }),
  confidentialMintBurn: () => ({ type: TOKEN_2022_EXTENSION.confidentialMintBurn, data: Buffer.alloc(32) }),
  scaled: () => ({ type: TOKEN_2022_EXTENSION.scaledUiAmount, data: Buffer.alloc(56) }),
  pausable: (authority: PublicKey | null, paused: boolean) => ({ type: TOKEN_2022_EXTENSION.pausable, data: Buffer.concat([keyBytes(authority), Buffer.from([paused ? 1 : 0])]) }),
  unknown: (type: number) => ({ type, data: Buffer.alloc(8) }),
};

const splInfo = (data: Buffer) => ({ owner: SPL_TOKEN_PROGRAM, data });
const t22Info = (data: Buffer) => ({ owner: SPL_TOKEN_2022_PROGRAM, data });

/** A token account's 165 bytes (and, for Token-2022, its type byte 2 and an extension after them). */
function tokenAccount(o: { mint: PublicKey; owner: PublicKey; amount: bigint; state?: number; delegate?: PublicKey; native?: bigint; extended?: boolean }): Buffer {
  const b = Buffer.alloc(165);
  o.mint.toBuffer().copy(b, 0);
  o.owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(o.amount, 64);
  if (o.delegate) {
    b.writeUInt32LE(1, 72);
    o.delegate.toBuffer().copy(b, 76);
  }
  b[108] = o.state ?? 1;
  if (o.native !== undefined) {
    b.writeUInt32LE(1, 109);
    b.writeBigUInt64LE(o.native, 113);
  }
  // ImmutableOwner (7), as an associated token account of Token-2022 carries it.
  return o.extended ? Buffer.concat([b, Buffer.from([2, 7, 0, 0, 0])]) : b;
}

describe('splProgramOf', () => {
  it('knows the two token programs and nothing else', () => {
    expect(splProgramOf(SPL_TOKEN_PROGRAM)?.equals(SPL_TOKEN_PROGRAM)).toBe(true);
    expect(splProgramOf(SPL_TOKEN_2022_PROGRAM.toBase58())?.equals(SPL_TOKEN_2022_PROGRAM)).toBe(true);
    expect(splProgramOf(TOKEN_PROGRAM)).toBeNull();
    expect(splProgramOf(SystemProgram.programId)).toBeNull();
    expect([splProgramName(SPL_TOKEN_PROGRAM), splProgramName(SPL_TOKEN_2022_PROGRAM), splProgramName(TOKEN_PROGRAM)]).toEqual(['spl-token', 'token-2022', null]);
  });
});

describe('readTokenAccount', () => {
  it('reads both programs’ accounts, a Token-2022 one with its extensions after the base', () => {
    const [mint, owner, delegate] = [k(), k(), k()];
    const a = readTokenAccount(splInfo(tokenAccount({ mint, owner, amount: 42n, delegate })));
    expect(a).toMatchObject({ amount: 42n, state: 'initialized', isNative: null, delegatedAmount: 0n, closeAuthority: null });
    expect(a!.mint.equals(mint) && a!.owner.equals(owner) && a!.delegate!.equals(delegate) && a!.program.equals(SPL_TOKEN_PROGRAM)).toBe(true);
    const b = readTokenAccount(t22Info(tokenAccount({ mint, owner, amount: 7n, state: 2, extended: true })));
    expect(b).toMatchObject({ amount: 7n, state: 'frozen' });
    expect(b!.program.equals(SPL_TOKEN_2022_PROGRAM)).toBe(true);
    expect(readTokenAccount(splInfo(tokenAccount({ mint, owner, amount: 2_039_280n, native: 2_039_280n })))!.isNative).toBe(2_039_280n);
  });

  it('is null for a missing account, another owner, a mint, or an uninitialized account', () => {
    const [mint, owner] = [k(), k()];
    expect(readTokenAccount(null)).toBeNull();
    expect(readTokenAccount({ owner: TOKEN_PROGRAM, data: tokenAccount({ mint, owner, amount: 1n }) })).toBeNull();
    expect(readTokenAccount(splInfo(mintBase()))).toBeNull();
    expect(readTokenAccount(t22Info(mint2022(mintBase(), [ext.metadataPointer()])))).toBeNull();
    expect(readTokenAccount(splInfo(tokenAccount({ mint, owner, amount: 1n, state: 0 })))).toBeNull();
  });
});

describe('readSplMintAccount and readMintExtensions', () => {
  it('reads an SPL Token mint’s base layout', () => {
    const [authority, freeze] = [k(), k()];
    const m = readSplMintAccount(splInfo(mintBase({ mintAuthority: authority, freezeAuthority: freeze, supply: 5n, decimals: 8 })))!;
    expect(m).toMatchObject({ program: 'spl-token', supply: 5n, decimals: 8, extensions: [] });
    expect(m.mintAuthority!.equals(authority) && m.freezeAuthority!.equals(freeze)).toBe(true);
    expect(readSplMintAccount(splInfo(mintBase()))!.freezeAuthority).toBeNull();
  });

  it('reads a Token-2022 mint’s extensions from the TLV after byte 165, stopping at zeroed space', () => {
    const data = mint2022(mintBase(), [ext.metadataPointer(), ext.pausable(k(), false), ext.scaled()], 40);
    const m = readSplMintAccount(t22Info(data))!;
    expect(m.program).toBe('token-2022');
    expect(m.extensions.map((e) => [e.type, e.data.length])).toEqual([[18, 64], [26, 33], [25, 56]]);
    expect(readMintExtensions(mintBase())).toEqual([]);
    // A Token-2022 mint without extensions is 82 bytes, like SPL Token's.
    expect(readSplMintAccount(t22Info(mintBase()))!.extensions).toEqual([]);
  });

  it('is null for what is not an initialized mint, and refuses a TLV that runs past the end', () => {
    expect(readSplMintAccount(null)).toBeNull();
    expect(readSplMintAccount({ owner: TOKEN_PROGRAM, data: mintBase() })).toBeNull();
    expect(readSplMintAccount(splInfo(mintBase({ initialized: false })))).toBeNull();
    expect(readSplMintAccount(splInfo(tokenAccount({ mint: k(), owner: k(), amount: 1n })))).toBeNull();
    expect(readSplMintAccount(t22Info(tokenAccount({ mint: k(), owner: k(), amount: 1n, extended: true })))).toBeNull();
    const broken = mint2022(mintBase(), [ext.metadataPointer()]).subarray(0, 166 + 4 + 10);
    expect(() => readSplMintAccount(t22Info(Buffer.from(broken)))).toThrow(RangeError);
  });
});

describe('quoteMintPolicy (docs/token-quotes.md §2.3)', () => {
  const policy = (extensions: { type: number; data: Buffer }[], freezeAuthority: PublicKey | null = null) => quoteMintPolicy(readSplMintAccount(t22Info(mint2022(mintBase({ freezeAuthority }), extensions)))!);

  it('takes any SPL Token mint, labelling a freeze authority', () => {
    expect(quoteMintPolicy(readSplMintAccount(splInfo(mintBase()))!)).toEqual({ refusal: null, risks: [], extensions: [] });
    expect(quoteMintPolicy(readSplMintAccount(splInfo(mintBase({ freezeAuthority: k() })))!)).toEqual({ refusal: null, risks: ['freeze'], extensions: [] });
  });

  it('refuses a transfer fee, non-transferability, confidential minting and an unknown number', () => {
    expect(policy([ext.transferFee()]).refusal).toBe('transfer_fee');
    expect(policy([ext.confidentialFee()]).refusal).toBe('transfer_fee');
    expect(policy([ext.nonTransferable()]).refusal).toBe('non_transferable');
    expect(policy([ext.confidentialMintBurn()]).refusal).toBe('confidential');
    expect(policy([ext.unknown(99)])).toMatchObject({ refusal: 'unknown_extension', extensions: ['#99'] });
    // An account-side extension never belongs on a mint.
    expect(policy([ext.unknown(7)]).refusal).toBe('unknown_extension');
    // The most telling refusal is named when there are several.
    expect(policy([ext.unknown(99), ext.transferFee(), ext.nonTransferable()]).refusal).toBe('non_transferable');
  });

  it('takes DefaultAccountState only when new accounts start initialized', () => {
    expect(policy([ext.defaultState(1)]).refusal).toBeNull();
    expect(policy([ext.defaultState(2)]).refusal).toBe('frozen_by_default');
    expect(policy([ext.defaultState(0)]).refusal).toBe('frozen_by_default');
  });

  it('takes a transfer hook only with no program set, labelling who can set one', () => {
    expect(policy([ext.transferHook(k(), null)])).toMatchObject({ refusal: null, risks: ['hookAuthority'] });
    expect(policy([ext.transferHook(null, null)])).toMatchObject({ refusal: null, risks: [] });
    expect(policy([ext.transferHook(k(), k())]).refusal).toBe('transfer_hook');
  });

  it('takes Pausable only when not paused, labelling who can pause', () => {
    expect(policy([ext.pausable(k(), false)])).toMatchObject({ refusal: null, risks: ['pausable'] });
    expect(policy([ext.pausable(k(), true)]).refusal).toBe('paused');
  });

  it('labels the issuer’s other powers without refusing them: an xStock’s set', () => {
    const verdict = policy([ext.closeAuthority(k()), ext.metadataPointer(), ext.permanentDelegate(k()), ext.transferHook(k(), null), ext.pausable(k(), false), ext.scaled(), ext.defaultState(1)], k());
    expect(verdict).toEqual({
      refusal: null,
      risks: ['freeze', 'permanentDelegate', 'pausable', 'hookAuthority', 'closeAuthority', 'scaledAmount'],
      extensions: ['MintCloseAuthority', 'MetadataPointer', 'PermanentDelegate', 'TransferHook', 'Pausable', 'ScaledUiAmount', 'DefaultAccountState'],
    });
    expect(policy([ext.interestBearing()]).risks).toEqual(['scaledAmount']);
    // A power whose key is none is no power.
    expect(policy([ext.closeAuthority(null), ext.permanentDelegate(null)]).risks).toEqual([]);
  });
});

describe('transferChecked', () => {
  it('is instruction 12 with the amount and the decimals, the four accounts in order', () => {
    const [source, mint, destination, owner] = [k(), k(), k(), k()];
    const ix = transferChecked(source, mint, destination, owner, 1_234_567_890n, 8, SPL_TOKEN_2022_PROGRAM);
    expect(ix.programId.equals(SPL_TOKEN_2022_PROGRAM)).toBe(true);
    expect([...ix.data]).toEqual([12, ...Buffer.from(new BigUint64Array([1_234_567_890n]).buffer), 8]);
    expect(ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([
      [source.toBase58(), false, true],
      [mint.toBase58(), false, false],
      [destination.toBase58(), false, true],
      [owner.toBase58(), true, false],
    ]);
    expect(transferChecked(source, mint, destination, owner, 1n, 6).programId.equals(SPL_TOKEN_PROGRAM)).toBe(true);
    expect(() => transferChecked(source, mint, destination, owner, 1n, 6, TOKEN_PROGRAM)).toThrow(/not a token program/);
    expect(() => transferChecked(source, mint, destination, owner, -1n, 6)).toThrow(RangeError);
  });
});

describe('part 2 of quote tokens: account extensions, PermissionedBurn and the UI multiplier', () => {
  /** A Token-2022 token account with `extensions` after its 165 bytes and type byte 2. */
  const account2022 = (extensions: { type: number; data: Buffer }[]) => {
    const base = Buffer.alloc(165);
    k().toBuffer().copy(base, 0);
    k().toBuffer().copy(base, 32);
    base.writeBigUInt64LE(10n, 64);
    base[108] = 1;
    const tlv = extensions.map((e) => {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(e.type, 0);
      head.writeUInt16LE(e.data.length, 2);
      return Buffer.concat([head, e.data]);
    });
    return readTokenAccount({ owner: SPL_TOKEN_2022_PROGRAM, data: Buffer.concat([base, Buffer.from([2]), ...tlv]) })!;
  };

  it('reads a token account’s CPI Guard and memo-required flags', () => {
    const plain = account2022([{ type: 7, data: Buffer.alloc(0) }]);
    expect([cpiGuardLocked(plain), memoTransferRequired(plain)]).toEqual([false, false]);
    const guarded = account2022([{ type: TOKEN_2022_ACCOUNT_EXTENSION.cpiGuard, data: Buffer.from([1]) }]);
    expect([cpiGuardLocked(guarded), memoTransferRequired(guarded)]).toEqual([true, false]);
    const memo = account2022([{ type: TOKEN_2022_ACCOUNT_EXTENSION.memoTransfer, data: Buffer.from([1]) }, { type: TOKEN_2022_ACCOUNT_EXTENSION.cpiGuard, data: Buffer.from([0]) }]);
    expect([cpiGuardLocked(memo), memoTransferRequired(memo)]).toEqual([false, true]);
    // An SPL Token account has none.
    expect(readTokenAccount(splInfo(tokenAccount({ mint: k(), owner: k(), amount: 1n })))!.extensions).toEqual([]);
  });

  it('refuses PermissionedBurn (28) as an extension the DEX does not know', () => {
    const m = readSplMintAccount(t22Info(mint2022(mintBase(), [{ type: TOKEN_2022_EXTENSION.permissionedBurn, data: Buffer.alloc(32) }])))!;
    expect(quoteMintPolicy(m)).toMatchObject({ refusal: 'unknown_extension', extensions: ['#28'] });
  });

  it('reads a ScaledUiAmount multiplier: the current one, the new one from its effective time on, 1 without the extension', () => {
    const scaled = (current: number, effectiveAt: bigint, next: number) => {
      const data = Buffer.alloc(56);
      k().toBuffer().copy(data, 0);
      data.writeDoubleLE(current, 32);
      data.writeBigInt64LE(effectiveAt, 40);
      data.writeDoubleLE(next, 48);
      return readSplMintAccount(t22Info(mint2022(mintBase(), [{ type: TOKEN_2022_EXTENSION.scaledUiAmount, data }])))!;
    };
    expect(scaledUiMultiplierOf(scaled(1.25, 0n, 0), 1_000)).toBe(1.25);
    expect(scaledUiMultiplierOf(scaled(1.25, 2_000n, 1.5), 1_999)).toBe(1.25);
    expect(scaledUiMultiplierOf(scaled(1.25, 2_000n, 1.5), 2_000)).toBe(1.5);
    expect(scaledUiMultiplierOf(scaled(0, 0n, 0), 1_000)).toBe(1);
    expect(scaledUiMultiplierOf(readSplMintAccount(splInfo(mintBase()))!)).toBe(1);
  });
});

describe('the mint authority label', () => {
  it('labels a mint whose mint authority is set (the COption at 0), SPL Token or Token-2022', () => {
    expect(quoteMintPolicy(readSplMintAccount(splInfo(mintBase({ mintAuthority: k() })))!).risks).toEqual(['mintAuthority']);
    expect(quoteMintPolicy(readSplMintAccount(t22Info(mint2022(mintBase({ mintAuthority: k(), freezeAuthority: k() }), [{ type: TOKEN_2022_EXTENSION.scaledUiAmount, data: Buffer.alloc(56) }])))!).risks).toEqual(['freeze', 'mintAuthority', 'scaledAmount']);
    expect(quoteMintPolicy(readSplMintAccount(splInfo(mintBase()))!).risks).toEqual([]);
  });
});
