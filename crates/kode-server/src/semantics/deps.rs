//! BAS-09 增量依赖边。
//!
//! 记录 **producer → consumers 反向依赖**:producer 是定义/类型/Python/配置
//! 文件,consumer 是引用它的文件。producer 变更时 [`DependencyGraph::invalidate`]
//! 只返回**相关项**(直接消费者;级联经 [`invalidate_closure`] 有界 BFS),
//! 单文件变更不触全仓重扫。
//!
//! producer 分类由 [`producer_kind`] 按 URI 扩展名给出(def/types 定义,
//! xml/yaml/json 配置,py Python;其余 None 非 producer)——分类是调用点
//! 事实,图本身只存文档间边,不重复编码分类。
//!
//! 文档删除对称清理:消费者移除时连带其入边,producer 移除时连带其出边
//! ([`remove`]),避免悬空键残留失效误报。

use std::collections::{BTreeSet, HashMap};

use kode_vfs::store::DocumentKey;

/// producer 种类(URI 扩展名分类;其余 None)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducerKind {
    /// `.def` 实体定义。
    Def,
    /// `.types` 类型定义。
    Types,
    /// 配置文件(`.xml`/`.yaml`/`.yml`/`.json`;KBEngine 资源配置惯例)。
    Config,
    /// `.py` Python 源码。
    Python,
}

/// 按 URI 扩展名分类 producer(调用点事实;图不重复编码)。
pub fn producer_kind(key: &DocumentKey) -> Option<ProducerKind> {
    let b = key.uri.basename();
    match b.rsplit_once('.') {
        Some((_, "def")) => Some(ProducerKind::Def),
        Some((_, "types")) => Some(ProducerKind::Types),
        Some((_, "xml")) | Some((_, "yaml")) | Some((_, "yml")) | Some((_, "json")) => Some(ProducerKind::Config),
        Some((_, "py")) => Some(ProducerKind::Python),
        _ => None,
    }
}

/// 增量依赖图(producer → consumers 反向依赖)。
///
/// 不变量:
/// - 每条边两向记录(`reverse`/`forward` 互补),删除对称清理;
/// - 消费者集合为 `BTreeSet`(确定性序);无向重复边幂等;
/// - [`invalidate`] 只回直接消费者,级联需显式 [`invalidate_closure`]。
#[derive(Debug, Default)]
pub struct DependencyGraph {
    /// producer → 消费者集合(反向依赖)。
    reverse: HashMap<DocumentKey, BTreeSet<DocumentKey>>,
    /// consumer → producer 集合(正向依赖;用于删除对称清理)。
    forward: HashMap<DocumentKey, BTreeSet<DocumentKey>>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记 producer → consumer 边(幂等;同边重复登记无副作用)。
    pub fn add_edge(&mut self, producer: &DocumentKey, consumer: &DocumentKey) {
        self.reverse.entry(producer.clone()).or_default().insert(consumer.clone());
        self.forward.entry(consumer.clone()).or_default().insert(producer.clone());
    }

    /// producer 的直接消费者(升序;无消费者 → 空)。
    pub fn consumers_of(&self, producer: &DocumentKey) -> Vec<DocumentKey> {
        self.reverse.get(producer).map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// consumer 的直接 producer(升序;无 → 空)。
    pub fn producers_of(&self, consumer: &DocumentKey) -> Vec<DocumentKey> {
        self.forward.get(consumer).map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// 单文件变更的失效集:直接消费者(相关项;不含 producer 自身)。
    pub fn invalidate(&self, producer: &DocumentKey) -> Vec<DocumentKey> {
        self.consumers_of(producer)
    }

    /// 级联失效(有界 BFS):producer 变更后,返回边距离 ≤ `max_hops` 的
    /// 消费链节点(直接消费者 = 距离 1;`max_hops = 0` → 空,producer 自身
    /// 不计)。结果按发现序(键升序层内,去重);环安全(visited 集)。
    pub fn invalidate_closure(&self, producer: &DocumentKey, max_hops: usize) -> Vec<DocumentKey> {
        let mut out = Vec::new();
        let mut visited: BTreeSet<DocumentKey> = BTreeSet::new();
        let mut frontier: Vec<DocumentKey> = self.consumers_of(producer);
        let mut depth = 1;
        while !frontier.is_empty() && depth <= max_hops {
            let mut next = Vec::new();
            for c in frontier {
                if visited.insert(c.clone()) {
                    out.push(c.clone());
                    next.extend(self.consumers_of(&c));
                }
            }
            frontier = next;
            depth += 1;
        }
        out
    }

    /// 删除文档:对称清理(消费者与 producer 两角色全清),返回是否确有边。
    pub fn remove(&mut self, doc: &DocumentKey) -> bool {
        let mut touched = false;
        // 作 producer:清其出边 + 从消费者入边中移除本键。
        if let Some(consumers) = self.reverse.remove(doc) {
            for c in &consumers {
                if let Some(ps) = self.forward.get_mut(c) {
                    ps.remove(doc);
                    if ps.is_empty() {
                        self.forward.remove(c);
                    }
                }
            }
            touched = true;
        }
        // 作 consumer:清其入边 + 从 producer 出边中移除本键。
        if let Some(producers) = self.forward.remove(doc) {
            for p in &producers {
                if let Some(cs) = self.reverse.get_mut(p) {
                    cs.remove(doc);
                    if cs.is_empty() {
                        self.reverse.remove(p);
                    }
                }
            }
            touched = true;
        }
        touched
    }

    /// 边总数(诊断)。
    pub fn edge_count(&self) -> usize {
        self.reverse.values().map(|s| s.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.reverse.is_empty() && self.forward.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::store::RootId;
    use kode_vfs::uri::CanonicalUri;

    fn key(uri: &str) -> DocumentKey {
        DocumentKey::new(RootId(1), CanonicalUri::from_path(uri))
    }

    #[test]
    fn producer_kind_classifies_by_extension() {
        assert_eq!(producer_kind(&key("/defs/Avatar.def")), Some(ProducerKind::Def));
        assert_eq!(producer_kind(&key("/types/Pos.types")), Some(ProducerKind::Types));
        assert_eq!(producer_kind(&key("/res/server.xml")), Some(ProducerKind::Config));
        assert_eq!(producer_kind(&key("/res/game.yml")), Some(ProducerKind::Config));
        assert_eq!(producer_kind(&key("/res/game.yaml")), Some(ProducerKind::Config));
        assert_eq!(producer_kind(&key("/res/paths.json")), Some(ProducerKind::Config));
        assert_eq!(producer_kind(&key("/scripts/avatar.py")), Some(ProducerKind::Python));
        assert_eq!(producer_kind(&key("/docs/readme.md")), None, "非 producer 无分类");
    }

    #[test]
    fn add_and_query_reverse_dependency() {
        let mut g = DependencyGraph::new();
        let def = key("/defs/Monster.def");
        let avatar = key("/defs/Avatar.def");
        let py = key("/scripts/avatar.py");
        g.add_edge(&def, &avatar);
        g.add_edge(&def, &py);
        assert_eq!(g.consumers_of(&def), vec![avatar.clone(), py.clone()], "升序消费者");
        assert_eq!(g.producers_of(&avatar), vec![def.clone()]);
        assert_eq!(g.invalidate(&def), vec![avatar.clone(), py.clone()], "单文件变更只失效相关项");
        assert_eq!(g.consumers_of(&key("/defs/None.def")), Vec::<DocumentKey>::new(), "无消费者 → 空");
    }

    #[test]
    fn duplicate_edge_idempotent() {
        let mut g = DependencyGraph::new();
        let p = key("/defs/A.def");
        let c = key("/defs/B.def");
        g.add_edge(&p, &c);
        g.add_edge(&p, &c);
        assert_eq!(g.consumers_of(&p).len(), 1, "同边重复幂等");
        assert_eq!(g.edge_count(), 1);
    }

    #[test]
    fn invalidate_closure_bounded_and_cycle_safe() {
        let mut g = DependencyGraph::new();
        let a = key("/defs/A.def");
        let b = key("/defs/B.def");
        let c = key("/defs/C.def");
        // A→B→C→A 环。
        g.add_edge(&a, &b);
        g.add_edge(&b, &c);
        g.add_edge(&c, &a);
        // 距离 1:只 B(直接消费者)。
        assert_eq!(g.invalidate_closure(&a, 1), vec![b.clone()]);
        // 距离 3:环安全,去重。
        let cl = g.invalidate_closure(&a, 3);
        assert_eq!(cl.len(), 3, "环安全不无限: {cl:?}");
        assert!(cl.contains(&b) && cl.contains(&c) && cl.contains(&a));
    }

    #[test]
    fn invalidate_closure_depth_zero_is_direct() {
        let mut g = DependencyGraph::new();
        let a = key("/defs/A.def");
        let b = key("/defs/B.def");
        let c = key("/defs/C.def");
        g.add_edge(&a, &b);
        g.add_edge(&b, &c);
        assert_eq!(g.invalidate_closure(&a, 0), Vec::<DocumentKey>::new(), "0 = 无(producer 不计)");
        assert_eq!(g.invalidate_closure(&a, 1), vec![b.clone()], "1 = 直接消费者");
        assert_eq!(g.invalidate_closure(&a, 2), vec![b.clone(), c.clone()], "2 = 含二级");
    }

    #[test]
    fn remove_symmetric_cleanup() {
        let mut g = DependencyGraph::new();
        let a = key("/defs/A.def");
        let b = key("/defs/B.def");
        let c = key("/defs/C.def");
        g.add_edge(&a, &b);
        g.add_edge(&b, &c);
        // 删除中间消费者 b:其入边(a→b)与出边(b→c)全清。
        assert!(g.remove(&b));
        assert_eq!(g.consumers_of(&a), Vec::<DocumentKey>::new(), "a 的出边随 b 删除清理");
        assert_eq!(g.consumers_of(&b), Vec::<DocumentKey>::new(), "b 的出边清除");
        assert_eq!(g.producers_of(&c), Vec::<DocumentKey>::new(), "c 的入边清除");
        assert!(g.is_empty() || g.edge_count() == 0, "无残留悬空键");
        // 重复删除幂等。
        assert!(!g.remove(&b));
    }
}
