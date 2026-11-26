//! CodeAction provider wiring decision core (RUST-143 batch 2; the pure-library
//! half of the four-provider wiring flow in TS
//! `src/languageProviders/codeAction.ts`).
//!
//! Batch 1 (code_action.rs) delivered the seven pure faces (annotation mapping /
//! skeleton / insertion point / near-spelling suggestions / receiver-range
//! attribution / the two guard edits / FD whole reassign); this batch wires the
//! provider decision flow on top: diagnostic code gate -> range intersection ->
//! location-face extraction -> dedup -> edit construction -> title / kind /
//! diagnostic reconciliation, producing [`ActionFace`] (a pure descriptor; no
//! vscode objects are produced). The four families reconciled:
//! - fix parameter type = KBEngineTypeCodeActionProvider (unknown-type
//!   near-spelling replacement)
//! - create missing definition = KBEngineDefPythonParityCodeActionProvider
//!   (missing-implementation method skeleton; the EntityMappingManager async
//!   service face of MethodImplementationProvider belongs to the wiring batch,
//!   its pure half was already folded in batch 1)
//! - conflict resolution = KBEngineReceiverNoneGuardCodeActionProvider (the two
//!   guard actions, wrap style preferred) + KBEngineFixedDictWholeReassignCodeActionProvider
//!   (whole reassign)
//!
//! Honest boundaries (registered, never impersonated):
//! - The Type provider's `getKnownTypeContext` (builtins+types.xml+entity
//!   assembly) is a completion-module service face; this face consumes the
//!   `registered` list as input; provider-class-level behavior is covered by
//!   the electron suite (lintQuickFixBoundaries).
//! - The parity wiring consumes snapshot text input (`readSharedFileSnapshot`
//!   prefers the open document + disk reload belongs to the wiring batch);
//!   `collect_method_arg_types` goes through the kode_parser model (client ->
//!   cell -> base reverse order = the equivalent order of TS DFS-LIFO under the
//!   standard layout; when def sections land in a non-standard document order TS
//!   does DFS in document order and the model has no span to preserve order —
//!   registered as a boundary).
//! - Titles are en source strings ({name} placeholder interpolation = TS
//!   l10n.t's default behavior without a bundle); the zh bundle belongs to the
//!   l10n face and does not enter parity.
//! - The diagnostic face is pure data (code / range / related); vscode.Diagnostic
//!   object construction and the event stream belong to the wiring batch; the
//!   cancel bit (provider first line isCancellationRequested -> empty) is a
//!   host face, and its N/A status for a pure function is registered honestly.

use serde::Serialize;

use crate::code_action::{
    build_fixed_dict_whole_reassign_edit, build_receiver_none_guard_edit,
    build_receiver_none_wrap_edit, find_python_class_insertion_point,
    find_registered_type_suggestions, receiver_from_diagnostic_line, MethodStubBody,
};

// ---------------------------------------------------------------------------
// Diagnostic code constants (same values as the TS production face; KODE-AUD-002 reconciliation)
// ---------------------------------------------------------------------------

/// src/languageProviders/validation.ts UNKNOWN_TYPE_DIAGNOSTIC_CODE。
pub const UNKNOWN_TYPE_DIAGNOSTIC_CODE: &str = "kbengine.unknownType";
/// defMethodConsistency.DEF_METHOD_MISSING_DIAGNOSTIC_CODE = the Rust lint rule id.
pub const DEF_PYTHON_PARITY_DIAGNOSTIC_CODE: &str = "def-method-missing-in-python";
/// src/backend/receiverNoneDiagnostics.ts RECEIVER_NONE_DIAGNOSTIC_CODE。
pub const RECEIVER_NONE_DIAGNOSTIC_CODE: &str = "kbengine.receiverNone";
/// src/backend/behaviorKnowledge.ts FIXED_DICT_NESTED_MUTATION_CODE。
pub const FIXED_DICT_NESTED_MUTATION_CODE: &str = "kbengine.fixedDictNestedMutation";

// ---------------------------------------------------------------------------
// Input face (pure-data diagnostics; line 0-based, char 0-based = the same domain as vscode Position)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateRange {
    pub start_line: usize,
    pub start_char: usize,
    pub end_line: usize,
    pub end_char: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticGateFace {
    pub code: String,
    pub range: GateRange,
    /// relatedInformation[0].location.uri.fsPath (the parity family's location face; None = absent).
    pub related_file: Option<String>,
    /// relatedInformation[0].message (target class name; an empty string -> falls back to entityNameOfDefFile).
    pub related_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRangeFace {
    pub start_line: usize,
    pub start_char: usize,
    pub end_line: usize,
    pub end_char: usize,
}

impl RequestRangeFace {
    fn as_gate(&self) -> GateRange {
        GateRange {
            start_line: self.start_line,
            start_char: self.start_char,
            end_line: self.end_line,
            end_char: self.end_char,
        }
    }
}

/// Whether the diagnostic range intersects the request range (isomorphic to TS
/// diagnosticRangeIntersects: line/char compared directly as
/// line*1_000_000+char; closed-interval endpoints touching counts as an
/// intersection).
pub fn range_intersects(left: &GateRange, right: &GateRange) -> bool {
    let value = |line: usize, char: usize| line * 1_000_000 + char;
    value(left.start_line, left.start_char) <= value(right.end_line, right.end_char)
        && value(right.start_line, right.start_char) <= value(left.end_line, left.end_char)
}

/// Range text extraction (isomorphic to document.getText(range): line/char ->
/// offset slice; out-of-bounds clamped to line end / text end). None = the
/// start line is out of bounds.
pub fn text_in_range(text: &str, range: &GateRange) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    if range.start_line >= lines.len() {
        return None;
    }
    let line_start_offset =
        |target: usize| -> usize { lines.iter().take(target).map(|line| line.len() + 1).sum() };
    let start =
        line_start_offset(range.start_line) + range.start_char.min(lines[range.start_line].len());
    let end = if range.end_line >= lines.len() {
        text.len()
    } else {
        line_start_offset(range.end_line) + range.end_char.min(lines[range.end_line].len())
    };
    let end = end.max(start).min(text.len());
    Some(text[start..end].to_string())
}

/// Entity name = the def file name without `.def` (isomorphic to TS
/// entityNameOfDefFile: takes the last segment over both / and \ separators;
/// strips exactly the ".def" suffix).
pub fn entity_name_of_def_file(def_file: &str) -> String {
    let last = def_file.rsplit(['/', '\\']).next().unwrap_or(def_file);
    last.strip_suffix(".def").unwrap_or(last).to_string()
}

// ---------------------------------------------------------------------------
// parity skeleton face (isomorphic to defPythonParity; this is a **different
// design decision** from the batch 1 defMethodConsistency skeleton: this one
// falls back to Any for unrecognized types and emits all table values (lossy
// but a legitimate analysis criterion); the batch 1 one emits bare argN for
// unrecognized types and only table values that need no import)
// ---------------------------------------------------------------------------

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS (the same table as the pythonTypeStubs single source of truth).
pub fn map_def_type_to_python_annotation(type_name: &str) -> &'static str {
    match type_name.trim() {
        "UINT8" | "UINT16" | "UINT32" | "UINT64" | "INT8" | "INT16" | "INT32" | "INT64" => "int",
        "FLOAT" | "DOUBLE" => "float",
        "STRING" | "UNICODE" => "str",
        "BOOL" => "bool",
        "VECTOR2" => "Vector2",
        "VECTOR3" => "Vector3",
        "VECTOR4" => "Vector4",
        "ENTITYCALL" | "PYTHON" => "Any",
        "PY_DICT" => "dict",
        "PY_TUPLE" => "tuple",
        "PY_LIST" => "list",
        "BLOB" => "bytes",
        _ => "Any",
    }
}

/// parity method skeleton: 4-space-indented `def <name>(self, argN: <annotation>...)
/// -> None:` + body; unrecognized types fall back to Any
/// (map_def_type_to_python_annotation) and the body defaults to
/// raise NotImplementedError. Isomorphic to TS buildPythonMethodSkeletonWithTypes.
pub fn build_method_skeleton_with_types(
    method_name: &str,
    arg_types: &[&str],
    body: MethodStubBody,
) -> String {
    let args: Vec<String> = arg_types
        .iter()
        .enumerate()
        .map(|(index, type_name)| {
            format!(
                "arg{}: {}",
                index,
                map_def_type_to_python_annotation(type_name)
            )
        })
        .collect();
    let signature = if args.is_empty() {
        "self".to_string()
    } else {
        format!("self, {}", args.join(", "))
    };
    let body_line = match body {
        MethodStubBody::Raise => "        raise NotImplementedError",
        MethodStubBody::Pass => "        pass",
    };
    // The return annotation is always `-> None` (same text as TS; the method-skeleton semantics = no return value).
    format!(
        "    def {}({}) -> None:\n{}\n",
        method_name, signature, body_line
    )
}

/// Collecting the `<Arg>` type sequence of a method in a def document
/// (isomorphic to TS collectMethodArgTypes + findMethodElementByName): within
/// the method sections, find the first same-named method in the client -> cell
/// -> base reverse order (= the equivalent order of TS DFS-LIFO under the
/// standard layout) and take its `<Arg>` text order; a same-named name in the
/// property section / unresolvable -> empty (a self-only signature).
pub fn collect_method_arg_types(def_text: &str, method_name: &str) -> Vec<String> {
    let parsed = kode_parser::model::parse_def(def_text);
    for methods in [
        &parsed.client_methods,
        &parsed.cell_methods,
        &parsed.base_methods,
    ] {
        for method in methods {
            if method.name == method_name {
                return method.args.clone();
            }
        }
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Wiring output face (pure descriptors; TS CodeAction/WorkspaceEdit construction belongs to the wiring batch's thin shell)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditFace {
    /// TextEdit(diagnostic.range, candidate) — the near-spelling type replacement.
    ReplaceRange {
        file: String,
        range: GateRange,
        new_text: String,
    },
    /// edit.insert(Position(line, 0), text) — insertion at line start (the text already carries the blank-line prefix).
    InsertLine {
        file: String,
        line: usize,
        text: String,
    },
    /// edit.replace(Range(startLine, 0, endLine, 0), text) — whole-line-span
    /// replacement (the trailing newline is baked in per each family's rule:
    /// the wrap family = the span ends at text end and the whole text ends with
    /// \n; the FD family = only the span ending at text end).
    ReplaceLines {
        file: String,
        start_line: usize,
        end_line: usize,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionFace {
    /// "QuickFix" | "Refactor" (the vscode.CodeActionKind value domain).
    pub kind: &'static str,
    /// Title after l10n source-string interpolation (the en face).
    pub title: String,
    pub edit: EditFace,
    /// The action.diagnostics reconciliation = the hit diagnostic's start line (single diagnostic).
    pub diagnostic_start_line: usize,
    /// Title interpolation params (ordered per family; the TS l10n thin shell
    /// picks a template per family and interpolates positionally; the zh bundle
    /// does not go through the en interpolation string):
    /// typeReplacement=[candidate name]; parityMethod=[method name, target file,
    /// 1-based display line]; receiverNone=[receiver]; fixedDict=[].
    pub title_params: Vec<String>,
}

/// Near-spelling type replacement wiring (the KBEngineTypeCodeActionProvider
/// decision flow): code gate -> range intersection -> range text trim non-empty
/// -> one replacement action per registered near-spelling candidate (the
/// candidate face is sorted and truncated by find_registered_type_suggestions,
/// isomorphic to batch 1).
pub fn assemble_type_replacement_actions(
    doc_text: &str,
    doc_file: &str,
    registered: &[&str],
    diagnostics: &[DiagnosticGateFace],
    request: &RequestRangeFace,
) -> Vec<ActionFace> {
    let mut actions = Vec::new();
    for diagnostic in diagnostics {
        if diagnostic.code != UNKNOWN_TYPE_DIAGNOSTIC_CODE {
            continue;
        }
        if !range_intersects(&diagnostic.range, &request.as_gate()) {
            continue;
        }
        let unknown_name = text_in_range(doc_text, &diagnostic.range)
            .unwrap_or_default()
            .trim()
            .to_string();
        if unknown_name.is_empty() {
            continue;
        }
        for candidate in find_registered_type_suggestions(&unknown_name, registered) {
            actions.push(ActionFace {
                kind: "QuickFix",
                title: format!("Replace with registered type {candidate}"),
                edit: EditFace::ReplaceRange {
                    file: doc_file.to_string(),
                    range: diagnostic.range.clone(),
                    new_text: candidate.clone(),
                },
                diagnostic_start_line: diagnostic.range.start_line,
                title_params: vec![candidate],
            });
        }
    }
    actions
}

/// Missing-implementation method skeleton wiring (the
/// KBEngineDefPythonParityCodeActionProvider decision flow): code gate ->
/// intersection -> related location face (absent = nothing emitted) -> target
/// class name (a non-empty related.message wins, otherwise the def file name is
/// the fallback) -> method name (range text trimmed non-empty) ->
/// dedupe(file:method) -> def `<Arg>` collection -> snapshot insertion point ->
/// skeleton (raise body) -> line-start insertion (an empty body gets no
/// blank-line prefix, a non-empty body does).
pub fn assemble_parity_method_actions(
    def_text: &str,
    def_file: &str,
    snapshot: Option<&str>,
    diagnostics: &[DiagnosticGateFace],
    request: &RequestRangeFace,
) -> Vec<ActionFace> {
    let mut actions = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for diagnostic in diagnostics {
        if diagnostic.code != DEF_PYTHON_PARITY_DIAGNOSTIC_CODE {
            continue;
        }
        if !range_intersects(&diagnostic.range, &request.as_gate()) {
            continue;
        }
        let Some(related_file) = diagnostic.related_file.clone() else {
            continue;
        };
        let class_name = match diagnostic.related_message.as_deref() {
            Some(message) if !message.is_empty() => message.to_string(),
            _ => entity_name_of_def_file(def_file),
        };
        let Some(method_name) =
            text_in_range(def_text, &diagnostic.range).map(|t| t.trim().to_string())
        else {
            continue;
        };
        if method_name.is_empty() {
            continue;
        }
        let dedupe_key = format!("{related_file}:{method_name}");
        if seen.contains(&dedupe_key) {
            continue;
        }
        seen.insert(dedupe_key);

        let arg_types = collect_method_arg_types(def_text, &method_name);
        let Some(snapshot_text) = snapshot else {
            continue;
        };
        let Some((line, blank_prefix)) =
            find_python_class_insertion_point(snapshot_text, &class_name)
        else {
            continue;
        };
        let arg_refs: Vec<&str> = arg_types.iter().map(|s| s.as_str()).collect();
        let skeleton =
            build_method_skeleton_with_types(&method_name, &arg_refs, MethodStubBody::Raise);
        actions.push(ActionFace {
            kind: "QuickFix",
            title: format!(
                "Generate method {method_name} \u{2192} {related_file}:{}",
                line + 1
            ),
            edit: EditFace::InsertLine {
                file: related_file.clone(),
                line,
                text: if blank_prefix {
                    format!("\n{skeleton}")
                } else {
                    skeleton
                },
            },
            diagnostic_start_line: diagnostic.range.start_line,
            title_params: vec![method_name, related_file, (line + 1).to_string()],
        });
    }
    actions
}

/// receiver-none guard wiring (the KBEngineReceiverNoneGuardCodeActionProvider
/// decision flow): code gate -> intersection -> take the receiver by the
/// diagnostic line's range attribution (unextractable = nothing emitted) ->
/// dedupe(receiver:line) -> the two guard edits (both None = not deduped, both
/// emitted, TS same order) -> wrap style first + early-return second; the wrap
/// family's trailing-newline rule = the span ends at text end and the whole
/// text ends with \n (isomorphic to TS).
pub fn assemble_receiver_none_actions(
    doc_text: &str,
    doc_file: &str,
    diagnostics: &[DiagnosticGateFace],
    request: &RequestRangeFace,
) -> Vec<ActionFace> {
    let mut actions = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let lines: Vec<&str> = doc_text.split('\n').collect();
    for diagnostic in diagnostics {
        if diagnostic.code != RECEIVER_NONE_DIAGNOSTIC_CODE {
            continue;
        }
        if !range_intersects(&diagnostic.range, &request.as_gate()) {
            continue;
        }
        let line = diagnostic.range.start_line;
        let Some(line_text) = lines.get(line) else {
            continue;
        };
        let Some(receiver) = receiver_from_diagnostic_line(
            line_text,
            diagnostic.range.start_char,
            diagnostic.range.end_char,
        ) else {
            continue;
        };
        let dedupe_key = format!("{receiver}:{line}");
        if seen.contains(&dedupe_key) {
            continue;
        }
        let wrap = build_receiver_none_wrap_edit(doc_text, line, receiver);
        let guard = build_receiver_none_guard_edit(doc_text, line, receiver);
        if wrap.is_none() && guard.is_none() {
            continue;
        }
        seen.insert(dedupe_key);
        if let Some(edit) = wrap {
            // wrap style (user order 2026-10-30): continue when judged non-None, preferred first.
            let trailing_newline = edit.end_line < lines.len()
                || (edit.end_line == lines.len() && doc_text.ends_with('\n'));
            actions.push(ActionFace {
                kind: "QuickFix",
                title: format!("Wrap with null guard (if self.{receiver}:)"),
                edit: EditFace::ReplaceLines {
                    file: doc_file.to_string(),
                    start_line: edit.start_line,
                    end_line: edit.end_line,
                    text: if trailing_newline {
                        format!("{}\n", edit.text)
                    } else {
                        edit.text
                    },
                },
                diagnostic_start_line: line,
                title_params: vec![receiver.to_string()],
            });
        }
        if let Some(edit) = guard {
            actions.push(ActionFace {
                kind: "QuickFix",
                title: format!("Insert None guard (if not self.{receiver}: return)"),
                edit: EditFace::InsertLine {
                    file: doc_file.to_string(),
                    line: edit.line,
                    text: edit.text,
                },
                diagnostic_start_line: line,
                title_params: vec![receiver.to_string()],
            });
        }
    }
    actions
}

/// FIXED_DICT whole-reassign wiring (the
/// KBEngineFixedDictWholeReassignCodeActionProvider decision flow): code gate
/// -> intersection -> line dedupe (check before adding; a failed edit
/// construction does not take a slot, TS same order) -> whole reassign; the
/// trailing-newline rule = only the span ending at text end (unlike the wrap
/// family, isomorphic to TS).
pub fn assemble_fixed_dict_actions(
    doc_text: &str,
    doc_file: &str,
    diagnostics: &[DiagnosticGateFace],
    request: &RequestRangeFace,
) -> Vec<ActionFace> {
    let mut actions = Vec::new();
    let mut seen: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    let lines: Vec<&str> = doc_text.split('\n').collect();
    for diagnostic in diagnostics {
        if diagnostic.code != FIXED_DICT_NESTED_MUTATION_CODE {
            continue;
        }
        if !range_intersects(&diagnostic.range, &request.as_gate()) {
            continue;
        }
        let line = diagnostic.range.start_line;
        if seen.contains(&line) {
            continue;
        }
        let Some(edit) = build_fixed_dict_whole_reassign_edit(doc_text, line) else {
            continue;
        };
        seen.insert(line);
        let trailing_newline = edit.end_line < lines.len();
        actions.push(ActionFace {
            kind: "QuickFix",
            title: String::from(
                "Whole reassign: rewrite FIXED_DICT sub-key assignment as top-level assignment",
            ),
            edit: EditFace::ReplaceLines {
                file: doc_file.to_string(),
                start_line: edit.start_line,
                end_line: edit.end_line,
                text: if trailing_newline {
                    format!("{}\n", edit.text)
                } else {
                    edit.text
                },
            },
            diagnostic_start_line: line,
            title_params: Vec::new(),
        });
    }
    actions
}

// ---------------------------------------------------------------------------
// golden fourth face (assembly snapshots of synthetic cases; the TS mirror drives the production provider for parity)
// ---------------------------------------------------------------------------

pub const CODE_ACTION_ASSEMBLY_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/code-action-assembly-parity.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseDump {
    name: &'static str,
    actions: Vec<ActionFace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssemblyDump {
    generator: &'static str,
    case_count: usize,
    action_count: usize,
    cases: Vec<CaseDump>,
}

fn diag(
    code: &str,
    start_line: usize,
    start_char: usize,
    end_line: usize,
    end_char: usize,
) -> DiagnosticGateFace {
    DiagnosticGateFace {
        code: code.to_string(),
        range: GateRange {
            start_line,
            start_char,
            end_line,
            end_char,
        },
        related_file: None,
        related_message: None,
    }
}

fn request(line: usize) -> RequestRangeFace {
    RequestRangeFace {
        start_line: line,
        start_char: 0,
        end_line: line,
        end_char: usize::MAX / 2,
    }
}

/// Assembly snapshot: the four synthetic case families are wired one by one and
/// a full ActionFace snapshot is produced. Cases include positive and negative
/// arms (code outside the gate / non-intersecting ranges / missing location
/// face / duplicate dedupe keys; negative arms have no actions). The synthetic
/// corpus is self-contained and deterministic; the TS mirror rebuilds it
/// verbatim and drives the production provider for parity.
pub fn dump_code_action_assembly_golden() -> String {
    const TYPE_DEF: &str =
        "<Avatar>\n  <Properties>\n    <hp type=\"UNIT32\"/>\n  </Properties>\n</Avatar>\n";
    const AVATAR_DEF: &str = "<Avatar>\n  <Properties>\n    <level type=\"UINT32\"/>\n  </Properties>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n    </onTalk>\n  </BaseMethods>\n</Avatar>\n";
    const AVATAR_PY: &str = "import KBEngine\n\nclass Avatar:\n    def __init__(self):\n        self.level = 0\n\n    def onMove(self):\n        pass\n";
    const RECV_PY: &str = "class Mob:\n    def onEnter(self, entity):\n        self.cell.prepareEnter(entity)\n        self.cell.ready()\n";
    const FD_PY: &str = "class Box:\n    def onUse(self):\n        self.contents[\"slot\"] = 1\n        self.contents[\"extra\"] = 2\n";

    let mut cases = Vec::new();

    // Fix parameter type: positive arm (UNIT32 -> the two candidates UINT32 dist 1
    // + UINT64 dist 2) + negative arm (code outside the gate + non-intersecting range).
    let registered = ["UINT32", "UINT64", "VECTOR3", "STRING"];
    let actions = assemble_type_replacement_actions(
        TYPE_DEF,
        "/w/scripts/entity_defs/Avatar.def",
        &registered,
        &[
            diag(UNKNOWN_TYPE_DIAGNOSTIC_CODE, 2, 14, 2, 20),
            diag("kbengine.other", 2, 14, 2, 20),
            diag(UNKNOWN_TYPE_DIAGNOSTIC_CODE, 0, 0, 0, 7),
        ],
        &request(2),
    );
    cases.push(CaseDump {
        name: "type-replacement",
        actions,
    });

    // Create missing definition: positive arm (an empty related message -> the def
    // file name fallback; onTalk Arg=UINT32 -> arg0: int; a non-empty class body ->
    // a blank-line prefix) + negative arm (related missing + same-key dedup).
    let actions = assemble_parity_method_actions(
        AVATAR_DEF,
        "/w/scripts/entity_defs/Avatar.def",
        Some(AVATAR_PY),
        &[
            {
                let mut d = diag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11);
                d.related_file = Some("/w/scripts/avatar.py".to_string());
                d.related_message = Some(String::new());
                d
            },
            diag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11),
            {
                let mut d = diag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11);
                d.related_file = Some("/w/scripts/avatar.py".to_string());
                d.related_message = Some(String::new());
                d
            },
        ],
        &request(5),
    );
    cases.push(CaseDump {
        name: "parity-method",
        actions,
    });

    // Conflict resolution, guards: positive arm (prepareEnter range attribution gives
    // cell; wrap style first + early-return second) + negative arm (same receiver
    // same line dedup + lines with no receiver).
    let actions = assemble_receiver_none_actions(
        RECV_PY,
        "/w/scripts/mob.py",
        &[
            diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 30),
            diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 24),
            diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 1, 4, 1, 11),
        ],
        &RequestRangeFace {
            start_line: 0,
            start_char: 0,
            end_line: 3,
            end_char: usize::MAX / 2,
        },
    );
    cases.push(CaseDump {
        name: "receiver-none-guard",
        actions,
    });

    // Conflict resolution, whole reassign: positive arm (the subscript-store rewrite
    // idiom; the FD face only accepts the `self.<attr>[...]=v` shape, dot-nested
    // shapes do not match and produce nothing, honestly inheriting the batch 1
    // editor semantics) + negative arm (same-line dedup).
    let actions = assemble_fixed_dict_actions(
        FD_PY,
        "/w/scripts/box.py",
        &[
            diag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 16),
            diag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 13),
        ],
        &request(2),
    );
    cases.push(CaseDump {
        name: "fixed-dict-whole-reassign",
        actions,
    });

    let action_count: usize = cases.iter().map(|case| case.actions.len()).sum();
    let dump = AssemblyDump {
        generator: "kode-server dump-code-action-assembly-golden",
        case_count: cases.len(),
        action_count,
        cases,
    };
    serde_json::to_string_pretty(&dump).expect("golden JSON")
}

/// Test helper (compiled only for test targets; no consumer face in non-test builds).
#[cfg(test)]
impl ActionFace {
    /// Whether the InsertLine text starts with a blank-line prefix (the prefix face is not a directly readable field).
    fn edit_serialized_contains_newline_prefix(&self) -> bool {
        match &self.edit {
            EditFace::InsertLine { text, .. } => text.starts_with('\n'),
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Unit pins
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Intersecting closed intervals: touching endpoints count as intersecting; fully separated does not (isomorphic to TS).
    #[test]
    fn range_intersects_is_closed_interval() {
        let base = GateRange {
            start_line: 2,
            start_char: 10,
            end_line: 2,
            end_char: 20,
        };
        let touching = GateRange {
            start_line: 2,
            start_char: 20,
            end_line: 2,
            end_char: 30,
        };
        let apart = GateRange {
            start_line: 2,
            start_char: 21,
            end_line: 2,
            end_char: 30,
        };
        assert!(range_intersects(&base, &touching), "端点相触=相交");
        assert!(!range_intersects(&base, &apart));
        // Cross-line: the line*1_000_000+char direct-comparison semantics.
        let next_line = GateRange {
            start_line: 3,
            start_char: 0,
            end_line: 3,
            end_char: 5,
        };
        assert!(!range_intersects(&base, &next_line));
        let spanning = GateRange {
            start_line: 1,
            start_char: 0,
            end_line: 4,
            end_char: 0,
        };
        assert!(range_intersects(&base, &spanning));
    }

    /// parity skeleton: unrecognized types fall back to Any; all table values are
    /// emitted (bare VECTOR2/dict names, a lossy but legitimate boundary) — a
    /// different design decision from the batch 1 defMethodConsistency skeleton
    /// (bare argN + the no-import gate); the two faces coexist without replacing
    /// each other.
    #[test]
    fn skeleton_with_types_emits_full_table_with_any_fallback() {
        let code = build_method_skeleton_with_types(
            "onTalk",
            &["UINT32", "VECTOR2", "PY_DICT", "WHATEVER"],
            MethodStubBody::Raise,
        );
        assert_eq!(
            code,
            "    def onTalk(self, arg0: int, arg1: Vector2, arg2: dict, arg3: Any) -> None:\n        raise NotImplementedError\n"
        );
        let pass = build_method_skeleton_with_types("noop", &[], MethodStubBody::Pass);
        assert_eq!(pass, "    def noop(self) -> None:\n        pass\n");
        // batch 1 face (control): the same input degrades to bare argN, proving the two skeletons are different flows.
        let batch1 = crate::code_action::build_method_stub_code(
            "onTalk",
            &["VECTOR2"],
            MethodStubBody::Pass,
        );
        assert_eq!(batch1, "    def onTalk(self, arg0):\n        pass\n");
    }

    /// Range text extraction: cross-line slicing + out-of-bounds clamping + None when the start line is out of bounds.
    #[test]
    fn text_in_range_slices_and_clamps() {
        let text = "alpha\nbeta gamma\ndelta";
        let r = GateRange {
            start_line: 1,
            start_char: 5,
            end_line: 1,
            end_char: 10,
        };
        assert_eq!(text_in_range(text, &r).as_deref(), Some("gamma"));
        let clamped = GateRange {
            start_line: 1,
            start_char: 5,
            end_line: 1,
            end_char: 99,
        };
        assert_eq!(text_in_range(text, &clamped).as_deref(), Some("gamma"));
        let multiline = GateRange {
            start_line: 0,
            start_char: 2,
            end_line: 2,
            end_char: 2,
        };
        assert_eq!(
            text_in_range(text, &multiline).as_deref(),
            Some("pha\nbeta gamma\nde")
        );
        let out = GateRange {
            start_line: 9,
            start_char: 0,
            end_line: 9,
            end_char: 1,
        };
        assert_eq!(text_in_range(text, &out), None);
    }

    /// Entity name: the last segment over both / and \ separators; strips exactly ".def"; without the suffix it is kept as-is.
    #[test]
    fn entity_name_strips_only_exact_def_suffix() {
        assert_eq!(
            entity_name_of_def_file("/w/scripts/entity_defs/Avatar.def"),
            "Avatar"
        );
        assert_eq!(
            entity_name_of_def_file("C:\\w\\entity_defs\\Mob.def"),
            "Mob"
        );
        assert_eq!(entity_name_of_def_file("/w/Backup.DEF"), "Backup.DEF");
        assert_eq!(entity_name_of_def_file("/w/Plain"), "Plain");
    }

    /// `<Arg>` collection: when a same-named method spans sections the client
    /// section wins first (the TS DFS-LIFO equivalent order under the standard
    /// layout); a same-named name in the property section does not hit; a missing
    /// name gives an empty sequence.
    #[test]
    fn method_arg_collection_prefers_client_section_on_duplicate() {
        let def_text = "<Avatar>\n  <Properties>\n    <onTalk type=\"UINT8\"/>\n  </Properties>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT8</Arg>\n    </onTalk>\n  </BaseMethods>\n  <CellMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n      <Arg>STRING</Arg>\n    </onTalk>\n  </CellMethods>\n  <ClientMethods>\n    <onTalk>\n      <Arg>INT8</Arg>\n    </onTalk>\n  </ClientMethods>\n</Avatar>\n";
        assert_eq!(
            collect_method_arg_types(def_text, "onTalk"),
            vec!["INT8".to_string()],
            "client 段先于 cell/base(TS DFS-LIFO 标准布局等价序)"
        );
        assert!(collect_method_arg_types(def_text, "missing").is_empty());
    }

    /// parity wiring negative arms: a missing related emits nothing; the same
    /// (file, method) dedups to one; the class-name fallback goes through the def
    /// file name (an empty related.message).
    #[test]
    fn parity_assembly_gates_and_dedupes() {
        let def_text = "<Avatar>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n    </onTalk>\n  </BaseMethods>\n</Avatar>\n";
        let snapshot = "class Avatar:\n    pass\n";
        let with_related = |related: Option<(&str, &str)>| {
            let mut d = diag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 2, 5, 2, 11);
            if let Some((file, message)) = related {
                d.related_file = Some(file.to_string());
                d.related_message = Some(message.to_string());
            }
            d
        };
        let actions = assemble_parity_method_actions(
            def_text,
            "/w/scripts/entity_defs/Avatar.def",
            Some(snapshot),
            &[
                with_related(Some(("/w/scripts/avatar.py", "Avatar"))),
                with_related(Some(("/w/scripts/avatar.py", "Avatar"))),
                with_related(None),
            ],
            &request(2),
        );
        assert_eq!(actions.len(), 1, "同键去重 + related 缺失负臂");
        assert!(
            actions[0]
                .title
                .contains("Generate method onTalk \u{2192} /w/scripts/avatar.py:3"),
            "方法名取区间真文本;非空类体插入行 2(0 基),1 基展示行 3"
        );
        assert!(
            actions[0].edit_serialized_contains_newline_prefix(),
            "非空体加空行分隔前缀"
        );
    }

    /// Guard wiring: wrap style first, early-return second; the second diagnostic
    /// for the same receiver on the same line dedups; lines with no extractable
    /// receiver emit nothing.
    #[test]
    fn receiver_assembly_orders_wrap_then_guard_and_dedupes() {
        let doc =
            "class Mob:\n    def onEnter(self, entity):\n        self.cell.prepareEnter(entity)\n";
        let actions = assemble_receiver_none_actions(
            doc,
            "/w/scripts/mob.py",
            &[
                diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 30),
                diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 24),
            ],
            &RequestRangeFace {
                start_line: 0,
                start_char: 0,
                end_line: 2,
                end_char: usize::MAX / 2,
            },
        );
        assert_eq!(actions.len(), 2, "wrap+guard 各一,同键第二诊断去重");
        assert_eq!(actions[0].title, "Wrap with null guard (if self.cell:)");
        assert_eq!(
            actions[1].title,
            "Insert None guard (if not self.cell: return)"
        );
        // no self.<r>.<m> line: the receiver cannot be extracted, nothing emitted.
        let none = assemble_receiver_none_actions(
            doc,
            "/w/scripts/mob.py",
            &[diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 1, 4, 1, 11)],
            &request(1),
        );
        assert!(none.is_empty());
    }

    /// FD wiring: line dedup keeps one; a code outside the gate emits nothing.
    #[test]
    fn fixed_dict_assembly_dedupes_by_line() {
        let doc = "class Box:\n    def onUse(self):\n        self.contents[\"slot\"] = 1\n";
        let actions = assemble_fixed_dict_actions(
            doc,
            "/w/scripts/box.py",
            &[
                diag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 16),
                diag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 13),
                diag("kbengine.other", 2, 8, 2, 16),
            ],
            &request(2),
        );
        assert_eq!(actions.len(), 1);
        assert_eq!(
            actions[0].title,
            "Whole reassign: rewrite FIXED_DICT sub-key assignment as top-level assignment"
        );
    }
}
