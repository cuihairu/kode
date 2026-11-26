//! The hover response chain (PR-010, book §8 LSP-003 / §17 PR-010 / PH1-03 vertical slice).
//!
//! The "HOVER-001..013" codes mentioned in this ticket's dispatch have no such prefix entries in the book's KODE_2_COMPLETE_TODO.md
//! (§8 is the LSP series), the same situation as PR-008's TYPE prefix: this module follows §17 PR-010's original text
//! + LSP-003, and the chain-face numbering is defined in docs/kode2/pr-010.md with item-by-item mapping to book entries, claiming nothing extra.
//!
//! The response chain (locate -> document -> signature -> inherited members), all purely synchronous, zero IO:
//! - Locate: UTF-16 position -> word -> symbols declared in this file (six kinds, the same face as PR-007);
//!   a `.def`'s `<Parent>` tag/value word triggers the inheritance-chain face;
//! - Document: symbol kind + owning section (the face sharing a source with TS getSectionLabel) + the origin file;
//! - Signature: properties (Type/Flags/Default/DetailLevel/DatabaseLength/Identifier/
//!   Persistent), methods (facet/Arg/Exposed),
//!   components (Type/Persistent), type declarations (kind / redirect target), aliases (the Type target),
//!   entity registrations (def existence), and def entity bodies (Parent);
//! - Inherited members: the def chain (parent recursion + interfaces flattened + components attached, the same stance as TS
//!   buildDefChain, cycles truncated with explicit marking) + the property/method member expansion of each ancestor on the chain.
//!
//! RUST-136 adds three faces (still zero IO, derivable from the corpus):
//! - Source: the document holding the hovered word + the hit declaration line (1-based);
//! - Available facets: the def-entity-body face gives this def's non-empty method sections among the three (base->cell->
//!   client order); the method face's markdown renders a Facet line (from the existing symbol.facet structural face);
//! - Comment: the `<!-- -->` comment block immediately above the declaration (blank lines may intervene, stopping at the first
//!   content line). The version face is outside the corpus-derivable domain (the engine version = TS kbengine.engineVersion's
//!   declared stance; its supply chain belongs to the RUST-113 domain, not built and not wired); full type resolution (types.xml
//!   FIXED_DICT field names) is left to a parser-model extension, likewise not built.
//!
//! ARCH-012 red line: no performance claims; the only structural guarantee (LSP-003 forbids blocking): a query
//! only touches the text this file already holds and the filed-corpus view -- no disk scans, no whole-repo walks.
//!
//! Comparison: the TS side's `tests/kodeHoverParity.test.ts` recomputes the same corpus's hover face with defParser/compositionRoots/
//! buildDefChain and compares field by field against the golden produced by [`dump_hover_golden`]
//! (a bidirectional gate, isomorphic with PR-005/007/008).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use kode_index::symbol::{def_entity_name, extract_records, MethodFacet, SymbolKind};
use kode_index::ChangeCategory;
use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_parser::json::{collect_corpus, PARITY_CORPORA};
use kode_parser::model::{
    parse_alias, parse_def, parse_entities, parse_types, DefFile, TypeDecl, TypeField, TypeKind,
};
use kode_vfs::store::{DocumentKey, RootId};

// ---------------------------------------------------------------------------
// Response model (the structured face; markdown rendering exists only for LSP contents compatibility, not the comparison face)
// ---------------------------------------------------------------------------

/// One hover response: symbol identity + source face + signature face + inheritance face (def entity bodies only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverResponse {
    /// The request's single face. Shadow comparison compares face first; a different face is a diff, never normalized
    /// across faces; only the same face proceeds to strict body comparison.
    pub face: HoverFace,
    pub symbol: HoverSymbol,
    /// Source face: the document holding the hovered word (canonical path) + the hit declaration line (1-based). The hovered
    /// word's document is the declaration document (locating only holds over symbols declared in this file), and line = each face's
    /// hit declaration line. Pure memory, zero IO (RUST-136).
    pub source: HoverSource,
    pub signature: HoverSignature,
    /// The inheritance-closure face when hovering a def entity or a `<Parent>`; None otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<InheritedChain>,
}

/// Source face (RUST-136): file = the hover document's canonical path (in the golden context = the corpus key's
/// relative path, sharing a source with golden files[].file); line = the hit declaration line (1-based).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverSource {
    pub file: String,
    pub line: usize,
}

/// The hover provider face (exactly one per request).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HoverFace {
    DefEntity,
    DefProperty,
    DefMethod,
    DefComponent,
    EntitiesXml,
    TypesXml,
    AliasXml,
}

/// Symbol identity (the locate result). `kind`/`facet` use the same literals as the PR-007 symbol face.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverSymbol {
    pub name: String,
    pub kind: String,
    pub facet: Option<String>,
    /// Owning section: sharing an input source with TS getSectionLabel (Entity/Properties/Components/
    /// BaseMethods/CellMethods/ClientMethods/Entities/Types/Aliases)。
    pub section: &'static str,
}

/// Signature face: filled by symbol kind; inapplicable fields are null (keys always present, both comparison sides share the shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HoverSignature {
    /// Property: the first token of the `<Type>` direct text.
    pub r#type: Option<String>,
    /// Full type (RUST-136 increment 2): the `<Type>` token recursively expanded via the root's types.xml declarations
    /// into a readable full text (FIXED_DICT key field names / ARRAY elements; depth guard <= 3;
    /// an expansion equal to the original token (builtin / absent / empty FD / ARRAY without of) = null). Two consumer faces:
    /// def properties + types.xml declaration bodies.
    pub full_type: Option<String>,
    /// Property: the `<Flags>` raw text (trimmed).
    pub flags: Option<String>,
    /// Property: the `<Default>` raw text (trimmed).
    pub default_value: Option<String>,
    /// Property: `<DetailLevel>` (legacy spellings recognized too).
    pub detail_level: Option<String>,
    /// Property: the `<DatabaseLength>` raw text (trimmed).
    pub database_length: Option<String>,
    /// Property: the `<Identifier>` raw text (trimmed).
    pub identifier: Option<String>,
    /// Property/component: `<Persistent>` truthiness; null when the tag is absent.
    pub persistent: Option<bool>,
    /// Method: the number of Args.
    pub arg_count: Option<usize>,
    /// Method: the `<Arg>` texts (in order of appearance).
    pub args: Option<Vec<String>>,
    /// Method: `<Exposed>` truthiness.
    pub exposed: Option<bool>,
    /// Component: the `<Type>` value (the component def name).
    pub component_type: Option<String>,
    /// types.xml declaration: fixedDict | array | builtin (the same literals as TS parseTypesXml).
    pub type_kind: Option<String>,
    /// The target of a types.xml redirect entry (the first token of a directive that is not FIXED_DICT/ARRAY).
    pub alias_target: Option<String>,
    /// alias.xml: the `<Type>` target.
    pub alias_type: Option<String>,
    /// entities.xml registration: the hit def path (first seen in the corpus); a conventional name when there is no hit.
    pub def_file: Option<String>,
    /// entities.xml registration: whether the def is in the filed corpus.
    pub def_exists: Option<bool>,
    /// Def entity body: the `<Parent>` name.
    pub parent: Option<String>,
    /// Comment face (RUST-136): the `<!-- -->` comment block immediately above the declaration (blank lines may intervene,
    /// stopping at the first non-comment content line; strip markers and trim line by line, drop leading/trailing blank lines, join multiple lines with '\n').
    /// None when absent.
    pub comment: Option<String>,
    /// Available facets (RUST-136): the def-entity-body face = this def's non-empty sections among the three method sections
    /// (base->cell->client order); all other faces are always an empty array (keys always present).
    pub facets: Vec<String>,
}

/// Inheritance-chain node (shared by the three def-chain faces): existence = the path is in the filed corpus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainNodeInfo {
    pub name: String,
    pub exists: bool,
}

/// The member expansion of a single ancestor on the chain (the inherited-members face).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSummary {
    pub entity: String,
    pub exists: bool,
    pub properties: Vec<MemberProperty>,
    pub methods: Vec<MemberMethod>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProperty {
    pub name: String,
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberMethod {
    pub name: String,
    pub facet: &'static str,
}

/// Def-chain face (isomorphic with the TS buildDefChain output + member expansion):
/// the parent chain starts at the immediate parent; interfaces/components are flattened within the closure (same-named entries deduplicated, first-seen kept, order preserved);
/// interface defs do not follow Parent; cycles are truncated with explicit marking, never looping forever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedChain {
    pub parent_chain: Vec<ChainNodeInfo>,
    pub interfaces: Vec<ChainNodeInfo>,
    pub components: Vec<ChainNodeInfo>,
    pub cycle_truncated: bool,
    pub members: Vec<MemberSummary>,
}

/// Section name -> the same Chinese section wording as TS getSectionLabel (aligned with the PR-012 gate §1.3-(3) rendering face;
/// unmapped sections keep the raw text; on the TS side those sections go through another hover face, outside this alignment's scope).
fn section_label(section: &str) -> &str {
    match section {
        "Properties" => "属性区块",
        "BaseMethods" | "CellMethods" | "ClientMethods" => "方法区块",
        "Components" => "组件区块",
        "Parent" => "父类区块",
        "Interfaces" => "接口区块",
        "Volatile" => "易变同步区块",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// RUST-136 increment 2: fullType expansion (the same algorithm as the tests/kodeHoverParity.test.ts TS mirror --
// recursion depth guard, separators, and null criteria all map item for item)
// ---------------------------------------------------------------------------

/// The expansion recursion depth guard: past it the raw token is presented (cycle/blowup protection).
const FULL_TYPE_MAX_DEPTH: usize = 3;

/// The root's types.xml declaration table: path lexicographic order (BTreeMap key order), first-seen for same names
/// (entry/or_insert); root isolation = a path_roots ownership check (the KBUG-ROOT stance).
fn root_types_table<'a>(
    types_files: &'a BTreeMap<String, kode_parser::model::TypesFile>,
    path_roots: &'a BTreeMap<String, RootId>,
    root: RootId,
) -> BTreeMap<&'a str, &'a TypeDecl> {
    let mut table = BTreeMap::new();
    for (path, tf) in types_files {
        if path_roots.get(path) != Some(&root) {
            continue;
        }
        for decl in &tf.types {
            table.entry(decl.name.as_str()).or_insert(decl);
        }
    }
    table
}

/// Expand a token recursively through the declaration table: FD -> `FIXED_DICT { name: display, ... }`, ARRAY ->
/// `ARRAY<expanded>`; builtin / absent / empty FD / ARRAY without of -> the original token; depth >= the guard -> the original token.
fn expand_type_token(table: &BTreeMap<&str, &TypeDecl>, tok: &str, depth: usize) -> String {
    if depth >= FULL_TYPE_MAX_DEPTH {
        return tok.to_string();
    }
    let Some(decl) = table.get(tok) else {
        return tok.to_string();
    };
    match decl.kind {
        TypeKind::Builtin => tok.to_string(),
        TypeKind::Array => match &decl.element_ref {
            Some(elem) => format!("ARRAY<{}>", expand_type_token(table, elem, depth + 1)),
            None => tok.to_string(),
        },
        TypeKind::FixedDict => {
            if decl.fields.is_empty() {
                return tok.to_string();
            }
            let inner = decl
                .fields
                .iter()
                .map(|f| format!("{}: {}", f.name, expand_field(table, f, depth + 1)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("FIXED_DICT {{ {} }}", inner)
        }
    }
}

/// FD key-field display: ARRAY fields expand through the `<of>` element (no of = `ARRAY`);
/// other tokens expand directly (the depth continues from the caller's already-incremented level).
fn expand_field(table: &BTreeMap<&str, &TypeDecl>, f: &TypeField, depth: usize) -> String {
    if f.directive == "ARRAY" {
        return match &f.of_ref {
            Some(of) => format!("ARRAY<{}>", expand_type_token(table, of, depth + 1)),
            None => "ARRAY".to_string(),
        };
    }
    expand_type_token(table, &f.directive, depth)
}

/// The def property face: ARRAY directives expand through the `<of>` element, other tokens expand directly;
/// an expansion equal to the original token -> None.
fn full_type_of_property(
    table: &BTreeMap<&str, &TypeDecl>,
    tok: Option<&str>,
    of: Option<&str>,
) -> Option<String> {
    let tok = tok?;
    let expanded = if tok == "ARRAY" {
        let of = of?;
        format!("ARRAY<{}>", expand_type_token(table, of, 1))
    } else {
        expand_type_token(table, tok, 0)
    };
    if expanded == tok {
        None
    } else {
        Some(expanded)
    }
}

/// Render LSP contents as markdown (the property/method faces are byte-for-byte identical to TS getSymbolHover in
/// text and trailing whitespace, PR-012 gate §1.3-(3); the other faces use Rust-side wording and are not the comparison face).
pub fn render_markdown(response: &HoverResponse) -> String {
    let mut md = String::new();
    md.push_str(&format!("**{}**\n\n", response.symbol.name));
    md.push_str(&format!(
        "{}中的自定义定义。\n\n",
        section_label(response.symbol.section)
    ));
    // RUST-136 source face: the declaration document; the declaration line (1-based).
    md.push_str(&format!(
        "**Source**: `{}:{}`\n\n",
        response.source.file, response.source.line
    ));
    let s = &response.signature;
    let kind = response.symbol.kind.as_str();
    if kind == "property" {
        // Property face: field order/wording/trailing whitespace are byte-for-byte identical to TS getSymbolHover's property block
        // (languageProviders.ts:1623-1649:Type→Flags→Default→DetailLevel→
        // through DatabaseLength->Identifier). The TS property face does not render **Persistent**; the Rust face, being the same face,
        // no longer emits it on one side only; the database-storage section needs a DB snapshot (the FS/DB face), an attribution boundary.
        // RUST-136 increment 2: the **Full Type** line is a Rust-side added face (TS production hover has not followed,
        // the comparison face = the golden data face, not the markdown), placed right after the Type line.
        if let Some(t) = &s.r#type {
            md.push_str(&format!("**Type**: `{t}`\n\n"));
        }
        if let Some(ft) = &s.full_type {
            md.push_str(&format!("**Full Type**: `{ft}`\n\n"));
        }
        if let Some(f) = &s.flags {
            md.push_str(&format!("**Flags**: `{f}`\n\n"));
        }
        if let Some(d) = &s.default_value {
            md.push_str(&format!("**Default**: `{d}`\n\n"));
        }
        if let Some(d) = &s.detail_level {
            md.push_str(&format!("**DetailLevel**: `{d}`\n\n"));
        }
        if let Some(l) = &s.database_length {
            md.push_str(&format!("**DatabaseLength**: `{l}`\n\n"));
        }
        if let Some(i) = &s.identifier {
            md.push_str(&format!("**Identifier**: `{i}`\n\n"));
        }
        append_doc_block(&mut md, &s.comment);
        return md;
    }
    if kind == "method" {
        // Method face: isomorphic with TS -- the **Args** line carries no trailing blank line (the Exposed section's
        // leading blank line connects); with no Args, the **argument count** line's trailing blank line closes it.
        // RUST-136 facet line: symbol.facet (base/cell/client) is the method's owning section.
        if let Some(facet) = &response.symbol.facet {
            md.push_str(&format!("**Facet**: `{facet}`\n\n"));
        }
        md.push_str(&format!("**参数个数**: {}\n\n", s.arg_count.unwrap_or(0)));
        if let Some(args) = &s.args {
            if !args.is_empty() {
                md.push_str(&format!("**Args**: `{}`", args.join(", ")));
            }
        }
        if let Some(true) = s.exposed {
            md.push_str("\n\n**Exposed**: `true`\n\n该方法可被客户端远程调用。");
        }
        append_doc_block(&mut md, &s.comment);
        return md;
    }
    if let Some(t) = &s.r#type {
        md.push_str(&format!("**Type**: `{t}`\n\n"));
    }
    if let Some(f) = &s.flags {
        md.push_str(&format!("**Flags**: `{f}`\n\n"));
    }
    if let Some(d) = &s.detail_level {
        md.push_str(&format!("**DetailLevel**: `{d}`\n\n"));
    }
    if let Some(p) = s.persistent {
        if p {
            md.push_str("**Persistent**: `true`\n\n");
        }
    }
    if let Some(n) = s.arg_count {
        md.push_str(&format!("**参数个数**: {n}\n\n"));
    }
    if let Some(args) = &s.args {
        if !args.is_empty() {
            md.push_str(&format!("**Args**: `{}`\n\n", args.join(", ")));
        }
    }
    if let Some(true) = s.exposed {
        md.push_str("**Exposed**: `true`\n\n该方法可被客户端远程调用。\n\n");
    }
    if let Some(ctype) = &s.component_type {
        md.push_str(&format!("**Component Type**: `{ctype}`\n\n"));
    }
    if let Some(kind) = &s.type_kind {
        md.push_str(&format!("**TypeKind**: `{kind}`\n\n"));
    }
    if let Some(ft) = &s.full_type {
        md.push_str(&format!("**Full Type**: `{ft}`\n\n"));
    }
    if let Some(target) = &s.alias_target {
        md.push_str(&format!("**AliasType**: `{target}`\n\n"));
    }
    if let Some(target) = &s.alias_type {
        md.push_str(&format!("**AliasType**: `{target}`\n\n"));
    }
    if let Some(parent) = &s.parent {
        md.push_str(&format!("**Parent**: `{parent}`\n\n"));
    }
    if let Some(def_file) = &s.def_file {
        md.push_str(&format!("**Definition**: `{def_file}`\n\n"));
    }
    // RUST-136 available facets: the entity-body face's non-empty sections among the three method sections (base->cell->client order).
    if !s.facets.is_empty() {
        let names: Vec<String> = s.facets.iter().map(|f| format!("`{f}`")).collect();
        md.push_str(&format!("**Facets**: {}\n\n", names.join("、")));
    }
    if let Some(chain) = &response.inherited {
        md.push_str("**def 链**(引擎归并口径)\n\n");
        if !chain.parent_chain.is_empty() {
            let names: Vec<String> = chain.parent_chain.iter().map(chain_node_label).collect();
            let note = if chain.cycle_truncated {
                ";检测到环,已截断"
            } else {
                ""
            };
            md.push_str(&format!(
                "- **Parent 链**: {}(共 {} 层{note})\n\n",
                names.join(" → "),
                chain.parent_chain.len()
            ));
        }
        if !chain.interfaces.is_empty() {
            let names: Vec<String> = chain.interfaces.iter().map(chain_node_label).collect();
            md.push_str(&format!(
                "- **Interfaces 平铺**: {}(接口 def 不跟随 Parent)\n\n",
                names.join("、")
            ));
        }
        if !chain.components.is_empty() {
            let names: Vec<String> = chain.components.iter().map(chain_node_label).collect();
            md.push_str(&format!("- **Components 挂接**: {}\n\n", names.join("、")));
        }
        for member in &chain.members {
            if !member.exists {
                continue;
            }
            let props: Vec<String> = member
                .properties
                .iter()
                .map(|p| match &p.r#type {
                    Some(t) => format!("{}:`{t}`", p.name),
                    None => p.name.clone(),
                })
                .collect();
            let methods: Vec<String> = member
                .methods
                .iter()
                .map(|m| format!("{}({})", m.name, m.facet))
                .collect();
            md.push_str(&format!(
                "- **{} 成员**: 属性 [{}];方法 [{}]\n\n",
                member.entity,
                props.join(", "),
                methods.join(", ")
            ));
        }
    }
    // RUST-136 comment face: the `<!-- -->` block immediately above the declaration, rendered line by line as a quote block.
    append_doc_block(&mut md, &s.comment);
    md.trim_end().to_string()
}

/// RUST-136 comment-face block (the `<!-- -->` declaration comment immediately above, rendered line by line as a quote block); the
/// property/method early-return branches and the generic tail share the three-section rendering path, so the comment face appears on every face.
fn append_doc_block(md: &mut String, comment: &Option<String>) {
    let Some(doc) = comment else {
        return;
    };
    md.push_str("**Doc**\n\n");
    for line in doc.lines() {
        md.push_str(&format!("> {line}\n"));
    }
    md.push('\n');
}

fn chain_node_label(node: &ChainNodeInfo) -> String {
    if node.exists {
        format!("`{}`", node.name)
    } else {
        format!("`{}`(def 缺失)", node.name)
    }
}

/// The entity-body face's available facets (RUST-136): this def's non-empty sections among the three method sections (the fixed
/// base->cell->client order); inherited-face methods are not on this face (chain members already carry their facet per ancestor).
fn entity_facets(def: &DefFile) -> Vec<String> {
    let mut out = Vec::new();
    if !def.base_methods.is_empty() {
        out.push("base".to_string());
    }
    if !def.cell_methods.is_empty() {
        out.push("cell".to_string());
    }
    if !def.client_methods.is_empty() {
        out.push("client".to_string());
    }
    out
}

/// The `<!-- -->` comment block immediately above the declaration line (1-based) (the RUST-136 comment face). Rules:
/// scan upward from the line above the declaration; blank lines may intervene, stopping at the first non-comment content line; a multi-line comment
/// (`<!--` opens, `-->` closes on separate lines) continues upward; strip markers and trim line by line, drop the block's leading/trailing blank lines, and
/// join multiple lines with '\n'. A malformed unclosed comment returns what was collected so far at the top (honestly: not escalated to
/// an error); a same-line trailing comment on the declaration line itself is outside the scan domain (it is not "above").
fn preceding_comment(text: &str, decl_line1: usize) -> Option<String> {
    if decl_line1 <= 1 {
        return None;
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut pieces: Vec<String> = Vec::new();
    let mut in_comment = false; // the multi-line state: a `-->` tail was seen, scanning upward for the `<!--` opening
    let mut idx = decl_line1 - 2; // 0-based: the line above the declaration
    while let Some(line) = lines.get(idx) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if in_comment {
                break; // a blank line inside a multi-line comment: the block ends here
            }
        } else {
            let opens = trimmed.contains("<!--");
            let closes = trimmed.contains("-->");
            if !opens && !closes {
                break; // a non-comment content line: stop
            }
            if closes {
                // Content = after the last `<!--` up to before its first `-->` (when there is no `<!--`,
                // from the line start); boundary-safe even when `-->` is not at the line end.
                let start = trimmed.rfind("<!--").map(|p| p + 4).unwrap_or(0);
                let end = trimmed[start..]
                    .find("-->")
                    .map(|p| start + p)
                    .unwrap_or(trimmed.len());
                let content = trimmed[start..end].trim();
                if !content.is_empty() {
                    pieces.push(content.to_string());
                }
                if opens {
                    break; // closed on the same line: the block start
                }
                in_comment = true; // a multi-line comment tail, continue upward
            } else {
                // Only `<!--` (a multi-line comment opening line): counts as the block start only within the multi-line state, otherwise treated
                // as a content line (an unclosed `<!--` hanging above content does not count as a comment block).
                if !in_comment {
                    break;
                }
                let pos = trimmed.rfind("<!--").expect("contains checked");
                let content = trimmed[pos + 4..].trim();
                if !content.is_empty() {
                    pieces.push(content.to_string());
                }
                break; // the block start: collection complete
            }
        }
        if idx == 0 {
            break;
        }
        idx -= 1;
    }
    if pieces.is_empty() {
        return None;
    }
    pieces.reverse();
    Some(pieces.join("\n"))
}

// ---------------------------------------------------------------------------
// HoverEngine: corpus views + locating + the response chain
// ---------------------------------------------------------------------------

/// RUST-078-W: the hover parse residency budget (the weight unit = the resident parse products' own string bytes;
/// RUST-129 measured a def-shaped RSS of about weight x 3, so a 256 MiB weight is roughly 768 MiB RSS, the same order as the warm-gate
/// stress budget). Over budget it evicts via a second-chance approximated LRU; losing a cache entry loses no correctness
/// (a re-update of the evicted file rebuilds it).
pub const HOVER_PARSE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

/// The hover engine: holds the symbol index and the filed def-corpus views, answering purely from memory.
#[derive(Debug)]
pub struct HoverEngine {
    pub index: kode_index::SymbolIndex,
    /// Def semantic views: keyed **by path** (the same semantics as TS reading files per path; same-named entities across corpora
    /// never interfere with each other).
    def_files: BTreeMap<String, DefFile>,
    /// Entity name (file stem) -> same-root candidate paths (the entities.xml registration's defFile face;
    /// KBUG-ROOT: isolated by DocumentKey.root, so same-named entries across project roots never borrow from each other; within a root, by
    /// filing order; ambiguous same-name multi-candidates are not force-guessed as first-seen).
    pub(crate) def_by_name: BTreeMap<(RootId, String), Vec<String>>,
    /// Filed def file paths (the existence check, corresponding to TS's fs.existsSync face).
    pub(crate) corpus_defs: BTreeSet<String>,
    /// The directory holding entities.xml (for the defsRoot upward probe).
    entities_dirs: BTreeSet<String>,
    /// The entities.xml corpus view (the Phase2 diagnostic/definition face: keyed by path).
    pub(crate) entities_files: BTreeMap<String, kode_parser::model::EntitiesFile>,
    /// The types.xml corpus view (the PR-011 type completion face: keyed by path, no cross-corpus same-name interference).
    pub(crate) types_files: BTreeMap<String, kode_parser::model::TypesFile>,
    /// The alias.xml corpus view (the PR-011 alias completion face).
    pub(crate) alias_files: BTreeMap<String, kode_parser::model::AliasFile>,
    /// The def/types corpus **raw text** (the RUST-138 references occurrence scan needs a per-file full-text
    /// rescan; the parse model carries no raw-text coordinates). BodyOnly (model-equal, text-different) refreshes too --
    /// occurrence line numbers depend directly on the raw text; the old text must not be used.
    texts: BTreeMap<String, String>,
    /// Path -> owning root (RUST-069-W): the path-keyed corpus views do not record roots, so the root-purge fan-out relies on this
    /// ownership table to scope the clearing; update registers, remove/invalidate_root removes.
    path_roots: BTreeMap<String, RootId>,
}

impl Default for HoverEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// RUST-069-W: HoverEngine registers into WorkspaceSession as a shared-cache consumer face;
/// on root purge the session fans out root-level invalidation in registration order (the receipt name hover-engine).
impl kode_scheduler::RootInvalidationSink for HoverEngine {
    fn invalidate_root(&mut self, root: RootId) -> usize {
        HoverEngine::invalidate_root(self, root)
    }

    fn sink_name(&self) -> &'static str {
        "hover-engine"
    }
}

impl HoverEngine {
    pub fn new() -> HoverEngine {
        HoverEngine {
            index: kode_index::SymbolIndex::with_parse_budget(HOVER_PARSE_BUDGET_BYTES),
            def_files: BTreeMap::new(),
            def_by_name: BTreeMap::new(),
            corpus_defs: BTreeSet::new(),
            entities_dirs: BTreeSet::new(),
            entities_files: BTreeMap::new(),
            types_files: BTreeMap::new(),
            alias_files: BTreeMap::new(),
            texts: BTreeMap::new(),
            path_roots: BTreeMap::new(),
        }
    }

    /// File a single document: maintain the symbol index + corpus views together, invalidating differentially by change class
    /// (RUST-120-W): `Identical` = the text fingerprint hits => the corpus model must be equal => the views are written nowhere;
    /// `BodyOnly` = registered facts (the corpus model) fully equal => the views are written nowhere (the index layer does not bump
    /// the generation either, so readers holding snapshots all survive); `Signature` = re-populate the views.
    /// Files outside the four corpus classes (.py etc.) have no corpus views; the class = the index layer's judgement.
    pub fn update(&mut self, key: DocumentKey, text: &str) -> ChangeCategory {
        let report = self.index.update(key.clone(), text);
        if report.change == ChangeCategory::Identical {
            return ChangeCategory::Identical;
        }
        let path = key.uri.as_path().to_string();
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                let parsed = parse_def(text);
                // Raw-text residency sits **before** the model-equality early return: BodyOnly (model-equal, text-different,
                // e.g. comment additions/removals) must refresh too -- references occurrence coordinates depend on raw-text line positions.
                self.texts.insert(path.clone(), text.to_string());
                if self.def_files.get(&path) == Some(&parsed) {
                    return ChangeCategory::BodyOnly;
                }
                // RUST-069-W: register the path ownership (the scoping basis for the root-purge fan-out).
                self.path_roots.insert(path.clone(), key.root);
                self.corpus_defs.insert(path.clone());
                self.def_files.insert(path.clone(), parsed);
                if let Some(name) = def_entity_name(&path) {
                    let candidates = self.def_by_name.entry((key.root, name)).or_default();
                    if !candidates.contains(&path) {
                        candidates.push(path);
                    }
                }
                ChangeCategory::Signature
            }
            FileKind::Entities => {
                let parsed = parse_entities(text);
                if self.entities_files.get(&path) == Some(&parsed) {
                    return ChangeCategory::BodyOnly;
                }
                self.path_roots.insert(path.clone(), key.root);
                if let Some(dir) = parent_dir(&path) {
                    self.entities_dirs.insert(dir.to_string());
                }
                self.entities_files.insert(path, parsed);
                ChangeCategory::Signature
            }
            FileKind::Types => {
                let parsed = parse_types(text);
                // Same def: raw-text residency sits before the early return, so BodyOnly refreshes too.
                self.texts.insert(path.clone(), text.to_string());
                if self.types_files.get(&path) == Some(&parsed) {
                    return ChangeCategory::BodyOnly;
                }
                self.path_roots.insert(path.clone(), key.root);
                self.types_files.insert(path, parsed);
                ChangeCategory::Signature
            }
            FileKind::Alias => {
                let parsed = parse_alias(text);
                if self.alias_files.get(&path) == Some(&parsed) {
                    return ChangeCategory::BodyOnly;
                }
                self.path_roots.insert(path.clone(), key.root);
                self.alias_files.insert(path, parsed);
                ChangeCategory::Signature
            }
            _ => {
                self.path_roots.insert(path, key.root);
                report.change
            }
        }
    }

    /// File removal (the VFS-012 downstream cleanup: symbols + corpus views along with it).
    pub fn remove(&mut self, key: &DocumentKey) -> usize {
        let removed = self.index.remove(key);
        let path = key.uri.as_path().to_string();
        self.path_roots.remove(&path);
        self.corpus_defs.remove(&path);
        self.def_files.remove(&path);
        self.entities_files.remove(&path);
        self.types_files.remove(&path);
        self.alias_files.remove(&path);
        self.texts.remove(&path);
        self.def_by_name.retain(|_, paths| {
            paths.retain(|p| p != &path);
            !paths.is_empty()
        });
        removed
    }

    /// Same-root same-name def candidates (filing order). KBUG-ROOT: the caller's DocumentKey.root scopes it,
    /// no borrowing across roots; returns an empty slice when there are no candidates.
    pub(crate) fn def_candidates(&self, root: RootId, name: &str) -> &[String] {
        self.def_by_name
            .get(&(root, name.to_string()))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// RUST-134: a py file-name stem -> the unique corpus def path within the root (entity ownership, shared
    /// by completion queries). First the entities.xml registered candidates (the registry truth); if empty, the in-root corpus
    /// stem scan falls back (the TS entitiesByName stance); zero/multiple hits return None, yielding to
    /// the caller's existing chain, never force-guessing.
    pub(crate) fn corpus_def_for_entity(&self, root: RootId, entity: &str) -> Option<String> {
        let registered = self.def_candidates(root, entity);
        match registered {
            [only] => return Some(only.clone()),
            [] => {}
            _ => return None,
        }
        let matches: Vec<&String> = self
            .corpus_defs
            .iter()
            .filter(|p| {
                self.path_roots.get(*p) == Some(&root)
                    && def_entity_name(p).as_deref() == Some(entity)
            })
            .collect();
        match matches.as_slice() {
            [only] => Some((*only).clone()),
            _ => None,
        }
    }

    /// RUST-134: a corpus def path -> the filed DefFile view (the shared completion-query read face;
    /// completion.rs and hover drink from the same river; no separate field openings for each).
    pub(crate) fn corpus_def(&self, path: &str) -> Option<&DefFile> {
        self.def_files.get(path)
    }

    /// RUST-138: the corpus raw-text read face (the references occurrence scan; def/types reside on filing).
    pub(crate) fn corpus_text(&self, path: &str) -> Option<&str> {
        self.texts.get(path).map(|text| text.as_str())
    }

    /// RUST-138: path -> owning root (the references same-root declaration scoping read face).
    pub(crate) fn path_root_of(&self, path: &str) -> Option<RootId> {
        self.path_roots.get(path).copied()
    }

    /// Root-level invalidation (the RUST-069-W root-purge fan-out): clear everything this root holds -- the symbol index + the path-keyed
    /// corpus views (scoped by path_roots ownership, sparing surviving roots) + the root-keyed def candidates +
    /// the entities-directory derived set (the directory has no root identity; recompute from the surviving entities.xml).
    /// Returns the number of cleared entries (receipt accounting: index clears + path-key entries + def candidate keys).
    pub fn invalidate_root(&mut self, root: RootId) -> usize {
        let mut cleared = self.index.invalidate_root(root);
        let owned: Vec<String> = self
            .path_roots
            .iter()
            .filter(|(_, owner)| **owner == root)
            .map(|(path, _)| path.clone())
            .collect();
        for path in &owned {
            self.path_roots.remove(path);
            self.corpus_defs.remove(path);
            self.def_files.remove(path);
            self.entities_files.remove(path);
            self.types_files.remove(path);
            self.alias_files.remove(path);
            self.texts.remove(path);
            cleared += 1;
        }
        let before = self.def_by_name.len();
        self.def_by_name
            .retain(|candidate_root, _| candidate_root.0 != root);
        cleared += before - self.def_by_name.len();
        self.entities_dirs = self
            .entities_files
            .keys()
            .filter_map(|path| parent_dir(path).map(|dir| dir.to_string()))
            .collect();
        cleared
    }

    /// The interactive entry: UTF-16 position -> word -> the response chain.
    pub fn hover(
        &self,
        key: &DocumentKey,
        text: &str,
        line: u32,
        character: u32,
    ) -> Option<HoverResponse> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let word = word_at(text, line, character)?;
        self.hover_word(key, text, &word, line as usize + 1)
    }

    /// The declaration-line entry (for golden generation): the declaration line number (1-based) + the symbol name -> the response chain.
    pub fn hover_at_line(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        word: &str,
    ) -> Option<HoverResponse> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        self.hover_word(key, text, word, line1)
    }

    /// The response-chain body: try the `<Parent>` inheritance face first, then produce the signature face per the declared symbol.
    fn hover_word(
        &self,
        key: &DocumentKey,
        text: &str,
        word: &str,
        line1: usize,
    ) -> Option<HoverResponse> {
        let path = key.uri.as_path();
        // Source face: the hit declaration line is the find result of `x.line == line1` on every face,
        // so line always takes line1 (RUST-136).
        let source = HoverSource {
            file: path.to_string(),
            line: line1,
        };
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                let def = parse_def(text);
                let entity = def_entity_name(path)?;
                // A `<Parent>` tag/value word -> the inheritance-chain face (the same trigger face as TS getDefChainHover:
                // a chain face is given even with no Parent, honestly presenting "no declaration").
                if word == "Parent" || Some(word) == def.parent.as_deref() {
                    return Some(HoverResponse {
                        face: HoverFace::DefEntity,
                        symbol: HoverSymbol {
                            name: entity.clone(),
                            kind: "entity".into(),
                            facet: None,
                            section: "Entity",
                        },
                        source,
                        signature: HoverSignature {
                            parent: def.parent.clone(),
                            comment: preceding_comment(text, line1),
                            facets: entity_facets(&def),
                            ..HoverSignature::default()
                        },
                        inherited: Some(self.chain_face(path, &def)),
                    });
                }
                let (records, _) = extract_records(key, &ParsedUnit::Def(parse_def(text)));
                let record = records.iter().find(|r| r.name == word && r.line == line1)?;
                match record.kind {
                    SymbolKind::Property => {
                        let prop = def
                            .properties
                            .iter()
                            .find(|p| p.name == word && p.line == line1)?;
                        // RUST-136 increment 2: expand fullType via the in-root declaration table (ARRAY goes through `<of>`).
                        let table = root_types_table(&self.types_files, &self.path_roots, key.root);
                        let full_type = full_type_of_property(
                            &table,
                            prop.type_name.as_deref(),
                            prop.of_ref.as_deref(),
                        );
                        Some(HoverResponse {
                            face: HoverFace::DefProperty,
                            symbol: hover_symbol(record, "Properties"),
                            source,
                            signature: HoverSignature {
                                r#type: prop.type_name.clone(),
                                full_type,
                                flags: prop.flags_raw.clone(),
                                default_value: prop.default_value.clone(),
                                detail_level: prop.detail_level.clone(),
                                database_length: prop.database_length.clone(),
                                identifier: prop.identifier.clone(),
                                persistent: prop.persistent,
                                comment: preceding_comment(text, prop.line),
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Method => {
                        let (methods, facet_str) = match record.facet {
                            Some(MethodFacet::Base) => (&def.base_methods, "base"),
                            Some(MethodFacet::Cell) => (&def.cell_methods, "cell"),
                            Some(MethodFacet::Client) | None => (&def.client_methods, "client"),
                        };
                        let method = methods.iter().find(|m| m.name == word && m.line == line1)?;
                        Some(HoverResponse {
                            face: HoverFace::DefMethod,
                            symbol: hover_symbol(record, facet_section(facet_str)),
                            source,
                            signature: HoverSignature {
                                arg_count: Some(method.args.len()),
                                args: Some(method.args.clone()),
                                exposed: Some(method.exposed),
                                comment: preceding_comment(text, method.line),
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Component => {
                        let comp = def
                            .components
                            .iter()
                            .find(|c| c.name == word && c.line == line1)?;
                        Some(HoverResponse {
                            face: HoverFace::DefComponent,
                            symbol: hover_symbol(record, "Components"),
                            source,
                            signature: HoverSignature {
                                component_type: comp.component_type.clone(),
                                persistent: comp.persistent,
                                comment: preceding_comment(text, comp.line),
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Entity => Some(HoverResponse {
                        face: HoverFace::DefEntity,
                        symbol: HoverSymbol {
                            name: entity.clone(),
                            kind: "entity".into(),
                            facet: None,
                            section: "Entity",
                        },
                        source,
                        signature: HoverSignature {
                            parent: def.parent.clone(),
                            comment: preceding_comment(text, line1),
                            facets: entity_facets(&def),
                            ..HoverSignature::default()
                        },
                        inherited: Some(self.chain_face(path, &def)),
                    }),
                    // Def files produce no type/alias symbols.
                    SymbolKind::Type | SymbolKind::Alias => None,
                }
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                let entry = entities
                    .entities
                    .iter()
                    .find(|e| e.name == word && e.line == line1)?;
                let candidates = self.def_candidates(key.root, word);
                let def_path = candidates.first();
                Some(HoverResponse {
                    face: HoverFace::EntitiesXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "entity".into(),
                        facet: None,
                        section: "Entities",
                    },
                    source,
                    signature: HoverSignature {
                        def_file: Some(def_path.cloned().unwrap_or_else(|| format!("{word}.def"))),
                        def_exists: Some(!candidates.is_empty()),
                        comment: preceding_comment(text, entry.line),
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Types => {
                let types = parse_types(text);
                let decl = types
                    .types
                    .iter()
                    .find(|t| t.name == word && t.line == line1)?;
                let type_kind = match decl.kind {
                    TypeKind::FixedDict => "fixedDict",
                    TypeKind::Array => "array",
                    TypeKind::Builtin => "builtin",
                };
                let directive = decl.directive.as_deref();
                let alias_target = match directive {
                    Some(d) if d != "ARRAY" && d != "FIXED_DICT" => Some(d.to_string()),
                    _ => None,
                };
                // RUST-136 increment 2: declaration-body expansion (a first-seen same-name table; the hovered item may be shadowed by an earlier
                // declaration -- both mirrors share the same table and criteria).
                let table = root_types_table(&self.types_files, &self.path_roots, key.root);
                let full_type = match expand_type_token(&table, word, 0) {
                    s if s == word => None,
                    s => Some(s),
                };
                Some(HoverResponse {
                    face: HoverFace::TypesXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "type".into(),
                        facet: None,
                        section: "Types",
                    },
                    source,
                    signature: HoverSignature {
                        type_kind: Some(type_kind.to_string()),
                        full_type,
                        alias_target,
                        comment: preceding_comment(text, decl.line),
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Alias => {
                let aliases = parse_alias(text);
                let alias = aliases
                    .aliases
                    .iter()
                    .find(|a| a.name == word && a.line == line1)?;
                Some(HoverResponse {
                    face: HoverFace::AliasXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "alias".into(),
                        facet: None,
                        section: "Aliases",
                    },
                    source,
                    signature: HoverSignature {
                        alias_type: Some(alias.alias_type.clone()),
                        comment: preceding_comment(text, alias.line),
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Other => None,
        }
    }

    /// The def-chain face: the same algorithm as TS buildDefChain (def views replace fs reads), including member expansion.
    /// The entry's semantic face takes **the hover file's own** parse result (`entry`), never a by-name global lookup --
    /// views of same-named entities across corpora never interfere (parent/interface/component existence is resolved per path within the corpus).
    /// Since PR-011 this is reused by completion's inherited-members face (within the crate).
    pub(crate) fn chain_face(&self, path: &str, entry: &DefFile) -> InheritedChain {
        let mut face = InheritedChain {
            parent_chain: Vec::new(),
            interfaces: Vec::new(),
            components: Vec::new(),
            cycle_truncated: false,
            members: Vec::new(),
        };
        let Some(defs_root) = self.defs_root(path) else {
            return face;
        };
        let mut seen_interfaces: BTreeSet<String> = BTreeSet::new();
        let mut seen_components: BTreeSet<String> = BTreeSet::new();
        let mut seen_files: BTreeSet<String> = BTreeSet::from([path.to_string()]);

        // Closure three-face collection: same-name dedup keeping first-seen and order (the same stance as TS collectFlatDecls).
        fn collect(
            face: &mut InheritedChain,
            defs_root: &str,
            corpus_defs: &BTreeSet<String>,
            seen_interfaces: &mut BTreeSet<String>,
            seen_components: &mut BTreeSet<String>,
            def: &DefFile,
        ) {
            for name in &def.interfaces {
                if seen_interfaces.insert(name.clone()) {
                    let def_path = format!("{defs_root}/interfaces/{name}.def");
                    face.interfaces.push(ChainNodeInfo {
                        name: name.clone(),
                        exists: corpus_defs.contains(&def_path),
                    });
                }
            }
            for comp in &def.components {
                let Some(name) = &comp.component_type else {
                    continue;
                };
                if seen_components.insert(name.clone()) {
                    let def_path = format!("{defs_root}/components/{name}.def");
                    face.components.push(ChainNodeInfo {
                        name: name.clone(),
                        exists: corpus_defs.contains(&def_path),
                    });
                }
            }
        }

        let mut current: Option<(String, &DefFile)> = Some((path.to_string(), entry));
        while let Some((cpath, cdef)) = current {
            let category = category_of(&defs_root, &cpath);
            collect(
                &mut face,
                &defs_root,
                &self.corpus_defs,
                &mut seen_interfaces,
                &mut seen_components,
                cdef,
            );
            // Interface defs do not follow Parent (the engine loadInterfaces stance).
            let parent = match category {
                Category::Interface => None,
                _ => cdef.parent.clone(),
            };
            let Some(parent) = parent.filter(|p| !p.is_empty()) else {
                break;
            };
            let parent_dir = match category {
                Category::Component => format!("{defs_root}/components"),
                _ => defs_root.clone(),
            };
            let parent_path = format!("{parent_dir}/{parent}.def");
            let exists = self.corpus_defs.contains(&parent_path);
            face.parent_chain.push(ChainNodeInfo {
                name: parent.clone(),
                exists,
            });
            if seen_files.contains(&parent_path) {
                face.cycle_truncated = true;
                break;
            }
            seen_files.insert(parent_path.clone());
            // Member expansion + advance: read that parent's def view **by path** (the same semantics as TS
            // reading files per path); treat unfiled as a missing file, never fabricating.
            match self.def_files.get(&parent_path) {
                Some(pdef) => {
                    face.members.push(MemberSummary {
                        entity: parent.clone(),
                        exists: true,
                        properties: pdef
                            .properties
                            .iter()
                            .map(|p| MemberProperty {
                                name: p.name.clone(),
                                r#type: p.type_name.clone(),
                            })
                            .collect(),
                        methods: facet_methods(pdef),
                    });
                    current = Some((parent_path.clone(), pdef));
                }
                _ => {
                    face.members.push(MemberSummary {
                        entity: parent.clone(),
                        exists,
                        properties: Vec::new(),
                        methods: Vec::new(),
                    });
                    break;
                }
            }
        }
        face
    }

    /// The entities.xml corpus view (read-only, for the Phase2 diagnostic/definition face).
    pub(crate) fn entities_files(&self) -> &BTreeMap<String, kode_parser::model::EntitiesFile> {
        &self.entities_files
    }

    /// The defsRoot probe (the same rules as TS findEntityDefsRootFromFile): walk upward for a directory containing
    /// entities.xml; when the file is inside `entity_defs/`, the root is that subdirectory.
    pub(crate) fn defs_root(&self, path: &str) -> Option<String> {
        let mut dir = parent_dir(path)?;
        loop {
            if self.entities_dirs.contains(dir) {
                let defs_root = format!("{dir}/entity_defs");
                if path.starts_with(&format!("{defs_root}/")) {
                    return Some(defs_root);
                }
                return Some(dir.to_string());
            }
            dir = parent_dir(dir)?;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Category {
    Entity,
    Interface,
    Component,
}

/// A file's category under defsRoot (the same rules as TS categoryOf: the relative path containing interfaces/
/// components decides).
pub(crate) fn category_of(defs_root: &str, path: &str) -> Category {
    if !path.starts_with(&format!("{defs_root}/")) {
        return Category::Entity;
    }
    let rel = &path[defs_root.len() + 1..];
    if rel.split('/').any(|s| s == "interfaces") {
        Category::Interface
    } else if rel.split('/').any(|s| s == "components") {
        Category::Component
    } else {
        Category::Entity
    }
}

fn facet_methods(def: &DefFile) -> Vec<MemberMethod> {
    let sections = [
        (MethodFacet::Base, &def.base_methods),
        (MethodFacet::Cell, &def.cell_methods),
        (MethodFacet::Client, &def.client_methods),
    ];
    let mut out = Vec::new();
    for (facet, methods) in sections {
        for m in methods {
            out.push(MemberMethod {
                name: m.name.clone(),
                facet: facet.as_str(),
            });
        }
    }
    out
}

fn facet_section(facet: &str) -> &'static str {
    match facet {
        "base" => "BaseMethods",
        "cell" => "CellMethods",
        _ => "ClientMethods",
    }
}

fn hover_symbol(record: &kode_index::symbol::SymbolRecord, section: &'static str) -> HoverSymbol {
    HoverSymbol {
        name: record.name.clone(),
        kind: record.kind.as_str().to_string(),
        facet: record.facet.map(|f| f.as_str().to_string()),
        section,
    }
}

/// The parent directory (paths use `/`; returns None when there is no parent).
pub(crate) fn parent_dir(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(dir, _)| dir)
}

// ---------------------------------------------------------------------------
// Word extraction (the HOVER locating layer; UTF-16 character <-> char boundaries)
// ---------------------------------------------------------------------------

/// The byte range of the given line (0-based), excluding the line terminator; returns None when the line is missing.
fn line_bounds(text: &str, line0: u32) -> Option<(usize, usize)> {
    let mut line: u32 = 0;
    let mut start = 0usize;
    for (idx, ch) in text.char_indices() {
        if line == line0 {
            let end = text[idx..]
                .find('\n')
                .map(|n| idx + n)
                .unwrap_or(text.len());
            return Some((start, end));
        }
        if ch == '\n' {
            line += 1;
            start = idx + 1;
        }
    }
    if line == line0 {
        return Some((start, text.len()));
    }
    None
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// LSP word extraction: character counts in UTF-16; a hit works with the cursor inside the word or right at its end
/// (a subset of VS Code semantics: astral characters such as emoji correctly straddle boundaries as two UTF-16 units).
pub fn word_at(text: &str, line0: u32, character: u32) -> Option<String> {
    let (s, e) = line_bounds(text, line0)?;
    let line = text[s..e].trim_end_matches('\r');
    // The sequence of (utf16 start, char) pairs.
    let mut chars: Vec<(u32, char)> = Vec::new();
    let mut acc = 0u32;
    for ch in line.chars() {
        chars.push((acc, ch));
        acc += ch.len_utf16() as u32;
    }
    if chars.is_empty() {
        return None;
    }
    // The char the cursor covers (character falls within some char's utf16 range); at line end take the last char.
    let idx = chars
        .iter()
        .position(|(start, ch)| character < start + ch.len_utf16() as u32)
        .unwrap_or(chars.len() - 1);
    // A hit inside the word; otherwise right at the word's end (the cursor at the previous char's end) also hits.
    let mut anchor = idx;
    if !is_word_char(chars[idx].1) {
        if idx > 0 && character == chars[idx].0 && is_word_char(chars[idx - 1].1) {
            anchor = idx - 1;
        } else {
            return None;
        }
    }
    let mut lo = anchor;
    while lo > 0 && is_word_char(chars[lo - 1].1) {
        lo -= 1;
    }
    let mut hi = anchor;
    while hi + 1 < chars.len() && is_word_char(chars[hi + 1].1) {
        hi += 1;
    }
    let word: String = chars[lo..=hi].iter().map(|(_, ch)| ch).collect();
    Some(word)
}

// ---------------------------------------------------------------------------
// Comparison golden (write-only, never read back; recomputed by the TS side's tests/kodeHoverParity.test.ts)
// ---------------------------------------------------------------------------

/// The golden file name (relative to the repo root).
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/hover-parity.json";

#[derive(Debug, Serialize)]
struct GoldenHover {
    line: usize,
    word: String,
    hover: HoverResponse,
}

#[derive(Debug, Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    hovers: Vec<GoldenHover>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    hover_count: usize,
    files: Vec<GoldenFile>,
}

/// Corpus file -> ParsedUnit (the kind string comes from collect_corpus).
fn parse_by_kind(kind: &str, text: &str) -> Option<ParsedUnit> {
    match kind {
        "def" => Some(ParsedUnit::Def(parse_def(text))),
        "entities" => Some(ParsedUnit::Entities(parse_entities(text))),
        "types" => Some(ParsedUnit::Types(parse_types(text))),
        "alias" => Some(ParsedUnit::Alias(parse_alias(text))),
        _ => None,
    }
}

/// The hover golden JSON for the whole corpus (one response chain per declared symbol per file).
pub fn dump_hover_golden(repo_root: &std::path::Path) -> String {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    // File everything first (lexicographic order = the TS corpus order; keys = each corpus project root, KBUG-ROOT isolation).
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-hover-golden",
        file_count: files.len(),
        hover_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let Some(unit) = parse_by_kind(kind, text) else {
            continue;
        };
        let key = crate::golden_corpus::corpus_key(&registry, path);
        let (records, _) = extract_records(&key, &unit);
        let mut hovers = Vec::new();
        for record in &records {
            if let Some(hover) = engine.hover_at_line(&key, text, record.line, &record.name) {
                hovers.push(GoldenHover {
                    line: record.line,
                    word: record.name.clone(),
                    hover,
                });
            }
        }
        dump.hover_count += hovers.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            hovers,
        });
    }
    serde_json::to_string(&dump).expect("serialize hover golden")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(
            kode_vfs::store::RootId(1),
            kode_vfs::uri::CanonicalUri::from_path(path),
        )
    }

    #[test]
    fn update_round_trips_per_file_kind() {
        let mut e = HoverEngine::new();
        // Def: first filing is Signature; same text is Identical; comment additions/removals (model-equal, text-different) are BodyOnly.
        let def_path = "/p/scripts/entity_defs/Avatar.def";
        let def_text = "<root>\n\t<Properties>\n\t</Properties>\n</root>\n";
        assert!(matches!(
            e.update(key(def_path), def_text),
            ChangeCategory::Signature
        ));
        assert!(matches!(
            e.update(key(def_path), def_text),
            ChangeCategory::Identical
        ));
        let def_commented = def_text.replace("</root>", "<!-- note --></root>");
        assert!(matches!(
            e.update(key(def_path), &def_commented),
            ChangeCategory::BodyOnly
        ));
        // Entities / Types / Alias: isomorphic round trips (first Signature, then model-equal refiling as BodyOnly).
        for (path, text) in [
            ("/p/scripts/entities.xml", "<root>\n\t<Avatar/>\n</root>\n"),
            ("/p/scripts/entity_defs/types.xml", "<root>\n</root>\n"),
            ("/p/scripts/entity_defs/alias.xml", "<root>\n</root>\n"),
        ] {
            assert!(
                matches!(e.update(key(path), text), ChangeCategory::Signature),
                "{path} 首入必须 Signature"
            );
            let commented = text.replace("</root>", "<!-- c --></root>");
            assert!(
                matches!(e.update(key(path), &commented), ChangeCategory::BodyOnly),
                "{path} 模型等价再入必须 BodyOnly"
            );
        }
        // Outside the four corpus classes (.py): the index layer's negative cache blocks outright (not a KBEngine declaration file) ->
        // update always early-returns as Identical, writing nothing to the corpus model.
        assert!(matches!(
            e.update(
                key("/p/scripts/base/Avatar.py"),
                "class Avatar(object):\n    pass\n"
            ),
            ChangeCategory::Identical
        ));
    }

    fn resp(kind: &str, sig: HoverSignature, inherited: Option<InheritedChain>) -> HoverResponse {
        HoverResponse {
            face: HoverFace::DefMethod,
            symbol: HoverSymbol {
                name: "attack".into(),
                kind: kind.into(),
                facet: None,
                section: "BaseMethods",
            },
            source: HoverSource {
                file: "Avatar.def".into(),
                line: 3,
            },
            signature: sig,
            inherited,
        }
    }

    #[test]
    fn render_method_args_and_exposed_face() {
        let md = render_markdown(&resp(
            "method",
            HoverSignature {
                arg_count: Some(2),
                args: Some(vec!["self".into(), "x".into()]),
                exposed: Some(true),
                ..HoverSignature::default()
            },
            None,
        ));
        assert!(md.contains("**Args**: `self, x`"), "{md}");
        assert!(md.contains("**Exposed**: `true`"), "{md}");
    }

    #[test]
    fn render_inherited_chain_cycle_note() {
        let chain = InheritedChain {
            parent_chain: vec![ChainNodeInfo {
                name: "Monster".into(),
                exists: true,
            }],
            interfaces: vec![],
            components: vec![],
            cycle_truncated: true,
            members: vec![],
        };
        let md = render_markdown(&resp("entity", HoverSignature::default(), Some(chain)));
        assert!(md.contains("**Parent 链**"), "{md}");
        assert!(md.contains(";检测到环,已截断"), "{md}");
        // An acyclic chain: the same rendering but no cycle annotation.
        let plain = InheritedChain {
            parent_chain: vec![ChainNodeInfo {
                name: "Monster".into(),
                exists: true,
            }],
            interfaces: vec![],
            components: vec![],
            cycle_truncated: false,
            members: vec![],
        };
        let md2 = render_markdown(&resp("entity", HoverSignature::default(), Some(plain)));
        assert!(md2.contains("**Parent 链**"), "{md2}");
        assert!(!md2.contains("检测到环"), "{md2}");
    }

    #[test]
    fn preceding_comment_block_boundary_faces() {
        // A blank line within the multi-line state: the block truncates here, collecting only the `-->` line's content.
        let mid = preceding_comment("<!-- top\n\nmid -->\nDECL\n", 4);
        assert_eq!(mid.as_deref(), Some("mid"));
        // An unclosed `<!--` hanging above content (not in the multi-line state): does not count as a comment block.
        assert_eq!(preceding_comment("<!-- dangling\nDECL\n", 2), None);
        // The comment chain reaches the file's first line (collection completes at idx==0).
        assert!(preceding_comment("one -->\ntwo -->\nDECL\n", 3).is_some());
    }

    #[test]
    fn corpus_def_multi_candidate_is_none() {
        // Two same-root same-stem defs: multiple candidates are not force-guessed -> None.
        let mut e = HoverEngine::new();
        let t = "<root>\n</root>\n";
        e.update(key("/p/scripts/entity_defs/Avatar.def"), t);
        e.update(key("/p/scripts/other/Avatar.def"), t);
        assert_eq!(e.corpus_def_for_entity(RootId(1), "Avatar"), None);
    }

    #[test]
    fn misc_helpers_direct_faces() {
        // A defsRoot prefix miss -> the Entity fallback; a hit goes through the interfaces judgement.
        assert_eq!(
            category_of("/defs", "/elsewhere/Avatar.def"),
            Category::Entity
        );
        assert_eq!(
            category_of("/defs", "/defs/interfaces/ROLE.def"),
            Category::Interface
        );
        // The last line has no newline: the range extends to the text end (the line==line0 fallback arm).
        assert_eq!(line_bounds("ab\ncd", 1), Some((3, 5)));
        // The text ends with a newline: the trailing empty line takes the post-loop fallback arm (an empty range).
        assert_eq!(line_bounds("ab\n", 1), Some((3, 3)));
        // parse_by_kind: the types/alias two arms + None for an unknown kind.
        assert!(matches!(
            parse_by_kind("types", "<root/>"),
            Some(ParsedUnit::Types(_))
        ));
        assert!(matches!(
            parse_by_kind("alias", "<root/>"),
            Some(ParsedUnit::Alias(_))
        ));
        assert!(parse_by_kind("py", "x = 1\n").is_none());
    }

    #[test]
    fn full_type_display_faces() {
        // Corpus: a self-referencing FD (depth guard + cycle protection) + an ARRAY wrapper + builtin entries.
        let types_text = "<root>\n <SPACE_VECTOR>\n  FIXED_DICT\n  <Properties>\n   <x>\n    <Type> FLOAT </Type>\n   </x>\n   <slots>\n    <Type>\n     ARRAY\n     <of> UINT32 </of>\n    </Type>\n   </slots>\n   <deep>\n    <Type> SPACE_VECTOR </Type>\n   </deep>\n  </Properties>\n </SPACE_VECTOR>\n <TELEPORT_POINTS>\n  ARRAY\n  <of> SPACE_VECTOR </of>\n </TELEPORT_POINTS>\n <PLAIN>\n  UINT32\n </PLAIN>\n</root>\n";
        // The def property's four faces: FD token / the ARRAY<of> double layer / builtin (=null) / ARRAY without of (=null).
        let def_text = "<root>\n <Properties>\n  <pos>\n   <Type> SPACE_VECTOR </Type>\n  </pos>\n  <path>\n   <Type> ARRAY <of> TELEPORT_POINTS </of> </Type>\n  </path>\n  <count>\n   <Type> UINT32 </Type>\n  </count>\n  <broken>\n   <Type> ARRAY </Type>\n  </broken>\n </Properties>\n</root>\n";
        let mut e = HoverEngine::new();
        assert!(matches!(
            e.update(key("/p/scripts/entity_defs/types.xml"), types_text),
            ChangeCategory::Signature
        ));
        assert!(matches!(
            e.update(key("/p/scripts/entity_defs/Avatar.def"), def_text),
            ChangeCategory::Signature
        ));
        // Depth guard: levels 0/1/2 expand; from level 3 the raw token is used (a self-reference never loops).
        let inner2 = "FIXED_DICT { x: FLOAT, slots: ARRAY<UINT32>, deep: SPACE_VECTOR }";
        let inner1 = format!(
            "FIXED_DICT {{ x: FLOAT, slots: ARRAY<UINT32>, deep: {} }}",
            inner2
        );
        let outer = format!(
            "FIXED_DICT {{ x: FLOAT, slots: ARRAY<UINT32>, deep: {} }}",
            inner1
        );
        let def_key = key("/p/scripts/entity_defs/Avatar.def");
        let pos = e
            .hover_at_line(&def_key, def_text, 3, "pos")
            .expect("pos 悬停");
        assert_eq!(pos.signature.full_type.as_deref(), Some(outer.as_str()));
        let path = e
            .hover_at_line(&def_key, def_text, 6, "path")
            .expect("path 悬停");
        // A property's ARRAY<of> counts from depth 1: the inner FD expands at depth 2, and references inside it present the raw
        // token per the guard (one level more than pos's depth-0 baseline; both mirrors share the same criteria).
        assert_eq!(
            path.signature.full_type.as_deref(),
            Some(format!("ARRAY<ARRAY<{inner2}>>").as_str())
        );
        let count = e
            .hover_at_line(&def_key, def_text, 9, "count")
            .expect("count 悬停");
        assert_eq!(count.signature.full_type, None, "内建 token 展开=原文→null");
        let broken = e
            .hover_at_line(&def_key, def_text, 12, "broken")
            .expect("broken 悬停");
        assert_eq!(broken.signature.full_type, None, "ARRAY 无 of→null");
        // Markdown rendering: the **Full Type** line immediately follows **Type**.
        let md = render_markdown(&pos);
        let type_at = md.find("**Type**: `SPACE_VECTOR`").expect("Type 行");
        let full_at = md.find("**Full Type**:").expect("Full Type 行");
        assert!(full_at > type_at, "{md}");
        assert!(md.contains(&format!("**Full Type**: `{outer}`")), "{md}");
        // The types.xml declaration face: FD/ARRAY expand, builtin=null.
        let types_key = key("/p/scripts/entity_defs/types.xml");
        let sv = e
            .hover_at_line(&types_key, types_text, 2, "SPACE_VECTOR")
            .expect("SPACE_VECTOR 悬停");
        assert_eq!(sv.signature.full_type.as_deref(), Some(outer.as_str()));
        let tp = e
            .hover_at_line(&types_key, types_text, 19, "TELEPORT_POINTS")
            .expect("TELEPORT_POINTS 悬停");
        // The declaration face counts from depth 0, and the ARRAY element consumes one: the inner FD expands at depth 1.
        assert_eq!(
            tp.signature.full_type.as_deref(),
            Some(format!("ARRAY<{inner1}>").as_str())
        );
        let plain = e
            .hover_at_line(&types_key, types_text, 23, "PLAIN")
            .expect("PLAIN 悬停");
        assert_eq!(plain.signature.full_type, None, "builtin 声明→null");
        // Markdown: the declaration face's TypeKind is followed by the Full Type line.
        let tp_md = render_markdown(&tp);
        assert!(tp_md.contains("**TypeKind**: `array`"), "{tp_md}");
        assert!(
            tp_md.contains(&format!("**Full Type**: `ARRAY<{inner1}>`")),
            "{tp_md}"
        );
    }
}
