# Companion script starter

The program every Workshop companion script starts from (the monorepo's
`tools/studio-builder/template-script`), published here so builders can copy it without the site.
It is an Anchor program with the keeper's step interface and, since 0.17.0, `decide` for agent
companions (see the SDK's `checkAgentJson` / `decideInstruction`, in `@bordrless/sdk` 0.17.0 and later, and https://bordrless.app/sdk/agents);
since 0.20.0 `decide` also takes `bill_leg`, an agent's bill in a leg's token on a coin quoted in tokens.
The vendored `crates/` are the public bordrless-programs crates the Workshop builds against.

Built unchanged with the Workshop's image (solanafoundation/solana-verifiable-build:4.3.0), `src/lib.rs`
gives a 151,728-byte program with hash
`fbd0991cf446d65ad16d390d919e50ef2438d0f450d9dae75836fbbd155c7834` (placeholder program id
`11111111111111111111111111111111`). Keep `Cargo.lock` as it is: the dependency graph is part of every
script's hash.
