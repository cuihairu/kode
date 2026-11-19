//! KSEM-NAV(RUST-110,旧 SEM-008)实体跨语言可逆导航链(纯库面,无 RPC/
//! 无 TS 消费)。
//!
//! 三腿链:entities.xml 注册位 → `.def` 声明位 → Python 实现位。Python 腿
//! 按 KBEngine 标准布局从文件路径推断:根件 `<assets>/scripts/<Entity>.py`,
//! 段件 `<assets>/scripts/{base,cell,client}/<Entity>.py`(TS
//! defPythonParity 同口径);段目录只有 base/cell/client 三个(引擎只装这三
//! 段),其余目录不产腿。可逆 = Python 文件 → 实体(文件名去 `.py` 即实体
//! 名,与实体同名的顶层类是引擎脚本绑定要求)→ def → 注册位。
//!
//! 诚实边界:
//! - 类缺失(文件在、同名顶层类不在)→ 腿在、类位 `None`,不造行号;
//! - 未注册也未声明 def 的实体名脚本不喂入(`FeedOutcome::Ignored` 带因),
//!   不产幽灵条目——Python 腿喂入要求实体已在册(先喂 entities.xml/def
//!   语料再喂 Python,是资产语料的自然序);
//! - 多 root 同名歧义归 RUST-111:注册位先到先得(RUST-105
//!   entity_registrations 同口径),本模块不判歧义;
//! - 行号双口径如实:注册位 = parser 1 基,类位 = kode-python AST 0 基
//!   (仓内 Python 面口径),逐字段注释钉死,本模块不换算。
//!
//! 更新语义:同名实体注册先到先得;`declare_def` / `feed_python` 同键重喂 =
//! 替换(文件更新语义);`remove_python_file` 对称清理反向映射(删除后
//! `reverse_from_file` 即 `None`)。

use std::collections::BTreeMap;

use kode_parser::model::EntityEntry;

use super::id::Facet;

/// Python 实现腿别。`BTreeMap` 键序 = 枚举声明序(Root < Base < Cell <
/// Client),`python` 腿集合迭代序确定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PyFacet {
    /// `scripts/<Entity>.py` 根件(实体主类)。
    Root,
    /// `scripts/base/<Entity>.py` 段件。
    Base,
    /// `scripts/cell/<Entity>.py` 段件。
    Cell,
    /// `scripts/client/<Entity>.py` 段件。
    Client,
}

impl PyFacet {
    pub fn as_str(&self) -> &'static str {
        match self {
            PyFacet::Root => "root",
            PyFacet::Base => "base",
            PyFacet::Cell => "cell",
            PyFacet::Client => "client",
        }
    }
}

/// entities.xml 注册位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationSite {
    pub file: String,
    /// 条目行(parser 1 基)。
    pub line: usize,
    /// 条目属性事实(文档序,原样不解析)。
    pub attributes: Vec<(String, String)>,
}

impl RegistrationSite {
    /// `hasBase` / `hasCell` / `hasClient` 布尔读取:缺属性 = `None`;值
    /// `true` / `1`(大小写不敏感)= true,其余 = false(TS 向导按 boolean
    /// 字符串化写 `"true"` / `"false"`,官方模板同)。
    pub fn flag(&self, name: &str) -> Option<bool> {
        self.attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.eq_ignore_ascii_case("true") || v == "1")
    }
}

/// Python 实现腿(单文件;每实体每腿至多一个文件 = 标准布局唯一路径)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyImplSite {
    pub file: String,
    pub facet: PyFacet,
    /// 与实体同名的顶层类起始行(kode-python AST 0 基原样;类缺失 =
    /// `None`,不造行号)。
    pub class_line: Option<usize>,
    /// 类结束行(不含,AST 原样;类缺失 = `None`)。
    pub class_end_line: Option<usize>,
    /// 该类基类名(AST 原样事实;本模块不校验基类语义)。
    pub bases: Vec<String>,
}

/// 单实体导航链(三腿各自独立 Optional,缺哪腿如实 `None`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityNavEntry {
    pub entity: String,
    pub registration: Option<RegistrationSite>,
    pub def_file: Option<String>,
    /// def 段事实(消费方喂入,登记序;空段是否计段由消费方口径定)。
    pub def_facets: Vec<Facet>,
    pub python: BTreeMap<PyFacet, PyImplSite>,
}

/// `feed_python` 忽略原因(不喂入、不产条目)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedIgnoreReason {
    /// 不在 scripts 标准布局(见 [`script_layout`])。
    NotScriptLayout,
    /// 布局推断出的实体名未注册也未声明 def。
    EntityNotRegistered,
}

/// `feed_python` 结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedOutcome {
    Fed {
        entity: String,
        facet: PyFacet,
        /// 类位(`None` = 类缺失,腿照登)。
        class_line: Option<usize>,
    },
    Ignored(FeedIgnoreReason),
}

/// KBEngine 标准脚本布局推断:路径(含 `\` / `/` 混用)含 `scripts` 段,
/// 其后一段为 `base` / `cell` / `client` → 段腿(再后一段须是
/// `<Entity>.py` 文件),否则该段即 `<Entity>.py` → 根腿。其余(无
/// `scripts` 段 / 非标准子目录 / 非 `.py` / 空名)一律 `None`。
pub fn script_layout(py_path: &str) -> Option<(PyFacet, String)> {
    let comps: Vec<&str> = py_path
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .collect();
    let scripts = comps.iter().position(|c| *c == "scripts")?;
    let rest = &comps[scripts + 1..];
    let (facet, name) = match rest.first().copied() {
        Some("base") => (PyFacet::Base, rest.get(1).copied()),
        Some("cell") => (PyFacet::Cell, rest.get(1).copied()),
        Some("client") => (PyFacet::Client, rest.get(1).copied()),
        Some(name) => (PyFacet::Root, Some(name)),
        None => return None,
    };
    let entity = name?.strip_suffix(".py")?;
    if entity.is_empty() {
        return None;
    }
    Some((facet, entity.to_string()))
}

/// 导航索引。反向映射(`by_py_file`)与正向腿集合同步维护,不外泄内部
/// 结构;查询走 [`EntityNavIndex::forward`] / [`EntityNavIndex::reverse_from_file`]。
#[derive(Debug, Default)]
pub struct EntityNavIndex {
    entries: BTreeMap<String, EntityNavEntry>,
    by_py_file: BTreeMap<String, String>,
}

impl EntityNavIndex {
    /// 登记 entities.xml 注册位。同名实体先到先得(RUST-111 歧义另账),
    /// 后到条目不覆盖。
    pub fn register_entity(&mut self, file: &str, entry: &EntityEntry) {
        let site = RegistrationSite {
            file: file.to_string(),
            line: entry.line,
            attributes: entry.attributes.clone(),
        };
        let e = self
            .entries
            .entry(entry.name.clone())
            .or_insert_with(|| EntityNavEntry {
                entity: entry.name.clone(),
                registration: None,
                def_file: None,
                def_facets: Vec::new(),
                python: BTreeMap::new(),
            });
        if e.registration.is_none() {
            e.registration = Some(site);
        }
    }

    /// 登记 def 声明位(实体名 = def 文件名去 `.def`,消费方映射)。同实体
    /// 重喂 = 替换。仅声明 def(未注册)也算在册——Python 腿可挂。
    pub fn declare_def(&mut self, entity: &str, def_file: &str, facets: &[Facet]) {
        let e = self.entry_or_blank(entity);
        e.def_file = Some(def_file.to_string());
        e.def_facets = facets.to_vec();
    }

    /// 喂入一个 Python 文件(布局推断腿别 + 实体名;同名顶层类事实直取
    /// kode-python AST,0 基原样)。同路径重喂 = 替换。返回
    /// [`FeedOutcome`]——忽略时**不产任何条目**。
    pub fn feed_python(
        &mut self,
        py_file: &str,
        symbols: &kode_python::model::AstSymbols,
    ) -> FeedOutcome {
        let Some((facet, entity)) = script_layout(py_file) else {
            return FeedOutcome::Ignored(FeedIgnoreReason::NotScriptLayout);
        };
        if !self.entries.contains_key(&entity) {
            return FeedOutcome::Ignored(FeedIgnoreReason::EntityNotRegistered);
        }
        let cls = symbols
            .classes
            .iter()
            .find(|c| c.qualified_name == entity)
            .cloned();
        let class_line = cls.as_ref().map(|c| c.start_line);
        let site = PyImplSite {
            file: py_file.to_string(),
            facet,
            class_line,
            class_end_line: cls.as_ref().map(|c| c.end_line),
            bases: cls.map(|c| c.bases).unwrap_or_default(),
        };
        self.entry_or_blank(&entity).python.insert(facet, site);
        self.by_py_file.insert(py_file.to_string(), entity.clone());
        FeedOutcome::Fed {
            entity,
            facet,
            class_line,
        }
    }

    /// 摘除一个 Python 文件(删除对称:腿与反向映射同清)。返回是否确有
    /// 摘除。
    pub fn remove_python_file(&mut self, py_file: &str) -> bool {
        let Some(entity) = self.by_py_file.remove(py_file) else {
            return false;
        };
        let Some((facet, _)) = script_layout(py_file) else {
            return false;
        };
        self.entries
            .get_mut(&entity)
            .map(|e| e.python.remove(&facet).is_some())
            .unwrap_or(false)
    }

    /// 正向:实体名 → 导航链。
    pub fn forward(&self, entity: &str) -> Option<&EntityNavEntry> {
        self.entries.get(entity)
    }

    /// 反向:Python 文件 → 实体导航链(反向映射查无 = `None`)。
    pub fn reverse_from_file(&self, py_file: &str) -> Option<&EntityNavEntry> {
        let entity = self.by_py_file.get(py_file)?;
        self.forward(entity)
    }

    fn entry_or_blank(&mut self, entity: &str) -> &mut EntityNavEntry {
        self.entries
            .entry(entity.to_string())
            .or_insert_with(|| EntityNavEntry {
                entity: entity.to_string(),
                registration: None,
                def_file: None,
                def_facets: Vec::new(),
                python: BTreeMap::new(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn py(source: &str) -> kode_python::model::AstSymbols {
        kode_python::symbols::extract(&kode_python::parse::ParsedAst::new(source))
    }

    fn avatar_index() -> EntityNavIndex {
        let mut idx = EntityNavIndex::default();
        let ents = kode_parser::model::parse_entities(
            "<root>\n <Avatar hasBase=\"true\" hasCell=\"true\" hasClient=\"true\"/>\n</root>",
        );
        idx.register_entity("assets/scripts/entities.xml", &ents.entities[0]);
        idx.declare_def(
            "Avatar",
            "assets/scripts/entity_defs/Avatar.def",
            &[Facet::Base, Facet::Cell, Facet::Client],
        );
        idx
    }

    #[test]
    fn full_chain_forward_legs_in_deterministic_order() {
        let mut idx = avatar_index();
        assert!(matches!(
            idx.feed_python(
                "assets/scripts/Avatar.py",
                &py("class Avatar(Base):\n  pass\n")
            ),
            FeedOutcome::Fed { .. }
        ));
        assert!(matches!(
            idx.feed_python(
                "assets/scripts/base/Avatar.py",
                &py("class Avatar(AvatarBase):\n  def onJump(self):\n    pass\n")
            ),
            FeedOutcome::Fed { .. }
        ));
        idx.feed_python(
            "assets/scripts/cell/Avatar.py",
            &py("class Avatar(CellBase):\n  pass\n"),
        );
        idx.feed_python(
            "assets/scripts/client/Avatar.py",
            &py("class Avatar(ClientBase):\n  pass\n"),
        );

        let entry = idx.forward("Avatar").expect("在册");
        let reg = entry.registration.as_ref().expect("注册位");
        assert_eq!(reg.file, "assets/scripts/entities.xml");
        assert_eq!(reg.line, 2, "parser 1 基");
        assert_eq!(reg.flag("hasBase"), Some(true));
        assert_eq!(reg.flag("hasCell"), Some(true));
        assert_eq!(
            entry.def_file.as_deref(),
            Some("assets/scripts/entity_defs/Avatar.def")
        );
        let keys: Vec<PyFacet> = entry.python.keys().copied().collect();
        assert_eq!(
            keys,
            [PyFacet::Root, PyFacet::Base, PyFacet::Cell, PyFacet::Client]
        );
        assert_eq!(
            entry.python[&PyFacet::Root].class_line,
            Some(0),
            "AST 0 基原样"
        );
        assert_eq!(entry.python[&PyFacet::Base].bases, ["AvatarBase"]);
    }

    #[test]
    fn script_layout_inference_table() {
        assert_eq!(
            script_layout("a/scripts/Avatar.py"),
            Some((PyFacet::Root, "Avatar".into()))
        );
        assert_eq!(
            script_layout("a\\scripts\\base\\Avatar.py"),
            Some((PyFacet::Base, "Avatar".into()))
        );
        assert_eq!(
            script_layout("/x/scripts/cell/Monster.py"),
            Some((PyFacet::Cell, "Monster".into()))
        );
        assert_eq!(
            script_layout("x/scripts/client/Spaces.py"),
            Some((PyFacet::Client, "Spaces".into()))
        );
        assert_eq!(script_layout("src/Avatar.py"), None, "无 scripts 段");
        assert_eq!(script_layout("scripts/"), None);
        assert_eq!(script_layout("scripts/Avatar.ts"), None, "非 .py");
        assert_eq!(
            script_layout("scripts/base/sub/Avatar.py"),
            None,
            "段下多一层非标准"
        );
        assert_eq!(script_layout("scripts/.py"), None, "空实体名");
    }

    #[test]
    fn unregistered_entity_script_is_ignored_without_phantom_entry() {
        let mut idx = EntityNavIndex::default();
        assert_eq!(
            idx.feed_python("scripts/Ghost.py", &py("class Ghost:\n  pass\n")),
            FeedOutcome::Ignored(FeedIgnoreReason::EntityNotRegistered)
        );
        assert!(idx.forward("Ghost").is_none(), "不产幽灵条目");
        // 仅声明 def(未注册)也算在册:Python 腿可挂。
        idx.declare_def("Only", "a/Only.def", &[]);
        assert!(matches!(
            idx.feed_python("scripts/Only.py", &py("class Only:\n  pass\n")),
            FeedOutcome::Fed { .. }
        ));
    }

    #[test]
    fn non_standard_layout_is_ignored() {
        let mut idx = avatar_index();
        assert_eq!(
            idx.feed_python("scripts/common/Helper.py", &py("class Helper:\n  pass\n")),
            FeedOutcome::Ignored(FeedIgnoreReason::NotScriptLayout)
        );
        assert!(idx.forward("Avatar").unwrap().python.is_empty());
    }

    #[test]
    fn class_missing_keeps_leg_with_honest_none_site() {
        let mut idx = avatar_index();
        assert_eq!(
            idx.feed_python("scripts/Avatar.py", &py("import kbengine\n\nx = 1\n")),
            FeedOutcome::Fed {
                entity: "Avatar".into(),
                facet: PyFacet::Root,
                class_line: None
            }
        );
        let leg = &idx.forward("Avatar").unwrap().python[&PyFacet::Root];
        assert_eq!(leg.class_line, None, "类缺失不造行号");
        assert_eq!(leg.class_end_line, None);
        assert!(leg.bases.is_empty());
    }

    #[test]
    fn reverse_navigation_and_symmetric_removal() {
        let mut idx = avatar_index();
        idx.feed_python("scripts/Avatar.py", &py("class Avatar:\n  pass\n"));
        assert_eq!(
            idx.reverse_from_file("scripts/Avatar.py")
                .map(|e| e.entity.as_str()),
            Some("Avatar")
        );
        assert!(idx.remove_python_file("scripts/Avatar.py"));
        assert!(idx.reverse_from_file("scripts/Avatar.py").is_none());
        assert!(idx.forward("Avatar").unwrap().python.is_empty(), "腿同清");
        assert!(
            !idx.remove_python_file("scripts/Avatar.py"),
            "重复删 = false"
        );
        assert!(!idx.remove_python_file("scripts/Untracked.py"));
    }

    #[test]
    fn registration_first_wins_rust_111_deferred() {
        let mut idx = EntityNavIndex::default();
        let a = kode_parser::model::parse_entities("<root>\n <Avatar/>\n</root>");
        idx.register_entity("root-a/scripts/entities.xml", &a.entities[0]);
        let b = kode_parser::model::parse_entities("<root>\n\n\n\n <Avatar/>\n</root>");
        idx.register_entity("root-b/scripts/entities.xml", &b.entities[0]);
        let reg = idx
            .forward("Avatar")
            .unwrap()
            .registration
            .as_ref()
            .unwrap();
        assert_eq!(reg.file, "root-a/scripts/entities.xml", "先到先得");
        assert_eq!(reg.line, 2);
    }

    #[test]
    fn refed_python_file_replaces_leg_without_duplicate() {
        let mut idx = avatar_index();
        idx.feed_python("scripts/Avatar.py", &py("class Avatar:\n  pass\n"));
        idx.feed_python("scripts/Avatar.py", &py("import kbengine\n"));
        let entry = idx.forward("Avatar").unwrap();
        assert_eq!(entry.python.len(), 1, "同腿重喂 = 替换不叠加");
        assert_eq!(entry.python[&PyFacet::Root].class_line, None);
    }

    #[test]
    fn flag_accessor_truthy_table() {
        let site = RegistrationSite {
            file: "entities.xml".into(),
            line: 1,
            attributes: vec![
                ("hasBase".into(), "true".into()),
                ("hasCell".into(), "1".into()),
                ("hasClient".into(), "false".into()),
                ("custom".into(), "yes".into()),
            ],
        };
        assert_eq!(site.flag("hasBase"), Some(true));
        assert_eq!(site.flag("hasCell"), Some(true));
        assert_eq!(site.flag("hasClient"), Some(false));
        assert_eq!(site.flag("custom"), Some(false), "非 true/1 = false");
        assert_eq!(site.flag("hasGhost"), None, "缺属性 = None");
    }
}
