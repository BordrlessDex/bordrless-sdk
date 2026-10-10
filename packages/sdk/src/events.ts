/**
 * The programs' events, read from a transaction's inner instructions: a self-CPI whose data is
 * `EVENT_IX_TAG_LE ‖ discriminator ‖ Borsh`, decoded with the IDL coders. Numbered in execution
 * order, which is the ordinal the indexer keys rows by. One transaction carries events of several
 * programs (the token program's inside every DEX, launch, kit and bridge instruction; the kit's
 * `KitInstalled` inside `create_launch` and `KitGraduated` inside `graduate`): each is decoded by
 * the program that emitted it. The kit's callbacks emit nothing.
 *
 * `eventsOf` gives every event with its fields flattened to JSON-safe values; `typedEvent` reads
 * the v2 events the indexer builds rows from into typed objects (amounts as bigint, keys as base58).
 */
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { launchRulesData, type LaunchRulesData } from './accounts.ts';
import { CODERS, type ProgramName } from './coders.ts';

/** `sha256("anchor:event")[..8]`, little-endian as Anchor writes it. */
export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const PROGRAM_OF: ReadonlyMap<string, ProgramName> = new Map([
  [a.TOKEN_PROGRAM.toBase58(), 'token'],
  [a.SWAP_PROGRAM.toBase58(), 'swap'],
  [a.BRIDGE_PROGRAM.toBase58(), 'bridge'],
  [a.LAUNCH_PROGRAM.toBase58(), 'launch'],
  [a.KIT_PROGRAM.toBase58(), 'kit'],
  [a.TAX_HOOK_PROGRAM.toBase58(), 'taxHook'],
  [a.HALF_LIFE_PROGRAM.toBase58(), 'halfLife'],
]);

/** Every program the SDK has a coder for, by id: the indexed ones above, the companion, the lottery hook, `hook_timelock` and `hook_vault`. */
const ANY_PROGRAM_OF: ReadonlyMap<string, ProgramName> = new Map<string, ProgramName>([...PROGRAM_OF, [a.COMPANION_PROGRAM.toBase58(), 'companion'], [a.LOTTERY_HOOK_PROGRAM.toBase58(), 'lotteryHook'], [a.HOOK_TIMELOCK_PROGRAM.toBase58(), 'hookTimelock'], [a.HOOK_VAULT_PROGRAM.toBase58(), 'hookVault']]);

/** The SDK's name of a Bordrless program id whose events the indexer reads (`INDEXED_EVENT_PROGRAMS`); null for any other program. */
export const programNameOf = (programId: string | PublicKey): ProgramName | null => PROGRAM_OF.get(typeof programId === 'string' ? programId : programId.toBase58()) ?? null;
/** The SDK's name of any Bordrless program id it has a coder for, the companion and the lottery hook included; null for any other program. */
export const anyProgramNameOf = (programId: string | PublicKey): ProgramName | null => ANY_PROGRAM_OF.get(typeof programId === 'string' ? programId : programId.toBase58()) ?? null;

/**
 * The programs whose events `eventsOf` reads unless told otherwise: what the indexer stores, keyed
 * by ordinal. The companion's and the lottery hook's events (`GAME_EVENT_PROGRAMS`: a game's draw
 * history, `DrawCommitted` … `PrizePaid`, `RolledOver`, `Entered`) are read when asked for, so the
 * ordinals of a transaction the indexer already stored never change.
 */
export const INDEXED_EVENT_PROGRAMS: readonly ProgramName[] = [...PROGRAM_OF.values()];
/** The companion and the lottery hook: pass `[...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS]` to `eventsOf` to read a game's events too. */
export const GAME_EVENT_PROGRAMS: readonly ProgramName[] = ['companion', 'lotteryHook'];

export interface DecodedEvent {
  ordinal: number;
  program: ProgramName;
  programId: string;
  /** The IDL's event name, camel-cased by the coder (`transferred`, `swapped`, `kitInstalled`…). */
  name: string;
  /** Pubkeys as base58 strings, integers as decimal strings, `bytes` as 0x-hex, byte arrays as number arrays, nested objects kept. */
  data: Record<string, unknown>;
}

/** An inner instruction as the RPC's `json` encoding gives it. */
export interface RawInnerInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

/** Flattens a value the Borsh coder produced into JSON-safe strings. */
export function flatten(value: unknown): unknown {
  if (value instanceof BN) return value.toString(10);
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(flatten);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = flatten(v);
    return out;
  }
  return value;
}

/** Decodes one self-CPI payload (after the tag) for `program`. */
export function decodeEventPayload(program: ProgramName, payload: Buffer): { name: string; data: Record<string, unknown> } | null {
  try {
    const ev = CODERS[program].events.decode(payload.toString('base64')) as { name: string; data: unknown } | null;
    if (!ev) return null;
    return { name: ev.name, data: flatten(ev.data) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Every event of a transaction, from its inner instructions, in order. `accountKeys` is the full key
 * list (static, then lookup-table writable, then readonly: v0 transactions load the event authorities
 * from the protocol table); `inner` is every inner instruction in execution order; `decodeData`
 * turns the RPC's base58 data into bytes; `programs` are the programs whose events are read
 * (`INDEXED_EVENT_PROGRAMS` by default), and ordinals count only those.
 */
export function eventsOf(accountKeys: string[], inner: RawInnerInstruction[], decodeData: (data: string) => Buffer, programs: readonly ProgramName[] = INDEXED_EVENT_PROGRAMS): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const ix of inner) {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId) continue;
    const program = ANY_PROGRAM_OF.get(programId);
    if (!program || !programs.includes(program)) continue;
    const bytes = decodeData(ix.data);
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
    // A real event CPI has the event authority as its only account.
    if (ix.accounts.length !== 1 || accountKeys[ix.accounts[0]!] !== a.eventAuthority(new PublicKey(programId)).toBase58()) continue;
    const decoded = decodeEventPayload(program, bytes.subarray(8));
    if (!decoded) continue;
    out.push({ ordinal: out.length, program, programId, name: decoded.name, data: decoded.data });
  }
  return out;
}

// ---- typed v2 events -------------------------------------------------------------------------------

/** A delta the token program applied for a hook's `before_transfer` answer. */
export interface DeltaApplied {
  holding: string;
  owner: string;
  amount: bigint;
  /** The holding's balance after it. */
  post: bigint;
}

/** token `Transferred` (v2: `deltas` replaces v1's single delta; hook data is never in an event). */
export interface TransferredEvent {
  kind: 'token.Transferred';
  mint: string;
  source: string;
  destination: string;
  sourceOwner: string;
  destinationOwner: string;
  authority: string;
  amount: bigint;
  deltas: DeltaApplied[];
  sourcePost: bigint;
  destinationPost: bigint;
  slot: bigint;
  ts: number;
}

/** token `HookDataWritten` (new): the mint's hook replaced a holding's 64 bytes through `write_hook_data` (the kit's `claim`). */
export interface HookDataWrittenEvent {
  kind: 'token.HookDataWritten';
  mint: string;
  holding: string;
  owner: string;
  data: Uint8Array;
}

/** A delta a pool hook's answer paid: the amount sent (a token hook on that mint may take its own cut). */
export interface DeltaPaid {
  holding: string;
  amount: bigint;
}

/**
 * swap `Swapped` (v2). On a launch pool: the creator fee is the delta to the launch's quote holding,
 * the holder fee the delta to the holder vault (`deltasIn` on buys, `deltasOut` on sells); the trade
 * burn is `burnOut` on buys, `burnIn` on sells; `protocolFee` is always in quote. `amountOut` is the
 * curve's output (before a sell's protocol fee), `receivedIn` what reached the input vault,
 * `deliveredOut` what the recipient's holding gained.
 */
export interface SwappedEvent {
  kind: 'swap.Swapped';
  pool: string;
  trader: string;
  recipient: string;
  /** 1 buy (quote in), 0 sell. */
  direction: number;
  amountIn: bigint;
  deltasIn: DeltaPaid[];
  burnIn: bigint;
  /** What the hooks took from the input that someone receives (§3.1): `amountIn - burnIn - receivedIn`. Bordrless's share under the share model is of these. */
  cutsIn: bigint;
  receivedIn: bigint;
  lpFee: bigint;
  /** Bordrless's take, always in quote: a flat rate of the quote, or its share of the cuts (the two sides' shares added). */
  protocolFee: bigint;
  lpFeeBps: number;
  amountOut: bigint;
  deltasOut: DeltaPaid[];
  burnOut: bigint;
  /** What the hooks took from the output that someone receives: `amountOut - burnOut - held - deliveredOut`. */
  cutsOut: bigint;
  deliveredOut: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  swapCount: bigint;
  slot: bigint;
  ts: number;
}

/** swap `ProtocolFeesCollected` (v2: quote only; v1's `base_amount` is gone). */
export interface ProtocolFeesCollectedEvent {
  kind: 'swap.ProtocolFeesCollected';
  pool: string;
  quoteAmount: bigint;
  collector: string;
  ts: number;
}

/** launch `LaunchCreated` (v2: the rules, the modules, the kit config and holder vault, the absolute unlock times, 0 when off). */
export interface LaunchCreatedEvent {
  kind: 'launch.LaunchCreated';
  launch: string;
  mint: string;
  creator: string;
  pool: string;
  quoteMint: string;
  lpMint: string;
  name: string;
  symbol: string;
  uri: string;
  supply: bigint;
  decimals: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  sniperWindowSecs: number;
  sniperStartBps: number;
  virtualQuote: bigint;
  virtualBase: bigint;
  graduationQuote: bigint;
  curveTokens: bigint;
  reserveTokens: bigint;
  launchFeeLamports: bigint;
  rules: LaunchRulesData;
  modules: number;
  /** With kit modules. */
  kitConfig: string | null;
  /** With holder rewards. */
  holderVault: string | null;
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  /** The `LaunchConfig` the launch was made from (§5.7); null for inline rules. */
  config: string | null;
  /** The creator's own token hook (§5.8); null for the kit or none. */
  customHook: string | null;
  /** Its flags; 0 without one. */
  customHookFlags: number;
  slot: bigint;
  ts: number;
}

/** launch `LaunchConfigCreated` (§5.7): a `LaunchConfig` was made with `create_config`. */
export interface LaunchConfigCreatedEvent {
  kind: 'launch.LaunchConfigCreated';
  config: string;
  creator: string;
  rules: LaunchRulesData;
  creatorFeeBps: number;
  customHook: string | null;
  customHookFlags: number;
  label: string;
  ts: number;
}

/** launch `ConfigListed`: a config made for the marketplace (`create_listed_config`), after its `LaunchConfigCreated`. */
export interface ConfigListedEvent {
  kind: 'launch.ConfigListed';
  config: string;
  author: string;
  authorShareBps: number;
  ts: number;
}

/** launch `AuthorFeesPaid`: a listed config's author's part of a claim of a launch's creator fees, whoever claimed. */
export interface AuthorFeesPaidEvent {
  kind: 'launch.AuthorFeesPaid';
  launch: string;
  mint: string;
  config: string;
  author: string;
  amount: bigint;
  paidTotal: bigint;
  slot: bigint;
  ts: number;
}

/** kit `KitInstalled`: in the `create_launch` transaction of a launch with kit rules. */
export interface KitInstalledEvent {
  kind: 'kit.KitInstalled';
  mint: string;
  kitConfig: string;
  launch: string;
  pool: string;
  creator: string;
  rewardMint: string;
  /** The default key without holder rewards. */
  rewardVault: string;
  modules: number;
  supply: bigint;
  minEligible: bigint;
  maxWalletBps: number;
  maxWalletAmount: bigint;
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  ts: number;
}

/** kit `KitGraduated`: in the `graduate` transaction of a kit launch; max wallet is lifted. */
export interface KitGraduatedEvent {
  kind: 'kit.KitGraduated';
  mint: string;
  ts: number;
}

/** kit `RewardsClaimed` (after the token program's `Transferred` and `HookDataWritten`). It carries no time: use the block's. */
export interface RewardsClaimedEvent {
  kind: 'kit.RewardsClaimed';
  mint: string;
  owner: string;
  amount: bigint;
  owedLeft: bigint;
  totalClaimed: bigint;
}

/** kit `RewardsShared` (after the token program's `Transferred`). It carries no time: use the block's. */
export interface RewardsSharedEvent {
  kind: 'kit.RewardsShared';
  mint: string;
  from: string;
  amount: bigint;
  totalShared: bigint;
}

export type TypedEvent =
  | TransferredEvent
  | HookDataWrittenEvent
  | SwappedEvent
  | ProtocolFeesCollectedEvent
  | LaunchCreatedEvent
  | LaunchConfigCreatedEvent
  | ConfigListedEvent
  | AuthorFeesPaidEvent
  | KitInstalledEvent
  | KitGraduatedEvent
  | RewardsClaimedEvent
  | RewardsSharedEvent;

type Data = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const b = (v: unknown): bigint => BigInt(String(v));
const n = (v: unknown): number => Number(v);
const optS = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const list = <T>(v: unknown, item: (d: Data) => T): T[] => (Array.isArray(v) ? (v as Data[]).map(item) : []);
const byteArray = (v: unknown): Uint8Array => (typeof v === 'string' ? Uint8Array.from(Buffer.from(v.replace(/^0x/, ''), 'hex')) : Uint8Array.from(v as ArrayLike<number>));

/** `Program.Name` with the event name in PascalCase, whatever case the coder gave it. */
export const eventKey = (ev: Pick<DecodedEvent, 'program' | 'name'>): string => `${ev.program}.${ev.name.charAt(0).toUpperCase()}${ev.name.slice(1)}`;

/** The typed view of a v2 event the indexer reads; null for any other event. */
export function typedEvent(ev: DecodedEvent): TypedEvent | null {
  const d = ev.data;
  switch (eventKey(ev)) {
    case 'token.Transferred':
      return {
        kind: 'token.Transferred',
        mint: s(d.mint),
        source: s(d.source),
        destination: s(d.destination),
        sourceOwner: s(d.sourceOwner),
        destinationOwner: s(d.destinationOwner),
        authority: s(d.authority),
        amount: b(d.amount),
        deltas: list(d.deltas, (x) => ({ holding: s(x.holding), owner: s(x.owner), amount: b(x.amount), post: b(x.post) })),
        sourcePost: b(d.sourcePost),
        destinationPost: b(d.destinationPost),
        slot: b(d.slot),
        ts: n(d.ts),
      };
    case 'token.HookDataWritten':
      return { kind: 'token.HookDataWritten', mint: s(d.mint), holding: s(d.holding), owner: s(d.owner), data: byteArray(d.data) };
    case 'swap.Swapped':
      return {
        kind: 'swap.Swapped',
        pool: s(d.pool),
        trader: s(d.trader),
        recipient: s(d.recipient),
        direction: n(d.direction),
        amountIn: b(d.amountIn),
        deltasIn: list(d.deltasIn, (x) => ({ holding: s(x.holding), amount: b(x.amount) })),
        burnIn: b(d.burnIn),
        cutsIn: b(d.cutsIn ?? 0),
        receivedIn: b(d.receivedIn),
        lpFee: b(d.lpFee),
        protocolFee: b(d.protocolFee),
        lpFeeBps: n(d.lpFeeBps),
        amountOut: b(d.amountOut),
        deltasOut: list(d.deltasOut, (x) => ({ holding: s(x.holding), amount: b(x.amount) })),
        burnOut: b(d.burnOut),
        cutsOut: b(d.cutsOut ?? 0),
        deliveredOut: b(d.deliveredOut),
        baseReserve: b(d.baseReserve),
        quoteReserve: b(d.quoteReserve),
        virtualBase: b(d.virtualBase),
        virtualQuote: b(d.virtualQuote),
        swapCount: b(d.swapCount),
        slot: b(d.slot),
        ts: n(d.ts),
      };
    case 'swap.ProtocolFeesCollected':
      return { kind: 'swap.ProtocolFeesCollected', pool: s(d.pool), quoteAmount: b(d.quoteAmount), collector: s(d.collector), ts: n(d.ts) };
    case 'launch.LaunchCreated':
      return {
        kind: 'launch.LaunchCreated',
        launch: s(d.launch),
        mint: s(d.mint),
        creator: s(d.creator),
        pool: s(d.pool),
        quoteMint: s(d.quoteMint),
        lpMint: s(d.lpMint),
        name: s(d.name),
        symbol: s(d.symbol),
        uri: s(d.uri),
        supply: b(d.supply),
        decimals: n(d.decimals),
        creatorFeeBps: n(d.creatorFeeBps),
        lpFeeBps: n(d.lpFeeBps),
        sniperWindowSecs: n(d.sniperWindowSecs),
        sniperStartBps: n(d.sniperStartBps),
        virtualQuote: b(d.virtualQuote),
        virtualBase: b(d.virtualBase),
        graduationQuote: b(d.graduationQuote),
        curveTokens: b(d.curveTokens),
        reserveTokens: b(d.reserveTokens),
        launchFeeLamports: b(d.launchFeeLamports),
        rules: launchRulesData(d.rules),
        modules: n(d.modules),
        kitConfig: optS(d.kitConfig),
        holderVault: optS(d.holderVault),
        creatorUnlockAt: n(d.creatorUnlockAt),
        earlyWindowEnd: n(d.earlyWindowEnd),
        earlyUnlockAt: n(d.earlyUnlockAt),
        config: optS(d.config),
        customHook: optS(d.customHook),
        customHookFlags: n(d.customHookFlags ?? 0),
        slot: b(d.slot),
        ts: n(d.ts),
      };
    case 'launch.LaunchConfigCreated':
      return { kind: 'launch.LaunchConfigCreated', config: s(d.config), creator: s(d.creator), rules: launchRulesData(d.rules), creatorFeeBps: n(d.creatorFeeBps), customHook: optS(d.customHook), customHookFlags: n(d.customHookFlags), label: s(d.label), ts: n(d.ts) };
    case 'launch.ConfigListed':
      return { kind: 'launch.ConfigListed', config: s(d.config), author: s(d.author), authorShareBps: n(d.authorShareBps), ts: n(d.ts) };
    case 'launch.AuthorFeesPaid':
      return { kind: 'launch.AuthorFeesPaid', launch: s(d.launch), mint: s(d.mint), config: s(d.config), author: s(d.author), amount: b(d.amount), paidTotal: b(d.paidTotal), slot: b(d.slot), ts: n(d.ts) };
    case 'kit.KitInstalled':
      return {
        kind: 'kit.KitInstalled',
        mint: s(d.mint),
        kitConfig: s(d.kitConfig),
        launch: s(d.launch),
        pool: s(d.pool),
        creator: s(d.creator),
        rewardMint: s(d.rewardMint),
        rewardVault: s(d.rewardVault),
        modules: n(d.modules),
        supply: b(d.supply),
        minEligible: b(d.minEligible),
        maxWalletBps: n(d.maxWalletBps),
        maxWalletAmount: b(d.maxWalletAmount),
        creatorUnlockAt: n(d.creatorUnlockAt),
        earlyWindowEnd: n(d.earlyWindowEnd),
        earlyUnlockAt: n(d.earlyUnlockAt),
        ts: n(d.ts),
      };
    case 'kit.KitGraduated':
      return { kind: 'kit.KitGraduated', mint: s(d.mint), ts: n(d.ts) };
    case 'kit.RewardsClaimed':
      return { kind: 'kit.RewardsClaimed', mint: s(d.mint), owner: s(d.owner), amount: b(d.amount), owedLeft: b(d.owedLeft), totalClaimed: b(d.totalClaimed) };
    case 'kit.RewardsShared':
      return { kind: 'kit.RewardsShared', mint: s(d.mint), from: s(d.from), amount: b(d.amount), totalShared: b(d.totalShared) };
    default:
      return null;
  }
}

/**
 * A launch-pool swap's fees as `Swapped` tells them (programs-summary §2.6): the creator fee (the
 * delta to the launch's quote holding), the holder fee (the delta to the holder vault) and the trade
 * burn, given the launch's quote holding and holder vault.
 */
export function launchSwapCuts(ev: SwappedEvent, launchQuoteHolding: string, holderVault: string): { creatorFee: bigint; holderFee: bigint; burn: bigint } {
  const deltas = ev.direction === 1 ? ev.deltasIn : ev.deltasOut;
  const sum = (holding: string): bigint => deltas.filter((x) => x.holding === holding).reduce((t, x) => t + x.amount, 0n);
  return { creatorFee: sum(launchQuoteHolding), holderFee: sum(holderVault), burn: ev.direction === 1 ? ev.burnOut : ev.burnIn };
}
