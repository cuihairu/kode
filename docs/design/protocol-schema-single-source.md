# Protocol schema single source (RUST-055)

> Status: **implemented**. The shared wire-DTO layer (`crates/kode-protocol`) is
> now generated from a single machine-readable schema instead of being
> hand-written twice (Rust structs + TS interfaces). This note is the
> authoritative wording for the chain, the gates, and the boundary against the
> behavioral contract gate.

## 1. Why this exists

kode is a two-process system: a VS Code extension (TypeScript) and a Rust
analysis core, talking JSON-RPC over stdio. The shared protocol layer —
envelope (`Request` / `Notification` / `Response` / `ResponseError` /
`ServerNotification`), `initialize` handshake, LSP base DTOs (`Position` /
`Range` / `DidOpenParams` …), `$/kode/health`, and the `$/kode/fileChanged`
notification — used to be **written by hand on both sides**:

- Rust: `crates/kode-protocol/src/lib.rs` (serde structs; the wire truth),
- TS: mirrors inside `src/backend/kodeCoreClient.ts` /
  `src/backend/fileChangeBypass.ts`.

Nothing linked the two copies at compile time. A field added on one side and
forgotten on the other stays green in both compilers and only breaks at
runtime. The behavioral contract gate
(`tests/protocolContract.test.ts`, SURFACE_PINS recursive fingerprints pinned
against the real binary) catches drift **after the fact**, by observation.
RUST-055 asked for the structural half: **one spec, both sides generated,
CI-enforced**.

## 2. The chain (three locks)

```
Rust DTOs (kode-protocol, serde + JsonSchema derive)
   │  cargo run -q -p kode-protocol --bin dump-protocol-schema
   ▼
crates/kode-protocol/protocol.schema.json   (committed; 36 wire DTOs,
   │                                         draft-07, version header)
   │  pnpm gen:protocol  (json-schema-to-typescript;
   │  renderer has a single implementation in scripts/protocol-schema-codegen.mjs,
   │  shared by the generator script and the gate test)
   ▼
src/generated/protocolTypes.ts             (committed; DO NOT EDIT)
```

`tests/protocolSchema.test.ts` enforces the chain byte-for-byte:

| Lock | Runs | Bites when |
| --- | --- | --- |
| ① version triple | always | schema header `x-kode-protocol-version` ≠ TS `KODE_PROTOCOL_VERSION` (the Rust↔TS pair is already guarded in `protocolContract.test.ts`; the schema is the third source) |
| ② TS regen | always | committed `protocolTypes.ts` ≠ what the committed schema regenerates (schema edited without `pnpm gen:protocol`) |
| ③ Rust regen | with cargo (skips like `kodeCoreE2E` elsewhere) | committed schema ≠ what `dump-protocol-schema` emits from the current Rust DTOs (struct edited without regenerating the schema) |
| ④ wire samples | always | real-shaped samples (initialize both directions, fileChanged frame, health response, JSON-RPC envelope) no longer validate against the schema definitions — the runtime mini-validator uses the schema itself, because `tsconfig` excludes `tests/` and type-level assertions are not enforced by any gate |

Prove-red for ①–③ is recorded in the batch that landed this
(RUST-055 third increment): a stray line in the generated file, a bumped
version header, and an unregenerated Rust field each turn the suite red; all
restored byte-identical afterwards.

## 3. Scope boundary (deliberate)

- **In the schema**: every wire DTO in `crates/kode-protocol` (36 types).
  Rust doc comments flow into schema `description`s and on into the generated
  TS — the spec is self-documenting.
- **Not in the schema**:
  - frame framing itself — `Content-Length` header + JSON body encode/decode is
    delegated to the `lsp-server` crate (held by `crates/kode-server`), not
    reimplemented here; there is no in-repo codec type to describe;
  - the 32 `$/kode/*` request methods' handler types — they live in
    `crates/kode-server` modules and are covered by the **behavioral** gate
    (`protocolContract.test.ts` SURFACE_PINS: observed response shapes of the
    real binary). Folding them into the generated-schema lane would touch the
    server crate's in-flight files for little gain; the observation gate is
    stronger than a declared schema for behavior. Revisit when the server
    wiring batch lands if a declared-spec lane is wanted there too.
- The handwritten TS mirrors in `kodeCoreClient.ts` are **kept** (they carry
  client-side superset fields like `maintenance`/`ingest` on health, which come
  from kode-server, not kode-protocol). Lock ④ keeps their wire-relevant shape
  honest against the schema.

## 4. Regeneration recipes

```bash
# after editing kode-protocol DTOs (Rust):
cargo run -q -p kode-protocol --bin dump-protocol-schema > crates/kode-protocol/protocol.schema.json
pnpm gen:protocol          # regenerates src/generated/protocolTypes.ts
pnpm test:unit tests/protocolSchema.test.ts   # must stay green

# new dependency story: schemars = "0.8" (Rust, kode-protocol),
# json-schema-to-typescript = 15.x (TS devDependency; 16.0.0 is broken
# under pnpm — it declares js-yaml ^5 but resolves 4.x, CORE_SCHEMA.withTags
# is not a function).
```

Dependency-version bumps of `schemars` or `json-schema-to-typescript` can
change emitted formatting; the correct response is to regenerate both
artifacts in one commit — the gates force exactly that.
