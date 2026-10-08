# 7. Without TypeScript

Everything in these guides is plain Solana: Anchor accounts, Anchor instructions and Anchor event
CPIs. No off-chain service is needed.

## IDLs

The Anchor IDLs of every program are in [`packages/sdk/idl`](../../packages/sdk/idl) and in
[bordrless-programs/idl](https://github.com/BordrlessDex/bordrless-programs/tree/main/idl):
`bordrless_token`, `bordrless_swap`, `bordrless_launch`, `bordrless_kit`, `bordrless_bridge`,
`tax_hook`, `half_life`. Any Anchor client (anchorpy, anchor-go, solana-go with an IDL generator,
the Rust `anchor-client`) can decode the accounts and events and encode the instructions from them.

- **Accounts:** 8-byte discriminator, then Borsh. Discriminators, sizes and filter offsets are in
  [The standard](01-the-standard.md#account-layouts).
- **Instructions:** 8-byte discriminator, then Borsh arguments. Account order is the IDL's, and
  optional accounts that are absent are passed as the program's own id. Hook accounts follow as
  remaining accounts: see `swap` in `bordrless_swap` (`in_hook_accounts`, `out_hook_accounts`).
- **Events:** inner instructions to the program's event authority whose data is
  `e445a52e51cb9a1d`, then the event discriminator, then Borsh
  ([Indexing trades](03-indexing-trades.md)).
- **Hook accounts:** a hook's registry at `["bordrless-hook-accounts", mint]` under the hook
  program lists its extra accounts. The format and the resolver are in
  [`crates/bordrless-hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/crates/bordrless-hook)
  (`HookAccountList`, `resolve`). The TypeScript twin is `packages/sdk/src/hooks.ts`.

## Rust

The program crates have client modules that build every instruction the way the programs expect.
Depend on them with the `no-entrypoint` feature:

```toml
bordrless-token = { git = "https://github.com/BordrlessDex/bordrless-programs", features = ["no-entrypoint"] }
bordrless-swap = { git = "https://github.com/BordrlessDex/bordrless-programs", features = ["no-entrypoint"] }
bordrless-launch = { git = "https://github.com/BordrlessDex/bordrless-programs", features = ["no-entrypoint"] }
bordrless-core = { git = "https://github.com/BordrlessDex/bordrless-programs" }
```

- `bordrless_token::client`: `holding_address`, `create_holding`, `transfer`, `read_holding`.
- `bordrless_swap::client`: `pool_address`, `vault_address`, `swap`, `token_hook_slice`.
- `bordrless_launch::client`: `launch_address`, `pool_address`, `swap`, `swap_with_base_slice`,
  `graduate`, `custom_hook_slice`.
- `bordrless_core`: the fee and curve math the programs run (`swap_out`, `fee_amount`,
  `protocol_share`, `quote_value`). The TypeScript quote in `@bordrless/shared` is pinned to it by
  shared test vectors.

The LiteSVM tests in `programs/tests` build and send real buys, sells, graduations and transfers
with these clients. They're the most complete Rust examples.
