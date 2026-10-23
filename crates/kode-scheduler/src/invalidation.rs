//! 失效图 + 分批重建计划(书 §17 PR-009「reverse DAG」+ §7 IDX-002/006/013 面)。
//!
//! - 失效图:文件 → 声明名(实体/类型/别名/属性/方法/组件)→ 反向受影响文件集
//!   (复用 kode-index 名称倒排与反向依赖索引,不重复建图);
//! - 分批重建:受影响集确定性排序后按上限切块,每批一个 `dependency-update`
//!   任务(优先级继承变更文件面),整批走 [`crate::Scheduler`] 的批量/合并面。

use std::collections::BTreeSet;

use kode_index::{DocumentKey, SymbolIndex};

use crate::model::{priority, TaskKind};
use crate::scheduler::{RunFn, TaskSpec};

/// 基于符号索引的反向失效视图(只读;图即索引的投影,不复制数据)。
#[derive(Debug, Clone, Copy)]
pub struct InvalidationGraph<'a> {
    index: &'a SymbolIndex,
}

impl<'a> InvalidationGraph<'a> {
    pub fn new(index: &'a SymbolIndex) -> InvalidationGraph<'a> {
        InvalidationGraph { index }
    }

    /// 该文件声明的名字(去重升序;实体/属性/方法/类型/别名/组件)。
    pub fn declared_names(&self, key: &DocumentKey) -> Vec<String> {
        let mut names: Vec<String> = self
            .index
            .symbols_in_file(key)
            .into_iter()
            .map(|s| s.name)
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// 变更该文件的受影响集 = 自身 ∪ ⋃(依赖它声明的名字的文件)。
    /// 确定性:DocumentKey 自带 Ord,结果为排序集合,重复依赖自动折叠。
    pub fn affected_by(&self, key: &DocumentKey) -> BTreeSet<DocumentKey> {
        let mut affected: BTreeSet<DocumentKey> = BTreeSet::new();
        affected.insert(key.clone());
        for name in self.declared_names(key) {
            for dependent in self.index.dependents_of(&name) {
                affected.insert(dependent);
            }
        }
        affected
    }

    /// 受影响集分批(确定性:按 (root_id, 路径) 升序后切块)。
    pub fn plan_rebuild_batches(
        &self,
        affected: &BTreeSet<DocumentKey>,
        max_batch: usize,
    ) -> Vec<Vec<DocumentKey>> {
        plan_batches(affected, max_batch)
    }
}

/// 受影响集分批(独立函数供批量提交面复用)。
pub fn plan_batches(affected: &BTreeSet<DocumentKey>, max_batch: usize) -> Vec<Vec<DocumentKey>> {
    let max_batch = max_batch.max(1);
    let mut ordered: Vec<&DocumentKey> = {
        let mut keys: Vec<&DocumentKey> = affected.iter().collect();
        keys.sort_by_key(|k| (k.root.0, k.uri.as_path().to_string()));
        keys
    };
    let mut batches = Vec::new();
    while !ordered.is_empty() {
        let take = ordered.len().min(max_batch);
        let batch: Vec<DocumentKey> = ordered.drain(..take).cloned().collect();
        batches.push(batch);
    }
    batches
}

/// 把一次文件变更落成调度任务:变更文件本身一个 `single-file-update`,
/// 受影响依赖按批切 `dependency-update`(优先级 = 依赖更新面)。
/// `make_run` 由调用方提供重建闭包(本 crate 不绑定具体索引实现)。
pub fn plan_dependency_tasks<F>(
    graph: &InvalidationGraph<'_>,
    changed: &DocumentKey,
    changed_priority: u8,
    dep_priority: u8,
    max_batch: usize,
    mut make_run: F,
) -> Vec<TaskSpec>
where
    F: FnMut(Vec<DocumentKey>) -> Box<RunFn>,
{
    let mut specs: Vec<TaskSpec> = Vec::new();
    let affected = graph.affected_by(changed);
    let batches = plan_batches(&affected, max_batch);
    for (i, batch) in batches.into_iter().enumerate() {
        let is_changed_file = batch.len() == 1 && batch[0] == *changed;
        let (kind, prio) = if is_changed_file {
            (TaskKind::SingleFileUpdate, changed_priority)
        } else {
            (TaskKind::DependencyUpdate, dep_priority)
        };
        let target = Some(format!("batch:{}:{}", i + 1, batch.len()));
        specs.push(TaskSpec {
            kind,
            priority: prio.min(priority::NON_INTERACTIVE),
            file: None,
            version: None,
            target,
            run: make_run(batch),
        });
    }
    specs
}
