//! kode2 Phase2 P0: Python corpus layer.
//!
//! This crate only handles **discovery and lightweight lexical indexing** of `.py`
//! files; it is the shared prerequisite for the P1/P2 landing points and hover:
//! - [`enumerate`][]: deterministic `.py` enumeration (default excludes match the TS `PY_SCAN_EXCLUDE` set);
//! - [`encoding`][]: BOM + PEP 263 `coding:` cookie detection and decoding;
//! - [`symbols`][]: lexical extraction of indentation/parenthesis-continued statements that never executes Python, producing the class/method/attribute/import tables;
//! - [`index`][]: file-level corpus index updated incrementally by content fingerprint;
//! - [`golden`][]: golden serialization of the fixture corpus (write-only, never read).
//!
//! **Explicit boundary** (`docs/kode2/phase2-slice-a.md` §1 / `phase2-py-face-gap.md` §4):
//! no definition/hover/completion/diagnostics results, no new parser `FileKind`,
//! no change to the `serveFromRust()` always-false traffic-switch gate.

pub mod encoding;
pub mod enumerate;
pub mod golden;
pub mod index;
pub mod symbols;

pub use encoding::{
    decode_source, detect_encoding, DecodeError, DecodedSource, Encoding, EncodingDetection,
    EncodingSource,
};
pub use enumerate::{
    enumerate_python_files, EnumerateOptions, EnumerateStats, Enumeration, PythonFile,
    DEFAULT_PY_EXCLUDED_DIRS,
};
pub use golden::{
    python_golden, render_case, render_detection, render_module, GoldenAttribute, GoldenCase,
    GoldenClass, GoldenImport, GoldenInstance, GoldenMethod,
};
pub use index::{
    content_fingerprint, index_python_corpus, IndexIssue, IndexIssueKind, IndexStats,
    IndexedPythonFile, PythonCorpusIndex,
};
pub use symbols::{
    parse_python_module, AttributeSymbol, ClassSymbol, ImportSymbol, InstanceAssignment,
    MethodSymbol, PythonModule,
};
