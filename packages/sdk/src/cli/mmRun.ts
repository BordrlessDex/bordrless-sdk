/**
 * `bordrless mm`: a self-custodied market maker for one token's pool on the Bordrless DEX, run by
 * the person who holds the key (a creator's fee wallet, as a rule). Bordrless hosts nothing and
 * holds nothing: this process reads the chain over the RPC you name, decides with cli/mm.ts, builds
 * each swap exactly as the site's API does (apps/server/src/trade: the holdings created
 * idempotently, plain SOL wrapped into bridged SOL on the way in, the token's hook slice and the
 * pool hook's extras resolved from their registries, a launch pool's swap through the launch
 * program with the kit's accounts or the creator's own hook), signs with your keypair and sends
 * with confirmation. A sell's proceeds stay in bridged SOL, which the next buy spends first.
 *
 * The pool: the deepest pool quoted in bridged SOL with the mint on the base side, read from the
 * DEX's `Pool` accounts (a launch pool counts once graduated; one still on its curve does not), or
 * the one `--pool` names. Every trade is dry-run first: the compute limit is what it used plus
 * 15%, and when the token runs a hook of its own (not the kit, whose cuts the quote models) the
 * dry run measures what actually arrives and the minimum out follows it, as the API does for a
 * creator's hook. `--dry-run` stops there and prints the plan and the simulation.
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, type AddressLookupTableAccount, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { KIT_MODULES, SOL_DECIMALS, quoteLaunchSwap, sniperLpFee, swapAmounts, type LaunchFeeParams, type Reserves, type Side } from '@bordrless/shared';
import { FEE_MODEL_SHARE, decodeHolding, decodeKitConfig, decodeLaunch, decodeMint, decodePool, type KitConfig, type Launch, type Mint, type Pool } from '../accounts.ts';
import { BRIDGED_SOL_MINT, KIT_PROGRAM, LAUNCH_PROGRAM, SWAP_PROGRAM, TOKEN_PROGRAM, dexHookSigner, holdingAddress, kitConfigAddress, launchAddress, vaultAddress } from '../addresses.ts';
import { CODERS } from '../coders.ts';
import { explainFailure } from '../errors.ts';
import { fetchCustomHookAccounts, fetchHookAccountList, poolHookAccounts, tokenHookOf, type CustomHookAccounts, type HookAccountList, type TokenHook } from '../hooks.ts';
import { bridge, launch as launchIx, launchKeysOf, setComputeUnitLimit, setComputeUnitPrice, swap as swapIx, token } from '../instructions.ts';
import { buildV0Transaction, checkProtocolLookupTable } from '../transactions.ts';
import { MAX_COMPUTE_UNITS, priorityFeeOf, simulatedLimit, solanaConfig } from './bordrless.ts';
import { POOL_BASE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET, buySize, decide, fillPrice, formatBps, formatPrice, formatUnits, minOutOf, moveBps, parsePrice, referenceAfter, rulesOf, sellSize, spotPrice, type Decision, type Price, type Quoter, type Rules, type Wallet } from './mm.ts';

/** The protocol lookup table Bordrless keeps on mainnet (docs/hooks-v2.md §6); `--lookup-table` or `PROTOCOL_LOOKUP_TABLE` name another, `none` builds without one. */
export const MAINNET_PROTOCOL_LOOKUP_TABLE = new PublicKey('4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ');
/** The compute limit requested when a trade cannot be dry-run (the API's fallback for a trade). */
export const TRADE_FALLBACK_UNITS = 400_000;
/** The priority fee when none is given, the API's on mainnet: 20,000 micro-lamports a unit. `--priority-fee 0` sends none. */
export const DEFAULT_PRIORITY_MICROLAMPORTS = 20_000;
/** The line every run prints. */
export const DISCLOSURE = 'This bot trades with your money on a public pool; its trades count as volume. Disclose it.';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const stamp = (): string => `${new Date().toISOString().slice(11, 19)}Z`;
const signed = (bps: number): string => `${bps > 0 ? '+' : bps < 0 ? '-' : ''}${formatBps(Math.abs(bps))}`;
const utc = (unix: number): string => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const reservesOf = (pool: Pool): Reserves => ({ baseReserve: pool.baseReserve, quoteReserve: pool.quoteReserve, virtualBase: pool.virtualBase, virtualQuote: pool.virtualQuote });

/** The market the bot trades: the pool and what building a swap on it takes, read once. */
export interface Market {
  mint: PublicKey;
  token: Mint;
  poolKey: PublicKey;
  pool: Pool;
  /** The launch whose pool this is (graduated), with its kit and the creator's own hook; null for an ordinary pool. */
  launch: Launch | null;
  kit: KitConfig | null;
  customHook: CustomHookAccounts | null;
  /** An ordinary pool's registries: the base mint's hook (null without one) and the pool hook's. */
  baseHookList: HookAccountList | null;
  poolHookList: HookAccountList | null;
}

function keypairFrom(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

/** `--rpc` (or `--url`), else `BORDRLESS_RPC_URL` or `SOLANA_RPC_URL`, else the Solana CLI's URL, else the public mainnet RPC. */
export function rpcUrlOf(flags: Record<string, string | true>, env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ['rpc', 'url']) {
    const f = flags[name];
    if (f === true) throw new Error(`--${name} takes a URL`);
    if (typeof f === 'string') return f;
  }
  return env.BORDRLESS_RPC_URL || env.SOLANA_RPC_URL || solanaConfig().url || 'https://api.mainnet-beta.solana.com';
}

/** The RPC's host, never its query string (an API key travels there). */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---- the pool ------------------------------------------------------------------------------------

/** Every DEX pool with `mint` on the base side and bridged SOL on the quote side, decoded. */
async function poolsOf(connection: Connection, mint: PublicKey): Promise<{ poolKey: PublicKey; pool: Pool }[]> {
  const disc = CODERS.swap.accounts.memcmp('pool') as { offset?: number; bytes?: string };
  const filters = [
    ...(disc.bytes ? [{ memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes } }] : []),
    { memcmp: { offset: POOL_BASE_MINT_OFFSET, bytes: mint.toBase58() } },
    { memcmp: { offset: POOL_QUOTE_MINT_OFFSET, bytes: BRIDGED_SOL_MINT.toBase58() } },
  ];
  const found = await connection.getProgramAccounts(SWAP_PROGRAM, { commitment: 'confirmed', filters });
  return found.map(({ pubkey, account }) => ({ poolKey: pubkey, pool: decodePool(account.data) })).filter(({ pool }) => pool.baseMint.equals(mint) && pool.quoteMint.equals(BRIDGED_SOL_MINT));
}

/** The deepest pool by quote reserve among those not on a curve (the API's rule for the pool it charts); a clear refusal otherwise. */
export function deepestPool<P extends { pool: Pick<Pool, 'quoteReserve' | 'curve'> }>(pools: readonly P[], mint: PublicKey): P {
  const open = pools.filter((p) => !p.pool.curve);
  if (open.length === 0) {
    if (pools.length > 0) throw new Error(`${mint.toBase58()} trades only on a launch still on its curve: the bot trades a launch pool after graduation, or an ordinary pool`);
    throw new Error(`no pool quoted in bridged SOL trades ${mint.toBase58()} on this cluster`);
  }
  return [...open].sort((a, b) => (a.pool.quoteReserve > b.pool.quoteReserve ? -1 : a.pool.quoteReserve < b.pool.quoteReserve ? 1 : 0))[0]!;
}

async function readPool(connection: Connection, poolKey: PublicKey, mint: PublicKey): Promise<{ poolKey: PublicKey; pool: Pool }> {
  const info = await connection.getAccountInfo(poolKey, 'confirmed');
  if (!info || !info.owner.equals(SWAP_PROGRAM)) throw new Error(`${poolKey.toBase58()} is not a pool of the Bordrless DEX on this cluster`);
  const pool = decodePool(info.data);
  if (!pool.baseMint.equals(mint)) throw new Error(`${poolKey.toBase58()} trades ${pool.baseMint.toBase58()}, not ${mint.toBase58()}`);
  if (!pool.quoteMint.equals(BRIDGED_SOL_MINT)) throw new Error(`${poolKey.toBase58()} is quoted in ${pool.quoteMint.toBase58()}, not bridged SOL: the bot sizes its trades in SOL`);
  if (pool.curve) throw new Error(`${poolKey.toBase58()} is a launch still on its curve: the bot trades a launch pool after graduation, or an ordinary pool`);
  return { poolKey, pool };
}

/** The mint, its pool and everything a swap on it is built from. */
export async function loadMarket(connection: Connection, mint: PublicKey, poolFlag: string | null): Promise<Market> {
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo || !mintInfo.owner.equals(TOKEN_PROGRAM)) throw new Error(`${mint.toBase58()} is not a mint of the Bordrless token standard on this cluster`);
  const tokenMint = decodeMint(mintInfo.data);
  const { poolKey, pool } = poolFlag ? await readPool(connection, new PublicKey(poolFlag), mint) : deepestPool(await poolsOf(connection, mint), mint);
  if (pool.hookProgram?.equals(LAUNCH_PROGRAM)) {
    const launchInfo = await connection.getAccountInfo(launchAddress(mint), 'confirmed');
    if (!launchInfo || !launchInfo.owner.equals(LAUNCH_PROGRAM)) throw new Error(`${poolKey.toBase58()} is a launch pool but ${mint.toBase58()} has no launch account`);
    const launch = decodeLaunch(launchInfo.data);
    if (!launch.pool.equals(poolKey)) throw new Error(`${poolKey.toBase58()} is not the pool of ${mint.toBase58()}'s launch (${launch.pool.toBase58()})`);
    if (launch.status === 0) throw new Error(`the launch of ${mint.toBase58()} is still on its curve: the bot trades it after graduation`);
    const kitInfo = launch.modules !== 0 ? await connection.getAccountInfo(kitConfigAddress(mint), 'confirmed') : null;
    const kit = kitInfo && kitInfo.owner.equals(KIT_PROGRAM) ? decodeKitConfig(kitInfo.data) : null;
    if (launch.modules !== 0 && !kit) throw new Error('the token rules of this launch cannot be read right now');
    const customHook = launch.customHook ? await fetchCustomHookAccounts(connection, launch.customHook, mint) : null;
    if (launch.customHook && !customHook) throw new Error(`the hook of this token (${launch.customHook.toBase58()}) has no registry for the mint: its swaps cannot be built`);
    return { mint, token: tokenMint, poolKey, pool, launch, kit, customHook, baseHookList: null, poolHookList: null };
  }
  const [baseHookList, poolHookList] = await Promise.all([
    tokenMint.hookProgram ? fetchHookAccountList(connection, tokenMint.hookProgram, mint) : null,
    pool.hookProgram ? fetchHookAccountList(connection, pool.hookProgram, poolKey) : null,
  ]);
  return { mint, token: tokenMint, poolKey, pool, launch: null, kit: null, customHook: null, baseHookList, poolHookList };
}

// ---- quotes and instructions, as the API builds them -----------------------------------------------

/** The quote of a swap on this market with the pool as it stands: the shared launch math for a launch pool, the flat math for an ordinary one. */
export function quoterOf(market: Market, pool: Pool, kit: KitConfig | null, now: number): Quoter {
  const reserves = reservesOf(pool);
  const share = pool.feeModel === FEE_MODEL_SHARE ? pool.protocolShareBps : 0;
  const l = market.launch;
  if (l) {
    const rewards = kit !== null && (l.modules & KIT_MODULES.HOLDER_REWARDS) !== 0;
    const params: LaunchFeeParams = {
      creatorFeeBps: l.creatorFeeBps,
      holderFeeBuyBps: l.rules.holderFeeBuyBps,
      holderFeeSellBps: l.rules.holderFeeSellBps,
      burnBuyBps: l.rules.burnBuyBps,
      burnSellBps: l.rules.burnSellBps,
      eligible: rewards && kit ? kit.eligible : 0n,
      minEligible: rewards && kit ? kit.minEligible : 0n,
    };
    const lpFee = sniperLpFee(now, l.createdAt, l.sniperWindowSecs, l.sniperStartBps, l.lpFeeBps);
    return (side, amountIn) => {
      const q = quoteLaunchSwap(reserves, side, amountIn, lpFee, share, params);
      return q.failure !== null || q.delivered === null ? { failure: q.failure ?? 'no_output' } : { amountOut: q.delivered };
    };
  }
  // The flat rate of the quote; under the share model Bordrless takes a share of what the hooks cut, and an ordinary pool's hooks cut nothing.
  const flatBps = pool.feeModel === FEE_MODEL_SHARE ? 0 : pool.protocolFeeBps;
  return (side, amountIn) => {
    const q = swapAmounts(side, amountIn, pool.lpFeeBps, flatBps, reserves);
    return q.failure === null ? { amountOut: q.amountOut } : { failure: q.failure };
  };
}

/**
 * The instructions of one trade, in the API's order (trade/pool.ts `poolSwapInstructions`,
 * trade/prepare.ts `swapInstructions`): the bridged-SOL holding made and `wrap` lamports wrapped
 * when a buy needs plain SOL, the token holding made, then the swap. No unwrap: a sell's proceeds
 * stay bridged for the next buy.
 */
export function tradeInstructions(m: Market, owner: PublicKey, side: Side, amountIn: bigint, minOut: bigint, wrap: bigint): TransactionInstruction[] {
  const quoteMint = m.pool.quoteMint;
  const ixs: TransactionInstruction[] = [];
  if (side === 'buy') {
    if (wrap > 0n) ixs.push(token.createHolding(owner, quoteMint, owner), bridge.wrapSol(owner, wrap));
    ixs.push(token.createHolding(owner, m.mint, owner));
  } else ixs.push(token.createHolding(owner, quoteMint, owner));
  const direction = side === 'buy' ? 1 : 0;
  if (m.launch) {
    ixs.push(launchIx.swap(launchKeysOf(m.launch, m.customHook), owner, owner, direction, amountIn, minOut));
    return ixs;
  }
  // The base mint's hook as this side's transfer takes it: a buy moves the vault's tokens to the trader, the pool signing; a sell the trader's to the vault.
  const mine = holdingAddress(m.mint, owner);
  const vault = vaultAddress(m.poolKey, m.mint);
  const op = side === 'buy' ? { mint: m.mint, source: vault, destination: mine, authority: m.poolKey, sourceOwner: m.poolKey, destinationOwner: owner } : { mint: m.mint, source: mine, destination: vault, authority: owner, sourceOwner: owner, destinationOwner: m.poolKey };
  const baseHook: TokenHook | null = m.token.hookProgram ? tokenHookOf(m.token.hookProgram, m.baseHookList, op) : null;
  const poolExtras = m.pool.hookProgram ? poolHookAccounts(m.poolHookList, dexHookSigner(m.pool.hookProgram), m.poolKey, m.mint, quoteMint, owner) : [];
  // Bridged SOL has no hook, so the quote side's slice is empty whichever way the swap goes; the base side's slice follows its mint.
  const keys = { trader: owner, pool: m.poolKey, baseMint: m.mint, quoteMint, traderBase: mine, traderQuote: holdingAddress(quoteMint, owner), hookProgram: m.pool.hookProgram };
  ixs.push(swapIx.swapWithHooks(keys, { direction, amountIn, minAmountOut: minOut }, side === 'buy' ? { outHook: baseHook, poolExtras } : { inHook: baseHook, poolExtras }));
  return ixs;
}

// ---- the chain -----------------------------------------------------------------------------------

/** The protocol lookup table, when the cluster holds one that passes the check; the plain swap fits without. */
async function lookupTables(connection: Connection, flag: string | true | undefined): Promise<{ tables: AddressLookupTableAccount[]; note: string }> {
  if (flag === true) throw new Error('--lookup-table takes an address, or none');
  const text = flag ?? process.env.PROTOCOL_LOOKUP_TABLE ?? MAINNET_PROTOCOL_LOOKUP_TABLE.toBase58();
  if (text === 'none') return { tables: [], note: 'none (--lookup-table none)' };
  const key = new PublicKey(text);
  const { value } = await connection.getAddressLookupTable(key, { commitment: 'confirmed' });
  if (!value) return { tables: [], note: `${key.toBase58()} is not on this cluster; transactions are built without one` };
  const problem = checkProtocolLookupTable(value);
  if (problem) return { tables: [], note: `${key.toBase58()} not used (${problem}); transactions are built without one` };
  return { tables: [value], note: key.toBase58() };
}

interface State {
  pool: Pool;
  kit: KitConfig | null;
  wallet: Wallet;
}

/** The pool, the wallet's plain SOL and its two holdings (and the kit's eligible count for a launch), in one round trip. */
async function readState(connection: Connection, market: Market, owner: PublicKey): Promise<State> {
  const withKit = market.launch !== null && market.launch.modules !== 0;
  const keys = [market.poolKey, holdingAddress(BRIDGED_SOL_MINT, owner), holdingAddress(market.mint, owner), ...(withKit ? [kitConfigAddress(market.mint)] : [])];
  const [infos, lamports] = await Promise.all([connection.getMultipleAccountsInfo(keys, 'confirmed'), connection.getBalance(owner, 'confirmed')]);
  const poolInfo = infos[0];
  if (!poolInfo) throw new Error(`the pool ${market.poolKey.toBase58()} cannot be read`);
  const amount = (i: number): bigint => {
    const info = infos[i];
    return info && info.owner.equals(TOKEN_PROGRAM) ? decodeHolding(info.data).amount : 0n;
  };
  const kitInfo = withKit ? infos[3] : null;
  return { pool: decodePool(poolInfo.data), kit: kitInfo ? decodeKitConfig(kitInfo.data) : market.kit, wallet: { lamports: BigInt(lamports), bridgedSol: amount(1), tokens: amount(2) } };
}

type Prepared =
  | { ok: true; tx: VersionedTransaction; units: number; measured: boolean; blockhash: string; lastValidBlockHeight: number; minOut: bigint; expectedOut: bigint; hookCut: bigint | null; logs: string[] }
  | { ok: false; error: string; logs: string[] };

/**
 * The trade dry-run and built: simulated at the maximum limit (signatures not checked), then built
 * with what it used plus 15%. With a hook of the token's own on the base side the dry run runs with
 * no minimum and watches the receiving holding: what arrives sets `expectedOut` and the minimum out
 * (the API's `measureHookedDelivery`). A failing dry run is the refusal, explained from the logs.
 */
async function prepareTrade(connection: Connection, market: Market, owner: PublicKey, side: Side, decision: Extract<Decision, { action: 'buy' | 'sell' }>, rules: Rules, wallet: Wallet, tables: AddressLookupTableAccount[], priority: number | null): Promise<Prepared> {
  const measure = market.token.hookProgram !== null && !market.token.hookProgram.equals(KIT_PROGRAM);
  const receiving = holdingAddress(side === 'buy' ? market.mint : BRIDGED_SOL_MINT, owner);
  const before = side === 'buy' ? wallet.tokens : wallet.bridgedSol;
  const wrap = decision.action === 'buy' ? decision.wrap : 0n;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const build = (minOut: bigint, units: number): VersionedTransaction =>
    buildV0Transaction(owner, [setComputeUnitLimit(units), ...(priority ? [setComputeUnitPrice(BigInt(priority))] : []), ...tradeInstructions(market, owner, side, decision.amountIn, minOut, wrap)], blockhash, tables);
  const probe = build(measure ? 0n : decision.minOut, MAX_COMPUTE_UNITS);
  const sim = await connection.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', ...(measure ? { accounts: { encoding: 'base64' as const, addresses: [receiving.toBase58()] } } : {}) });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) return { ok: false, error: explainFailure(logs, sim.value.err)?.explanation ?? JSON.stringify(sim.value.err), logs };
  let expectedOut = decision.expectedOut;
  let minOut = decision.minOut;
  let hookCut: bigint | null = null;
  if (measure) {
    const data = sim.value.accounts?.[0]?.data?.[0];
    if (!data) return { ok: false, error: 'the dry run did not return the receiving holding; nothing sent', logs };
    const after = decodeHolding(Buffer.from(data, 'base64')).amount;
    const delivered = after > before ? after - before : 0n;
    if (delivered <= 0n) return { ok: false, error: 'the token’s hook takes all of this trade: nothing would arrive', logs };
    hookCut = decision.expectedOut > delivered ? decision.expectedOut - delivered : 0n;
    expectedOut = delivered;
    minOut = minOutOf(delivered, rules.slippageBps);
  }
  const used = sim.value.unitsConsumed ?? 0;
  const units = used > 0 ? simulatedLimit(used) : TRADE_FALLBACK_UNITS;
  return { ok: true, tx: build(minOut, units), units, measured: used > 0, blockhash, lastValidBlockHeight, minOut, expectedOut, hookCut, logs };
}

type Sent = { ok: true; signature: string } | { ok: false; error: string; signature: string | null };

/** Signs, sends with preflight and waits for confirmation; a failure is explained from the logs. */
async function sendTrade(connection: Connection, prepared: Extract<Prepared, { ok: true }>, signer: Keypair): Promise<Sent> {
  prepared.tx.sign([signer]);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(prepared.tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  } catch (error) {
    const e = error as { logs?: string[]; message?: string };
    return { ok: false, error: explainFailure(e.logs ?? [])?.explanation ?? e.message ?? String(error), signature: null };
  }
  try {
    const result = await connection.confirmTransaction({ signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, 'confirmed');
    if (result.value.err) {
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
      return { ok: false, error: explainFailure(tx?.meta?.logMessages ?? [], result.value.err)?.explanation ?? JSON.stringify(result.value.err), signature };
    }
    return { ok: true, signature };
  } catch (error) {
    return { ok: false, error: `not confirmed before the blockhash expired (${error instanceof Error ? error.message : String(error)})`, signature };
  }
}

// ---- the run -------------------------------------------------------------------------------------

const describeHook = (program: PublicKey | null): string => (program === null ? 'none' : program.equals(KIT_PROGRAM) ? 'the kit (Bordrless token rules)' : `${program.toBase58()} (the creator’s own)`);

function printHeader(market: Market, state: State, rules: Rules, ref: Price, refFromFlag: boolean, owner: PublicKey, host: string, table: string, priority: number | null, dryRun: boolean, once: boolean, now: number): void {
  const { token: t, pool } = market;
  const sym = t.symbol || 'tokens';
  const price = (p: Price): string => `${formatPrice(p, t.decimals, SOL_DECIMALS)} SOL per ${sym}`;
  const spot = spotPrice(reservesOf(state.pool));
  out(`bordrless mm · ${host} · wallet ${owner.toBase58()}`);
  out(`Token      ${sym} (${t.name}) ${market.mint.toBase58()} · ${t.decimals} decimals · hook: ${describeHook(t.hookProgram)}`);
  const share = pool.feeModel === FEE_MODEL_SHARE ? pool.protocolShareBps : 0;
  if (market.launch) {
    const l = market.launch;
    out(`Pool       ${market.poolKey.toBase58()} · graduated launch pool (${utc(l.graduatedAt)}) · LP fee ${formatBps(pool.lpFeeBps)} (Bordrless’s on a launch pool)`);
    out(`Fees       creator ${formatBps(l.creatorFeeBps)} · holders ${formatBps(l.rules.holderFeeBuyBps)} buy / ${formatBps(l.rules.holderFeeSellBps)} sell · burn ${formatBps(l.rules.burnBuyBps)} buy / ${formatBps(l.rules.burnSellBps)} sell · Bordrless takes ${formatBps(share)} of the creator and holder fees`);
  } else {
    const protocol = pool.feeModel === FEE_MODEL_SHARE ? `${formatBps(share)} of the hooks’ cuts` : `${formatBps(pool.protocolFeeBps)} of the SOL side`;
    out(`Pool       ${market.poolKey.toBase58()} · ordinary pool${pool.hookProgram ? ` with pool hook ${pool.hookProgram.toBase58()}` : ''} · LP fee ${formatBps(pool.lpFeeBps)} · DEX protocol fee ${protocol}`);
  }
  out(`Reserves   ${formatUnits(state.pool.baseReserve, t.decimals, 3)} ${sym} / ${formatUnits(state.pool.quoteReserve, SOL_DECIMALS, 4)} SOL${state.pool.virtualQuote > 0n || state.pool.virtualBase > 0n ? ` (virtual ${formatUnits(state.pool.virtualBase, t.decimals, 3)} / ${formatUnits(state.pool.virtualQuote, SOL_DECIMALS, 4)})` : ''} · spot ${price(spot)}`);
  const w = state.wallet;
  out(`Wallet     ${formatUnits(w.lamports, SOL_DECIMALS, 6)} SOL plain (${formatUnits(rules.reserveLamports, SOL_DECIMALS, 2)} kept for fees) · ${formatUnits(w.bridgedSol, SOL_DECIMALS, 6)} bridged SOL · ${formatUnits(w.tokens, t.decimals, 3)} ${sym}`);
  const buy = buySize(w, rules);
  const sell = sellSize(w, rules);
  out(`Can buy    ${'none' in buy ? `no: ${buy.none}` : `yes: ${formatUnits(buy.lamportsIn, SOL_DECIMALS, 6)} SOL a trade${buy.wrap > 0n ? ` (${formatUnits(buy.wrap, SOL_DECIMALS, 6)} wrapped on the way)` : ''}`}`);
  out(`Can sell   ${'none' in sell ? `no: ${sell.none}` : `yes: ${formatUnits(sell.tokensIn, t.decimals, 3)} ${sym} a trade`}`);
  out(`Rules      buy ${formatBps(rules.buyBps)} of the wallet’s SOL (at most ${formatUnits(rules.maxSolLamports, SOL_DECIMALS, 4)} SOL) when the price is ${formatBps(rules.stepBps)} below the reference; sell ${formatBps(rules.sellBps)} of its ${sym}${rules.maxTokens === null ? '' : ` (at most ${formatUnits(rules.maxTokens, t.decimals, 3)})`} when ${formatBps(rules.stepBps)} above; slippage ${formatBps(rules.slippageBps)}; every ${rules.intervalSecs} s`);
  out(`Reference  ${price(ref)}${refFromFlag ? ` (--ref; the spot is ${signed(moveBps(spot, ref))} from it)` : ' (the spot now)'}; it moves to each fill`);
  out(`Chain      lookup table ${table} · priority fee ${priority ? `${priority} µlamports/unit` : 'none'} · ${dryRun ? 'DRY RUN: every trade is simulated, nothing is sent' : 'LIVE: trades are signed and sent'}${once ? ' · one evaluation, then exit' : ''}`);
  const warnings: string[] = [];
  const l = market.launch;
  if (l && market.kit) {
    if ((l.modules & KIT_MODULES.CREATOR_LOCK) !== 0 && owner.equals(l.creator) && now < l.creatorUnlockAt) warnings.push(`the creator wallet lock holds this wallet until ${utc(l.creatorUnlockAt)}: its sells are refused until then`);
    if ((l.modules & KIT_MODULES.EARLY_LOCK) !== 0 && now < l.earlyUnlockAt) warnings.push(`tokens bought in the early-buyer window are locked until ${utc(l.earlyUnlockAt)}: a sell of them is refused`);
  }
  if (t.hookProgram && !t.hookProgram.equals(KIT_PROGRAM)) warnings.push('the token’s hook takes its cut on this bot’s trades too; each trade is dry-run and the minimum out follows what arrives');
  for (const warning of warnings) out(`Note       ${warning}`);
  out(DISCLOSURE);
  out();
}

/** `bordrless mm --mint <mint> --keypair <path> …`: see the module comment and the README. */
export async function runMarketMaker(flags: Record<string, string | true>): Promise<void> {
  const text = (name: string): string | null => {
    const f = flags[name];
    if (f === true) throw new Error(`--${name} takes a value`);
    return f ?? null;
  };
  const keypairPath = text('keypair');
  if (!keypairPath) throw new Error('bordrless mm trades with a key you hold and nobody else’s: pass --keypair <path> (Bordrless hosts nothing and holds nothing for you)');
  const mintText = text('mint');
  if (!mintText) throw new Error('--mint <mint> is required');
  const mint = new PublicKey(mintText);
  const signer = keypairFrom(keypairPath);
  const owner = signer.publicKey;
  const dryRun = flags['dry-run'] === true;
  const once = flags.once === true;
  const url = rpcUrlOf(flags);
  const connection = new Connection(url, 'confirmed');
  const priorityFlag = flags['priority-fee'];
  const priority = priorityFlag === undefined && process.env.BORDRLESS_PRIORITY_FEE === undefined ? DEFAULT_PRIORITY_MICROLAMPORTS : priorityFeeOf(priorityFlag);

  const market = await loadMarket(connection, mint, text('pool'));
  const rules = rulesOf(flags, market.token.decimals);
  const table = await lookupTables(connection, flags['lookup-table']);
  const sym = market.token.symbol || 'tokens';
  const price = (p: Price): string => formatPrice(p, market.token.decimals, SOL_DECIMALS);
  const now = (): number => Math.floor(Date.now() / 1000);

  let state = await readState(connection, market, owner);
  const refText = text('ref');
  let ref: Price = refText ? parsePrice(refText, market.token.decimals, SOL_DECIMALS) : spotPrice(reservesOf(state.pool));
  printHeader(market, state, rules, ref, refText !== null, owner, hostOf(url), table.note, priority, dryRun, once, now());

  let fills = 0;
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    out(`${stamp()}  stopping after this evaluation (again to quit at once)`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const evaluate = async (): Promise<void> => {
    state = await readState(connection, market, owner);
    const spot = spotPrice(reservesOf(state.pool));
    const decision = decide(spot, ref, rules, state.wallet, quoterOf(market, state.pool, state.kit, now()));
    const head = `${stamp()}  ${price(spot)} SOL (${signed(decision.move)} vs ref ${price(ref)})`;
    if (decision.action === 'wait') {
      out(`${head}  wait: ${decision.reason}`);
      return;
    }
    const side: Side = decision.action;
    const amountIn = side === 'buy' ? `${formatUnits(decision.amountIn, SOL_DECIMALS, 6)} SOL` : `${formatUnits(decision.amountIn, market.token.decimals, 3)} ${sym}`;
    const amountOut = (v: bigint): string => (side === 'buy' ? `${formatUnits(v, market.token.decimals, 3)} ${sym}` : `${formatUnits(v, SOL_DECIMALS, 6)} SOL`);
    out(`${head}  ${side.toUpperCase()} ${amountIn} -> about ${amountOut(decision.expectedOut)} (min ${amountOut(decision.minOut)})${decision.action === 'buy' && decision.wrap > 0n ? `, wrapping ${formatUnits(decision.wrap, SOL_DECIMALS, 6)} SOL` : ''}`);
    const prepared = await prepareTrade(connection, market, owner, side, decision, rules, state.wallet, table.tables, priority);
    if (!prepared.ok) {
      out(`  dry run failed: ${prepared.error}`);
      for (const line of prepared.logs.slice(-4)) out(`    ${line}`);
      return;
    }
    if (prepared.hookCut !== null) out(`  the token’s hook takes ${amountOut(prepared.hookCut)} of the delivery: ${amountOut(prepared.expectedOut)} arrives, minimum out ${amountOut(prepared.minOut)}`);
    out(`  dry run ok: ${prepared.units} compute units${prepared.measured ? '' : ' (fallback)'}, ${prepared.tx.serialize().length} bytes, ${prepared.tx.message.compiledInstructions.length} instructions`);
    if (dryRun) {
      out('  dry run only: nothing sent');
      return;
    }
    const sent = await sendTrade(connection, prepared, signer);
    if (!sent.ok) {
      out(`  failed: ${sent.error}${sent.signature ? ` · ${sent.signature}` : ''}`);
      return;
    }
    const after = await readState(connection, market, owner);
    const gained = side === 'buy' ? after.wallet.tokens - state.wallet.tokens : after.wallet.bridgedSol - state.wallet.bridgedSol;
    const fill = fillPrice(side, decision.amountIn, gained > 0n ? gained : prepared.expectedOut);
    ref = referenceAfter(side, fill, spotPrice(reservesOf(after.pool)), rules.stepBps);
    fills += 1;
    out(`  filled: ${side.toUpperCase()} ${amountIn} -> ${amountOut(gained > 0n ? gained : prepared.expectedOut)} at ${price(fill)} SOL per ${sym} · ${sent.signature}`);
    out(`  reference -> ${price(ref)} SOL per ${sym}`);
    state = after;
  };

  for (;;) {
    try {
      await evaluate();
    } catch (error) {
      out(`${stamp()}  error: ${error instanceof Error ? error.message : String(error)}; trying again next interval`);
    }
    if (once || stopping) break;
    for (let waited = 0; waited < rules.intervalSecs * 1000 && !stopping; waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (stopping) break;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  out(`${stamp()}  done: ${fills} fill${fills === 1 ? '' : 's'}; reference ${price(ref)} SOL per ${sym}${fills > 0 ? ` (pass --ref ${price(ref)} to carry it on)` : ''}`);
}
