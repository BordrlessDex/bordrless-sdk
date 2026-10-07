/**
 * Program ids and every PDA the programs use (programs-summary §5). The seeds mirror the Rust
 * constants; the tests derive every fixed address again and hold it to the constants in
 * `@bordrless/shared` (`FIXED_ADDRESSES`, `HOOK_SIGNERS`), which are the values compiled into the
 * programs.
 */
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, HOOK_SIGNERS, NATIVE_MINT, PROGRAM_IDS, PROTOCOL_LOOKUP_TABLE_ADDRESSES, SYSTEM_PROGRAM_ID } from '@bordrless/shared';

export const TOKEN_PROGRAM = new PublicKey(PROGRAM_IDS.token);
export const SWAP_PROGRAM = new PublicKey(PROGRAM_IDS.swap);
export const BRIDGE_PROGRAM = new PublicKey(PROGRAM_IDS.bridge);
export const LAUNCH_PROGRAM = new PublicKey(PROGRAM_IDS.launch);
export const KIT_PROGRAM = new PublicKey(PROGRAM_IDS.kit);
export const TAX_HOOK_PROGRAM = new PublicKey(PROGRAM_IDS.taxHook);
export const SYSTEM_PROGRAM = new PublicKey(SYSTEM_PROGRAM_ID);
export const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SPL_TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
export const NATIVE_MINT_KEY = new PublicKey(NATIVE_MINT);
export const COMPUTE_BUDGET_PROGRAM = new PublicKey(COMPUTE_BUDGET_PROGRAM_ID);
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const ADDRESS_LOOKUP_TABLE_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');

const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];
const memo = new Map<string, PublicKey>();
const cached = (key: string, make: () => PublicKey): PublicKey => {
  let v = memo.get(key);
  if (!v) {
    v = make();
    memo.set(key, v);
  }
  return v;
};

/** `["hook-authority"]` of a program: a hook program's own authority (it signs `write_hook_data`, and creates the pools it hooks). */
export const hookAuthority = (program: PublicKey): PublicKey => cached(`ha:${program.toBase58()}`, () => pda([enc('hook-authority')], program));
/** `["__event_authority"]` of a program. */
export const eventAuthority = (program: PublicKey): PublicKey => cached(`ea:${program.toBase58()}`, () => pda([enc('__event_authority')], program));
/** `["config"]` of a program. */
export const configAddress = (program: PublicKey): PublicKey => cached(`cfg:${program.toBase58()}`, () => pda([enc('config')], program));
/** The ProgramData account of an upgradeable program (it holds the upgrade authority). */
export const programDataAddress = (program: PublicKey): PublicKey => pda([program.toBuffer()], BPF_LOADER_UPGRADEABLE);

export const TOKEN_EVENT_AUTHORITY = eventAuthority(TOKEN_PROGRAM);
export const SWAP_EVENT_AUTHORITY = eventAuthority(SWAP_PROGRAM);
export const BRIDGE_EVENT_AUTHORITY = eventAuthority(BRIDGE_PROGRAM);
export const LAUNCH_EVENT_AUTHORITY = eventAuthority(LAUNCH_PROGRAM);
export const KIT_EVENT_AUTHORITY = eventAuthority(KIT_PROGRAM);

// ---- hook signers (docs/hooks-v2.md, Review fixes, note 1) -------------------------------------------

/**
 * The token program's signer of every callback to the token hook `hookProgram`:
 * `["hook-authority", hookProgram]` under the token program. Token instructions of a hooked mint
 * pass it in their `hook_signer` slot; DEX instructions carry it in the mint's token-hook slice.
 */
export const tokenHookSigner = (hookProgram: PublicKey): PublicKey => cached(`ths:${hookProgram.toBase58()}`, () => pda([enc('hook-authority'), hookProgram.toBuffer()], TOKEN_PROGRAM));
/** The DEX's signer of every callback to the pool hook `hookProgram`: `["hook-authority", hookProgram]` under the DEX. */
export const dexHookSigner = (hookProgram: PublicKey): PublicKey => cached(`dhs:${hookProgram.toBase58()}`, () => pda([enc('hook-authority'), hookProgram.toBuffer()], SWAP_PROGRAM));
/** The token program's signer of the kit's callbacks (`6EsVn9…`). */
export const TOKEN_HOOK_SIGNER_KIT = new PublicKey(HOOK_SIGNERS.tokenForKit);
/** The token program's signer of `tax_hook`'s callbacks (`7xjGQo…`). */
export const TOKEN_HOOK_SIGNER_TAX_HOOK = new PublicKey(HOOK_SIGNERS.tokenForTaxHook);
/** The DEX's signer of the launch's pool callbacks (`FbMnAz9…`). */
export const DEX_HOOK_SIGNER_LAUNCH = new PublicKey(HOOK_SIGNERS.dexForLaunch);

// ---- token standard --------------------------------------------------------------------------------

/** The holding (token account) of `owner` for `mint`. */
export const holdingAddress = (mint: PublicKey, owner: PublicKey): PublicKey => pda([enc('holding'), mint.toBuffer(), owner.toBuffer()], TOKEN_PROGRAM);

// ---- DEX -------------------------------------------------------------------------------------------

export const SWAP_CONFIG = configAddress(SWAP_PROGRAM);

/** A pool of a pair with an LP fee and a hook (32 zero bytes stand for no hook). */
export function poolAddress(baseMint: PublicKey, quoteMint: PublicKey, lpFeeBps: number, hookProgram: PublicKey | null): PublicKey {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(lpFeeBps);
  return pda([enc('pool'), baseMint.toBuffer(), quoteMint.toBuffer(), fee, (hookProgram ?? PublicKey.default).toBuffer()], SWAP_PROGRAM);
}
/** The LP mint of a pool. */
export const lpMintAddress = (pool: PublicKey): PublicKey => pda([enc('lp'), pool.toBuffer()], SWAP_PROGRAM);
/** A pool's vault for `mint`: its holding. */
export const vaultAddress = (pool: PublicKey, mint: PublicKey): PublicKey => holdingAddress(mint, pool);

// ---- bridge ----------------------------------------------------------------------------------------

export const BRIDGE_CONFIG = configAddress(BRIDGE_PROGRAM);
export const SOL_VAULT = pda([enc('sol-vault')], BRIDGE_PROGRAM);
export const wrapperAddress = (underlying: PublicKey): PublicKey => pda([enc('wrapper'), underlying.toBuffer()], BRIDGE_PROGRAM);
export const wrappedMintAddress = (underlying: PublicKey): PublicKey => pda([enc('wrapped'), underlying.toBuffer()], BRIDGE_PROGRAM);
/** Bridged SOL's mint: the quote of every launch and the reward mint of every kit (it has no hook). */
export const BRIDGED_SOL_MINT = wrappedMintAddress(NATIVE_MINT_KEY);
export const SOL_WRAPPER = wrapperAddress(NATIVE_MINT_KEY);
/** The associated token account of `owner` for an SPL mint under `program`. */
export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey => pda([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
/** The vault of an SPL wrapper. */
export const bridgeVaultAddress = (underlying: PublicKey, program: PublicKey): PublicKey => associatedTokenAddress(wrapperAddress(underlying), underlying, program);

// ---- launchpad -------------------------------------------------------------------------------------

export const LAUNCH_CONFIG = configAddress(LAUNCH_PROGRAM);
/** The launch's `["hook-authority"]`: it creates launch pools and finalizes their curves (`Ehufri…`). */
export const LAUNCH_HOOK_AUTHORITY = hookAuthority(LAUNCH_PROGRAM);
export const launchAddress = (mint: PublicKey): PublicKey => pda([enc('launch'), mint.toBuffer()], LAUNCH_PROGRAM);
/** The launch's holding of its token: the reserve (the whole supply at creation, then what graduation does not take). */
export const launchReserveAddress = (mint: PublicKey): PublicKey => holdingAddress(mint, launchAddress(mint));
/** The launch's holding of the quote: creator fees, until `claim_creator_fees`. */
export const launchQuoteAddress = (mint: PublicKey, quoteMint: PublicKey): PublicKey => holdingAddress(quoteMint, launchAddress(mint));
/** The extra-accounts registry of a hook program for a mint (token hooks) or a pool (pool hooks). */
export const registryAddress = (hookProgram: PublicKey, key: PublicKey): PublicKey => pda([enc('bordrless-hook-accounts'), key.toBuffer()], hookProgram);
/** The pool of a launch (always hooked by the launch program). */
export const launchPoolAddress = (mint: PublicKey, quoteMint: PublicKey, lpFeeBps: number): PublicKey => poolAddress(mint, quoteMint, lpFeeBps, LAUNCH_PROGRAM);
/** The launch pool's registry: `["bordrless-hook-accounts", pool]` under the launch. */
export const launchRegistryAddress = (pool: PublicKey): PublicKey => registryAddress(LAUNCH_PROGRAM, pool);

// ---- the kit (docs/hooks-v2.md §4) -----------------------------------------------------------------

/** The kit's `["hook-authority"]`: it signs the token program's `write_hook_data` in `claim` (`5QehT…`). */
export const KIT_HOOK_AUTHORITY = hookAuthority(KIT_PROGRAM);
/** A token's `KitConfig`: `["kit", mint]` under the kit (it exists only with kit rules). */
export const kitConfigAddress = (mint: PublicKey): PublicKey => cached(`kc:${mint.toBase58()}`, () => pda([enc('kit'), mint.toBuffer()], KIT_PROGRAM));
/** The kit's registry for a mint: `["bordrless-hook-accounts", mint]` under the kit. */
export const kitRegistryAddress = (mint: PublicKey): PublicKey => registryAddress(KIT_PROGRAM, mint);
/** The launch's kit-caller PDA for a mint, `["kit-caller", mint]` under the launch, and its bump: it signs only the kit's `init` and `graduate`. */
export function kitCallerPda(mint: PublicKey): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync([enc('kit-caller'), mint.toBuffer()], LAUNCH_PROGRAM);
  return { address, bump };
}
/** The launch's kit-caller PDA for a mint. */
export const kitCallerAddress = (mint: PublicKey): PublicKey => cached(`kcl:${mint.toBase58()}`, () => kitCallerPda(mint).address);
/** The kit's reward vault for a mint: the kit config's holding of the reward mint (bridged SOL). It exists only with holder rewards. */
export const rewardVaultAddress = (mint: PublicKey, rewardMint: PublicKey): PublicKey => holdingAddress(rewardMint, kitConfigAddress(mint));
/** Where a launch's holder fees go (§5.4): `holding(quote, kit_config)`, the kit's reward vault; derived whatever the rules. */
export const holderVaultAddress = (mint: PublicKey, quoteMint: PublicKey): PublicKey => rewardVaultAddress(mint, quoteMint);

/**
 * The extra accounts of a launch pool's callbacks, as its registry resolves them (§5.4): the launch
 * (w) at index 5, its quote holding (w) at 6 (creator fees), the holder vault (w) at 7 (holder fees)
 * and the kit config (r) at 8; passed whatever the rules (the last two may not exist).
 */
export function launchHookExtras(mint: PublicKey, quoteMint: PublicKey): AccountMeta[] {
  const launch = launchAddress(mint);
  return [
    { pubkey: launch, isSigner: false, isWritable: true },
    { pubkey: holdingAddress(quoteMint, launch), isSigner: false, isWritable: true },
    { pubkey: holderVaultAddress(mint, quoteMint), isSigner: false, isWritable: true },
    { pubkey: kitConfigAddress(mint), isSigner: false, isWritable: false },
  ];
}

// ---- example hook ----------------------------------------------------------------------------------

export const taxConfigAddress = (mint: PublicKey): PublicKey => pda([enc('tax'), mint.toBuffer()], TAX_HOOK_PROGRAM);

// ---- the protocol lookup table (docs/hooks-v2.md §6) -----------------------------------------------

/**
 * The 18 addresses of the protocol lookup table, in table order (programs-summary §2.7): event and
 * hook authorities, config PDAs, bridged SOL and the SOL wrapper's accounts, the kit program, the
 * system and associated-token programs. `pnpm admin init` must extend the table with exactly these,
 * in this order.
 */
export const PROTOCOL_LOOKUP_TABLE: readonly PublicKey[] = PROTOCOL_LOOKUP_TABLE_ADDRESSES.map((a) => new PublicKey(a));
