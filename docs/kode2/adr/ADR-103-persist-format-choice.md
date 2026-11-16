# ADR-103 — 解析产物持久化格式:自研 packed-log 主向 + mmap 快照候选道,生产零第三方依赖

- 状态:已接受(2026-11-17,RUST-290 裁决落档;packed-log 主向 2026-11-16 RUST-128 初裁,本 ADR 以 2k/10k/50k 矩阵+mmap 候选臂复核后定案)
- 关联:书 §18 ADR-103、RUST-290、RUST-128(单档五候选初裁)、RUST-126(persist_cache_key 契约)、RUST-127(PersistStore 单条目原子性)、RUST-129(语料形态定标)
- 证据:`docs/perf/2026-11-16-persist-format-bench.md`(5k 单档+方法与口径)、`docs/perf/2026-11-17-persist-matrix-bench.md`(2k/10k/50k 矩阵+mmap-snapshot 臂,本批)、`crates/kode-vfs/examples/persist_format_bench.rs`(六候选可复现基准)、ADR-102(同模式先例:第三方 crate 需 ADR)

## 背景

书 ADR-103:SQLite vs redb vs mmap cache,用 2k/10k/50k 数据集比较 cold
startup/写放大。kode 的持久化对象=解析产物缓存(缓存语义:miss=重建,
崩溃只丢缓存不丢正确性),语料形态 ~34KB/文件(RUST-129)。仓库铁律:
密码学以外引入第三方 crate 需 ADR。

## 决策

1. **增量缓存主向 = 自研 packed-log 单文件追加日志**(零依赖:
   `[key16][len4][payload][checksum8]` 追加,批量 fsync,开库全扫建索引,
   撕裂尾按校验和截断抢救前缀)。裁决依据=RUST-128 单档初裁+本批矩阵复核:
   写放大 1.00、空间放大 1.00、单文件,全档(2k/10k/50k)线性外推排序不翻转;
   **增量语义是决定性优势**——LSP 编辑流按单文件逐条更新,packed-log 单条
   追加 ≈ payload+24B,而快照式(mmap/sqlite 全表重写形态)单条更新=
   整文件重写或引擎内部页管理。
2. **mmap cache 评测结论 = 快照形态候选道,不接线**。本批新增 mmap-snapshot
   臂(单文件快照+索引前置,mmap 只读索引建库+惰性记录区)在**整批模型**
   下全轴最优:冷读全量 17.3/83.6/390.7ms(packed-log 的 4.5-7.9 分之一),
   开库仅索引 0.1/0.5/2.7ms,随机读 6-7µs,写/空间放大双 1.00,单文件。
   但(一)整批写是它的主场,单文件增量更新=全量重写(50k 档 1.6GiB/次),
   需 compaction 机制才可作热路径;(二)无 per-record 校验,撕裂=整文件弃
   (正确性靠 miss 重建无损,但无前缀抢救);(三)生产当前无快照消费面。
   登记:**惰性 mmap 缓存/冷启动压缩道为后续候选**,接线须新任务点火
   (含 temp+rename 原子性设计与增量 compaction),不在本裁决内虚设。
3. **redb 出局维持**:空间放大 2.06→3.29(矩阵全档),耐久写 50k 档 87.7s,
   三轴无胜面。
4. **SQLite 降为二档记录**:sqlite-relaxed 冷读稳定第二(34/184/741ms)、
   空间 1.02、单文件;代价=rusqlite bundled C 进编译链。若后续出现
   查询/事务需求(如跨代际增量失效索引)可回选(同 RUST-128 判词)。
5. **第三方依赖裁定**:生产 lib 保持零依赖(packed-log 家族自研);
   rusqlite 0.41(bundled)/redb 2/fmmap 0.3(memmap2 安全包装,workspace
   禁 unsafe)三者**仅基准面 dev-dep**(kode-vfs Cargo.toml 注释钉),
   本 ADR 即其评估档。persist-store(现状生产面)按 RUST-128 结论待
   后续任务迁 packed-log 家族(迁移本身另属任务书,不在本 ADR)。

## 后果

- 正面:裁决落在实测矩阵上(任务书要求的 2k/10k/50k+cold startup/写放大
  两轴全数覆盖);零第三方生产依赖(供应链/VSIX 体积不变);矩阵外推
  线性成立使后续容量估算有据。
- 负面/约束:mmap 候选道的优势(冷重启毫秒级惰性加载)暂不可得,须等
  增量 compaction+原子快照设计;packed-log 批量 fsync 窗口崩溃丢尾部条目
  (RUST-128 已登记的有意取舍,miss 重建兜底)。
- reopen 条款:①产品需求出现跨代际查询/事务语义→回选 sqlite;②单文件
  增量写放大实测显示 packed-log 前缀抢救成本过高或文件增长失控→重评
  mmap+compaction 快照道(须基准证据);③mmap 惰性缓存接线任务点火时
  本 ADR 第 2 条随之更新。

## 边界(诚实)

- 冷启动=页缓存暖口径(非 root 无 drop_caches);
- 基准写相=整批一次写全量,单条目增量写放大未建模(矩阵文档「解读 3/边界」);
- 真·冷盘数字(重启后首读)未测(同 RUST-128 边界,需 root);
- persist-store→packed-log 生产迁移未点火,现状生产面仍为 persist-store。
