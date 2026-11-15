//! KSEM-ROOTS(RUST-111,旧 SEM-009)多 root 同名消解(纯库面,无 RPC/
//! 无 TS 消费)。
//!
//! 引擎真源:KBEngine 每进程只装**一个** assets root,引擎不合并多 root;
//! 多 root 查找顺序是 **IDE 约定**(VS Code 多根工作区文件夹序),由消费方
//! 按 `add_root` 显式供给——本模块只按序消解并产出歧义事实,**不把顺序
//! 说成引擎语义**。名称空间按 [`NameKind`] 三类隔离:同名实体(root-a)与
//! 同名类型(root-b)互不歧义。
//!
//! 消解语义:`resolve` 恒按显式优先序取**最高优先 root** 的命中为 winner,
//! 其余命中 = `shadowed`(歧义事实,供消费方发 diagnostics;消解本身确定
//! 性——「歧义」不改变 winner)。`ambiguities()` 枚举全表 ≥2 root 命中的
//! (kind,name),单命中/无名不产事实。
//!
//! 边界:同 root 内重复定义检测归 RUST-112(独立面)——本模块按
//! (root, kind, name) 唯一键存储,同键重喂 = 替换(文件更新语义),不做
//! 同 root 重复检测。多 root 下 RUST-105/RUST-110 各面的先到先得登记保持
//! 不变,消费方应先用本面消解出 winner 再喂那些面。

use std::collections::BTreeMap;

/// 名称空间类别(实体/组件/类型;跨类别同名不互歧义)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NameKind {
    Entity,
    Component,
    Type,
}

impl NameKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NameKind::Entity => "entity",
            NameKind::Component => "component",
            NameKind::Type => "type",
        }
    }
}

/// 单个 root 内的一条名称登记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootEntry {
    pub root: String,
    pub kind: NameKind,
    pub name: String,
    /// 声明文件(root 相对或绝对路径,消费方口径原样)。
    pub file: String,
    /// 声明行(来源口径原样;无行位如实体名来自文件名正文 = `None`)。
    pub line: Option<usize>,
}

/// 显式优先序多 root 名称登记表。root 序 = `add_root` 供给序(0 最高);
/// 同 root 重加 = 移到队尾(重排序信号)。名称表迭代序 = BTreeMap 键序,
/// 确定性。
#[derive(Debug, Default)]
pub struct MultiRootRegistry {
    roots: Vec<String>,
    entries: BTreeMap<(NameKind, String), Vec<RootEntry>>,
}

/// 逐 kind 消解结果:winner = 最高优先 root 命中(缺 = `None`,查无);
/// shadowed = 其余命中(歧义事实)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameResolution {
    pub winner: Option<RootEntry>,
    pub shadowed: Vec<RootEntry>,
}

/// 跨 root 同名歧义事实(≥2 root 命中;winner = 显式序最高优先,不因
/// 「歧义」改变——消解决定性)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguityFact {
    pub kind: NameKind,
    pub name: String,
    pub winner: RootEntry,
    pub shadowed: Vec<RootEntry>,
}

impl MultiRootRegistry {
    /// 登记一个 root(显式优先序;重加同名 root = 移到队尾,消费方重排)。
    pub fn add_root(&mut self, root: &str) {
        self.roots.retain(|r| r != root);
        self.roots.push(root.to_string());
    }

    /// 登记名称(按 (root, kind, name) 唯一键;同键重喂 = 替换)。root 未
    /// `add_root` 也接受(显式序外 root = 最低优先,按到达序垫底)。
    pub fn register(
        &mut self,
        root: &str,
        kind: NameKind,
        name: &str,
        file: &str,
        line: Option<usize>,
    ) {
        if !self.roots.iter().any(|r| r == root) {
            self.roots.push(root.to_string());
        }
        let bucket = self.entries.entry((kind, name.to_string())).or_default();
        let entry = RootEntry {
            root: root.to_string(),
            kind,
            name: name.to_string(),
            file: file.to_string(),
            line,
        };
        match bucket.iter_mut().find(|e| e.root == root) {
            Some(slot) => *slot = entry,
            None => bucket.push(entry),
        }
    }

    fn priority(&self, root: &str) -> usize {
        self.roots
            .iter()
            .position(|r| r == root)
            .unwrap_or(usize::MAX)
    }

    /// 逐 kind 消解:按显式优先序取最高优先 root 命中,其余入 `shadowed`。
    pub fn resolve(&self, kind: NameKind, name: &str) -> NameResolution {
        let mut hits: Vec<&RootEntry> = self
            .entries
            .get(&(kind, name.to_string()))
            .map(|b| b.iter().collect())
            .unwrap_or_default();
        hits.sort_by_key(|e| self.priority(&e.root));
        match hits.split_first() {
            None => NameResolution {
                winner: None,
                shadowed: Vec::new(),
            },
            Some((first, rest)) => NameResolution {
                winner: Some((*first).clone()),
                shadowed: rest.iter().map(|e| (*e).clone()).collect(),
            },
        }
    }

    /// 歧义事实枚举(≥2 root 命中的全部 (kind,name);BTreeMap 键序确定)。
    pub fn ambiguities(&self) -> Vec<AmbiguityFact> {
        self.entries
            .iter()
            .filter(|(_, b)| b.len() > 1)
            .map(|((kind, name), _)| {
                let r = self.resolve(*kind, name);
                AmbiguityFact {
                    kind: *kind,
                    name: name.clone(),
                    winner: r.winner.expect("len>1 必有 winner"),
                    shadowed: r.shadowed,
                }
            })
            .collect()
    }

    /// 显式 root 序(0 最高;只读)。
    pub fn root_order(&self) -> &[String] {
        &self.roots
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_order_wins_and_shadowed_recorded() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.add_root("root-b");
        reg.register(
            "root-b",
            NameKind::Entity,
            "Avatar",
            "b/Avatar.def",
            Some(1),
        );
        reg.register(
            "root-a",
            NameKind::Entity,
            "Avatar",
            "a/Avatar.def",
            Some(3),
        );
        let r = reg.resolve(NameKind::Entity, "Avatar");
        let w = r.winner.expect("命中");
        assert_eq!(w.root, "root-a", "显式序最高优先胜,与喂入序无关");
        assert_eq!(w.line, Some(3));
        assert_eq!(r.shadowed.len(), 1);
        assert_eq!(r.shadowed[0].root, "root-b");
    }

    #[test]
    fn reorder_via_add_root_flips_winner_deterministically() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.add_root("root-b");
        reg.register("root-a", NameKind::Type, "ITEM_ID", "a/types.xml", None);
        reg.register("root-b", NameKind::Type, "ITEM_ID", "b/types.xml", None);
        assert_eq!(
            reg.resolve(NameKind::Type, "ITEM_ID")
                .winner
                .as_ref()
                .unwrap()
                .root,
            "root-a"
        );
        reg.add_root("root-a"); // 重加 = 移到队尾(重排序信号)
        assert_eq!(reg.root_order(), ["root-b", "root-a"]);
        assert_eq!(
            reg.resolve(NameKind::Type, "ITEM_ID")
                .winner
                .as_ref()
                .unwrap()
                .root,
            "root-b"
        );
    }

    #[test]
    fn kinds_are_isolated_namespaces() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.add_root("root-b");
        reg.register("root-a", NameKind::Entity, "Item", "a/Item.def", Some(1));
        reg.register("root-b", NameKind::Type, "Item", "b/types.xml", None);
        let e = reg.resolve(NameKind::Entity, "Item");
        assert_eq!(e.winner.as_ref().unwrap().root, "root-a");
        assert!(e.shadowed.is_empty(), "跨类别同名不互歧义");
        let t = reg.resolve(NameKind::Type, "Item");
        assert_eq!(t.winner.as_ref().unwrap().root, "root-b");
        assert!(t.shadowed.is_empty());
        assert!(reg.ambiguities().is_empty());
    }

    #[test]
    fn unknown_name_resolves_to_none_without_facts() {
        let reg = MultiRootRegistry::default();
        let r = reg.resolve(NameKind::Entity, "Ghost");
        assert!(r.winner.is_none());
        assert!(r.shadowed.is_empty());
        assert!(reg.ambiguities().is_empty());
    }

    #[test]
    fn ambiguities_enumerate_all_multi_root_hits() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.add_root("root-b");
        reg.add_root("root-c");
        reg.register("root-a", NameKind::Component, "Bag", "a/Bag.def", Some(2));
        reg.register("root-c", NameKind::Component, "Bag", "c/Bag.def", None);
        reg.register("root-b", NameKind::Component, "Bag", "b/Bag.def", Some(7));
        reg.register("root-a", NameKind::Entity, "Solo", "a/Solo.def", None);
        let facts = reg.ambiguities();
        assert_eq!(facts.len(), 1, "单命中(Solo)不产事实");
        let f = &facts[0];
        assert_eq!(f.kind, NameKind::Component);
        assert_eq!(f.name, "Bag");
        assert_eq!(f.winner.root, "root-a");
        // shadowed = 显式序次序(root-b 先于 root-c)
        let roots: Vec<&str> = f.shadowed.iter().map(|e| e.root.as_str()).collect();
        assert_eq!(roots, ["root-b", "root-c"]);
        assert_eq!(f.shadowed[0].line, Some(7));
    }

    #[test]
    fn same_key_refeed_replaces_within_root() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.register(
            "root-a",
            NameKind::Entity,
            "Avatar",
            "a/old/Avatar.def",
            Some(9),
        );
        reg.register(
            "root-a",
            NameKind::Entity,
            "Avatar",
            "a/new/Avatar.def",
            Some(4),
        );
        let r = reg.resolve(NameKind::Entity, "Avatar");
        assert_eq!(
            r.winner.as_ref().unwrap().file,
            "a/new/Avatar.def",
            "同键重喂=替换"
        );
        assert!(r.shadowed.is_empty(), "同 root 不产歧义(RUST-112 另面)");
    }

    #[test]
    fn unregistered_root_lands_lowest_priority() {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.register("root-a", NameKind::Type, "T", "a/types.xml", None);
        reg.register("late-root", NameKind::Type, "T", "x/types.xml", None);
        let r = reg.resolve(NameKind::Type, "T");
        assert_eq!(
            r.winner.as_ref().unwrap().root,
            "root-a",
            "显式序内 root 胜过序外"
        );
        assert_eq!(r.shadowed[0].root, "late-root");
    }
}
