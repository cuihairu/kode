# Structure-aware Project Knowledge Index for kode-mcp (KODE-MCP-KB-002 · Design)

> Status: **design**. This document precedes the code; implementation starts
> after review passes and must align with this document item by item,
> reusing the repo's existing vocabulary and already-parsed data — no new
> coinage. Unimplemented surfaces are honestly marked "not implemented" and
> never dressed up as implemented.
>
> Task source: `todo.md` KODE-MCP-KB-002 (user directive 2026-11-08, P1).
> The user asked for "按此方案展开完整设计" (expand a complete design per
> this plan); this document is that expansion.
>
> Predecessors (already landed, part of KODE-MCP-KB-001): `search_docs`
> (3ff40139, project Markdown index), `search_symbols` (e3d87eff, Python
> symbol index), `list_config_settings` (169b9729, all config meanings),
> `why_setting` (KODE-CFG-018). The existing `explain` tool embeds
> compile-time knowledge articles; this index is a *dynamic, structure-aware*
> layer over the project's own files, complementary to `explain`.

## 1. What this is — and what it is NOT

This is a **structure-aware project knowledge index**, not a general-purpose
RAG service. The user's core principle (2026-11-08):

> 项目文档检索首先是定位问题，其次才是语义理解问题。
> (Project-document retrieval is first a localization problem, second a
> semantic-understanding problem.)

Therefore we do **not** copy the traditional RAG pipeline (chunk →
embedding → vector DB → similarity retrieval) as the default. Deterministic
exact/structure retrieval is the default path; vector semantics is a
**pluggable, on-demand** module enabled only when a query is genuinely
natural-language / fuzzy and exact search under-recalls. The engine chooses
the retrieval path by query characteristics (§8), not by running every
engine every time.

The index is **pure Rust**. Rust is only the implementation language; what
is indexed is **KBEngine schema semantics + Python type semantics**, not
Rust data structures.

## 2. Index-type selection

| Technology            | Best for                                      | Role here                                   |
| --------------------- | --------------------------------------------- | ------------------------------------------- |
| ripgrep / substring   | exact string, config key, symbol lookup       | built-in fallback (`search_docs`/`search_symbols` already use bounded substring walk) |
| BM25 / inverted index | API, term, design-doc search                  | Phase 2 (Tantivy), default main text index  |
| Trigram               | substring / symbol / path search in code      | Phase 2 (Tantivy trigram tokenizer), code retrieval |
| Structured hierarchical | sections, interfaces, classes, modules, types | **Phase 1 (this phase), strongly recommended** |
| Vector / RAG          | natural-language, fuzzy semantic              | Phase 3, **on-demand pluggable**            |
| Knowledge graph       | cross-module deps, complex relations          | Phase 4, later consideration                |

The strong recommendation (user) is the **structured hierarchical index**:
it localizes definitions/interfaces/types precisely, which is the dominant
need in a software project. Vector search is not faster or more accurate for
these; it solves a different (fuzzy) problem and is deferred.

## 3. Sources and format adapters

The index is **multi-format**, but the four file formats and the **parsed
in-memory data** are not peers in value. For a KBEngine project the
highest-value source is the **Python semantic model** (§4) formed by
unifying `.def` + `types.xml` + `.py`. Markdown (requirement/design docs) and
Excel (configuration tables) are supplementary document formats; XML config
(`kbengine.xml` / `kbengine_defaults.xml`) is already covered by the config
Q&A face.

| Format        | Library (user proposal)         | kode's in-repo equivalent (chosen)        | Index granularity           |
| ------------- | ------------------------------- | ----------------------------------------- | --------------------------- |
| Python        | tree-sitter-python              | **kode-python** (ruff AST, already the IDE analysis face) | module / class / function / method / attribute / import |
| XML (def/types) | quick-xml                     | **kode-parser + `AssetKnowledge`** (kb.rs, already parses defs/types.xml/message table into memory) | entity / property / method / type / config element |
| Markdown      | pulldown-cmark                  | docs_index (already landed)               | document / section / heading |
| Excel         | calamine                        | — (not implemented; needs calamine dep)   | workbook / sheet / field / row |
| Config XML    | quick-xml                       | **kode-parser resolve_config** (already landed) + serverConfigCatalog | option / value / meaning / file:line |

Design decision (honest): for Python we reuse **kode-python's ruff-based AST
symbol extraction** rather than introducing a second parser. It already
powers the IDE symbols/callgraph/dataflow faces, so the MCP index and the IDE
agree by construction (single source of truth). For def/types.xml we reuse
the already-parsed `AssetKnowledge` in-memory model rather than re-parsing —
this is exactly the user's "def 解析出来的内存数据" requirement: the parsed
in-memory data is a **first-class index source**, indexed as-is, not
re-derived from disk.

## 4. The Python semantic model (core)

`.def`, `types.xml` and `.py` are **three sources of the same Python type
system**, not three independent documents. This is the central design
correction (user 2026-11-08):

> `.def`、`types.xml` 和 `.py` 应视为同一套 Python 类型系统的不同信息来源，
> 而不是三类彼此独立的文档。

| Source     | Represents                                                     |
| ---------- | -------------------------------------------------------------- |
| `.def`     | engine-declared entity properties, remote methods, sync semantics |
| `types.xml`| custom types, aliases, serialization structures (ARRAY / FIXED_DICT / implementedBy) |
| `.py`      | real implementation: method bodies, type usage, conversion logic |

The semantic model unifies them:

- **Entity type view**: for each entity def, each property → resolved Python
  type. Resolution expands `types.xml` aliases: `ARRAY of T` → `list[T]`;
  `FIXED_DICT` → `TypedDict`/Python class; primitive alias → builtin.
- **implementedBy**: a `FIXED_DICT` (or entity) configured with
  `implementedBy` may be a **custom Python class** rather than a plain
  `dict`. The model must continue parsing the Python implementation and
  conversion functions, not stop at the XML.
  Two concrete forms occur in the wild: `MODULE.Class` (the symbol names a
  class) and `MODULE.inst` where the module holds a module-level instance
  assignment `inst = Class()` (the symbol names an *object*, resolved to its
  class by scanning the module source). Both must resolve to the class name;
  the object-name form cannot be answered from the symbol index alone.
- **Association edges**: def property ↔ Python class member; def remote
  method ↔ Python method (name + signature match); `types.xml` type ↔ Python
  class (implementedBy); Python import/call/dataflow ↔ definition.
- **Confidence tiers** (must never return a wrong *deterministic* claim):

  | Tier       | Meaning                                                |
  | ---------- | ------------------------------------------------------ |
  | Determined | statically certain (primitive alias, def property resolved to a concrete builtin) |
  | Inferred   | derived consistently from def + types.xml + py agreement |
  | Unknown    | Python dynamic attribute / `PYTHON` type / reflection — cannot be fully statically derived |

  Dynamic attributes and `PYTHON` types cannot be fully statically derived;
  these are surfaced as `Unknown`, never as a false `Determined`.

Example the model must answer:

- `Avatar.inventory` final Python type → `list[ItemData]` (via `ITEM_LIST` = `ARRAY of ITEM_DATA`, `ITEM_DATA` = `FIXED_DICT{itemId: UINT64, count: UINT32}`).
- `ItemData.count` used in which Python functions → reference graph.
- which `.def` property maps to which Python class member → association edges.
- which Python class actually implements `implementedBy` → implementedBy resolution.
- does a Python method's params match a def-declared remote method → signature check.

## 5. Unified node model and edges

```rust
pub struct IndexNode {
    pub id: String,             // stable id: project + file + kind + name (+ version/hash)
    pub project: String,
    pub file_path: String,
    pub kind: NodeKind,
    pub name: String,
    pub content: String,        // bounded; full content read on demand
    pub location: SourceLocation,
    pub content_hash: String,   // BLAKE3
    pub confidence: Confidence, // Determined | Inferred | Unknown
}

pub enum NodeKind {
    Document, Section,             // Markdown
    ExcelSheet, ExcelColumn, ExcelRow,
    PythonClass, PythonFunction, PythonMethod, PythonAttribute,
    Entity, EntityProperty, EntityMethod,   // .def
    XmlType, XmlElement, XmlAttribute,      // types.xml / config
}

pub enum SourceLocation {
    Lines { start: usize, end: usize },                 // 1-based
    Excel { sheet: String, range: String },
    Xml { path: String, line: usize },                  // XPath-style path + line
}

pub struct Reference {
    pub source_node: String,
    pub target_node: String,
    pub relation: Relation,      // Defines | References | Imports | Contains | Configures | Implements | Calls
    pub confidence: Confidence,
    pub rule: String,            // which project rule produced this edge (see §10)
}
```

Edges are maintained separately from nodes: `defines`, `references`,
`imports`, `contains`, `configures`, `implements`, `calls`. This supports
cross-document tracing.

## 6. Storage

**Phase 1 (this phase): in-memory structured index.** The structured
hierarchical index and the semantic model live in memory, built once from
the already-parsed `AssetKnowledge` + kode-python symbols. No new storage
dependency for P1 — the value is the semantic model + exact queries.

**Phase 2: Tantivy + SQLite.** Tantivy provides BM25 full-text + trigram
tokenization; SQLite stores structure, symbols, relations, file metadata and
locations. Local exact queries are the bulk; a vector DB (Qdrant/Milvus) is
**not** introduced — Tantivy + SQLite cover the local retrieval need. Chinese
text is tokenized with a CJK-friendly tokenizer; English/code symbols use a
dedicated tokenizer.

## 7. MCP tool surface

Not just one `search_documents`; the AI needs staged locate → query → read →
verify:

| Tool             | Status   | Role                                             |
| ---------------- | -------- | ------------------------------------------------ |
| `search`         | P1 (unify) | unified search, format + path filters           |
| `find_symbol`    | P1       | Python class/function, XML type, def property definition |
| `find_references`| P1       | references to a symbol/config across formats     |
| `read_node`      | P1       | precise read of a section/function/XML element   |
| `query_xml`      | P1       | element by path / attribute / namespace          |
| `get_dependencies` | P1    | cross-file affected range (def change → types.xml → py) |
| `index_status`   | P1       | index version, files scanned, errors, confidence |
| `query_excel`    | P4       | by sheet / key / field (needs calamine)          |

Existing tools (`search_entities`, `get_entity_model`, `get_type_graph`,
`get_message_entry`, `get_database_schema`, `explain`, `why_setting`,
`list_config_settings`, `get_final_config`, `get_entry_scripts`,
`encode_decode_sample`, `db_schema_preview`, `validate_defs`,
`search_docs`, `search_symbols`) remain; the new tools add the *semantic*
and *reference* dimensions, and `search` can eventually route to them.

Example query the tool surface must answer directly (not via AI inference):

```
find_references { symbol: "PLAYER_DATA", formats: ["xml","python","excel"] }
→ exact file, line/cell location + the parsed reference rule that produced it
```

## 8. Query routing by characteristics

The three retrieval engines do **not** all run per query. The MCP server
routes by query shape:

- **Exact symbol / type / config key** → structured hierarchical index
  (`find_symbol`, `why_setting`, `query_xml`) — no embedding, no BM25 scan.
- **API / term / design keyword** → BM25 inverted index (Phase 2), optional
  trigram for code/path substrings.
- **Natural-language fuzzy / term mismatch / exact under-recalls** → vector
  semantic retrieval (Phase 3, pluggable), possibly fused with BM25.

Default is **deterministic**. Vector runs only when exact search under-recalls
or the query is clearly NL — avoiding an Embedding-model call on every MCP
query.

## 9. Incremental update

Phase 2+ (notify + BLAKE3 + git status):

- `notify` filesystem watcher + periodic BLAKE3 hash reconciliation (network
  filesystems are unreliable for events).
- Per-file content hash dedup: unchanged file skipped, avoiding re-parse.
- Markdown updates in section units with stable node ids.
- Python: incremental re-parse, full re-parse fallback on parse error.
- XML: re-parse per element subtree, diff into node set.
- Excel: re-parse changed workbook, compare by sheet/row key.
- Read-only index: never read keys/temp/protected files; Excel archives
  resource-bounded.

## 10. Cross-format reference rules

Reference edges are **not** auto-assumed from same-name strings. They must be
produced by **configurable project rules**:

- XML type-declaration rule: a `types.xml` element with `FIXED_DICT`/`ARRAY`
  named `T` defines type `T`; a `.def` property `<Type>T</Type>` references it.
- Excel foreign-key rule: a column declared (by project rule) as referencing
  an entity/type name.
- Python import/attribute rule: `import`/`from` binding resolves to a
  definition; attribute use `self.x` / `instance.method` resolves to class
  member / method.
- implementedBy rule: `implementedBy="mod.Class"` → Python class in that
  module.

Each edge records the `rule` that produced it, so the AI gets the *parsed
reason*, not an inference to trust blindly. Same-name heuristic edges are
flagged `Unknown` confidence, never `Determined`.

## 11. RAG placement (phased)

| Mode        | Composition                                                       |
| ----------- | ----------------------------------------------------------------- |
| Light (default) | exact + BM25 + structure relations                            |
| Enhanced    | light + optional vector                                            |
| Semantic-first | hybrid retrieval + vector rerank                                 |

Recommendation: default deterministic; enable vector only when exact search
under-recalls or the query is natural language. The vector semantic index is
a **pluggable module**, enabled after real queries demonstrate the need — not
built up-front. Excel parsing (calamine), the full Tantivy+SQLite layer, the
knowledge graph and the vector module are all honestly deferred to later
phases.

## 12. Phased roadmap

- **P1 (this phase, kode-mcp)**: Python semantic model core — def property →
  types.xml type expansion → Python member association, confidence tiers,
  implementedBy resolution, reference edges from *already-parsed* data. Tools
  `find_symbol`, `query_xml`, `find_references`, `index_status` (+ `read_node`
  where the parsed model already yields a precise span). In-memory, no new
  storage dep. Accepts the existing 15-tool set unchanged.
- **P2**: Tantivy + SQLite persistence, BM25/trigram tokenizers, incremental
  update (notify + BLAKE3 + git), `search` unification, Chinese tokenizer.
- **P3**: pluggable vector module (on-demand), hybrid fusion.
- **P4**: Excel (`calamine`), knowledge graph, `query_excel`, `get_dependencies`
  full cross-format trace.

Honest boundary: P1 does **not** add Tantivy/SQLite/calamine or the vector
module; it builds the semantic model and exact/reference queries over data the
repo already parses. Unimplemented P2-P4 surfaces are marked "not implemented"
in tool descriptions and never advertised as available.

## 13. Acceptance gates

- `cargo test -p kode-mcp` all green; `cargo clippy -p kode-mcp` 0.
- Semantic model unit tests: the §4 examples (`Avatar.inventory →
  list[ItemData]`, implementedBy → Python class, confidence Unknown for
  dynamic) are covered by fixtures with prove-red (old code fails the new
  assertions).
- e2e: `find_symbol`/`query_xml`/`find_references`/`index_status` return real
  data from `tests/fixtures/kbengine-demo-assets`; `list_tools` count updated.
- Docs (this design + tool descriptions) locked step with implementation;
  nothing unimplemented is described as available.
- `tsc 0` / `lint 0` unaffected (kode-mcp is a standalone crate; TS gate is a
  no-op for this crate but run to confirm the tree stays green).
