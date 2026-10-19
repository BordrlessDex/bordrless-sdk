# Bordrless SDK

TypeScript packages for the [Bordrless programs](https://github.com/BordrlessDex/bordrless-programs)
on Solana.

| Package | What |
| --- | --- |
| [`@bordrless/sdk`](packages/sdk) | The client: addresses and every PDA, account and event decoding from the IDLs, instruction builders for every program, hook extra-account resolution, v0 transactions with the protocol lookup table |
| [`@bordrless/shared`](packages/shared) | The policy and fee math (the same as the programs' `bordrless-core`), program addresses and API types. No Solana dependencies |

```sh
npm install @bordrless/sdk @bordrless/shared
```

Use the same version of both packages. The [CHANGELOG](packages/sdk/CHANGELOG.md) says what each
version has; every release is also tagged under
[GitHub releases](https://github.com/BordrlessDex/bordrless-sdk/releases).

See [`packages/sdk/README.md`](packages/sdk/README.md) for usage.

## Integrating Bordrless tokens

Building a trading terminal, an aggregator, an indexer or a wallet? Start with
**[the integration guides](docs/integration)**: reading tokens and prices, indexing trades,
quoting and building swaps, hooks, and the bridge, with runnable examples in [`examples/`](examples)
checked against mainnet.

Building a companion script for the Workshop (including an agent companion with `decide`)? Copy the
starter in [`starters/script/`](starters/script).

## Program addresses

The same on mainnet-beta, devnet and localnet (`PROGRAM_IDS` in `@bordrless/shared`):

| Program | Address |
| --- | --- |
| Token standard | `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22` |
| DEX | `GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk` |
| Bridge | `CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7` |
| Launchpad | `1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC` |
| Kit | `14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH` |
| Half-Life hook | `53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8` |
| Example tax hook | `8tjnVSreJGBRQFyDBf1SyyhBgLsdBxa2rHYh9sbxFyX7` |
| Companion | `6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo` |
| Lottery hook | `HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr` |
| Hook timelock | `BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ` |
| Hook vault | `5cojoUStG7WFhHJiSncCUEwTqDuhDLKu4a9BqTbF8jzG` |
| Router | `7M5GTuzhByzBbrJURzLtbBrFjcsC8aHu816qWTXAYD85` |
| Loss cover hook | `6KMdXC3Fxovp3pnUsdQuUbderPzZtTA4t6R1jacYJWQr` |
| Loss cover script | `9mRXU9gpWY3B13AyuCCtNjHnKt1pUFBQ6vJDLTwgakhm` |

## Develop

Node 22+ and pnpm 10.

```sh
pnpm install
pnpm build       # shared, then sdk
pnpm typecheck
pnpm test
```

`packages/sdk/idl` and `packages/shared/vectors/launch-fees.json` are copies from
bordrless-programs (`idl/` and `programs/tests/vectors/`); copy them again when the programs change.

## Publishing

`@bordrless/shared` first, since the SDK depends on it; `pnpm publish` turns the `workspace:`
dependency into the published version:

```sh
pnpm -C packages/shared publish
pnpm -C packages/sdk publish
```

## License

[Apache-2.0](LICENSE).
