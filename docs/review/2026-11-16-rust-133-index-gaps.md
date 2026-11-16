# RUST-133 索引缺口报告(unindexed/partial/stale)+ 按需补齐验收

日期:2026-11-16
任务行(todo.md):`RUST-133 (旧 IDX-016) 记录索引缺口(unindexed / partial / stale),按需补齐,避免误报无法找到定义。`

## 结论

索引缺口从「散落计数」升级为**可查询裁定面**:`$/kode/indexGaps` 顶层请求
(无 uri = 聚合报告;带 uri = per-URI 四态裁定 + `fill:true` 按需补齐)+
health 顶层 `indexGaps` 键(恒装配,与聚合同源)。fill 循环端到端验证:
盘上未入库文件 unindexed → fill 回读盘入库 → 定义命中(todo 行口径
「避免误报无法找到定义」)。

## 设计

- **三族缺口对账**:
  - `unindexed` = 暖扫计划的未完成量(warm total/done/failed;暖扫之外无
    全量计划账,known/missing **诚实 null 不虚构 0**);
  - `partial` = 解析失败负缓存(count + 有界样本 ≤8,带 reason;负缓存
    全量枚举链 vfs→parser→index,**按 (root, 路径) 字典序排序产出**,
    HashMap 遍历序不稳定);
  - `stale` = 刷新在途(调度队列 queued + 风暴缓冲 stormBuffered)。
- **per-URI 裁定四态**:`gap ∈ "unindexed"|"partial"|"stale"|"none"`,
  裁定序 **stale → unindexed → partial**(在途刷新会改写驻留真相先报;
  真缺口才轮到 fill)。响应 `{uri, tracked, parseError, pendingRefresh,
  filled, gap}`。
  - tracked = 索引以任何形态知晓:注册表前向表(成功解析,含零符号文件
    ——`known_to_registry`,by_file 空的合法文件不被误判)**或**负缓存
    (解析失败已记账,不被误判 unindexed);
  - **fill 只对 unindexed 生效**:partial 的处置链是改文件重解析、stale
    已有在途刷新,fill 不越权重放;成功入队(Queued/Merged)才报
    `filled:true`,request_close 执行时刻真相重放(盘上合法文件回读)。
- **根外/不可解析 URI**:诚实 unindexed 且 fill 零越权(key_for 拒绝
  UNROOTED 铸键,零侧效)。
- **kode-protocol 零新 DTO**:ad-hoc Value params(其余 $/kode 臂同口径)。

## 测试(17 例)

- **vfs 单测 1 例**:negative_entries 字典序排序 + reason 拷贝 + 成功写入
  清负缓存后枚举收缩;
- **Rust 分派层 8 例**(tests/index_gaps_dispatch.rs,进程内 ServerState +
  真盘文件):聚合三族恒装配(fresh server known/missing=null)/ partial 族
  负缓存样本带 reason 且 parseError 与聚合同源 + 合法 def gap=none /
  stale 族在途刷新(泵后归零)/ unindexed+fill 回读入库 / 根外+不可解析
  URI 诚实 unindexed 且 fill 零侧效(注册根子目录仍算根内=前缀归属,真根外
  另立目录)/ fill 不越权 partial·stale / health indexGaps 键与聚合同源 /
  fill 消费者面(已打开 Probe.def 的 Parent 引用定义探针,目标 Late.def
  全程未打开:fill 前 miss → fill 后命中落点=语料 def 首行);
- **真二进制 E2E 2 例**(tests/indexGapsE2e.test.ts,spawn kode-server +
  真盘):fill 循环全链(unindexed → fill → 定义命中 → gap none);per-URI
  裁定已入库文件 none + health indexGaps 三族恒装配(partial count 0)。
- **契约钉 1 处**(tests/protocolContract.test.ts):health 顶层键集 14→15
  键(加 'indexGaps'),fresh server 形状钉死(unindexed known=null
  indexed=0 missing=null / partial count=0 samples=[] / stale 两计数)。
- **API 漂移闸同笔**(tests/rstR2IndexInventory.test.ts +
  docs/review/2026-10-29-r2-index-inventory.md):SymbolIndex 公开方法
  清单 +3(negative_entries/known_to_registry/tracks)。

## prove-red(四靶,cp 备份 + 变异 + cmp 字节还原,靶面互不掩护)

1. 摘 fill 分支(filled 恒 false)→ **恰 2 红**(unindexed_fill +
   definition_hit)——fill 面钉死;
2. 摘 pending_refresh 探测(恒 false)→ **恰 2 红**(stale_family +
   fill 不越权 stale 臂)——stale 面钉死;
3. 摘 health indexGaps 键 → **恰 1 红**(health_carries)——聚合键钉死;
4. 摘 per-URI partial 臂(parse_error 恒 None)→ **恰 2 红**(partial_family
   + fill 不越权 partial 臂)——partial 裁定面钉死,且聚合 partial 计数
   (index_gaps_report 独立面)不受影响 = 判别面正确。

## 诚实边界

- unindexed 聚合面只在暖扫窗口(Warming 态)有全量计划账可对;暖扫之外
  known/missing=null——服务无全局「known 文件总数」账本,不虚构 0。
  per-URI 面不受此限(注册表逐键裁定)。
- partial 族样本有界(≤8)防 health 载荷失控;全量枚举走 `$/kode/indexGaps`
  按 uri 逐键消费(负缓存条目数另有 parseCache.negative 计数)。
- fill 的入库是异步执行(filled=true = 入队成功非入库完成);消费面证据
  = 后续请求入口 pump 后定义命中(E2E 钉)。
- stale 判据是「刷新在途」(调度队列 + 风暴缓冲);风暴窗口到期移交前
  didChange 事件按 buffered 计,与 queued 分列不混淆。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- `cargo test -p kode-vfs -p kode-index -p kode-parser -p kode-server`:
  RC=0,1319 过 0 红(+9 = 分派 8 + vfs 1)
- `pnpm lint`:0;`pnpm compile`(tsc):0
- vitest 全量:845 文件 10342 过 + 8 skip,RC=0
- `xvfb-run -a npm run test:demo:editor`:25 passing,RC=0
