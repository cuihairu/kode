# Player data clone (db-clone)

Documentation for the player data clone subsystem (crate `kode-db-clone` +
the `kbengine.clone.*` command surface):

- [db-clone overview: capability boundary & the full clone pipeline](./db-clone-overview.md) —
  authoritative overview: what the crate is, the end-to-end clone pipeline
  (read → plan → encrypted archive → import → ID backfill), what is landed vs.
  honestly blocked, why it is named db-clone, and the test surface.
- [Source evidence](./source-evidence.md) — engine-side persistence facts
  (parentID, child tables, autoLoad) the crate encodes.
- [Ops & security](./ops-and-security.md) — command surface, sensitive data
  handling, archive retention/destruction, known limitations.

Design of record: [Player Data Clone plan (v0.2.1)](../design/v0.2.1-player-data-clone-plan.md).
