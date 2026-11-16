# RUST-126:磁盘缓存 key 五因子契约(验收纪实)

日期:2026-11-16
任务行(todo.md):`RUST-126 (旧 IDX-009) 磁盘缓存 key 包含 Core schema、engine profile、root identity、workspace config、解析器版本。`

## 结论

持久化家族 key 契约先行:kode-vfs 新纯核 `persist_key.rs`(RUST-127 崩溃
安全写入 / RUST-128 格式基准消费本契约)。**任何影响解析产物语义的环境
因子都必须进 key——环境变了旧条目还能命中 = 脏读**。

- **五因子**(RUST-126 行逐名):`core_schema`(如 Schema::SCHEMA_VERSION
  的字符串形态)/ `engine_profile`(如 EngineMetaLayer seed 集 + override
  指纹)/ `root_identity`(跨进程持久化不能用进程内 RootId 数值,用根
  路径等稳定身份)/ `workspace_config`(调用方规范化串)/ `parser_version`
  (解析规则变化旧缓存必须失效)。另含 `doc_path` 文档路径身份。
- **编码** = 定序长度前缀串流 + 双 seed FNV-1a 128bit,输出 32 hex。
  **长度前缀防拼接歧义**:值含分隔符时 ("a|b","c") 与 ("a","b|c") 无前缀
  会拼出同流撞 key,带前缀不可能;双 seed 把生日界推到 2^64 量级,持久
  化跨会话条目按 hex 索引零歧义。
- **纯函数**:同因子同路径恒稳定(无时钟/随机);任一因子或路径变化即变。
  全空因子(不合法但构造器不设防)path 仍唯一决定 key,不 panic。

## 诚实边界

- **因子来源接线随 RUST-127 写入面**:本面只锁 key 契约(构造器纯核 +
  敏感性测试);五因子的真实取值(schema 版本串/engine profile 指纹的
  序列化/根路径/配置规范化)由写入面装配时供给并钉测试——不预造没有
  消费者的装配层。
- 现有 `DiskCache`(disk.rs)是进程内「磁盘文本缓冲」缓存(指纹→文本,
  进程生命周期),不是落盘持久化;本 key 契约为 RUST-127/128 的落盘
  缓存本体铺路,不改 DiskCache 现行为。

## 验收实测

- 5 例单测:稳定性 + hex 形态(定宽 hex 字符集)、五因子逐名敏感性 +
  路径敏感性、长度前缀防拼接歧义(真歧义样本)、空因子不 panic、
  分隔符跨界不撞。
- **prove-red 双靶全红且 cp+cmp 字节还原**:①`push_factor` 去长度前缀 →
  分隔符歧义例红;②丢 `workspace_config` 因子 → 因子敏感性例红。

## 坑账

1. **假歧义样本**:首个歧义测试用 ("ab","c") vs ("a","bc")——'|' 分隔符
   在场时两流 "ab|c…" vs "a|bc…" 并不相同,去前缀变异**没有红**(靶失效
   实锤:5 passed)。真歧义必须值含分隔符:("a|b","c") vs ("a","b|c")
   无前缀时同流 "a|b|c|…"。prove-red 靶打了没红 = 靶不合格,须重构样本
   再打(与 RUST-114「编译挂非测试红」同族的靶质量纪律)。
2. **const 类型位匿名生命周期**:`const BASE: fn(...) -> PersistKeyFactors<'_>`
   E0106——const 类型位不能用 `'_`,删别名直接调 helper;
   helper 返回 `PersistKeyFactors<'_>` 同因,显式 `<'a>`。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- cargo test(kode-vfs/parser/index/server):全绿 0 failed
- `pnpm lint`:0;`tsc --noEmit`:0(纯 Rust 批,TS 面零变化,门禁照跑)
- vitest 全量 + xvfb demo:见执行记录

## 执行记录

- vitest 全量:843 文件 passed + 1 skipped,10334 tests passed + 8 skipped,exit 0
- xvfb-run -a npm run test:demo:editor:25 passing,Exit code 0
