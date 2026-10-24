//! kode2 Phase2 P0: Python 语料层。
//!
//! 本 crate 只负责 `.py` 的**发现与轻量词法索引**,是 P1/P2 落点与悬停的共同前置:
//! - [`enumerate`][]:确定性 `.py` 枚举(默认排除与 TS `PY_SCAN_EXCLUDE` 同集);
//! - [`encoding`][]:BOM + PEP 263 `coding:` cookie 探测与解码;
//! - [`symbols`][]:不执行 Python 的缩进/包裹连续语句词法抽取,产出类/方法/属性/导入四表;
//! - [`index`][]:按内容指纹增量的文件级语料索引;
//! - [`golden`][]:fixture 语料 golden 序列化(只写不读)。
//!
//! **明确边界**(`docs/kode2/phase2-slice-a.md` §1 / `phase2-py-face-gap.md` §4):
//! 不产出 definition/hover/completion/diagnostics 结果,不新增 parser `FileKind`,
//! 不改变 `serveFromRust()` 恒 false 的切流门禁。

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
