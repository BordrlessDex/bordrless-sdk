/**
 * `hook_vault` (phase 3a, bordrless-programs docs/phase3a.md §5): deferred actions for a launchpad
 * coin's own token hook. The vault is made before the coin exists (`createVault`, the mint's
 * keypair signing; the mint must not exist yet) with up to three slots, each with a policy fixed for
 * good: burn the slot's cut, sell it for SOL to a wallet (a creator tax in effect), or sell it and
 * buy and burn another launchpad token. The coin's hook sends each cut to the slot's holding
 * (`slotHolding`); once the coin is launched `openVault` creates the holdings, and anyone runs the
 * slots (`execute`, `executeBuy`, `retire`) for a bounty under the companion's buyback guards.
 *
 * The builders mirror `hook_vault::client` account for account (each step's remaining accounts are
 * the instructions it invokes, every key listed once, writable if any listing is, nobody a signer),
 * held to it by `vectors/vault.json`.
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { customHookTokenHook, kitTokenHook, type CustomHookAccounts } from './hooks.ts';
import { bridge, launch, token, type LaunchKeys } from './instructions.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');

export const HOOK_VAULT_EVENT_AUTHORITY = a.eventAuthority(a.HOOK_VAULT_PROGRAM);

/** Slot policies as the program numbers them. */
export const VAULT_POLICY = { unused: 0, burn: 1, sellForSol: 2, sellBuyBurn: 3 } as const;
export type VaultPolicyName = keyof typeof VAULT_POLICY;
const POLICY_NAMES: readonly VaultPolicyName[] = ['unused', 'burn', 'sellForSol', 'sellBuyBurn'];

/** The program's bounds (`hook_vault::constants`). */
export const VAULT_LIMITS = {
  maxSlots: 3,
  maxBountyBps: 100,
  maxSellBps: 100,
  minInterval: 60,
  maxInterval: 30 * 86_400,
  maxHookCutBps: 5_000,
  retireSecs: 60 * 86_400,
  /** A sell waits while the price is more than this below its reference (a buy: above). */
  maxDiscountBps: 300,
} as const;

/** The vault of `mint`, `["vault", mint]`. */
export const hookVaultAddress = (mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync([enc('vault'), mint.toBuffer()], a.HOOK_VAULT_PROGRAM)[0];
/** Slot `i`'s owner, `["slot", mint, [i]]`: a system address only the vault signs for. */
export const slotOwner = (mint: PublicKey, i: number): PublicKey => PublicKey.findProgramAddressSync([enc('slot'), mint.toBuffer(), Buffer.from([i])], a.HOOK_VAULT_PROGRAM)[0];
/** The holding of the coin a hook names for slot `i` (its delta target). */
export const slotHolding = (mint: PublicKey, i: number): PublicKey => a.holdingAddress(mint, slotOwner(mint, i));

// ---- accounts ---------------------------------------------------------------------------------------

/** One slot of a vault: its policy (fixed) and its running state. */
export interface VaultSlot {
  policy: VaultPolicyName;
  /** `sellForSol`: the wallet paid. `sellBuyBurn`: the pool of the token bought and burned. The default key otherwise. */
  target: PublicKey;
  ownerBump: number;
  /** `sellBuyBurn` of a custom-hook token: the most that token's hook may cut from the buy (basis points). */
  maxCutBps: number;
  /** The last sell, burn or retirement (unix seconds; 0 before the first). The next sell is an interval later. */
  lastAt: number;
  /** The last time the sell waited; the next attempt is a minute later. */
  waitedAt: number;
  referencePrice: bigint;
  referenceAt: number;
  /** Bridged SOL the slot holds for later (lamports). */
  pendingSol: bigint;
  buyReference: bigint;
  buyReferenceAt: number;
  /** The last buy. */
  buyLastAt: number;
  /** The last time the buy waited; the next attempt is a minute later. */
  buyWaitedAt: number;
  sold: bigint;
  solOut: bigint;
  xBurned: bigint;
  burned: bigint;
  bounties: bigint;
}

/** A coin's vault as the program keeps it. */
export interface Vault {
  version: number;
  bump: number;
  mint: PublicKey;
  /** The coin's own token hook, which sends the cuts. */
  hook: PublicKey;
  creator: PublicKey;
  nSlots: number;
  /** All three entries; `slots.slice(0, nSlots)` are in use. */
  slots: VaultSlot[];
  bountyBps: number;
  maxSellBps: number;
  interval: number;
  /** The most the coin's own hook may cut from the vault's sell (declared). */
  maxHookCutBps: number;
  opened: boolean;
  openedAt: number;
  createdAt: number;
  lastActivityAt: number;
}

type Raw = Record<string, unknown>;
const big = (v: unknown): bigint => BigInt((v as BN).toString(10));
const int = (v: unknown): number => (BN.isBN(v) ? (v as BN).toNumber() : (v as number));

function slotOf(s: Raw): VaultSlot {
  return {
    policy: POLICY_NAMES[s.policy as number] ?? 'unused',
    target: s.target as PublicKey,
    ownerBump: s.ownerBump as number,
    maxCutBps: s.maxCutBps as number,
    lastAt: int(s.lastAt),
    waitedAt: int(s.waitedAt),
    referencePrice: big(s.referencePrice),
    referenceAt: int(s.referenceAt),
    pendingSol: big(s.pendingSol),
    buyReference: big(s.buyReference),
    buyReferenceAt: int(s.buyReferenceAt),
    buyLastAt: int(s.buyLastAt),
    buyWaitedAt: int(s.buyWaitedAt),
    sold: big(s.sold),
    solOut: big(s.solOut),
    xBurned: big(s.xBurned),
    burned: big(s.burned),
    bounties: big(s.bounties),
  };
}

/** A `Vault` account's data (discriminator checked). */
export function decodeVault(data: Buffer | Uint8Array): Vault {
  const v = CODERS.hookVault.accounts.decode('vault', Buffer.from(data)) as Raw;
  return {
    version: v.version as number,
    bump: v.bump as number,
    mint: v.mint as PublicKey,
    hook: v.hook as PublicKey,
    creator: v.creator as PublicKey,
    nSlots: v.nSlots as number,
    slots: (v.slots as Raw[]).map(slotOf),
    bountyBps: v.bountyBps as number,
    maxSellBps: v.maxSellBps as number,
    interval: int(v.interval),
    maxHookCutBps: v.maxHookCutBps as number,
    opened: v.opened as boolean,
    openedAt: int(v.openedAt),
    createdAt: int(v.createdAt),
    lastActivityAt: int(v.lastActivityAt),
  };
}

/** Slot `i` of a decoded vault (in use). */
export const vaultSlot = (vault: Pick<Vault, 'nSlots' | 'slots'>, i: number): VaultSlot => {
  const s = vault.slots[i];
  if (i >= vault.nSlots || !s || s.policy === 'unused') throw new Error(`the vault has no slot ${i}`);
  return s;
};

const sells = (s: Pick<VaultSlot, 'policy'>): boolean => s.policy === 'sellForSol' || s.policy === 'sellBuyBurn';

// ---- builders ---------------------------------------------------------------------------------------

/** Appends `pubkey` once (writable if any listing is), not a signer. */
function push(out: AccountMeta[], pubkey: PublicKey, writable: boolean): void {
  const m = out.find((x) => x.pubkey.equals(pubkey));
  if (m) m.isWritable ||= writable;
  else out.push({ pubkey, isSigner: false, isWritable: writable });
}

/** Appends an instruction's accounts and its program, each once, nobody a signer. */
function add(out: AccountMeta[], ix: TransactionInstruction): void {
  for (const m of ix.keys) push(out, m.pubkey, m.isWritable);
  push(out, ix.programId, false);
}

function build(named: AccountMeta[], extra: AccountMeta[], data: Buffer): TransactionInstruction {
  const accounts = [...named.map((m) => ({ ...m })), ro(HOOK_VAULT_EVENT_AUTHORITY), ro(a.HOOK_VAULT_PROGRAM)];
  // The named accounts carry their own flags: what the remaining accounts list again is dropped.
  const rest: AccountMeta[] = [];
  for (const m of extra) {
    const named = accounts.find((x) => x.pubkey.equals(m.pubkey));
    if (named) named.isWritable ||= m.isWritable;
    else push(rest, m.pubkey, m.isWritable);
  }
  return new TransactionInstruction({ programId: a.HOOK_VAULT_PROGRAM, keys: [...accounts, ...rest], data });
}

const encode = (name: string, args: Record<string, unknown>): Buffer => CODERS.hookVault.instruction.encode(name, args);
const registry = (out: AccountMeta[], hook: PublicKey, mint: PublicKey): void => push(out, a.registryAddress(hook, mint), false);
const unwrapAccounts = (out: AccountMeta[], owner: PublicKey): void => add(out, bridge.unwrapSol(owner, 0n));
/** `owner`'s burn of its holding of `mint`, with the mint's custom hook resolved for that burn. */
const hookedBurn = (owner: PublicKey, mint: PublicKey, hook: CustomHookAccounts): TransactionInstruction => token.burn(owner, a.holdingAddress(mint, owner), mint, 0n, customHookTokenHook(hook));
const step = (cranker: PublicKey, mint: PublicKey, i: number): AccountMeta[] => [rw(cranker, true), rw(hookVaultAddress(mint)), rw(slotOwner(mint, i)), ro(a.launchAddress(mint)), ro(a.SYSTEM_PROGRAM)];
const poolOf = (k: LaunchKeys): PublicKey => a.launchPoolAddress(k.mint, k.quoteMint, k.lpFeeBps);

/** A slot as `createVault` takes it. */
export interface VaultSlotArgs {
  policy: Exclude<VaultPolicyName, 'unused'>;
  /** `sellForSol`: the wallet paid (it must be able to take SOL: not a program, a reserved key or one of the vault's own addresses). `sellBuyBurn`: the token's launch pool. Omitted for `burn`. */
  target?: PublicKey;
  /** `sellBuyBurn` of a token that runs its own hook: the most that hook may cut from the buy (at most 5,000 basis points); 0 otherwise. */
  maxCutBps?: number;
}

/** `create_vault`'s arguments; none of them ever changes. */
export interface CreateVaultArgs {
  /** The coin's own token hook (its `LaunchConfig`'s `custom_hook`). */
  hook: PublicKey;
  /** One to three slots, in the order the hook names them; at most one buy slot a pool. */
  slots: VaultSlotArgs[];
  /** The crank's pay, at most 100 basis points of the SOL a step moves. */
  bountyBps: number;
  /** The most the vault sells an interval, 1 to 100 basis points of the pool's quote side (and never more than the launch's fees allow), split evenly among its selling slots. */
  maxSellBps: number;
  /** Seconds between two sells of a slot (and two buys): 60 to 30 days. */
  interval: number;
  /** The most the coin's own hook may cut from the vault's sell, at most 5,000 basis points. */
  maxHookCutBps: number;
}

/** `hook_vault::client::BuyHook`: the token bought's hook, as `executeBuy` passes it. */
export type VaultBuyHook = { kind: 'kit'; rewards: boolean } | { kind: 'custom'; transfer: CustomHookAccounts; burn: CustomHookAccounts };

/** The parts of a decoded vault the builders read. */
export type VaultView = Pick<Vault, 'mint' | 'nSlots' | 'slots'>;

export const vault = {
  /**
   * `create_vault`: the vault of `mint`, whose keypair signs (and which must not exist yet), `payer`
   * paying its rent. `buyMints` are the tokens of the `sellBuyBurn` slots, whose launches are read;
   * each `sellForSol` wallet is passed too.
   */
  createVault(payer: PublicKey, mint: PublicKey, args: CreateVaultArgs, buyMints: PublicKey[]): TransactionInstruction {
    const named = [rw(payer, true), ro(mint, true), rw(hookVaultAddress(mint)), ro(a.SYSTEM_PROGRAM)];
    const slots = args.slots.map((s) => ({ policy: VAULT_POLICY[s.policy], target: s.target ?? PublicKey.default, maxCutBps: s.maxCutBps ?? 0 }));
    const extra: AccountMeta[] = [];
    for (const s of slots) if (s.policy === VAULT_POLICY.sellBuyBurn) push(extra, s.target, false);
    for (const x of buyMints) push(extra, a.launchAddress(x), false);
    for (const s of slots) if (s.policy === VAULT_POLICY.sellForSol) push(extra, s.target, false);
    const data = encode('createVault', { args: { hook: args.hook, slots, bountyBps: args.bountyBps, maxSellBps: args.maxSellBps, interval: new BN(args.interval), maxHookCutBps: args.maxHookCutBps } });
    return build(named, extra, data);
  },

  /**
   * `open_vault`, once the coin is launched with the vault's hook: `sender` pays the slots' holdings
   * and funds the selling slots' owners. `coin` gives the coin's pool. Only the vault's creator (who
   * paid `createVault`) opens it, or a sender with the mint's keypair signing too (`mintSigns`):
   * `NotOpener` otherwise (independent audit X3). The sells' reference opens at the pool's price, at
   * most the launch's opening price. The launch and this do not fit one transaction: send it as the
   * creator's next transaction after the launch (`vaultLaunchSequence`), or no cut ever reaches the
   * slots (the hook pays nothing while a slot's holding does not exist).
   */
  openVault(sender: PublicKey, v: VaultView, coin: LaunchKeys, options: { mintSigns?: boolean } = {}): TransactionInstruction {
    const mint = v.mint;
    const named = [rw(sender, true), rw(hookVaultAddress(mint)), ro(a.launchAddress(mint)), ro(mint, options.mintSigns === true), ro(a.SYSTEM_PROGRAM)];
    const extra: AccountMeta[] = [];
    push(extra, poolOf(coin), false);
    v.slots.slice(0, v.nSlots).forEach((slot, i) => {
      const owner = slotOwner(mint, i);
      push(extra, owner, sells(slot));
      add(extra, token.createHolding(sender, mint, owner));
      if (sells(slot)) add(extra, token.createHolding(sender, a.BRIDGED_SOL_MINT, owner));
      if (slot.policy === 'sellBuyBurn') push(extra, slot.target, false);
    });
    return build(named, extra, encode('openVault', {}));
  },

  /**
   * `execute(i)`: slot `i` burns its coin, or sells a slice of it (or waits). `coin` is the coin's
   * launch keys; `hook` the coin's hook with its extras resolved for the slot's operation: the burn
   * of the slot's holding (`burn`), or the transfer from the slot's holding to the pool's coin vault,
   * the slot's owner signing (`sellForSol`, `sellBuyBurn`).
   */
  execute(cranker: PublicKey, v: VaultView, i: number, coin: LaunchKeys, hook: CustomHookAccounts): TransactionInstruction {
    const mint = v.mint;
    const owner = slotOwner(mint, i);
    const slot = vaultSlot(v, i);
    const extra: AccountMeta[] = [];
    if (slot.policy === 'burn') {
      add(extra, hookedBurn(owner, mint, hook));
    } else {
      add(extra, launch.swap({ ...coin, customHook: hook }, owner, owner, 0, 0n, 0n));
      unwrapAccounts(extra, owner);
      if (slot.policy === 'sellForSol') push(extra, slot.target, true);
    }
    registry(extra, hook.program, mint);
    return build(step(cranker, mint, i), extra, encode('execute', { i }));
  },

  /** `execute_buy(i)`: a `sellBuyBurn` slot buys the token `x` (its launch keys) with the SOL its sells left, and burns it (or waits). */
  executeBuy(cranker: PublicKey, v: VaultView, i: number, x: LaunchKeys, hook: VaultBuyHook): TransactionInstruction {
    const owner = slotOwner(v.mint, i);
    const extra: AccountMeta[] = [];
    const buy = hook.kind === 'kit' ? launch.swap({ ...x, customHook: null }, owner, owner, 1, 0n, 0n) : launch.swap({ ...x, customHook: hook.transfer }, owner, owner, 1, 0n, 0n);
    add(extra, buy);
    push(extra, a.launchAddress(x.mint), false);
    add(extra, token.createHolding(cranker, x.mint, owner));
    const holding = a.holdingAddress(x.mint, owner);
    let burn: TransactionInstruction;
    if (hook.kind === 'custom') burn = hookedBurn(owner, x.mint, hook.burn);
    else if (x.modules !== 0) burn = token.burn(owner, holding, x.mint, 0n, kitTokenHook(x.mint, hook.rewards ? a.holderVaultAddress(x.mint, x.quoteMint) : null));
    else burn = token.burn(owner, holding, x.mint, 0n, null);
    add(extra, burn);
    unwrapAccounts(extra, owner);
    if (hook.kind === 'custom') registry(extra, hook.transfer.program, x.mint);
    return build(step(cranker, v.mint, i), extra, encode('executeBuy', { i }));
  },

  /** `retire(i, burnCoin)` (anyone, after 60 days in which slot `i` neither ran nor waited): its SOL to the incinerator and, with `burnCoin`, its coin burned (`burn`: the coin's hook resolved for the slot's burn). */
  retire(cranker: PublicKey, v: VaultView, i: number, burnCoin: boolean, burn: CustomHookAccounts | null = null): TransactionInstruction {
    const mint = v.mint;
    const owner = slotOwner(mint, i);
    const extra: AccountMeta[] = [];
    if (vaultSlot(v, i).pendingSol > 0n) {
      unwrapAccounts(extra, owner);
      push(extra, a.INCINERATOR, true);
    }
    if (burn && burnCoin) {
      add(extra, hookedBurn(owner, mint, burn));
      registry(extra, burn.program, mint);
    }
    return build(step(cranker, mint, i), extra, encode('retire', { i, burnCoin }));
  },
};

// ---- labels -----------------------------------------------------------------------------------------

/** The policy of a vault as a label reads it: a decoded vault, or the arguments it will be made with. */
/** A vault's view as `openVault` reads it, before the vault exists: from `createVault`'s arguments. */
export function vaultViewOf(mint: PublicKey, args: Pick<CreateVaultArgs, 'slots'>): VaultView {
  const slots = args.slots.map(
    (s) =>
      ({
        policy: s.policy,
        target: s.target ?? PublicKey.default,
        ownerBump: 0,
        maxCutBps: s.maxCutBps ?? 0,
        lastAt: 0,
        waitedAt: 0,
        referencePrice: 0n,
        referenceAt: 0,
        pendingSol: 0n,
        buyReference: 0n,
        buyReferenceAt: 0,
        buyLastAt: 0,
        buyWaitedAt: 0,
        sold: 0n,
        solOut: 0n,
        xBurned: 0n,
        burned: 0n,
        bounties: 0n,
      }) satisfies VaultSlot,
  );
  return { mint, nSlots: slots.length, slots };
}

/** One transaction of a vault coin's launch: its instructions, in order, and who signs. */
export interface VaultLaunchStep {
  label: 'setup' | 'launch' | 'open';
  instructions: TransactionInstruction[];
  /** `creator` always; `mint` for the setup and the launch (the mint's keypair). */
  signers: ('creator' | 'mint')[];
}

/**
 * The transactions of a launch with a vault, in order (`docs/phase3a.md` §5.5; independent audit
 * X3): (1) the setup, `createVault` (the mint signs: the vault, and so every slot's policy, is fixed
 * before the coin exists) and the hook's own preparation (`hookPrepare`, e.g. its registry for the
 * mint); (2) the launch (`launchIx`: `createLaunch` from the hook's config, with `hookTimelocked`
 * when the config says so); (3) `openVault`, sent by `creator` (the vault's creator, who paid
 * `createVault`) as soon as the launch has landed. The launch and the open do not fit one
 * transaction (measured: `x3_open_vault_does_not_fit_in_the_launch_transaction`). Until (3) lands
 * the hook takes no cut; nobody else can open it, and a price pumped around it is never a sell
 * reference (it opens at most at the opening price).
 */
export function vaultLaunchSequence(
  creator: PublicKey,
  mint: PublicKey,
  args: CreateVaultArgs,
  buyMints: PublicKey[],
  launchIx: TransactionInstruction,
  coin: LaunchKeys,
  hookPrepare: TransactionInstruction[] = [],
): VaultLaunchStep[] {
  return [
    { label: 'setup', instructions: [vault.createVault(creator, mint, args, buyMints), ...hookPrepare], signers: ['creator', 'mint'] },
    { label: 'launch', instructions: [launchIx], signers: ['creator', 'mint'] },
    { label: 'open', instructions: [vault.openVault(creator, vaultViewOf(mint, args), coin)], signers: ['creator'] },
  ];
}

export type VaultPolicyView = Pick<Vault, 'nSlots' | 'slots' | 'bountyBps' | 'maxSellBps' | 'interval' | 'maxHookCutBps'> | CreateVaultArgs;

const usedSlots = (v: VaultPolicyView): { policy: VaultPolicyName; target: PublicKey; maxCutBps: number }[] =>
  'nSlots' in v ? v.slots.slice(0, v.nSlots).map((s) => ({ policy: s.policy, target: s.target, maxCutBps: s.maxCutBps })) : v.slots.map((s) => ({ policy: s.policy, target: s.target ?? PublicKey.default, maxCutBps: s.maxCutBps ?? 0 }));

/** Whether a vault sells any cut for SOL to a wallet: a creator tax in effect, and labelled as one. */
export const vaultIsCreatorTax = (v: VaultPolicyView): boolean => usedSlots(v).some((s) => s.policy === 'sellForSol');

const percent = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
function duration(secs: number): string {
  const units: [number, string][] = [[86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [n, unit] of units) if (secs >= n && secs % n === 0) return `${secs / n} ${unit}${secs / n === 1 ? '' : 's'}`;
  return `${secs} seconds`;
}

/**
 * A vault's policy in plain words, one sentence a line: each slot's policy, then the terms every
 * slot runs under. A slot that sells for SOL to a wallet is said to be what it is: a creator tax.
 * `vault` null is a coin whose hook sends cuts to vault slots although no vault was made before its
 * launch (none can be made after): nothing can ever move those cuts. `name` shows a wallet or a
 * pool (default: its address).
 */
export function vaultPolicyWords(v: VaultPolicyView | null, name: (key: PublicKey) => string = (k) => k.toBase58()): string[] {
  if (!v) return ['No vault: this coin’s hook sends cuts to vault slots, but no vault was made for it before its launch, and none can be made now. Those cuts can never be sold, burned or moved.'];
  const lines = usedSlots(v).map((s, i) => {
    const slot = `Slot ${i + 1}`;
    switch (s.policy) {
      case 'burn':
        return `${slot}: its cut is burned.`;
      case 'sellForSol':
        return `${slot}: its cut is sold for SOL to ${name(s.target)}. This is a creator tax in effect: that wallet is paid from every trade the hook takes this cut of.`;
      case 'sellBuyBurn':
        return `${slot}: its cut is sold for SOL, which buys the token of the pool ${name(s.target)} and burns it${s.maxCutBps > 0 ? `, accepting up to ${percent(s.maxCutBps)} of each buy taken by that token’s own hook` : ''}.`;
      default:
        return `${slot}: unused.`;
    }
  });
  const selling = usedSlots(v).filter((s) => s.policy === 'sellForSol' || s.policy === 'sellBuyBurn').length;
  if (selling > 0) {
    const split = selling > 1 ? `, split evenly: each of its ${selling} selling slots sells at most ${percent(v.maxSellBps / selling)} of it a sale` : '';
    lines.push(`The vault sells at most ${percent(v.maxSellBps)} of the pool’s SOL side every ${duration(v.interval)} (less on a low-fee pool)${split}, each slot at least ${duration(v.interval)} apart, never at less than the pool’s own price less fees and 2%, and waits while the price is more than ${percent(VAULT_LIMITS.maxDiscountBps)} below its reference (trying again a minute later).`);
  }
  if (v.maxHookCutBps > 0) lines.push(`The coin’s own hook may take up to ${percent(v.maxHookCutBps)} of each of the vault’s sales.`);
  lines.push(v.bountyBps > 0 ? `Whoever runs a step earns ${percent(v.bountyBps)} of the SOL it moves.` : 'Whoever runs a step earns nothing for it.');
  lines.push('A slot nobody runs for 60 days is retired: what it holds is burned, paying nobody.');
  return lines;
}
