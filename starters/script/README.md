# Companion script starter

The program every Workshop companion script starts from (the monorepo's
`tools/studio-builder/template-script`), published here so builders can copy it without the site.
It is an Anchor program with the keeper's step interface and, since 0.17.0, `decide` for agent
companions (see the SDK's `checkAgentJson` / `decideInstruction`, in `@bordrless/sdk` 0.17.0 and later, and https://bordrless.app/sdk/agents).
The vendored `crates/` are the public bordrless-programs crates the Workshop builds against.

Built unchanged with the Workshop's image (solanafoundation/solana-verifiable-build:4.3.0), `src/lib.rs`
gives a 140,096-byte program with hash
`2bc4383ae24d67ad47b5092e170bc6dfeff314447ba4639cd1fc3208d754229c` (placeholder program id
`11111111111111111111111111111111`). Keep `Cargo.lock` as it is: the dependency graph is part of every
script's hash.
