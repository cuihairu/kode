//! CodeAction provider 装配决策核(RUST-143 批 2;TS
//! `src/languageProviders/codeAction.ts` 四 provider 装配流的纯库半边)。
//!
//! 批 1(code_action.rs)交付七个纯面(注解映射/骨架/插入点/近拼建议/
//! receiver 区间归属/守卫双编辑/FD 整体重赋);本批在其上装配 provider
//! 决策流:诊断 code 闸 → 区间相交 → 定位面提取 → 去重 → 编辑构造 →
//! 标题/种类/诊断对账,产出 [`ActionFace`](纯描述符,不产 vscode 对象)。
//! 四族对账:
//! - 修参数类型 = KBEngineTypeCodeActionProvider(unknown-type 近拼替换)
//! - 创建缺失定义 = KBEngineDefPythonParityCodeActionProvider(缺实现
//!   方法骨架;MethodImplementationProvider 的 EntityMappingManager 异步
//!   服务面归接线批,其纯半边批 1 已收)
//! - 冲突定位 = KBEngineReceiverNoneGuardCodeActionProvider(守卫双动作
//!   +包裹式首选)+ KBEngineFixedDictWholeReassignCodeActionProvider
//!   (整体重赋)
//!
//! 诚实边界(登记,不冒充):
//! - Type provider 的 `getKnownTypeContext`(builtins+types.xml+实体装配)
//!   是 completion 模块服务面,本面吃 `registered` 列表输入;provider 类
//!   级行为由 electron 套件(lintQuickFixBoundaries)覆盖。
//! - parity 装配吃快照文本输入(`readSharedFileSnapshot` 打开文档优先 +
//!   磁盘补载归接线批);`collect_method_arg_types` 走 kode_parser 模型
//!   (client→cell→base 逆序 = TS DFS-LIFO 在标准布局下的等价序;def 段
//!   落非标准文档序时 TS 按文档序 DFS,模型无 span 保序,边界登记)。
//! - 标题为 en 源串({name} 占位插值 = TS l10n.t 无 bundle 默认行为);
//!   zh bundle 归 l10n 面不进对拍。
//! - 诊断面为纯数据(code/区间/related),vscode.Diagnostic 对象构造与
//!   事件流归接线批;cancel/取消位(provider 首行 isCancellationRequested
//!   → 空)是宿主面,纯函数 N-A 如实登记。

use serde::Serialize;

use crate::code_action::{
    build_fixed_dict_whole_reassign_edit, build_receiver_none_guard_edit,
    build_receiver_none_wrap_edit, find_python_class_insertion_point,
    find_registered_type_suggestions, receiver_from_diagnostic_line, MethodStubBody,
};

// ---------------------------------------------------------------------------
// 诊断 code 常量(TS 生产面同值;KODE-AUD-002 对账)
// ---------------------------------------------------------------------------

/// src/languageProviders/validation.ts UNKNOWN_TYPE_DIAGNOSTIC_CODE。
pub const UNKNOWN_TYPE_DIAGNOSTIC_CODE: &str = "kbengine.unknownType";
/// defMethodConsistency.DEF_METHOD_MISSING_DIAGNOSTIC_CODE = Rust lint 规则 id。
pub const DEF_PYTHON_PARITY_DIAGNOSTIC_CODE: &str = "def-method-missing-in-python";
/// src/backend/receiverNoneDiagnostics.ts RECEIVER_NONE_DIAGNOSTIC_CODE。
pub const RECEIVER_NONE_DIAGNOSTIC_CODE: &str = "kbengine.receiverNone";
/// src/backend/behaviorKnowledge.ts FIXED_DICT_NESTED_MUTATION_CODE。
pub const FIXED_DICT_NESTED_MUTATION_CODE: &str = "kbengine.fixedDictNestedMutation";

// ---------------------------------------------------------------------------
// 输入面(纯数据诊断;line 0 基,char 0 基 = vscode Position 同域)
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
    /// relatedInformation[0].location.uri.fsPath(parity 族定位面;无=None)。
    pub related_file: Option<String>,
    /// relatedInformation[0].message(目标类名;空串 → entityNameOfDefFile 兜底)。
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

/// 诊断区间与请求区间相交(TS diagnosticRangeIntersects 同构:行/列直比
/// line*1_000_000+char,闭区间端点相触即相交)。
pub fn range_intersects(left: &GateRange, right: &GateRange) -> bool {
    let value = |line: usize, char: usize| line * 1_000_000 + char;
    value(left.start_line, left.start_char) <= value(right.end_line, right.end_char)
        && value(right.start_line, right.start_char) <= value(left.end_line, left.end_char)
}

/// 区间文本提取(document.getText(range) 同构:行/列 → 偏移切片;越界
/// 截到行尾/文尾)。None = 起点行越界。
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

/// 实体名 = def 文件名去 `.def`(TS entityNameOfDefFile 同构:/ 与 \ 双分隔
/// 取末段;后缀只剥恰好 ".def")。
pub fn entity_name_of_def_file(def_file: &str) -> String {
    let last = def_file.rsplit(['/', '\\']).next().unwrap_or(def_file);
    last.strip_suffix(".def").unwrap_or(last).to_string()
}

// ---------------------------------------------------------------------------
// parity 骨架面(defPythonParity 同构;与批 1 defMethodConsistency 骨架
// 是**两条不同设计决策**:这条未识别类型兜底 Any、表值全发射(有损但合法
// 分析口径);批 1 那条未识别裸 argN、表值只发免 import 名)
// ---------------------------------------------------------------------------

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS(pythonTypeStubs 单一事实源同表)。
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

/// parity 方法骨架:4 缩进 `def <name>(self, argN: <注解>...) -> None:` + 体;
/// 未识别类型兜底 Any(map_def_type_to_python_annotation),体默认
/// raise NotImplementedError。TS buildPythonMethodSkeletonWithTypes 同构。
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
    // 返回注解恒 `-> None`(TS 同文;方法骨架语义=无返回值)。
    format!(
        "    def {}({}) -> None:\n{}\n",
        method_name, signature, body_line
    )
}

/// def 文档方法 `<Arg>` 类型序列采集(TS collectMethodArgTypes +
/// findMethodElementByName 同构):方法段内按 client→cell→base 逆序找首个
/// 同名方法(= TS DFS-LIFO 在标准布局下的等价序),取其 `<Arg>` 文本序;
/// 属性段同名/解析不到 → 空(仅 self 签名)。
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
// 装配产出面(纯描述符;TS CodeAction/WorkspaceEdit 构造归接线批薄壳)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditFace {
    /// TextEdit(diagnostic.range, candidate) — 类型近拼替换。
    ReplaceRange {
        file: String,
        range: GateRange,
        new_text: String,
    },
    /// edit.insert(Position(line, 0), text) — 行首插入(文本已含空行前缀)。
    InsertLine {
        file: String,
        line: usize,
        text: String,
    },
    /// edit.replace(Range(startLine, 0, endLine, 0), text) — 整行段替换
    /// (尾换行已按各自规则烘焙:wrap 族=段末在文尾且全文以 \n 结尾;
    /// FD 族=仅段末在文尾)。
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
    /// "QuickFix" | "Refactor"(vscode.CodeActionKind 值域)。
    pub kind: &'static str,
    /// l10n 源串插值后标题(en 面)。
    pub title: String,
    pub edit: EditFace,
    /// action.diagnostics 对账 = 命中诊断的起始行(单诊断)。
    pub diagnostic_start_line: usize,
    /// 标题插值参数(按族定序;TS l10n 薄壳按族选模板并按位插值,zh bundle
    /// 不经 en 插值串):typeReplacement=[候选名];parityMethod=[方法名,
    /// 目标文件,1 基展示行];receiverNone=[receiver];fixedDict=[]。
    pub title_params: Vec<String>,
}

/// 类型近拼替换装配(KBEngineTypeCodeActionProvider 决策流):code 闸 →
/// 区间相交 → 区间文本 trim 非空 → registered 近拼候选逐个出替换动作
/// (候选面由 find_registered_type_suggestions 截断排序,批 1 同构)。
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

/// 缺实现方法骨架装配(KBEngineDefPythonParityCodeActionProvider 决策流):
/// code 闸 → 相交 → related 定位面(缺=不出)→ 目标类名(related.message
/// 非空优先,否则 def 文件名兜底)→ 方法名(区间文本 trim 非空)→
/// dedupe(file:method)→ def `<Arg>` 采集 → 快照插入点 → 骨架(raise 体)
/// → 行首插入(空体不加空行前缀,非空体加)。
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

/// receiver-none 守卫装配(KBEngineReceiverNoneGuardCodeActionProvider
/// 决策流):code 闸 → 相交 → 诊断行区间归属取 receiver(提不出不出)→
/// dedupe(receiver:line)→ 守卫双编辑(双 None 不 dedupe 不出,TS 同序)
/// → 包裹式首选 + 早退式次选;包裹式尾换行规则 = 段末在文尾且全文以 \n
/// 结尾(TS 同构)。
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
            // 包裹式(2026-10-30 用户令):判非 None 后继续,首选靠前。
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

/// FIXED_DICT 整体重赋装配(KBEngineFixedDictWholeReassignCodeActionProvider
/// 决策流):code 闸 → 相交 → 行 dedupe(先查后加,编辑构造失败不占位,
/// TS 同序)→ 整体重赋;尾换行规则 = 仅段末在文尾(与 wrap 族不同,TS 同构)。
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
// golden 第四面(合成案例装配快照;TS 镜像驱动生产 provider 对拍)
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

/// 装配快照:四族合成案例逐一装配,产出 ActionFace 全量快照。案例含正臂
/// 与负臂(闸外 code/区间不相交/定位面缺失/去重键重复;负臂动作空)。
/// 合成语料自含确定性,TS 镜像逐字重建并驱动生产 provider 对拍。
pub fn dump_code_action_assembly_golden() -> String {
    const TYPE_DEF: &str =
        "<Avatar>\n  <Properties>\n    <hp type=\"UNIT32\"/>\n  </Properties>\n</Avatar>\n";
    const AVATAR_DEF: &str = "<Avatar>\n  <Properties>\n    <level type=\"UINT32\"/>\n  </Properties>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n    </onTalk>\n  </BaseMethods>\n</Avatar>\n";
    const AVATAR_PY: &str = "import KBEngine\n\nclass Avatar:\n    def __init__(self):\n        self.level = 0\n\n    def onMove(self):\n        pass\n";
    const RECV_PY: &str = "class Mob:\n    def onEnter(self, entity):\n        self.cell.prepareEnter(entity)\n        self.cell.ready()\n";
    const FD_PY: &str = "class Box:\n    def onUse(self):\n        self.contents[\"slot\"] = 1\n        self.contents[\"extra\"] = 2\n";

    let mut cases = Vec::new();

    // 修参数类型:正臂(UNIT32 → UINT32 dist1 + UINT64 dist2 两候选)+
    // 负臂(code 闸外 + 区间不相交)。
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

    // 创建缺失定义:正臂(related 空 message → def 文件名兜底;onTalk
    // Arg=UINT32 → arg0: int;非空类体 → 空行前缀)+ 负臂(related 缺失
    // + 同键去重)。
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

    // 冲突定位·守卫:正臂(prepareEnter 区间归属 cell;包裹式首选 + 早退
    // 次选)+ 负臂(同 receiver 同行去重 + 无 receiver 行)。
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

    // 冲突定位·整体重赋:正臂(下标存储改写习语;FD 面只吃 `self.<attr>
    // [...]=v` 形态,点嵌套不匹配不出,批 1 编辑器语义如实继承)+ 负臂
    // (同行去重)。
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

/// 测试辅助(仅测试目标编译;非测试构建下无消费面)。
#[cfg(test)]
impl ActionFace {
    /// InsertLine 文本是否以空行前缀开头(前缀面非直读字段)。
    fn edit_serialized_contains_newline_prefix(&self) -> bool {
        match &self.edit {
            EditFace::InsertLine { text, .. } => text.starts_with('\n'),
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// 单元钉
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 相交闭区间:端点相触即相交;完全分离不相交(与 TS 同构)。
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
        // 跨行:line*1_000_000+char 直比语义。
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

    /// parity 骨架:未识别类型兜底 Any;表值全发射(VECTOR2/dict 裸名,
    /// 有损但合法边界)——与批 1 defMethodConsistency 骨架(裸 argN +
    /// 免 import 闸)是两条不同设计决策,双面并存不互替。
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
        // 批 1 面(对照):同输入裸 argN 退化,证明两骨架不同流。
        let batch1 = crate::code_action::build_method_stub_code(
            "onTalk",
            &["VECTOR2"],
            MethodStubBody::Pass,
        );
        assert_eq!(batch1, "    def onTalk(self, arg0):\n        pass\n");
    }

    /// 区间文本提取:跨行切片 + 越界截断 + 起点行越界 None。
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

    /// 实体名:/ 与 \ 双分隔取末段;仅剥恰好 ".def";无后缀原样。
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

    /// `<Arg>` 采集:同名方法跨段时 client 段先胜(TS DFS-LIFO 标准布局
    /// 等价序);属性段同名不命中;缺名空序。
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

    /// parity 装配负臂序:related 缺失不出;同 (file,method) 去重只一条;
    /// 类名兜底走 def 文件名(related.message 空)。
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

    /// 守卫装配:包裹式在先、早退式在后;同 receiver 同行第二诊断去重;
    /// receiver 提不出的行不出。
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
        // 无 self.<r>.<m> 行:receiver 提不出,不出。
        let none = assemble_receiver_none_actions(
            doc,
            "/w/scripts/mob.py",
            &[diag(RECEIVER_NONE_DIAGNOSTIC_CODE, 1, 4, 1, 11)],
            &request(1),
        );
        assert!(none.is_empty());
    }

    /// FD 装配:行 dedupe 只一条;闸外 code 不出。
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
