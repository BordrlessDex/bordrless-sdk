/**
 * Hook accounts. A hook's extra accounts are listed in its registry, `["bordrless-hook-accounts",
 * key]` under the hook program (`key` the mint for a token hook, the pool for a pool hook): the
 * magic `02 da f6 66 2c 38 c0 cd`, then Borsh `HookAccountList { version: u8, accounts:
 * Vec<ExtraAccount> }` (programs-summary §2.4; `bordrless_hook::HookAccountList` is the reference).
 * This module decodes and encodes registries, resolves them against a callback's prefix exactly as
 * the Rust `resolve` does, and assembles what instructions take:
 *
 * - token instructions (`transfer`, `mint_to`, `burn`): the hook program and the token program's
 *   signer for it in two account slots, the extras as remaining accounts ([`TokenHook`]);
 * - DEX instructions: each hooked mint's slice `[hook_program, token signer for it, ...extras]`
 *   ([`tokenHookSlice`]), empty for a mint without a hook (bridged SOL);
 * - the kit's two extras, fixed keys: `kit_config` (w), then the reward vault (r) with holder rewards
 *   or the kit's own id (Anchor's `None`) without.
 */
import { PublicKey, type AccountMeta, type Connection } from '@solana/web3.js';
import { decodeMint } from './accounts.ts';
import { KIT_PROGRAM, LAUNCH_PROGRAM, TOKEN_PROGRAM, kitConfigAddress, registryAddress, tokenHookSigner } from './addresses.ts';

/** The first 8 bytes of every registry account. */
export const HOOK_ACCOUNTS_MAGIC = Buffer.from([0x02, 0xda, 0xf6, 0x66, 0x2c, 0x38, 0xc0, 0xcd]);
/** The callback prefix every registry resolves against: 5 accounts (token: signer, mint, source, destination, authority; pool: signer, pool, base mint, quote mint, actor). */
export const HOOK_PREFIX_ACCOUNTS = 5;

export type Seed = { kind: 'literal'; bytes: Uint8Array } | { kind: 'account'; index: number } | { kind: 'sourceOwner' } | { kind: 'destinationOwner' };
export type AccountSource = { kind: 'key'; key: PublicKey } | { kind: 'pda'; program: PublicKey; seeds: Seed[] };
export interface ExtraAccount {
  writable: boolean;
  source: AccountSource;
}
export interface HookAccountList {
  version: number;
  accounts: ExtraAccount[];
}

class Reader {
  private at = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  u8(): number {
    const v = this.buf[this.at];
    if (v === undefined) throw new Error('registry: truncated');
    this.at += 1;
    return v;
  }
  u32(): number {
    if (this.at + 4 > this.buf.length) throw new Error('registry: truncated');
    const v = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  bytes(n: number): Buffer {
    if (this.at + n > this.buf.length) throw new Error('registry: truncated');
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  key(): PublicKey {
    return new PublicKey(this.bytes(32));
  }
}

/** Decodes a registry account's bytes; null when it is not one. */
export function decodeHookAccountList(data: Buffer): HookAccountList | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(HOOK_ACCOUNTS_MAGIC)) return null;
  const r = new Reader(data.subarray(8));
  const version = r.u8();
  const count = r.u32();
  const accounts: ExtraAccount[] = [];
  for (let i = 0; i < count; i += 1) {
    const writable = r.u8() === 1;
    const sourceTag = r.u8();
    if (sourceTag === 0) accounts.push({ writable, source: { kind: 'key', key: r.key() } });
    else if (sourceTag === 1) {
      const program = r.key();
      const n = r.u32();
      const seeds: Seed[] = [];
      for (let j = 0; j < n; j += 1) {
        const tag = r.u8();
        if (tag === 0) seeds.push({ kind: 'literal', bytes: r.bytes(r.u32()) });
        else if (tag === 1) seeds.push({ kind: 'account', index: r.u8() });
        else if (tag === 2) seeds.push({ kind: 'sourceOwner' });
        else if (tag === 3) seeds.push({ kind: 'destinationOwner' });
        else throw new Error(`registry: unknown seed ${tag}`);
      }
      accounts.push({ writable, source: { kind: 'pda', program, seeds } });
    } else throw new Error(`registry: unknown source ${sourceTag}`);
  }
  return { version, accounts };
}

/** A registry account's bytes (`HookAccountList::encode`): the magic, then Borsh. */
export function encodeHookAccountList(list: HookAccountList): Buffer {
  const parts: Buffer[] = [HOOK_ACCOUNTS_MAGIC, Buffer.from([list.version])];
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(list.accounts.length));
  for (const extra of list.accounts) {
    parts.push(Buffer.from([extra.writable ? 1 : 0]));
    if (extra.source.kind === 'key') parts.push(Buffer.from([0]), extra.source.key.toBuffer());
    else {
      parts.push(Buffer.from([1]), extra.source.program.toBuffer(), u32(extra.source.seeds.length));
      for (const seed of extra.source.seeds) {
        if (seed.kind === 'literal') parts.push(Buffer.from([0]), u32(seed.bytes.length), Buffer.from(seed.bytes));
        else if (seed.kind === 'account') parts.push(Buffer.from([1, seed.index]));
        else parts.push(Buffer.from([seed.kind === 'sourceOwner' ? 2 : 3]));
      }
    }
  }
  return Buffer.concat(parts);
}

/**
 * Resolves a list against the prefix keys of a callback (and, for token hooks, the owners), in the
 * order and with the writability the calling program must pass them. `Account(i)` indexes the
 * prefix, then the extras already resolved. Throws when a seed names an account not resolved yet
 * (the Rust `resolve` answers `None`).
 */
export function resolveHookAccounts(list: HookAccountList, prefix: PublicKey[], sourceOwner: PublicKey = PublicKey.default, destinationOwner: PublicKey = PublicKey.default): AccountMeta[] {
  const keys = [...prefix];
  const metas: AccountMeta[] = [];
  for (const extra of list.accounts) {
    let pubkey: PublicKey;
    if (extra.source.kind === 'key') pubkey = extra.source.key;
    else {
      const seeds = extra.source.seeds.map((s) => {
        if (s.kind === 'literal') return Buffer.from(s.bytes);
        if (s.kind === 'account') {
          const k = keys[s.index];
          if (!k) throw new Error(`registry: seed refers to account ${s.index}, which is not resolved yet`);
          return k.toBuffer();
        }
        return (s.kind === 'sourceOwner' ? sourceOwner : destinationOwner).toBuffer();
      });
      pubkey = PublicKey.findProgramAddressSync(seeds, extra.source.program)[0];
    }
    keys.push(pubkey);
    metas.push({ pubkey, isSigner: false, isWritable: extra.writable });
  }
  return metas;
}

/** Reads a hook's registry for `key` (a mint or a pool); null when the hook published none. */
export async function fetchHookAccountList(connection: Connection, hookProgram: PublicKey, key: PublicKey): Promise<HookAccountList | null> {
  const info = await connection.getAccountInfo(registryAddress(hookProgram, key), 'confirmed');
  return info ? decodeHookAccountList(info.data) : null;
}

// ---- token hooks -----------------------------------------------------------------------------------

/**
 * A mint's hook as an instruction takes it: the hook program, the token program's signer of its
 * callbacks (`["hook-authority", program]` under the token program) and the hook's extra accounts.
 * Token instructions put the first two in their `hook_program` and `hook_signer` slots and the
 * extras in the remaining accounts; DEX instructions take all three as the mint's slice.
 */
export interface TokenHook {
  program: PublicKey;
  signer: PublicKey;
  extras: AccountMeta[];
}

/**
 * The parties of one token operation, which a registry may name. For a mint the mint stands in the
 * source slot, for a burn in the destination slot; an owner a side lacks is the default key.
 */
export interface TokenOperation {
  mint: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  sourceOwner?: PublicKey;
  destinationOwner?: PublicKey;
}

/** The hook `hookProgram` of an operation, its extras resolved from `list` against `[signer, mint, source, destination, authority]` (none without a registry). */
export function tokenHookOf(hookProgram: PublicKey, list: HookAccountList | null, op: TokenOperation): TokenHook {
  const signer = tokenHookSigner(hookProgram);
  const extras = list ? resolveHookAccounts(list, [signer, op.mint, op.source, op.destination, op.authority], op.sourceOwner, op.destinationOwner) : [];
  return { program: hookProgram, signer, extras };
}

/** Reads the mint's hook and its registry and resolves it for `op`; null for a mint without a hook (or one that does not exist). */
export async function fetchTokenHook(connection: Connection, op: TokenOperation): Promise<TokenHook | null> {
  const info = await connection.getAccountInfo(op.mint, 'confirmed');
  if (!info || !info.owner.equals(TOKEN_PROGRAM)) return null;
  const mint = decodeMint(info.data);
  if (!mint.hookProgram) return null;
  return tokenHookOf(mint.hookProgram, await fetchHookAccountList(connection, mint.hookProgram, op.mint), op);
}

/** A mint's token-hook slice for a DEX instruction (`bordrless_swap::client::token_hook_slice`): `[program, signer, ...extras]`, empty without a hook. */
export function tokenHookSlice(hook: TokenHook | null): AccountMeta[] {
  if (!hook) return [];
  return [{ pubkey: hook.program, isSigner: false, isWritable: false }, { pubkey: hook.signer, isSigner: false, isWritable: false }, ...hook.extras];
}

// ---- a creator's own token hook (§5.8) --------------------------------------------------------------

/**
 * A creator's own token hook on a launched mint (`bordrless_launch::client::CustomHookAccounts`): the
 * program and its extras, resolved from its registry for the mint. The same slice goes on the
 * supply `mint_to` of `create_launch`, on the pool deposit, on every swap of the launch pool (the
 * base side) and on the graduation, so the extras are resolved once, against the mint alone: a
 * registry whose seeds name the source or destination holding cannot serve a swap (DEX note 6), and
 * `resolveCustomHookAccounts` throws for one.
 */
export interface CustomHookAccounts {
  program: PublicKey;
  extras: AccountMeta[];
}

/**
 * The most accounts a custom hook's registry may list for a launch. `create_launch` carries the
 * hook's registry extras as remaining accounts, which cannot come from the protocol lookup table
 * (they are per mint), and the whole must fit one v0 transaction (`PACKET_DATA_SIZE`, 1,232 bytes).
 * Measured in transactions.test.ts with the longest metadata the site uploads (a name of 32
 * bytes, a symbol of 10, an ipfs:// link of 66): one more and the launch does not fit.
 */
export const MAX_CUSTOM_HOOK_EXTRAS = 4;

/** The custom hook's slice for a DEX instruction (`custom_hook_slice`): `[program, token signer for it, ...extras]`. */
export const customHookSlice = (hook: CustomHookAccounts): AccountMeta[] => tokenHookSlice(customHookTokenHook(hook));

/** The custom hook as a token instruction takes it. */
export const customHookTokenHook = (hook: CustomHookAccounts): TokenHook => ({ program: hook.program, signer: tokenHookSigner(hook.program), extras: hook.extras });

/**
 * The remaining accounts of `create_launch` for a custom hook (§5.8): the program, the token
 * program's signer for it, the registry at `["bordrless-hook-accounts", mint]` under the hook, then
 * exactly the registry's extras, as the client resolved them.
 */
export function customHookLaunchAccounts(hook: CustomHookAccounts, mint: PublicKey): AccountMeta[] {
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  return [ro(hook.program), ro(tokenHookSigner(hook.program)), ro(registryAddress(hook.program, mint)), ...hook.extras];
}

/**
 * Resolves a hook's registry for `mint` into the slice every launch instruction passes: against
 * `[signer, mint, mint, mint, mint]`, so a seed that names the mint resolves and one that names a
 * holding or an owner cannot (it would differ per transfer, which the launch's one slice cannot
 * carry). Throws for such a registry.
 */
export function resolveCustomHookAccounts(hookProgram: PublicKey, list: HookAccountList, mint: PublicKey): CustomHookAccounts {
  for (const extra of list.accounts) {
    if (extra.source.kind !== 'pda') continue;
    for (const seed of extra.source.seeds) {
      if (seed.kind === 'sourceOwner' || seed.kind === 'destinationOwner') throw new Error('the hook’s registry depends on who sends or receives: it cannot serve a launch, whose one slice must fit every transfer');
      if (seed.kind === 'account' && seed.index >= 2 && seed.index < HOOK_PREFIX_ACCOUNTS) throw new Error('the hook’s registry names a holding or the authority of the transfer: it cannot serve a launch, whose one slice must fit every transfer');
    }
  }
  const signer = tokenHookSigner(hookProgram);
  return { program: hookProgram, extras: resolveHookAccounts(list, [signer, mint, mint, mint, mint]) };
}

/** Reads the hook's registry for `mint` and resolves it; null when the hook has not been prepared for the mint (no registry, or not one). */
export async function fetchCustomHookAccounts(connection: Connection, hookProgram: PublicKey, mint: PublicKey): Promise<CustomHookAccounts | null> {
  const list = await fetchHookAccountList(connection, hookProgram, mint);
  return list ? resolveCustomHookAccounts(hookProgram, list, mint) : null;
}

// ---- the kit (§4.4) --------------------------------------------------------------------------------

/**
 * The kit's two extras for a mint, as its registry lists them: `kit_config` (w), then the reward
 * vault (r) with holder rewards, or the kit's own id (r, Anchor's `None`) without
 * (`bordrless_kit::client::hook_extras`). They do not depend on the holdings, so one slice serves
 * every transfer and burn of a side.
 */
export function kitHookExtras(mint: PublicKey, rewardVault: PublicKey | null): AccountMeta[] {
  return [
    { pubkey: kitConfigAddress(mint), isSigner: false, isWritable: true },
    { pubkey: rewardVault ?? KIT_PROGRAM, isSigner: false, isWritable: false },
  ];
}

/** A kit mint's hook, without reading its registry: the kit, the token program's signer for it (`6EsVn9…`), the two extras. */
export function kitTokenHook(mint: PublicKey, rewardVault: PublicKey | null): TokenHook {
  return { program: KIT_PROGRAM, signer: tokenHookSigner(KIT_PROGRAM), extras: kitHookExtras(mint, rewardVault) };
}

/** A kit mint's DEX slice (`bordrless_kit::client::hook_slice`): `[KIT_ID, 6EsVn9…, kit_config (w), reward vault (r) or KIT_ID]`, 4 accounts. */
export function kitHookSlice(mint: PublicKey, rewardVault: PublicKey | null): AccountMeta[] {
  return tokenHookSlice(kitTokenHook(mint, rewardVault));
}

/** The kit's registry for a mint (81 bytes encoded; `bordrless_kit::instructions::registry_list`): two fixed keys. */
export function kitRegistryList(kitConfig: PublicKey, rewardVault: PublicKey | null): HookAccountList {
  return {
    version: 1,
    accounts: [
      { writable: true, source: { kind: 'key', key: kitConfig } },
      { writable: false, source: { kind: 'key', key: rewardVault ?? KIT_PROGRAM } },
    ],
  };
}

/**
 * A launch pool's registry (186 bytes encoded; `bordrless_launch::instructions::launch::registry_list`):
 * the launch `Pda launch ["launch", Account(2) = base mint]` (w), its quote holding `Pda token
 * ["holding", Account(3) = quote mint, Account(5) = launch]` (w), the holder vault (w, a key) and the
 * kit config (r, a key); written whatever the rules.
 */
export function launchPoolRegistryList(holderVault: PublicKey, kitConfig: PublicKey): HookAccountList {
  const literal = (s: string): Seed => ({ kind: 'literal', bytes: Buffer.from(s, 'utf8') });
  return {
    version: 1,
    accounts: [
      { writable: true, source: { kind: 'pda', program: LAUNCH_PROGRAM, seeds: [literal('launch'), { kind: 'account', index: 2 }] } },
      { writable: true, source: { kind: 'pda', program: TOKEN_PROGRAM, seeds: [literal('holding'), { kind: 'account', index: 3 }, { kind: 'account', index: 5 }] } },
      { writable: true, source: { kind: 'key', key: holderVault } },
      { writable: false, source: { kind: 'key', key: kitConfig } },
    ],
  };
}

// ---- pool hooks ------------------------------------------------------------------------------------

/** The extras of a pool hook's callback, resolved against `[hookSigner, pool, baseMint, quoteMint, actor]`; `hookSigner` is the DEX's signer for the pool's hook (`dexHookSigner`). */
export function poolHookAccounts(list: HookAccountList | null, hookSigner: PublicKey, pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, actor: PublicKey): AccountMeta[] {
  return list ? resolveHookAccounts(list, [hookSigner, pool, baseMint, quoteMint, actor]) : [];
}
