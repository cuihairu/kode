//! SignatureHelp 决策核(RUST-140 批 2):src/languageProviders/hover.ts 的
//! KBEngineSignatureHelpProvider 决策链同构下沉——调用点词法面(批 1
//! python_call_at)→ 方法声明解析(类型 IR 面:实体归属/继承链闭包/接收者
//! 段闸)→ 签名组装(label/形参注解/documentation/activeParameter)。
//!
//! 解析链对齐 TS `EntityMappingManager.resolveMethodDefinition`:
//! 1. 调用方 python 路径 → owner 三元组(kind/name/section,三个推断面
//!    与 TS 逐字同构);owner kind = `/components/`→component、
//!    `/interfaces/`→interface、`.py`→entity;
//! 2. 候选 = 本域 owner 实体 def 的继承链闭包声明(TS index.methodDefinitions
//!    = owner 实体 resolved semantics 收集面;组件槽展开留接线批,
//!    componentSlotName 恒缺席 → +30 分支不参与);
//! 3. 接收者段闸(用户令 2026-10-21):receiverSection 在场 = 硬过滤
//!    (段不符一律剔除,不是降权),发生在打分之前;段缺省时不设闸,
//!    调用方目录段经打分 +20 自然偏置;
//! 4. 打分:ownerKind +40 / ownerName +40 / callerSection +20 /
//!    sourceKind local +10(语料候选恒声明本面);同分按规范化 def 路径
//!    字典序、再行号稳定破平(TS localeCompare 差异边界:语料路径全
//!    ASCII 小写,逐字节序与 locale 序一致);
//! 5. 本域 miss 且 ownerKind==interface && 段在场 → 跨 def 全语料回退
//!    (TS allowCrossDefFallback 同口径;接口无段文件不回退,防误绑无关
//!    实体声明)。
//!
//! 签名组装对齐 TS formatDefMethodParameter/formatDefMethodSignature:
//! 形参名 argN 与存根生成器同口径;类型注解取内建直查面
//! (resolve_annotation_direct,workspaceRoot='' 语境;types.xml/alias.xml
//! 注册表快照链留 TS,RUST-144 同诚实边界),链断/未知不显 `: Any`,
//! 只出名不造型。documentation 三段拼接与 TS appendMarkdown 逐字节一致。
//!
//! 韧性面(RUST-149 横切):本面同步纯函数、零 await/RPC——stale/cancel/
//! cold 维度 N-A;root 维度由单测钉(invalidate_root 后候选摘除、解析
//! 如实 miss)与 def 换代钉闭环。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::def_param_hints::{
    infer_method_section_from_python_file, normalize_file_identity, resolve_annotation_direct,
};
use crate::hover::{category_of, Category, HoverEngine};
use crate::python_call_at::get_python_call_at_position;

// ---------------------------------------------------------------------------
// 调用方 python 路径身份(entityMappingHelpers 同构)
// ---------------------------------------------------------------------------

/// TS inferOwnerKindFromPythonFile 同构:归一化小写路径含 `/components/`
/// → component、含 `/interfaces/` → interface、以 `.py` 结尾 → entity。
pub fn infer_owner_kind_from_python_file(python_file: &str) -> Option<&'static str> {
    let normalized = normalize_file_identity(python_file).to_lowercase();
    if normalized.contains("/components/") {
        return Some("component");
    }
    if normalized.contains("/interfaces/") {
        return Some("interface");
    }
    if normalized.ends_with(".py") {
        return Some("entity");
    }
    None
}

/// TS inferOwnerNameFromPythonFile 同构(path.basename(pythonFile, '.py')):
/// 末段去 `.py` 后缀;非 .py 文件原样返回(TS basename 同语义)。
pub fn infer_owner_name_from_python_file(python_file: &str) -> String {
    let base = python_file
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(python_file);
    base.strip_suffix(".py").unwrap_or(base).to_string()
}

// ---------------------------------------------------------------------------
// def 方法候选索引(类型 IR 面)
// ---------------------------------------------------------------------------

/// def 方法声明候选(TS IndexedMethodDefinition 决策核字段子集;组件槽
/// 展开留接线批,故无 componentSlotName)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodDefCandidate {
    pub def_file: String,
    /// 声明行(1 起,parser MethodDef.line 同口径)。
    pub line: u32,
    pub section: &'static str,
    pub exposed: bool,
    pub owner_kind: &'static str,
    /// 声明 def 的文件名去 .def(= TS owner.name 同径)。
    pub owner_name: String,
    pub symbol_name: String,
    /// `<Arg>` 直文本序列(注解解析在组装面做,不在此预算)。
    pub declared_args: Vec<String>,
}

impl HoverEngine {
    /// 全语料 def 方法候选索引:语料 def 视图逐文件展开 base/cell/client
    /// 三段;ownerKind 按 defs_root 相对目录段(TS definitionSemantics 按
    /// 类别目录装载同径)。语料字典序 = 稳定收集序。
    pub(crate) fn method_def_candidates(&self) -> Vec<MethodDefCandidate> {
        let mut out = Vec::new();
        for path in &self.corpus_defs {
            let Some(def) = self.corpus_def(path) else {
                continue;
            };
            let owner_kind = match self.defs_root(path) {
                Some(defs_root) => match category_of(&defs_root, path) {
                    Category::Entity => "entity",
                    Category::Interface => "interface",
                    Category::Component => "component",
                },
                None => "entity",
            };
            let owner_name = path
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .strip_suffix(".def")
                .unwrap_or(path)
                .to_string();
            for (section, methods) in [
                ("BaseMethods", &def.base_methods),
                ("CellMethods", &def.cell_methods),
                ("ClientMethods", &def.client_methods),
            ] {
                for method in methods {
                    out.push(MethodDefCandidate {
                        def_file: path.clone(),
                        line: method.line as u32,
                        section,
                        exposed: method.exposed,
                        owner_kind,
                        owner_name: owner_name.clone(),
                        symbol_name: method.name.clone(),
                        declared_args: method.args.clone(),
                    });
                }
            }
        }
        out
    }

    /// owner 实体 def 继承链闭包的**路径集**(本域候选域;chain_face 同一
    /// 走查口径,只取存在路径:自身 + parent 链 + interfaces + components,
    /// 接口 def 不跟随 Parent,环截断)。owner def 不在语料 → None
    /// (TS ensureIndexForPythonFile 落空同口径)。
    fn owner_chain_paths(&self, python_file: &str) -> Option<Vec<String>> {
        let owner_name = infer_owner_name_from_python_file(python_file);
        // entity_defs 根折算:python 文件在 entities 目录树下但通常不在
        // entity_defs 内,defs_root 返回 entities 目录本身——按 TS
        // layout.entityDefsRoot 口径折算 `{entities_dir}/entity_defs`
        // (definition.rs entity_defs_root 的折算分支对树外路径不可达,
        // 此处本地折算;该面缺陷登记不冒充修复,归 definition 车道)。
        let defs_root_dir = self.defs_root(python_file)?;
        let entity_defs = if defs_root_dir.ends_with("/entity_defs") {
            defs_root_dir.clone()
        } else {
            format!("{defs_root_dir}/entity_defs")
        };
        let owner_path = format!("{entity_defs}/{owner_name}.def");
        if !self.corpus_defs.contains(&owner_path) {
            return None;
        }
        let Some(defs_root) = self.defs_root(&owner_path) else {
            return Some(vec![owner_path]);
        };
        let mut out = vec![owner_path.clone()];
        let mut seen = std::collections::BTreeSet::from([owner_path.clone()]);
        let mut current = Some(owner_path);
        while let Some(cpath) = current {
            let Some(cdef) = self.corpus_def(&cpath) else {
                break;
            };
            let category = category_of(&defs_root, &cpath);
            for name in &cdef.interfaces {
                let candidate = format!("{defs_root}/interfaces/{name}.def");
                if self.corpus_defs.contains(&candidate) && seen.insert(candidate.clone()) {
                    out.push(candidate);
                }
            }
            for comp in &cdef.components {
                let Some(name) = &comp.component_type else {
                    continue;
                };
                let candidate = format!("{defs_root}/components/{name}.def");
                if self.corpus_defs.contains(&candidate) && seen.insert(candidate.clone()) {
                    out.push(candidate);
                }
            }
            // 接口 def 不跟随 Parent(引擎 loadInterfaces 口径)。
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
            if !self.corpus_defs.contains(&parent_path) || !seen.insert(parent_path.clone()) {
                break;
            }
            out.push(parent_path.clone());
            current = Some(parent_path);
        }
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// 解析决策核(TS filterMethodDefinitionsBySection + selectMethodDefinition)
// ---------------------------------------------------------------------------

/// 候选打分:ownerKind +40 / ownerName +40 / callerSection +20 /
/// sourceKind local +10(语料候选恒声明本面,恒 +10)。ownerName 空串
/// 视 TS falsy 不计。组件槽 +30 分支随槽展开批入库。
fn score_candidate(
    candidate: &MethodDefCandidate,
    owner_kind: Option<&str>,
    owner_name: &str,
    caller_section: Option<&str>,
) -> u32 {
    let mut score = 0;
    if owner_kind == Some(candidate.owner_kind) {
        score += 40;
    }
    if !owner_name.is_empty() && candidate.owner_name == owner_name {
        score += 40;
    }
    if caller_section == Some(candidate.section) {
        score += 20;
    }
    score += 10;
    score
}

/// 方法声明解析:名字匹配 → 接收者段硬闸(段不符剔除,不是降权)→
/// 打分排序(分数降序;同分规范化 def 路径字典序、再行号)→ 首选。
pub fn resolve_method_definition<'a>(
    candidates: &'a [MethodDefCandidate],
    python_file: &str,
    method_name: &str,
    receiver_section: Option<&str>,
) -> Option<&'a MethodDefCandidate> {
    let owner_kind = infer_owner_kind_from_python_file(python_file);
    let owner_name = infer_owner_name_from_python_file(python_file);
    let caller_section = infer_method_section_from_python_file(python_file);
    let mut scored: Vec<(u32, &MethodDefCandidate)> = candidates
        .iter()
        .filter(|c| c.symbol_name == method_name)
        // 接收者段闸:receiverSection 在场时只留段相符声明(硬过滤)。
        .filter(|c| receiver_section.is_none_or(|s| c.section == s))
        .map(|c| {
            (
                score_candidate(c, owner_kind, &owner_name, caller_section),
                c,
            )
        })
        .collect();
    scored.sort_by(|(sa, ca), (sb, cb)| {
        sb.cmp(sa)
            .then_with(|| {
                normalize_file_identity(&ca.def_file).cmp(&normalize_file_identity(&cb.def_file))
            })
            .then_with(|| ca.line.cmp(&cb.line))
    });
    scored.first().map(|(_, c)| *c)
}

// ---------------------------------------------------------------------------
// 签名组装(TS formatDefMethodParameter/formatDefMethodSignature 同构)
// ---------------------------------------------------------------------------

/// 形参标签:有 `<Arg>` 无类型文本或解析落 Any → 只出名(`argN`,不显
/// `: Any`;ENTITYCALL/PYTHON 内建解析值同为 Any,同样只出名——TS
/// formatDefMethodParameter 对 PYTHON_TYPE_STUB_FALLBACK 的同一收口);
/// 其余内建直查命中 → `argN: type`。
pub fn format_def_method_parameter(arg: &str, index: usize) -> String {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return format!("arg{}", index + 1);
    }
    match resolve_annotation_direct(trimmed) {
        Some(annotation) if annotation != "Any" => format!("arg{}: {}", index + 1, annotation),
        _ => format!("arg{}", index + 1),
    }
}

/// 签名 label:`def <name>(self)` / `def <name>(self, p1, p2)`。
pub fn format_def_method_signature(method_name: &str, parameters: &[String]) -> String {
    if parameters.is_empty() {
        format!("def {method_name}(self)")
    } else {
        format!("def {method_name}(self, {})", parameters.join(", "))
    }
}

/// 选中声明的落点面(golden 与接线面共用)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDefinition {
    pub file: String,
    /// 声明行(1 起)。
    pub line: u32,
    pub section: &'static str,
    pub exposed: bool,
}

/// 一次 SignatureHelp 决策产物(activeParameter 随光标位置,由
/// clamp_active_parameter 单独给出;本结构只含位置无关四件)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelpFace {
    pub label: String,
    pub parameters: Vec<String>,
    pub documentation: String,
    pub definition: SignatureDefinition,
}

/// 活动形参标亮:实参序号超界夹到末形参;零形参恒 0(TS Math.min 面同构)。
pub fn clamp_active_parameter(active_argument: u32, parameter_count: usize) -> u32 {
    if parameter_count == 0 {
        0
    } else {
        active_argument.min(parameter_count as u32 - 1)
    }
}

impl HoverEngine {
    /// SignatureHelp 决策核:本域继承链闭包解析 → miss 且接口文件且段
    /// 在场时全语料回退 → 签名组装。返回 None = 无签名(TS location null
    /// 同口径,provider 出 null)。
    pub fn signature_help(
        &self,
        python_file: &str,
        method_name: &str,
        receiver_section: Option<&str>,
    ) -> Option<SignatureHelpFace> {
        let owner_kind = infer_owner_kind_from_python_file(python_file);
        let candidates = self.method_def_candidates();
        let selected = {
            let local = self
                .owner_chain_paths(python_file)
                .map(|scope| {
                    let scoped: Vec<MethodDefCandidate> = candidates
                        .iter()
                        .filter(|c| scope.contains(&c.def_file))
                        .cloned()
                        .collect();
                    resolve_method_definition(&scoped, python_file, method_name, receiver_section)
                        .cloned()
                })
                .unwrap_or(None);
            match local {
                Some(selected) => Some(selected),
                // 跨 def 回退仅接口文件且有段(TS allowCrossDefFallback)。
                None if owner_kind == Some("interface") && receiver_section.is_some() => {
                    resolve_method_definition(
                        &candidates,
                        python_file,
                        method_name,
                        receiver_section,
                    )
                    .cloned()
                }
                None => None,
            }
        }?;
        let parameters: Vec<String> = selected
            .declared_args
            .iter()
            .enumerate()
            .map(|(index, arg)| format_def_method_parameter(arg, index))
            .collect();
        let mut documentation = format!("此调用是实体 def 声明的 {} 方法", selected.section);
        if let Some(receiver) = receiver_section {
            documentation.push_str(&format!("(接收者 self.{receiver})"));
        }
        if selected.exposed {
            documentation.push_str(" · **Exposed**: 可被客户端远程调用");
        }
        Some(SignatureHelpFace {
            label: format_def_method_signature(method_name, &parameters),
            parameters,
            documentation,
            definition: SignatureDefinition {
                file: selected.def_file.clone(),
                line: selected.line,
                section: selected.section,
                exposed: selected.exposed,
            },
        })
    }
}

// ---------------------------------------------------------------------------
// golden(Rust 侧真值;TS 侧 tests/kodeSignatureHelpParity.test.ts 复算)
// ---------------------------------------------------------------------------

pub const SIGNATURE_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/signature-help-parity.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    /// 全集探针(逐行位置数 = 行 UTF-16 长度 + 1;与批 1 探测同口径)。
    probe_count: usize,
    /// 批 1 词法命中全集(与 python-call-at golden hitCount 同值,对账锚)。
    hit_count: usize,
    /// 解析出签名的命中位(= activations 总和)。
    resolved_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    file: String,
    probe_count: usize,
    hit_count: usize,
    entries: Vec<GoldenEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenEntry {
    /// 调用行(1 起)。
    line: u32,
    call: GoldenCallRef,
    help: SignatureHelpFace,
    /// 该调用组覆盖的命中位(character 升序)。
    activations: Vec<GoldenActivation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCallRef {
    method_name: String,
    section: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenActivation {
    character: usize,
    active_argument: u32,
    active_parameter: u32,
}

/// 逐语料 python 文件逐行逐位置:批 1 词法命中 → 决策核解析;命中组
/// (行, 方法名, 接收者段)入档一条,签名四件取组内首见解析(组内确定性:
/// 解析只依赖 python 文件 + 方法名 + 段),activations 逐位记
/// activeArgument→activeParameter 标亮。未解析命中不入档(对账靠
/// hitCount/resolvedCount 差值,TS 侧复算未解析位必须同落空)。
pub fn dump_signature_help_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let py_corpus = crate::python_call_at::collect_python_corpus(repo_root);
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-signature-help-golden",
        file_count: py_corpus.len(),
        probe_count: 0,
        hit_count: 0,
        resolved_count: 0,
        files: Vec::new(),
    };
    for (path, text) in &py_corpus {
        let mut golden_file = GoldenFile {
            file: path.clone(),
            probe_count: 0,
            hit_count: 0,
            entries: Vec::new(),
        };
        // 组键:(行, 方法名, 接收者段);组内首见签名 + 逐位 activations。
        let mut groups: BTreeMap<(u32, String, Option<&'static str>), GroupAcc> = BTreeMap::new();
        for (idx, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let units: Vec<u16> = line.encode_utf16().collect();
            golden_file.probe_count += units.len() + 1;
            for character in 0..=units.len() {
                let Some(call) = get_python_call_at_position(line, character) else {
                    continue;
                };
                golden_file.hit_count += 1;
                let face = engine.signature_help(path, &call.method_name, call.section);
                let Some(face) = face else {
                    continue;
                };
                let key = (idx as u32 + 1, call.method_name.clone(), call.section);
                let group = groups.entry(key).or_insert(GroupAcc {
                    face,
                    activations: Vec::new(),
                });
                group.activations.push(GoldenActivation {
                    character,
                    active_argument: call.active_argument,
                    active_parameter: clamp_active_parameter(
                        call.active_argument,
                        group.face.parameters.len(),
                    ),
                });
            }
        }
        dump.probe_count += golden_file.probe_count;
        dump.hit_count += golden_file.hit_count;
        for ((line, method_name, section), group) in groups {
            dump.resolved_count += group.activations.len();
            golden_file.entries.push(GoldenEntry {
                line,
                call: GoldenCallRef {
                    method_name,
                    section,
                },
                help: group.face,
                activations: group.activations,
            });
        }
        dump.files.push(golden_file);
    }
    serde_json::to_string_pretty(&dump).expect("serialize")
}

struct GroupAcc {
    face: SignatureHelpFace,
    activations: Vec<GoldenActivation>,
}

// ---------------------------------------------------------------------------
// 单元钉
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use kode_vfs::store::{DocumentKey, RootRegistry};
    use kode_vfs::uri::CanonicalUri;

    use super::*;

    fn registry() -> RootRegistry {
        let mut registry = RootRegistry::new();
        registry.register("/proj-a");
        registry.register("/proj-b");
        registry
    }

    fn key_for(registry: &RootRegistry, path: &str) -> DocumentKey {
        let uri = CanonicalUri::from_path(path);
        DocumentKey::new(registry.root_for(&uri), uri)
    }

    const A_ENTITIES: &str =
        "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n</root>\n";
    /// 双段同名方法:cell 段在前(收集序),base 段在后——段闸硬过滤不是降权。
    const A_AVATAR_SECTIONS: &str = "<root>\n  <CellMethods>\n    <onRpc>\n      <Arg> UINT32 </Arg>\n    </onRpc>\n  </CellMethods>\n  <BaseMethods>\n    <onRpc>\n      <Arg> INT8 </Arg>\n      <Arg> STRING </Arg>\n    </onRpc>\n    <onExposed>\n      <Exposed>true</Exposed>\n    </onExposed>\n  </BaseMethods>\n</root>\n";
    /// 接口声明(闭包经 <Interfaces> 折入)。
    const A_ROLE: &str = "<root>\n  <BaseMethods>\n    <onRoleRpc>\n      <Arg> UINT32 </Arg>\n    </onRoleRpc>\n  </BaseMethods>\n</root>\n";
    const A_IFACE_AVATAR: &str =
        "<root>\n  <Interfaces>\n    <interface> ROLE </interface>\n  </Interfaces>\n</root>\n";
    /// 跨 root 同名实体,只有 base 段声明(本域隔离/平分破平场景用)。
    const B_ENTITIES: &str =
        "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n</root>\n";
    const B_AVATAR: &str = "<root>\n  <BaseMethods>\n    <onRpc>\n      <Arg> UINT64 </Arg>\n    </onRpc>\n  </BaseMethods>\n</root>\n";

    fn build() -> (RootRegistry, HoverEngine) {
        let registry = registry();
        let mut engine = HoverEngine::new();
        for (path, text) in [
            ("/proj-a/scripts/entities.xml", A_ENTITIES),
            ("/proj-a/scripts/entity_defs/Avatar.def", A_AVATAR_SECTIONS),
            ("/proj-a/scripts/entity_defs/interfaces/ROLE.def", A_ROLE),
            (
                "/proj-a/scripts/entity_defs/AvatarIface.def",
                A_IFACE_AVATAR,
            ),
            ("/proj-b/scripts/entities.xml", B_ENTITIES),
            ("/proj-b/scripts/entity_defs/Avatar.def", B_AVATAR),
        ] {
            engine.update(key_for(&registry, path), text);
        }
        (registry, engine)
    }

    fn py_path(dir: &str, stem: &str) -> String {
        format!("/proj-a/scripts/{dir}/{stem}.py")
    }

    /// 段闸是硬过滤(用户令 2026-10-21):receiverSection 在场时段不符
    /// 声明一律不进打分——同 owner 双段同名方法,base 请求只留 base 段,
    /// cell 请求只留 cell 段。
    #[test]
    fn section_gate_hard_filters_before_scoring() {
        let (_registry, engine) = build();
        let py = py_path("base", "Avatar");
        let face = engine
            .signature_help(&py, "onRpc", Some("BaseMethods"))
            .expect("base 段命中");
        assert_eq!(face.definition.section, "BaseMethods");
        assert_eq!(face.parameters, vec!["arg1: int", "arg2: str"]);
        let face = engine
            .signature_help(&py, "onRpc", Some("CellMethods"))
            .expect("cell 段命中");
        assert_eq!(face.definition.section, "CellMethods");
        assert_eq!(face.parameters, vec!["arg1: int"]);
    }

    /// 段缺省不设闸:调用方目录段经打分 +20 自然偏置(cell 声明在收集序
    /// 更前,base 偏置仍选中 base 段——证明是打分不是收集序)。
    #[test]
    fn caller_section_bias_without_receiver_gate() {
        let (_registry, engine) = build();
        let py = py_path("base", "Avatar");
        let face = engine
            .signature_help(&py, "onRpc", None)
            .expect("无段请求命中");
        assert_eq!(face.definition.section, "BaseMethods");
    }

    /// 本域隔离:跨 root 同名实体声明不进本域候选(owner 闭包域只含本
    /// root 继承链)。
    #[test]
    fn local_scope_excludes_cross_root_same_name_decl() {
        let (_registry, engine) = build();
        let py = py_path("base", "Avatar");
        let face = engine
            .signature_help(&py, "onRpc", Some("BaseMethods"))
            .expect("本域命中");
        assert_eq!(
            face.definition.file, "/proj-a/scripts/entity_defs/Avatar.def",
            "跨 root 同名实体声明不进本域候选"
        );
    }

    /// 继承链闭包:接口声明折入本域(实体 <Interfaces> → interfaces/ROLE.def
    /// 的 BaseMethods 声明可解析)。
    #[test]
    fn interface_closure_decl_resolves_locally() {
        let (_registry, engine) = build();
        let py = py_path("base", "AvatarIface");
        let face = engine
            .signature_help(&py, "onRoleRpc", Some("BaseMethods"))
            .expect("接口闭包命中");
        assert_eq!(
            face.definition.file,
            "/proj-a/scripts/entity_defs/interfaces/ROLE.def"
        );
        assert_eq!(face.parameters, vec!["arg1: int"]);
    }

    /// 回退闸第一臂:接口文件但无段(TS allowCrossDefFallback 需要
    /// !!section)→ 本域 miss 后不回退,如实 None(onRpc 声明在 Avatar.def,
    /// 不在 ROLE 闭包内)。
    #[test]
    fn interface_python_without_section_never_falls_back() {
        let (_registry, engine) = build();
        let py = "/proj-a/scripts/interfaces/ROLE.py";
        assert!(engine.signature_help(py, "onRpc", None).is_none());
    }

    /// 回退闸第二臂:接口文件 + 段在场 + owner def 不在语料 → 全语料回退
    /// 命中(GHOST.def 缺失,回退到本域外 Avatar.def 声明)。
    #[test]
    fn interface_owner_def_missing_falls_back_globally() {
        let (_registry, engine) = build();
        let py = "/proj-a/scripts/base/interfaces/GHOST.py";
        let face = engine
            .signature_help(py, "onRpc", Some("BaseMethods"))
            .expect("跨 def 回退命中");
        assert_eq!(
            face.definition.file,
            "/proj-a/scripts/entity_defs/Avatar.def"
        );
        assert_eq!(face.definition.section, "BaseMethods");
    }

    /// 正向锚:接口文件 + 段在场 + owner def 在语料(ROLE.def)→ 本域
    /// 自命中,不属回退臂(与回退臂分界清楚)。
    #[test]
    fn interface_python_with_own_def_resolves_locally() {
        let (_registry, engine) = build();
        let py = "/proj-a/scripts/base/interfaces/ROLE.py";
        let face = engine
            .signature_help(py, "onRoleRpc", Some("BaseMethods"))
            .expect("接口文件本域命中");
        assert_eq!(
            face.definition.file,
            "/proj-a/scripts/entity_defs/interfaces/ROLE.def"
        );
    }

    /// resolve 级:同分候选按规范化 def 路径字典序破平(两 root 同名实体
    /// 同段同名,打分同 50,路径 /proj-a < /proj-b)。
    #[test]
    fn tie_break_normalized_path_then_line() {
        let (_registry, engine) = build();
        let candidates = engine.method_def_candidates();
        let py = "/other/anonymous.py";
        let picked = resolve_method_definition(&candidates, py, "onRpc", Some("BaseMethods"))
            .expect("平分取路径序首");
        assert_eq!(
            picked.def_file, "/proj-a/scripts/entity_defs/Avatar.def",
            "同分按规范化路径字典序,proj-a 先"
        );
    }

    /// 行号破平:同文件同段重复声明(语料允许重复 tag),路径同分按行号。
    #[test]
    fn tie_break_line_within_same_file() {
        let candidate = |line: u32| MethodDefCandidate {
            def_file: "/p/entity_defs/Avatar.def".into(),
            line,
            section: "BaseMethods",
            exposed: false,
            owner_kind: "entity",
            owner_name: "Avatar".into(),
            symbol_name: "onRpc".into(),
            declared_args: vec![],
        };
        let candidates = vec![candidate(9), candidate(3)];
        let picked =
            resolve_method_definition(&candidates, "/p/base/Avatar.py", "onRpc", None).unwrap();
        assert_eq!(picked.line, 3);
    }

    /// owner 归属打分:ownerKind/ownerName 双中压过目录段中(同方法声明在
    /// 他人 def,Aut olar.py 请求选中本名 def 而非段一致的他人声明)。
    #[test]
    fn owner_match_beats_section_only_match() {
        let candidates = vec![
            MethodDefCandidate {
                def_file: "/p/entity_defs/Monster.def".into(),
                line: 2,
                section: "BaseMethods",
                exposed: false,
                owner_kind: "entity",
                owner_name: "Monster".into(),
                symbol_name: "onRpc".into(),
                declared_args: vec![],
            },
            MethodDefCandidate {
                def_file: "/p/entity_defs/Avatar.def".into(),
                line: 7,
                section: "CellMethods",
                exposed: false,
                owner_kind: "entity",
                owner_name: "Avatar".into(),
                symbol_name: "onRpc".into(),
                declared_args: vec![],
            },
        ];
        // 无接收者段闸(段缺省):Monster 有 callerSection +20,Avatar 有
        // ownerName +40——owner 归属赢。
        let picked =
            resolve_method_definition(&candidates, "/p/base/Avatar.py", "onRpc", None).unwrap();
        assert_eq!(picked.owner_name, "Avatar");
    }

    /// activeParameter 夹取:超界夹到末形参;零形参恒 0。
    #[test]
    fn active_parameter_clamps() {
        assert_eq!(clamp_active_parameter(0, 2), 0);
        assert_eq!(clamp_active_parameter(5, 2), 1);
        assert_eq!(clamp_active_parameter(3, 0), 0);
    }

    /// 组装面:Exposed 尾注 + 接收者段注记逐字节;零形参 label 收口。
    #[test]
    fn documentation_composition_matches_ts_fragments() {
        let (_registry, engine) = build();
        let py = py_path("base", "Avatar");
        let face = engine
            .signature_help(&py, "onExposed", Some("BaseMethods"))
            .expect("命中");
        assert_eq!(
            face.documentation,
            "此调用是实体 def 声明的 BaseMethods 方法(接收者 self.BaseMethods) · **Exposed**: 可被客户端远程调用"
        );
        assert_eq!(face.label, "def onExposed(self)");
    }

    /// 形参注解边界:内建命中造型(arg1: int);链断/未知只出名不显 Any
    /// (TS 三提示面同口径);空类型文本只出名;label 拼接。
    #[test]
    fn parameter_annotation_boundaries() {
        assert_eq!(format_def_method_parameter("UINT32", 0), "arg1: int");
        assert_eq!(format_def_method_parameter("STRING", 0), "arg1: str");
        assert_eq!(format_def_method_parameter("NOT_A_TYPE", 0), "arg1");
        assert_eq!(format_def_method_parameter("", 1), "arg2");
        assert_eq!(format_def_method_parameter("  ", 0), "arg1");
        assert_eq!(
            format_def_method_signature("onRpc", &["arg1: int".into()]),
            "def onRpc(self, arg1: int)"
        );
        assert_eq!(format_def_method_signature("onRpc", &[]), "def onRpc(self)");
    }

    /// RUST-149 横切(root 维度):撤根扇出后候选摘除,解析如实 miss,
    /// 不虚报跨 root 残影。
    #[test]
    fn root_removal_drops_resolution() {
        let (registry, mut engine) = build();
        let py = py_path("base", "Avatar");
        assert!(engine
            .signature_help(&py, "onRpc", Some("BaseMethods"))
            .is_some());
        engine.invalidate_root(registry.root_for(&CanonicalUri::from_path("/proj-a/x.def")));
        assert!(
            engine
                .signature_help(&py, "onRpc", Some("BaseMethods"))
                .is_none(),
            "撤根后本域声明消失,解析如实 miss"
        );
    }

    /// RUST-149 横切(stale 面替位钉):同路径 def 换代即换签名,零陈旧
    /// 驻留;stale/cancel/cold 对本面 N-A——同步纯函数零 await/RPC,见模块
    /// 头注记。
    #[test]
    fn def_update_swaps_signature_same_path() {
        let (registry, mut engine) = build();
        let py = py_path("base", "Avatar");
        let before = engine
            .signature_help(&py, "onRpc", Some("BaseMethods"))
            .expect("初版命中");
        assert_eq!(before.parameters, vec!["arg1: int", "arg2: str"]);
        let updated = "<root>\n  <BaseMethods>\n    <onRpc>\n      <Arg> STRING </Arg>\n    </onRpc>\n  </BaseMethods>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def"),
            updated,
        );
        let after = engine
            .signature_help(&py, "onRpc", Some("BaseMethods"))
            .expect("换代命中");
        assert_eq!(after.parameters, vec!["arg1: str"]);
    }
}
