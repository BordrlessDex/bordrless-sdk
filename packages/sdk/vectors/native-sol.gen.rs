// The generator of vectors/native-sol.json: a scratch binary crate with path dependencies on bordrless-programs (branch native-sol),
// its Cargo.lock copied from there; `cargo run > native-sol.json`, then add the "_source" note. Not built here.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{Event, Discriminator};

fn k(n: u8) -> Pubkey { Pubkey::new_from_array([n; 32]) }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn ix_json(name: &str, ix: &Instruction) -> String {
    let metas: Vec<String> = ix.accounts.iter().map(|m| format!("[\"{}\",{},{}]", m.pubkey, m.is_signer, m.is_writable)).collect();
    format!("\"{}\":{{\"program\":\"{}\",\"accounts\":[{}],\"data\":\"{}\"}}", name, ix.program_id, metas.join(","), hex(&ix.data))
}
fn metas_json(name: &str, metas: &[AccountMeta]) -> String {
    let m: Vec<String> = metas.iter().map(|m| format!("[\"{}\",{},{}]", m.pubkey, m.is_signer, m.is_writable)).collect();
    format!("\"{}\":[{}]", name, m.join(","))
}
fn ev_json<E: Event>(name: &str, e: &E) -> String { format!("\"{}\":\"{}\"", name, hex(&e.data())) }

fn main() {
    use bordrless_swap::client as swap;
    use bordrless_launch::client as launch;
    let sol = bordrless_swap::constants::BRIDGED_SOL_MINT;
    let trader = k(1); let pool = k(2); let base = k(3); let tb = k(4); let hook = k(5); let admin = k(6);
    let mint = k(7); let author = k(8); let cfg = k(9); let partner = k(10); let creator = k(11); let integ = k(12); let treas = k(13);
    let mut out: Vec<String> = vec![];
    let args = |d: u8| bordrless_swap::instructions::SwapArgs { direction: d, amount_in: 1_000_000, min_amount_out: 5, in_hook_accounts: 0, out_hook_accounts: 0, hook_data: vec![1,2] };
    let extras = vec![AccountMeta::new(k(20), false), AccountMeta::new_readonly(k(21), false)];
    let v2b = swap::swap_v2(&swap::SwapV2Keys { trader, pool, base_mint: base, trader_base: tb, trader_quote: trader, hook_program: Some(hook), base_mint_writable: true, with_bridge: true }, args(1), extras.clone());
    out.push(ix_json("swapV2Bridge", &v2b));
    let v2n = swap::swap_v2(&swap::SwapV2Keys { trader, pool, base_mint: base, trader_base: tb, trader_quote: k(14), hook_program: None, base_mint_writable: false, with_bridge: false }, args(0), vec![]);
    out.push(ix_json("swapV2Plain", &v2n));
    out.push(ix_json("migratePool", &swap::migrate_pool_to_native(admin, pool, 777)));
    out.push(ix_json("revertPool", &swap::revert_pool_to_bridged(admin, pool)));
    out.push(ix_json("rebalancePool", &swap::rebalance_pool(trader, pool)));
    out.push(ix_json("setBufferTarget", &swap::set_buffer_target(admin, pool, 5)));
    let cpa = bordrless_swap::instructions::CreatePoolArgs { lp_fee_bps: 30, hook_program: Pubkey::default(), hook_flags: 0, virtual_base: 0, virtual_quote: 0, base_amount: 1000, quote_amount: 2000, base_hook_accounts: 0, quote_hook_accounts: 0, hook_data: vec![] };
    out.push(ix_json("createNativePool", &swap::create_native_pool(&swap::CreatePoolKeys { payer: trader, authority: trader, treasury: treas, base_mint: base, quote_mint: sol, hook_caller: None }, cpa, vec![])));
    // launch
    let rules = bordrless_launch::state::LaunchRules { holder_fee_buy_bps: 100, holder_fee_sell_bps: 100, burn_buy_bps: 10, burn_sell_bps: 0, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 };
    let lk = launch::LaunchKeys::new(mint, sol, bordrless_core::policy::LP_FEE_BPS, &rules);
    out.push(ix_json("launchSwapV2Buy", &launch::swap_v2(&lk, trader, k(15), 1, 1000, 1)));
    out.push(ix_json("launchSwapV2Sell", &launch::swap_v2(&lk, trader, k(15), 0, 1000, 1)));
    out.push(ix_json("launchSwapV2NoBridge", &launch::swap_v2_with_bridge(&lk, trader, trader, 1, 1000, 1, launch::base_hook_slice(&mint, &sol, lk.modules), false)));
    out.push(ix_json("claimCreatorSol", &launch::claim_creator_fees_sol(creator, mint, None, None)));
    out.push(ix_json("claimCreatorSolBoth", &launch::claim_creator_fees_sol(creator, mint, Some((cfg, author)), Some((cfg, partner)))));
    out.push(ix_json("claimAuthorSol", &launch::claim_author_fees_sol(author, mint, cfg, creator, Some(partner))));
    out.push(ix_json("claimAuthorSolNoPartner", &launch::claim_author_fees_sol(author, mint, cfg, creator, None)));
    out.push(ix_json("distributeSol", &launch::distribute_fees_sol(mint, cfg, creator, partner, Some(author))));
    out.push(ix_json("distributeSolNoAuthor", &launch::distribute_fees_sol(mint, cfg, creator, partner, None)));
    out.push(ix_json("setNativeLaunches", &launch::set_native_launches(admin, true)));
    out.push(ix_json("migrateLaunch", &launch::migrate_launch_to_native(admin, mint, sol, lk.modules)));
    out.push(ix_json("migrateLaunchNoKit", &launch::migrate_launch_to_native(admin, mint, sol, 0)));
    out.push(ix_json("migrateLaunchKitNoRewards", &launch::migrate_launch_to_native(admin, mint, sol, 2)));
    out.push(ix_json("revertLaunch", &launch::revert_launch_to_bridged(admin, mint, sol, lk.modules)));
    // kit
    out.push(ix_json("kitClaimSol", &bordrless_kit::client::claim_sol(trader, mint)));
    out.push(ix_json("kitShareSol", &bordrless_kit::client::share_sol(trader, mint, 12345)));
    out.push(ix_json("kitSetNative", &bordrless_kit::client::set_native(k(16), trader, mint, Some(k(17)), sol, true, true)));
    out.push(ix_json("kitSetNativeBare", &bordrless_kit::client::set_native(k(16), trader, mint, None, sol, false, false)));
    // companion
    out.push(ix_json("companionMigrate", &bordrless_companion::client::migrate_companion_to_native(admin, mint)));
    out.push(ix_json("companionRevert", &bordrless_companion::client::revert_companion_to_bridged(admin, mint)));
    out.push(metas_json("companionNativeAccounts", &bordrless_companion::client::native_accounts(&lk)));
    // hook vault
    let mut slots = [hook_vault::state::Slot::default(); hook_vault::constants::MAX_SLOTS];
    slots[0].policy = 2; slots[0].pending_sol = 5; slots[1].policy = 1; slots[2].policy = 3; slots[2].pending_sol = 9;
    let v = hook_vault::state::Vault { version: 1, bump: 1, mint, hook, creator, n_slots: 3, slots, bounty_bps: 0, max_sell_bps: 0, interval: 0, max_hook_cut_bps: 0, opened: true, opened_at: 0, created_at: 0, last_activity_at: 0, reserved: [0; 64] };
    out.push(ix_json("vaultMigrate", &hook_vault::client::set_vault_native(admin, &v, true)));
    out.push(ix_json("vaultRevert", &hook_vault::client::set_vault_native(admin, &v, false)));
    // router
    out.push(ix_json("routerSwapV2", &bordrless_router::client::swap_v2(trader, integ, treas, &v2n, 50, 99)));
    // events
    use bordrless_swap::events::*;
    out.push(ev_json("evSwappedNative", &SwappedNative { pool, direction: 1, quote_lamports: 123, quote_deltas: vec![NativeDeltaPaid { account: k(30), amount: 7, wrapped: false }, NativeDeltaPaid { account: k(31), amount: 8, wrapped: true }], buffer_quote: 9, pool_lamports: 10 }));
    out.push(ev_json("evPoolQuoteFormChanged", &PoolQuoteFormChanged { pool, kind: 2, native: true, unwrapped: 1, wrapped: 2, buffer_quote: 3, buffer_target: 4, quote_reserve: 5, protocol_fees_quote: 6, pool_lamports: 7, ts: 8 }));
    out.push(ev_json("evLaunchNativeSet", &bordrless_launch::events::LaunchNativeSet { launch: k(40), mint, native: true, moved: 55, ts: 66 }));
    out.push(ev_json("evNativeLaunchesSet", &bordrless_launch::events::NativeLaunchesSet { on: true, ts: 3 }));
    out.push(ev_json("evKitNativeSet", &bordrless_kit::events::KitNativeSet { mint, native: true, moved: 11, lamports_base: 22, ts: 33 }));
    out.push(ev_json("evCompanionNativeSet", &bordrless_companion::events::CompanionNativeSet { companion: k(41), native: true, moved: 44, spare: 45 }));
    let _ = SwappedNative::DISCRIMINATOR;
    println!("{{{}}}", out.join(",\n"));
}
