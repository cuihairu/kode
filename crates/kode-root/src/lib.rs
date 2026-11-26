//! kode-root — KBE root discovery (PR-006, book §5 VFS-009 full edition + §17 PR-006, PH1-05).
//!
//! Responsibility: identify KBEngine resource roots inside the workspace (entity
//! definition directories / entities.xml / types.xml / server asset root / engine
//! source root / engine message tables). The identification priority and strategy
//! are fully testable; the engine config rules are ported from TS discovery with
//! per-rule evidence (see the `src/workspaceDiscovery.ts:line` notes in the
//! [`conventions`] module).
//!
//! ROOT entry ledger (basic edition; corresponds to docs/kode2/pr-006.md):
//!
//! | Entry | Content | Location |
//! |---|---|---|
//! | ROOT-001 | Layered, testable root-identification priority: explicit config > remembered selection > convention chain > bounded deep scan; with multiple candidates prefer no guess over a wrong guess (ambiguity goes to diagnostics, never guessed) | [`resolve`] |
//! | ROOT-002 | Platform path rules: Windows case folding + drive-letter uppercasing / macOS folds by default (declared) / Linux is case sensitive / WSL UNC prefix semantics | [`platform`] |
//! | ROOT-003 | Per-platform canonical tree fixtures: linux_assets / engine_repo / multi_ambiguous etc.; the fixture is the acceptance test | `tests/fixtures/` |
//! | ROOT-004 | submodule / vendored determination: named in .gitmodules or carrying a .git marker = repo boundary; vendored component list = vendor boundary; anchors inside a boundary are downgraded so they never mislead root detection | [`scan`] |
//! | ROOT-005 | Mount cycle determination: in follow mode, a visited set of canonical identities + a depth cap guarantee termination of bind-mount cycles | [`scan`] |
//! | ROOT-006 | Alias-path determination: `//`, `./`, `..`, trailing `/`, symlink aliases -> the same root identity is recorded only once | [`platform`] + [`scan`] |
//! | ROOT-007 | Symlink cycle determination: directory symlinks are not followed by default (VFS-010 semantics); explicit following carries a cycle guard and never hangs | [`scan`] |
//! | ROOT-008 | Engine config rules ported with evidence: convention chain/probes/anchors all aligned to the TS implementation, comments carry file:line | [`conventions`] |
//! | ROOT-009 | Sensitive directories untouched: .git/node_modules/.vscode/out/dist/dot-prefixed directories are pruned, assertable per directory and per file (visited ledger) | [`scan`] |
//! | ROOT-010 | Parity with TS discovery: Rust dump-golden generates -> TS vitest recomputes with the existing scanWorkspaceAnchors, bidirectional gate | `tests/golden/` + `tests/kodeRootParity.test.ts` |
//! | ROOT-011 | UR+Path dual support: input may be a `file://` URI or a raw path, both normalized through kode-vfs CanonicalUri | [`platform`] |
//! | ROOT-012 | Diagnostics only on fresh discovery: discovery reports/diagnostics are produced only on cold runs and are not re-emitted on cache hits (reports carry a from_cache flag) | [`resolve`] |
//! | ROOT-013 | Bounded deep scan: depth 7 / 20000 entries caps share the same origin as TS; hitting a cap is honestly marked as truncated (zero hits ≠ absent) | [`scan`] |
//! | ROOT-014 | Multi-root registration and ownership: registration order = priority order, longest-prefix ownership, platform-folding awareness, conflicts surface as diagnostics | [`resolve`] |
//! | ROOT-015 | Engine-side locating family: kbe source root anchor + message-table dual-name four-tier + asset root family, all aligned to the TS semantics | [`resolve`] |
//!
//! Relationship to kode-vfs: the VFS-009 RootRegistry remains the identity layer for
//! document ownership; this crate is the discovery layer that decides "which
//! directories deserve to be roots", and its findings are handed to RootRegistry for
//! registration.

pub mod conventions;
pub mod diag;
pub mod golden;
pub mod platform;
pub mod resolve;
pub mod scan;

pub use conventions::{
    conventional_config_roots, has_engine_config_probe, DiscoveryConventions, CONVENTIONS,
    DEFAULT_SCAN_DEPTH, DEFAULT_SCAN_MAX_VISITED, SKIP_DIRECTORY_NAMES,
};
pub use diag::{RootDiagnostic, RootDiagnosticCode};
pub use platform::{case_folds, PlatformTarget, RootPath, RootPathError};
pub use resolve::{
    resolve_engine_messages_xml, AnchorKey, DiscoveryEngine, DiscoveryReport, ExplicitConfig,
    FieldReport, FieldStatus, PlatformRootRegistry, ResolutionSource, ENGINE_MESSAGES_LABELS,
};
pub use scan::{
    scan_workspace_anchors, AnchorScanner, Boundary, BoundaryKind, ScanOptions, ScanResult,
    VENDORED_DIR_NAMES,
};
