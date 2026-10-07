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

See [`packages/sdk/README.md`](packages/sdk/README.md) for usage.

## Program addresses

The same on mainnet-beta, devnet and localnet (`PROGRAM_IDS` in `@bordrless/shared`):

| Program | Address |
| --- | --- |
| Token standard | `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22` |
| DEX | `GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk` |
| Bridge | `CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7` |
| Launchpad | `1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC` |
| Kit | `14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH` |
| Example tax hook | `8tjnVSreJGBRQFyDBf1SyyhBgLsdBxa2rHYh9sbxFyX7` |

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
