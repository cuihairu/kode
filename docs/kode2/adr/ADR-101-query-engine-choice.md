# ADR-101 — kode-index/kode-types 采用自研 revision/generation 查询引擎(不引 Salsa)

- 状态:已接受(2026-11-17,RUST-288 裁决落档;此前 de-facto 自研已在役,本 ADR 追认并钉 reopen 条款)
- 关联:书 §18 ADR-101、RUST-288、pr-007(IDX-004「Salsa 选型 ADR-101 仍未裁决,不预设」的悬置就此关闭)、ADR-002(重评流程)、ADR-102(同模式先例:第三方 crate 需 ADR)
- 证据:`docs/perf/2026-11-15-index-increment-bench.md`(增量/热更新墙钟)、`docs/perf/2026-11-15-index-memory-eval.md`(内存,RUST-129/IDX-012)、`docs/perf/2026-11-15-request-storm.md`(查询面风暴)、`docs/perf/2026-11-15-soak-1h.md`(长跑)、`docs/review/2026-10-29-r2-index-inventory.md`

## 背景

书 ADR-101 要求按 query DAG 大小、内存、工程维护成本三轴裁决 Salsa vs 自研
revision query engine。仓库铁律:密码学以外引入第三方 crate 需 ADR。裁决悬置
期间(pr-007 明记「不预设」),实现已按自研路线在役:

- **kode-index**(`index.rs`):`ParseCache` 复用 VFS-011 + FNV-1a 指纹 +
  generation 计数;`update`/`update_batch` 指纹命中 `rebuilt=false` 零重建,
  批量提交后一次 bump(原子 generation);名字倒排 `BTreeMap` 有序范围扫描
  (workspace_symbols 不 O(文件数),IDX-006)+ `dependents_of` 反向依赖;
- **kode-types**(`graph.rs` TypeGraph):`record_*` 灌入 + 查询面
  (entity_methods/methods_by_facet/exposed_methods/origin_for 等,RUST-105/108);
- **kode-server**:snapshot/semantics 层按 root/version 上下文消费上述两 crate。

## 决策

**维持自研,不引入 Salsa。** 三轴裁决依据(全部实测,release):

1. **query DAG 大小与形态**:本工程查询面是「倒排+指纹缓存+代数失效」形态,
   依赖边有限(类型引用/Parent/组件/接口/entities 注册边,IDX-002;引用正反表),
   不是 Salsa 擅长的细粒度可增量重算 query 图。风暴实测五面全中
   (request-storm:S1 200 版编辑流单版吸收 p50 0.06ms、S2 三根同名轮转、
   S5 并发请求 p99 2.31ms);热更新单文件编辑到索引重建完成 P50 402µs /
   P99 739µs(n=295),同文本零重建 9.5µs/次且 generation 不变
   (index-increment-bench)——指纹+generation 已拿到增量重算的收益。
2. **内存**:50k 档 RSS 绝对驻留(`after_kb` 隔离进程口径)分层实测与结构
   裁决(interning/arena/small vectors)在案(index-memory-eval,RUST-129
   收口);soak 1h 600s 全绿无无界增长(SOAK-SUMMARY,RUST-030)。无
   「memoization 结构撑不住」的实证。
3. **工程维护成本**:自研面已有测试网兜底(kode-index `index_units`/`symbol_*`
   + `bench_increment`/`bench_memory` examples;kode-types `types_units`/
   `methods_units`/`provenance_units` + golden 对拍族);引 Salsa 的对价=新增第三方依赖
   (铁律需 ADR)+ 学习/版本跟进 + 现有指纹/generation 双轨并存的迁移面,
   而其核心卖点(细粒度增量重算)在本工程 query 形态下无已证缺口。

## 后果

- 正面:零新增依赖(供应链/VSIX 体积不变);失效语义(指纹命中零重建/
  真变必重建双证)已被基准钉死;与 ADR-102 同模式,裁决纪律一致。
- 负面/约束:细粒度增量(行/CST 级)不在本引擎,巨型单文件高频编辑形态
  已知(index-increment-bench「解读与边界」,1.6MB 全量重解析 ~150ms);
  跨文件细粒度依赖若将来成为产品需求,需按 reopen 条款重评。

## reopen 条款(可推翻,推翻需基准证据)

出现以下任一形态时,按 ADR-002 流程重评(候选含 Salsa/其他):

1. 产品需求引入**表达式级跨文件 query 依赖**(需要自动 dirty 追踪到
   细粒度输入,指纹+generation 粒度不够);
2. query 数量/组合爆炸致手写 memoization 维护成本超过引入框架的对价
   (须给出两侧维护面实证,不接受「感觉会爆炸」)。
