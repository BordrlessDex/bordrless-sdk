//! A Bordrless companion script, made in the Workshop.
//!
//! A script companion's launch has a program for its creator: the Bordrless companion holds the
//! launch's companion address, `PDA(["creator", mint])` under the companion, and the creator fees paid
//! to it, and sets part of every fee claim aside in a pot: on a native coin (every coin launched since
//! 15 Oct 2026; `launch.is_native()`) the companion address's own lamports above its rent, on an older
//! coin bridged SOL in the companion address's holding.
//! The script decides what the pot does. The companion calls it with the companion address signing,
//! so the script acts as the companion address. No other signature ever reaches it: every other account comes
//! unsigned (not the launcher's, not the mint's, not the sender's). So a script can't create
//! accounts, and it can't move anyone's funds but what the creator holds, which the companion limits
//! to the pot.
//!
//! What a script keeps, it keeps in its state: `PDA(["script-state", mint])` under the companion,
//! which the companion makes before `companion_init` (the size the launch asks for, at most 10,240
//! bytes, zeroed, owned by this program, its rent paid by the launcher). A launch that asks for no
//! state passes the system program's id, read-only, in its place.
//!
//! - `companion_init`, once, before the launch: the mint (not created yet) and the init data the
//!   launcher chose for this script (Borsh `Vec<u8>`, at most 512 bytes). Accounts: creator (signer,
//!   writable), mint, state (writable), system program, then every account the client passed.
//! - `companion_step`, from a minute after the launch, at most once an interval (10 seconds to a
//!   day, chosen with the companion), sent by anyone (the companion pays them a small bounty from
//!   the pot). Accounts: creator (signer, writable), mint, launch, companion, pool, state
//!   (writable), then every account the sender passed.
//!
//! After each call the companion checks what the script did, and fails the whole transaction
//! otherwise:
//! - the companion address's pot fell by at most the pot (its lamports above rent on a native coin, its
//!   bridged SOL on an older one; in `companion_init`, not at all);
//! - the companion address's tokens are still at least the dev bag;
//! - the companion address keeps its rent (an older coin: no fewer lamports), and is still a system
//!   account with no data;
//! - the companion address's bridged-SOL and token holdings are still there, with no delegate;
//! - the launch's creator fees were not claimed.
//!
//! What a script buys stays in the companion address's token holding, beside the dev bag; what it sells
//! goes back to the pot.
//!
//! To burn what it bought (the token program's `burn`), a script needs the mint writable: set
//! `"mintWritable": true` in its `keeper.json`, and every step the keeper sends passes the coin's
//! mint writable (the mint already in `swapAccounts` made writable, their order unchanged; without
//! them the mint appended last). Without it the mint is writable only on a launch with a burn rate,
//! and a burn fails the whole step (`MintNotWritable`). A burn may never take the companion
//! address's tokens below the dev bag still held (`ScriptTookDevBag`).
//!
//! To trade, build the swap with the launchpad's client and invoke it as the companion address. The companion
//! address already signs this call, so `invoke` passes its signature on (no seeds). On a native coin
//! the swap is `swap_v2` with no bridge accounts: a buy pays lamports from the companion address and
//! delivers the token to its holding, a sell delivers lamports to it. In `companion_step`:
//!
//! ```ignore
//! use anchor_lang::solana_program::program::invoke;
//! use bordrless_launch::client as launch_client;
//!
//! let launch = launch_client::read_launch(&ctx.accounts.launch)?;
//! let keys = launch_client::LaunchKeys::of(&launch);
//! let me = ctx.accounts.creator.key();
//! // Buy with `lamports` of the pot (direction 1; direction 0 sells tokens). A launch with its own
//! // token hook passes that hook's slice instead of `vec![]`.
//! let ix = if launch.is_native() {
//!     launch_client::swap_v2_with_base_slice(&keys, me, me, 1, lamports, 1, vec![])
//! } else {
//!     launch_client::swap(&keys, me, me, 1, lamports, 1)
//! };
//! let mut accounts = ctx.accounts.to_account_infos();
//! accounts.extend_from_slice(ctx.remaining_accounts);
//! invoke(&ix, &accounts)?;
//! ```
//!
//! Every account the swap names (the DEX and its config, the pool's vaults, the companion address's holdings
//! or its SOL vault, the token program, the hooks' accounts) must be among the accounts the sender
//! passed. A launch with its own token hook trades with `swap_with_base_slice` (`swap_v2_with_base_slice`
//! on a native coin) and that hook's slice. To pay a wallet on a native coin, transfer lamports from the
//! companion address with the system program (it signs); a holder's bridged-SOL holding is the older
//! coins' way.
//!
//! **An agent script** (docs/agents.md) is one whose steps a model chooses. `agent.json` beside
//! `src/` names its options (the code a step reads and what the step does with it; code 0 is
//! `hold`) and its sizes; the caps are the script's own code. Bordrless's keeper asks the model off
//! chain and signs its choice into the last `DECISION_LEN` bytes of the state with `decide` (the
//! agent key, `AGENT_KEY`, is its only signer), in a transaction of its own right before the step;
//! `companion_step` reads it (`read_decision`), does what that option says at that size, and spends
//! it (`clear_decision`), so a choice that is late, missing, void or unknown is a hold. A script
//! with no agent compiles and runs the same: no decision ever arrives, the tail stays zero, every
//! step holds. A decision may carry a bill (`bill_lamports`, docs/agents.md "Billing"): what the pot
//! pays Bordrless's treasury for the inference behind it. The step pays it first, before its action,
//! from the companion address to `TREASURY` with a system transfer (`pay_bill`), at most
//! `BILL_CAP_BPS` of the pot, and only when the treasury is among the accounts the sender passed
//! (the keeper passes it last on an agent script's steps); without it the bill is skipped, never the
//! step.
//!
//! This one writes a small header into its state and holds at each step (it reads the decision,
//! pays its bill, knows only `hold`, and spends it): it is the place to start. It needs a state of at
//! least `STATE_LEN` bytes: a launch with it asks for that much (with less, or none, its
//! `companion_init` fails, and so does the launch's setup).

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("11111111111111111111111111111111");

/// The Bordrless companion: the only program that can sign for a launch's companion address, so the
/// only caller of this script; it also makes the script's state.
pub const COMPANION_PROGRAM: Pubkey =
    Pubkey::from_str_const("6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo");
/// Bordrless's agent key (docs/agents.md): the only signer `decide` takes a decision from. The
/// Workshop's static checks hold a script with a `decide` to this key, as published.
pub const AGENT_KEY: Pubkey =
    Pubkey::from_str_const("6rY39aKYu5B17SAbKNzteJdvpGyJPR5WJ2aaUqrTuJ4Q");
/// Bordrless's treasury (docs/agents.md "Billing"): where a step pays the decision's inference bill
/// from the pot. The keeper passes it, writable, last among an agent script's step accounts.
pub const TREASURY: Pubkey =
    Pubkey::from_str_const("GAAvsY7D7pARVu8VSFExRYfvbHNyzH7GS6WKyz5zUHf4");
/// The most of the pot one bill may take, basis points (1%): a wrong bill can't drain the pot. The
/// keeper caps what it asks the same way; this holds it on chain.
pub const BILL_CAP_BPS: u64 = 100;
/// The companion's seed of a launch's companion address: `["creator", mint]`.
pub const CREATOR_SEED: &[u8] = b"creator";
/// The companion's seed of a script's state: `["script-state", mint]`.
pub const STATE_SEED: &[u8] = b"script-state";
/// The layout of `ScriptState` this script writes.
pub const STATE_VERSION: u8 = 1;
/// The decision's bytes, at the end of the state (docs/agents.md "The decision on chain"), so no
/// account is added to a step and the layout before them is the script's own.
pub const DECISION_LEN: usize = 64;
/// The first byte of a decision; anything else in its place is no decision.
pub const DECISION_MAGIC: u8 = 0xA6;
/// The decision's layout, the only one there is.
pub const DECISION_VERSION: u8 = 1;
/// The least state this script needs: Anchor's 8-byte discriminator, then `ScriptState`, then the
/// decision's tail.
pub const STATE_LEN: usize = 8 + ScriptState::INIT_SPACE + DECISION_LEN;

#[program]
pub mod workshop_script {
    use super::*;

    /// Once, before the launch (the companion's `create_script`): writes the state's header.
    /// `init_data` is what the launcher chose for this script; this one keeps none of it (to keep
    /// settings, add fields to `ScriptState` and fill them from it here).
    /// (The `'info` lifetime lets `ctx.remaining_accounts` go into a CPI with the named accounts.)
    pub fn companion_init<'info>(
        ctx: Context<'info, CompanionInit<'info>>,
        mint: Pubkey,
        init_data: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(mint, ctx.accounts.mint.key(), ScriptError::WrongMint);
        // The decision's tail sits after the header: a state too small for both would put it over
        // the header, so the launch is refused here, before anything is written.
        require!(ctx.accounts.state.to_account_info().data_len() >= STATE_LEN, ScriptError::StateTooSmall);
        let _ = init_data;
        let state = &mut ctx.accounts.state;
        state.version = STATE_VERSION;
        state.mint = mint;
        Ok(())
    }

    /// Every step (the companion's `script_step`): what the pot does now. This one reads the
    /// agent's decision, pays its bill, does what it says (it knows only `hold`), and spends it.
    pub fn companion_step<'info>(
        ctx: Context<'info, CompanionStep<'info>>,
        mint: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(mint, ctx.accounts.mint.key(), ScriptError::WrongMint);
        let state = ctx.accounts.state.to_account_info();
        let now = Clock::get()?.unix_timestamp;
        if let Some(decision) = read_decision(&state, now) {
            // The inference bill first, before the action spends any of the pot: what the decision
            // says, within the cap, to the treasury (docs/agents.md "Billing").
            if decision.bill_lamports > 0 {
                let paid = pay_bill(&ctx.accounts.creator.to_account_info(), ctx.remaining_accounts, decision.bill_lamports)?;
                msg!("inference bill: {} of {} lamports paid to the treasury", paid, decision.bill_lamports);
            }
            match decision.action {
                // 0 is hold: nothing this step. A builder's options go here, one arm per `code` of
                // agent.json, each doing its action at `decision.size` within the caps the script
                // compiles in; an action the script does not know is a hold too.
                0 => {}
                _ => {}
            }
            // Spent: a decision runs one step, never the next.
            clear_decision(&state)?;
        }
        Ok(())
    }

    /// The agent's choice for the next step (docs/agents.md "The decision on chain"): Bordrless's
    /// keeper signs it with the agent key into the last `DECISION_LEN` bytes of the state, in the
    /// transaction of its own, before the step. `seq` must grow, so an older decision can't be sent again; the
    /// state before the tail is not touched.
    pub fn decide(ctx: Context<Decide>, args: DecideArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let state = &ctx.accounts.state;
        require!(state.data_len() >= STATE_LEN, ScriptError::StateTooSmall);
        let mut data = state.try_borrow_mut_data()?;
        let at = data.len() - DECISION_LEN;
        let tail = &mut data[at..];
        // The seq stays once a decision is spent (only the magic is cleared), so a replay of any
        // earlier decision is refused for the life of the state.
        require!(args.seq > le_u32(tail, 24), ScriptError::StaleDecision);
        tail[0] = DECISION_MAGIC;
        tail[1] = DECISION_VERSION;
        tail[2] = args.action;
        tail[3] = args.size;
        tail[4..8].copy_from_slice(&args.bill_lamports.to_le_bytes());
        tail[8..16].copy_from_slice(&args.until.to_le_bytes());
        tail[16..24].copy_from_slice(&now.to_le_bytes());
        tail[24..28].copy_from_slice(&args.seq.to_le_bytes());
        tail[28..30].copy_from_slice(&args.confidence_bps.to_le_bytes());
        tail[30..32].copy_from_slice(&[0, 0]);
        tail[32..64].copy_from_slice(&args.state_hash);
        Ok(())
    }
}

/// What `decide` writes, Borsh in this order (the keeper builds it the same way).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct DecideArgs {
    /// The option's `code` (agent.json; 0 is hold).
    pub action: u8,
    /// The `sizes` level (0 when the script has none).
    pub size: u8,
    /// Unix seconds; the decision is void after.
    pub until: i64,
    /// Counts decisions: must be above the stored one.
    pub seq: u32,
    /// The model's confidence in the choice, basis points.
    pub confidence_bps: u16,
    /// SHA-256 of the state the model saw.
    pub state_hash: [u8; 32],
    /// What the step pays the treasury for the inference, lamports (0: nothing billed).
    pub bill_lamports: u32,
}

/// A decision as it stands in the state's tail: what `companion_step` does this step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    /// The option's `code` (0 is hold).
    pub action: u8,
    /// The `sizes` level (0 when the script has none).
    pub size: u8,
    /// What the step pays the treasury for the inference, lamports (0: nothing billed).
    pub bill_lamports: u32,
    /// Unix seconds; void after.
    pub until: i64,
    /// When it was signed.
    pub decided_at: i64,
    /// Counts decisions.
    pub seq: u32,
    /// The model's confidence in the choice, basis points.
    pub confidence_bps: u16,
    /// SHA-256 of the state the model saw.
    pub state_hash: [u8; 32],
}

/// The decision in the last `DECISION_LEN` bytes of `state` at `now`, or none to act on: a state
/// too small to hold one, no magic (none signed yet, or the last one spent), another layout, or one
/// void by now. None is a hold.
pub fn read_decision(state: &AccountInfo, now: i64) -> Option<Decision> {
    let data = state.try_borrow_data().ok()?;
    if data.len() < DECISION_LEN {
        return None;
    }
    let tail = &data[data.len() - DECISION_LEN..];
    if tail[0] != DECISION_MAGIC || tail[1] != DECISION_VERSION {
        return None;
    }
    let until = le_i64(tail, 8);
    if until < now {
        return None;
    }
    let mut state_hash = [0u8; 32];
    state_hash.copy_from_slice(&tail[32..64]);
    Some(Decision {
        action: tail[2],
        size: tail[3],
        bill_lamports: le_u32(tail, 4),
        until,
        decided_at: le_i64(tail, 16),
        seq: le_u32(tail, 24),
        confidence_bps: le_u16(tail, 28),
        state_hash,
    })
}

/// Spends the decision in `state`'s tail: its magic byte is zeroed, so the next step finds none.
/// The rest of the tail stays (its `seq` is what refuses a replay).
pub fn clear_decision(state: &AccountInfo) -> Result<()> {
    let mut data = state.try_borrow_mut_data()?;
    let len = data.len();
    if len >= DECISION_LEN {
        data[len - DECISION_LEN] = 0;
    }
    Ok(())
}

/// Pays the decision's inference bill (docs/agents.md "Billing"): `bill` lamports from the companion
/// address (`creator`, which signs this call: the companion's checks let a step spend the pot) to
/// `TREASURY`, found among the step's `remaining` accounts by key, with a system transfer (how a
/// script pays any wallet on a native coin). Capped at `BILL_CAP_BPS` of the pot, read here as the
/// companion address's lamports above an empty account's rent, so a wrong bill can't drain it. The
/// lamports paid. Without the treasury among the accounts the bill is skipped (`TreasuryMissing` in
/// the log, nothing paid): a missing account is never a reason to fail the step, since the coin
/// never depends on the brain.
pub fn pay_bill<'info>(creator: &AccountInfo<'info>, remaining: &[AccountInfo<'info>], bill: u32) -> Result<u64> {
    let Some(treasury) = remaining.iter().find(|a| a.key() == TREASURY) else {
        msg!("inference bill of {} lamports skipped: {}", bill, ScriptError::TreasuryMissing);
        return Ok(0);
    };
    let pot = creator.lamports().saturating_sub(Rent::get()?.minimum_balance(0));
    let paid = u64::from(bill).min(pot * BILL_CAP_BPS / 10_000);
    if paid == 0 {
        return Ok(0);
    }
    system_program::transfer(
        CpiContext::new(system_program::ID, system_program::Transfer { from: creator.clone(), to: treasury.clone() }),
        paid,
    )?;
    Ok(paid)
}

fn le_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le_i64(bytes: &[u8], at: usize) -> i64 {
    let mut out = [0u8; 8];
    out.copy_from_slice(&bytes[at..at + 8]);
    i64::from_le_bytes(out)
}

/// This script's state for a mint, after Anchor's discriminator. Anchor writes both when
/// `companion_init` returns. The decision's tail comes after, at the end of the account, and is
/// never part of this struct.
#[account]
#[derive(InitSpace)]
pub struct ScriptState {
    /// `STATE_VERSION`.
    pub version: u8,
    /// The mint this state is for.
    pub mint: Pubkey,
}

/// Accounts of `companion_init`, as the companion passes them; then every account the launcher's
/// transaction passed (`ctx.remaining_accounts`), none of them signing.
#[derive(Accounts)]
pub struct CompanionInit<'info> {
    /// The companion address, `PDA(["creator", mint])` under the companion. Only the
    /// companion can sign for it: this check is what makes the caller the companion.
    #[account(mut, seeds = [CREATOR_SEED, mint.key().as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub creator: Signer<'info>,
    /// CHECK: the launch's mint; it does not exist yet (the companion address is derived from it).
    pub mint: UncheckedAccount<'info>,
    /// This script's state for the mint, as the companion made it: Anchor's `zero` takes it only
    /// while its discriminator is still zeros (so once), owned by this program, writable and rent
    /// exempt, and `seeds` that it is the companion's `["script-state", mint]`.
    #[account(zero, seeds = [STATE_SEED, mint.key().as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub state: Account<'info, ScriptState>,
    pub system_program: Program<'info, System>,
}

/// Accounts of `companion_step`, as the companion passes them (it checked the mint, the launch and
/// the pool); then every account the sender passed (`ctx.remaining_accounts`), none of them
/// signing: what a swap needs.
#[derive(Accounts)]
pub struct CompanionStep<'info> {
    /// The companion address (as in `companion_init`): it holds the pot and the tokens, and
    /// signs this call.
    #[account(mut, seeds = [CREATOR_SEED, mint.key().as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub creator: Signer<'info>,
    /// CHECK: the token.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the launch, `PDA(["launch", mint])` under the launchpad: read it with
    /// `bordrless_launch::client::read_launch`.
    pub launch: UncheckedAccount<'info>,
    /// CHECK: the companion, `PDA(["companion", mint])` under the companion program (the pot is its
    /// `pending_pot`).
    pub companion: UncheckedAccount<'info>,
    /// CHECK: the launch's pool on the DEX.
    pub pool: UncheckedAccount<'info>,
    /// This script's state for the mint, as `companion_init` left it; writable, since a step
    /// spends the decision in its tail (Anchor writes the header back; the tail is written by hand).
    #[account(mut, seeds = [STATE_SEED, mint.key().as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub state: Account<'info, ScriptState>,
}

/// Accounts of `decide`, as Bordrless's keeper sends them before the step.
#[derive(Accounts)]
pub struct Decide<'info> {
    /// Bordrless's agent key, signing: the only key a decision is taken from.
    #[account(constraint = agent.key() == AGENT_KEY @ ScriptError::NotTheAgentKey)]
    pub agent: Signer<'info>,
    /// CHECK: the token; the state's address is derived from it.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: this script's state for the mint, the companion's `["script-state", mint]` (`seeds`)
    /// and owned by this program (`owner`); only its tail is written.
    #[account(mut, seeds = [STATE_SEED, mint.key().as_ref()], bump, seeds::program = COMPANION_PROGRAM, owner = crate::ID @ ScriptError::NotThisScriptsState)]
    pub state: UncheckedAccount<'info>,
}

/// Errors.
#[error_code]
pub enum ScriptError {
    #[msg("the mint in the instruction is not the mint account")]
    WrongMint,
    #[msg("the signer is not Bordrless's agent key")]
    NotTheAgentKey,
    #[msg("the state is not owned by this script")]
    NotThisScriptsState,
    #[msg("the decision's seq is not above the stored one: an older decision, or one sent twice")]
    StaleDecision,
    #[msg("the state is too small: a launch with this script asks for at least STATE_LEN bytes")]
    StateTooSmall,
    #[msg("the treasury is not among the step's accounts: the inference bill is skipped")]
    TreasuryMissing,
}
