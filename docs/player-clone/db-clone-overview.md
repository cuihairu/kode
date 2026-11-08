# kode-db-clone — capability boundary & the full clone pipeline

> This page is the **authoritative overview** of the player data clone core crate.
> Every capability below is stated against the actual source in
> `crates/kode-db-clone/src/` with `file:line` references; the design of record is
> [docs/design/v0.2.1-player-data-clone-plan.md](../design/v0.2.1-player-data-clone-plan.md)
> (the "PDC plan"). Sibling pages: [source-evidence.md](./source-evidence.md) (engine-side
> persistence facts) and [ops-and-security.md](./ops-and-security.md) (operations,
> sensitive data, retention). Capabilities that exist in the plan but are **not**
> landed are listed as such — nothing here is aspirational wording.

## 1. What this is

`crates/kode-db-clone` is the Rust core that the PDC plan (§3 architecture) lands as a
**self-contained crate with no `kode-server` dependency** (the def-derived schema is
consumed as data, so the wiring is a mechanical field mapping — `lib.rs:1-7`).
One sentence: it clones **persisted player entity data** from one authorized MySQL
database (source) into a local/test MySQL database (target), through a
planned, redacted, encrypted, auditable archive.

Mapping from the plan's §3 component names to the actual modules:

| Plan §3 component | Actual module | Entry point |
|---|---|---|
| SchemaResolver | `schema.rs` + `wire.rs` + `information_schema.rs` | `SchemaResolver::resolve` `schema.rs:171`; wire input `CloneSchema::from_derivation` `wire.rs:51` |
| RelationGraph | `relations.rs` | `RelationGraph::build` `relations.rs:63` |
| ExportPlanner | `planner.rs` | `ExportPlanner::plan` `planner.rs:96` |
| ExportExecutor | `reader.rs` | `SourceReader::export` `reader.rs:144` |
| ArchiveCodec | `archive.rs` + `archive/format.rs` + `keystore.rs` + `redact.rs` + `value.rs` | `write_archive` `archive.rs:518` |
| ImportPlanner | `import.rs` + `idmap.rs` + `target.rs` | `ImportPlanner::plan` `import.rs:198` |
| ImportExecutor | `apply.rs` | `ImportApplier::apply` `apply.rs:234` |
| ImportValidator | `apply.rs` (Verify phase) | post-commit `SELECT COUNT` re-check `apply.rs:488` |

## 2. The full clone pipeline

```text
source MySQL (read-only)                        target MySQL (local/test only)
   │                                                     ▲
   ▼                                                     │ single transaction
[1 schema] → [2 plan] → [3 read] → [4 redact+archive] → [5 import plan] → [6 apply+verify]
   wire.rs /          planner.rs   reader.rs   archive.rs   import.rs        apply.rs
   information_schema  relations.rs            keystore.rs  idmap.rs         (id backfill)
   schema.rs           rules.rs                redact.rs    target.rs
```

### Stage 1 — schema resolution (derived ↔ physical dual-side check)

- The def-derived table schema arrives as the camelCase JSON of kode-server's
  `$/kode/databaseSchema/build` output and is converted mechanically into a
  `CloneSchema` (`wire.rs:51`); only planning-relevant fields are taken, display
  metadata is ignored (`wire.rs:1-7`).
- The physical side is read from `information_schema` via read-only
  TABLES/COLUMNS/STATISTICS queries (`information_schema.rs:60-83`, row assembly
  `read_all` `information_schema.rs:93`), wrapped as a `PhysicalSchema`
  (`information_schema.rs:88`). Schema names are compared as quoted string
  literals, not identifiers (`information_schema.rs:60-83`).
- `SchemaResolver::resolve` (`schema.rs:171`) fails closed: type normalization
  mismatch → `DriftMismatch`, non-InnoDB tables rejected, physical-only tables
  that were not derived (e.g. `kbe_*`) go to `denied` (`DeniedTable`,
  `schema.rs:156`) instead of being guessed at.

### Stage 2 — export planning (read-only SELECT plan, no I/O)

- `RelationGraph::build` (`relations.rs:63`) derives child-table edges from the
  engine's `parentID` convention and `topological_order` (`relations.rs:112`)
  guarantees parents before children; cycles are rejected. Relation kinds follow
  the plan §4.2 A–E taxonomy (`RelationKind`, `relations.rs:14`): engine-generated,
  foreign-key (reserved; engine DDL has none), project-declared, unresolved
  (pickle blobs — untouched), external (`kbe_*` — excluded).
- `ExportPlanner::plan` (`planner.rs:96`) emits one parameterized SELECT per
  table: root `WHERE id = ?`, children `WHERE parentID = ?`
  (`planner.rs:40-42`, rendering in `planner.rs:223-240`). Column projection
  always keeps structural columns (`RuleSet::project` `rules.rs:76`); business
  relations are Follow/Skip/Error by explicit rule only (`rules.rs:93`,
  `RelationRuleAction` `rules.rs:12`). If the row estimate exceeds the budget,
  planning fails with `BudgetExceeded` (`planner.rs:173`) — it never silently
  truncates. `DryRun` (`planner.rs:72`) runs the same path without I/O.

### Stage 3 — read-only source export

- The source executor is the `ReadOnlyExecutor` trait (`reader.rs:34`), which has
  **no DML methods at all**; `validate_readonly` (`reader.rs:42`) additionally
  whitelists statements (SELECT/SHOW/DESCRIBE/EXPLAIN and session/transaction
  control) — a double defense.
- Export (`reader.rs:144`) opens `SET SESSION TRANSACTION READ ONLY`
  (`reader.rs:158`) then a consistent-snapshot transaction
  (`START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`, falling back to the
  5.x form, `reader.rs:161-166`), and walks the plan DFS parent-first
  (`walk` `reader.rs:206`). Row/byte/wall-clock budgets (`ExportBudget`
  `reader.rs:69`) and a cancel flag (`ExportControl` `reader.rs:87`) are checked
  per row; any error rolls the snapshot transaction back.
- Rows are encoded as typed values preserving NULL / signed / unsigned / 64-bit /
  float / decimal / bytes (hex) / datetime (`TypedValue::parse` `value.rs:48`,
  `TypedRow` `value.rs:40`) so 64-bit ids and DECIMAL survive the round-trip
  exactly.

### Stage 4 — redaction and encrypted archive

- Column sensitivity is classified by keyword (`SensitivityPolicy::classify`
  `redact.rs:46`): credential columns are masked to `***` (`redact.rs:82`),
  personal columns keep only head/tail, and log lines with credential-like
  `key=value` pairs are masked too (`redact_log` `redact.rs:92`). The
  `RedactingSink` (`redact.rs:152`) sits between export and archive and produces
  a `RedactionReport` (`redact.rs:249`).
- Keys live in a separate `FileKeyStore` written with 0600 permissions
  (`keystore.rs:42`, `keystore.rs:100`); a key directory is refused if it sits
  inside the archive (`ensure_key_outside_archive` `keystore.rs:111`).
- The archive is a framed container with magic `KDPCLONE1` + version + flags
  (`archive/format.rs:19`); each frame carries its name, nonce, plaintext length,
  SHA-256 of the plaintext, and an (optional) chacha20poly1305 ciphertext with
  the frame header as AEAD associated data (`archive.rs:3-7`). Logical files are
  `manifest.json` (written last so truncation is detectable, `archive.rs:265`),
  `data/<table>.rows.jsonl`, `relations.json`, `redaction-report.json`,
  `checksums.json`. Writes go through a temp file + `sync_all` + atomic rename;
  `Drop` cleans up half-written archives (`archive.rs:318`). `write_archive`
  (`archive.rs:518`) is the one-shot read→redact→archive entry; `Archive::open`
  (`archive.rs:337`) re-verifies magic/version/size caps/decryption/per-frame
  SHA/frame-set-vs-manifest/per-table checksums, and `Archive::inspect`
  (`archive.rs:379`) reads metadata without exposing row values.

### Stage 5 — import planning (Prepare phase, touches no database)

- The target is gated statically: `TargetEnvironment::from_str` accepts only
  `local`/`test` and rejects `prod`/`staging` (and any unknown spelling)
  fail-closed (`target.rs:22`); `TargetProfile::validate_for_import`
  (`target.rs:66`) additionally requires interface `mysql` and an explicit
  writable declaration.
- `ImportPlanner::plan` (`import.rs:198`) checks archive tables ⊆ resolved
  target tables, row width = projected column count, and per-value type fit
  before planning anything (`import.rs:219-262`).
- It runs in passes: a **seed pass** allocates/preserves primary keys and
  resolves unique-key conflicts up front (`import.rs:365`); conflicts rebuild the
  value as `{original}_{seed}{n}` probed against target ∪ archive ∪ rebuilt
  values (`import.rs:403`, `rebuild_unique` `import.rs:646`); a **reference
  pass** registers `parentID` and Follow-rule references (`import.rs:445`); a
  **render pass** then produces statements by read-only ledger lookups only
  (`import.rs:565`) — a reference to an un-cloned parent row fails closed.
- The typed ID map ledger `IdMap` (`idmap.rs:151`) keys on
  (physical table, primary key column, old value) (`IdMapKey` `idmap.rs:57`) to
  prevent cross-table tampering, with three outcomes — `Allocated` placeholder,
  `Preserved`, `Rebuilt` (`MappedId` `idmap.rs:103`). Planned cells have six
  explicit kinds (`PlannedCell` `import.rs:103`); every statement is
  `?`-parameterized. `AccountBindingPlan` (`import.rs:148`) reports honestly that
  without a binding rule the clone is not visible to local login accounts.

### Stage 6 — transactional apply, verify and ID backfill

- `ImportApplier::apply` (`apply.rs:234`) re-checks the target gates, then
  applies a duplicate-fingerprint gate: the archive manifest bytes are hashed
  (`archive_fingerprint` `apply.rs:220`) and a known fingerprint is
  `DuplicateRejected` unless `allow_duplicate` is explicit
  (`apply.rs:247-252`).
- Inside one transaction (`begin → statements in plan order → commit`,
  `apply.rs:321`): `NewKey` cells bind NULL and let MySQL AUTO_INCREMENT assign
  the id; the real last-insert id is backfilled into `resolved_ids`, and later
  `KeyReference` cells bind the real value — this is the **ID mapping backfill**
  step. Executor errors roll back before propagating (`apply.rs:308`); an
  injected `fail_at_statement` exists for tests (`apply.rs:267`).
- After commit, every table is re-counted read-only with
  `SELECT COUNT(*) ... WHERE id IN (...)` (`apply.rs:488`) into a `VerifyReport`
  (`apply.rs:142`) that fails honestly. The full `ImportRun` audit
  (`apply.rs:189`) records per-table counts, placeholder→real mappings, binding
  outcomes, verification and the `CleanupPlan` (`apply.rs:172`) — a
  reverse-topological parameterized DELETE plan that is **generated, never
  executed** (`apply.rs:495`). Engine load verification is represented by
  `LoadVerification` (`apply.rs:150`) and is recorded with `attempted = false`
  inside this crate (see §3).

## 3. Capability boundary — what is landed and what is not

### 3.1 The library has no MySQL driver dependency

`crates/kode-db-clone/Cargo.toml` `[dependencies]` contains only
`serde` / `serde_json` / `sha2` / `chacha20poly1305` / `getrandom`. The crate
never opens a socket: all source reads go through the `ReadOnlyExecutor` trait
(`reader.rs:34`), all writes through `WriteExecutor` (`apply.rs:35`), and
physical schema reads through `RowSource` (`information_schema.rs:18`). The
`mysql` crate and `testcontainers` are **dev-dependencies only**, used by the
Docker-gated integration test (below). Real connection assembly lives outside
the crate:

- server bridge: `crates/kode-server/src/db_clone.rs` registers the five RPCs
  `$/kode/dbClone/{inspectArchive,planExport,export,planImport,readArchiveRows}`
  (`db_clone.rs:40-44`);
- VS Code side: the TS mysql2 single-transaction executor
  (`src/playerDataCloneMysql.ts`) and the command/profile layers
  (`src/playerDataCloneCommands.ts`, `src/playerDataCloneProfiles.ts`), as
  documented in [ops-and-security.md](./ops-and-security.md);
- real MySQL exercise: `tests/mysql_real.rs` only, gated by `#[ignore]` plus
  `KODE_DB_CLONE_MYSQL=1` and a running Docker (`mysql_real.rs:6-8`,
  `mysql_real.rs:474`, `mysql_real.rs:485`). A plain `cargo test` never touches
  a database.

### 3.2 PDC plan items — landed vs. honestly blocked

Landed (checked in plan §9, 44 of 53 items) includes the whole
Phase 1–4 core: schema/relation/planning (`PDC-01xx`), export/archive
(typed rows, streaming archive + SHA-256, redaction, encryption, corruption
checks), import planning/apply (target gates, ID ledger, unique rebuild,
transaction, verify, cleanup plan), the VS Code command surface (`PDC-05xx`),
and the test matrix (`PDC-06xx`, incl. the archive-encryption wiring `PDC-0608`
and the export encryption toggle `PDC-0609`).

Explicitly **not** landed, and stated as such everywhere:

- `PDC-0003` — let the real engine auto-create tables in a test MySQL and lock a
  golden schema; blocked on a compiled Linux engine server (plan line 460, still
  unchecked). Until then, engine facts rest on the engine source reading in
  [source-evidence.md](./source-evidence.md) and testcontainers fixtures.
- `PDC-0007` — the `fixtures/` + Golden Schema deliverable is the part that
  depends on `PDC-0003` (plan line 491; the `source-evidence.md` half is
  delivered).
- `PDC-0407` — engine-native load verification: the `LoadVerification` shape
  exists (`apply.rs:150`) but this crate always records `attempted = false`;
  wiring it needs the same engine instance as `PDC-0003` (plan line 698).
- Acceptance-matrix items #4 (FIXED_DICT engine cross-check), #11
  (non-transactional table gate) and #13 (local service process detection) are
  recorded as not wired, for the same environmental reason (todo.md `CLONE-P6`).
- The trailing plan item "wire engine-side native load verification" (plan line
  800) is open.

Ledger note: the plan text still shows `PDC-0201..0207` unchecked even though
`todo.md` (`CLONE-P2`) records those crate-side capabilities as landed; this
page describes capability per source code, with the file:line anchors above.

### 3.3 Non-goals (unchanged from plan §1.2)

No online BaseApp/CellApp memory snapshots, no forcing `writeToDB()`, no
auto-cloning of shared business entities (guild/mail/friends), no engine
migration, no writes to production databases, no SQL console, no account
impersonation.

## 4. Why it is called "db-clone"

The name is literal: it clones **player data in the database** — the rows a
KBEngine server has persisted to MySQL — from a source database to a target
database. It is **not** a general-purpose database tool: there is no SQL editor,
no generic query browser, no schema migration between engines, and no MySQL
driver in the library itself (§3.1). Everything it does is bounded by the
def-derived table schema and the plan's export scope: one persisted entity
(root DBID) plus its engine-derived child tables. The user-facing surface is
the `kbengine.clone.*` command family plus the read-only player-data panel —
query and import are deliberately separate surfaces.

## 5. Test surface

| Suite | Tests | What it locks |
|---|---|---|
| `tests/golden_plan.rs` | 2 | Representative Avatar: golden table order, column list, exact SQL strings, budget within/exceeded, denied tables with reasons |
| `tests/golden_import.rs` | 1 | Archive → import plan golden assertions: parent-first order, shared placeholders, `hero → hero_imported1` rebuild, binding warnings, auditable JSON |
| `tests/golden_apply.rs` | 4 | Single-transaction shape, placeholder backfill (`parentID` = real id), duplicate-fingerprint rejection / explicit copy, injected failure → full rollback with exactly one data set, zero DELETE in the execution log |
| unit tests in `src/*.rs` | 92 | per-module invariants (archive round-trip, wrong/missing key rejection, idmap ordering, rule validation, target gates, wire parsing, …) |
| `tests/hardening.rs` | 12 | single-byte mutation, truncation, payload mutation, deep parent chains, deep cycles, 300k-row scale, budget fail-closed, pre-cancelled/timed-out export, path-odd archive names |
| `tests/fuzz.rs` | 10 | randomized archive inputs never open unsafely |
| `tests/perf.rs` | 4 | 300k-row export/import within time budget |
| `tests/security.rs` | 4 | fail-closed paths (readonly violations, prod targets, key handling) |
| `tests/platform.rs` | 3 | cross-platform path/permission behavior |
| `tests/error_display.rs` | 2 | user-presentable error text |
| `tests/mysql_real.rs` | 2 (`#[ignore]`) | real MySQL 8.0/5.7 testcontainers round-trip: information_schema parse, read-only export, transactional import with real AUTO_INCREMENT/rollback — run only with `KODE_DB_CLONE_MYSQL=1 cargo test -p kode-db-clone --test mysql_real -- --ignored` |
