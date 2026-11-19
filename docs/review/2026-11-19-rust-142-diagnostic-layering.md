# RUST-142 批 2:诊断分级装配决策核(diagnostic_layering.rs)

2026-11-19。kode2 LSP 族 Rust 收编批第 4 条(批 2 纯库面)。承接批 1
`diagnostic_pipeline.rs`(12 计数器调度状态机回放核 + 四族层模型),本批把
**真实 lint 家族税表**接入四层路由:`lint::Finding.check` 的 15 个在役
check 码 → `layer_for_check` 决策表 → `LayeredFindings` 四桶 → 逐层独立
`DiagnosticSchedulerCore` → `merged_publish` 层名字节序合流。

## 交付面

- `crates/kode-server/src/diagnostic_layering.rs`:CHECK_CODES 全表
  (15 码,lint/rules.rs 在役规则)、`layer_for_check`(现状全
  LocalSyntax,未知码保守路由不丢产出)、`route_findings` 保序入桶、
  `LayeredSchedulers`(四层独立节流,批 1 语义全继承:同版跳过/禁用
  记账/set_enabled)、`merged_publish`(字节序拼接,空层不产段)、
  `dump_diagnostic_layering_golden`(语料真分布快照)。
- `dump-diagnostic-layering-golden` bin + golden
  `tests/golden/diagnostic-layering-parity.json`(3876 字节,6 文件
  8 findings 3 家族:missing-flags 4 / unknown-type-reference 3 /
  redundant-detail-level 1;replay localSyntax 6 请求 6 发布,其余层零)。
- 集成测试 `tests/diagnostic_layering_golden.rs` 2 例:重生成字节比对 +
  结构完整性(计数守恒四面/决策表逐条对拍/合流序逐字节钉/逐层记账/
  真分布 ≥2 家族)。
- TS 镜像 `tests/kodeDiagnosticLayeringParity.test.ts` 4 例:税表字面
  双侧同表 + 决策分配对拍、计数守恒五面 + 语料文件存在性、合流序字节序
  重算 + 跨 golden 四层词表一致(批 1 pipeline golden layer 词表同集)、
  **production seam 从生产源文本复算**(diagnostics.ts 18 处
  `layer: '...' as const` 全 'local',任一翻 'semantic' 即红)。
- 5 单元钉:表完备性 + failsafe、路由保序、合流字节序(手工桶造异层
  占员)、逐层独立节流、RUST-149 换代替位。

## 诚实边界(登记,不冒充)

- 分级现状是**全 LocalSyntax 常表**:四层路由的异层可观察面在语料上不可
  分辨,由合成钉 + merged_publish 手工桶钉闭环;semantic/engineCompat/
  runtimeConfig 三个座位是目标设计面(engineCompat 真占员 = def md5
  兼容面,runtimeConfig = TS configContract 族),家族迁移时由 TS 装配批
  翻表 + 双侧 golden 重生成。
- didChange 生产接线 + LSP publishDiagnostics 留接线批,本批零接
  server.rs 纯库不变。
- lint findings 本体无法在 TS 复算(lint 规则集是 Rust 生产面),TS 镜像
  聚焦装配决策面,不做规则逐条重推。
- replayStats 的 requested==fileCount 口径 = 每命中文件一请求
  (items = 桶内下标),非逐 finding 一请求。

## prove-red 三靶(cp+cmp 还原,grep 钉复绿)

1. `MERGED_PUBLISH_ORDER` 翻序(semantic 首位)→ 单元合流序钉红。
2. `layer_for_check` 加 missing-flags→Semantic 特判 → 集成重生成比对红
   (golden layerForCheck/layerCounts/replayStats 三处联动)。
3. TS 双扰动:TS_LAYER_FOR_CHECK 翻一字面 → 表对拍例红;
   diagnostics.ts 翻一处 `layer: 'local'` → seam 例红(18 站点扫描
   咬合实证)。

## 坑账

- **lint severity 词表 ≠ LSP 词表**:rules.rs 系是
  `error`/`warning`/`info`,不是 LSP 的 `information`/`hint`。集成测试
  首版 SEVERITIES 按 LSP 词表写 → 语料 `info` 命中即红。词表应从产出侧
  (lint rules)取,不从消费侧(LSP DiagnosticSeverity)猜。
- **cmp 经命令替换吞尾换行**:`printf '%s' "$(cat f)"` 剥掉
  println!() 的尾换行 → 误报 EOF 差 1 字节。dump 约定(bin 加
  println!(),golden 文件带尾换行)下字节对拍必须直接 cmp 文件本体。
- **ruff_format 子进程族负载 flake**(对方车道件 b5007875,本批零接触):
  全量并行(`cargo test -p kode-server` 默认线程)下
  `nonzero_format_exit_is_surfaced_as_err` / `stdin_pipe_roundtrips_content`
  两成员跨轮先后红(每轮红员不同),隔离单跑与
  `-- --test-threads=4` 均 791/791 绿。定性 = spawn 子进程测试在高并行
  负载下的环境敏感 flake,非确定性缺陷;按共享门 flake 判例登记,不修
  对方车道件。本批改动(纯库 + 新文件)与其无数据交互。
- tsc 既有 2 处 Buffer variance 红(redisDrift.ts/telnetClient.ts)已被
  对方车道修复,本批 tsc rc=0 全清,无 delta 需登记。

## 门禁

- `cargo test -p kode-server`:791 lib(含本批 5 钉)+ 集成 2 例绿
  (ruff flake 按 --test-threads=4 与隔离单跑双口径核绿);
- `cargo clippy -p kode-server --all-targets` 0 警告(LayeredSchedulers
  补 `#[derive(Debug)]`);
- vitest:kodeDiagnosticLayeringParity 4 + kodeDiagnosticPipelineParity 3
  + diagnosticScheduler/configContractDiagnostics 46,全绿;
- `pnpm exec tsc --noEmit` rc=0。

## 余界

didChange 接线 + publishDiagnostics 接线、四族真占员入表(eng compat =
def md5 族,runtimeConfig = configContract 族)、TS 生产装配批翻表 ——
均留接线批;todo.md RUST-142 行保持「部分」。
