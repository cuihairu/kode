# kode-mcp Windows 覆盖率批次报告(2026-11-11)

任务:执行 `C:\tools\oc_kode_cov.md` 全步骤——Windows 上把 kode 的 CI 覆盖率指标(CI=Codecov merged badge 96.1%)向 98% 推进;kode-mcp 最低两模块各补 3-6 条行为测试(禁凑数、不改生产代码);如实记录。

## 结论(先说)

- **kode-mcp 行覆盖率(CI 同口径:llvm-cov lines)94.98% → 96.15%(+1.17pp,missed 397 → 308)**;全部 231 测试 0 失败;clippy `-D warnings` 0 错、`tsc -p tsconfig.mocha.json` 0 错。
- 最低两模块按基线 llvm-cov 行覆盖率判定为 **fts.rs(84.40%)与 kb_index.rs(87.99%)**(server.rs 88.16% 第三,regions 口径 server 85.41% 与 fts 85.46% 几乎并列)。各补行为测试后:**fts 86.47%(+2.07pp,残 54 miss 全在错误传播分支)、kb_index 92.25%(+4.26pp)**;bonus 面 server.rs 88.16% → **99.06%**(e2e 补齐 5 个此前从未经 stdio 打通的 dispatch 分支)。
- **98%(merged badge)在本批次范围内不可达,如实记录**:badge 是全仓(16 crates 的 rust flag + 全 TS 的 ts flag)按行加权归并,kode-mcp 约 8.0k 可执行行只是分母的一小部分;TS 侧 96.88%(行)不变,其余 crate 未动,kode-mcp 单侧 +1.17pp 传导到 merged 指标不足 0.5pp。要到 98% 需要另一批次处理 TS 长尾与其余 crate(见 §6 算术)。

## 1. 环境

- Windows Server 2022(10.0.20348),自托管;Rust 1.99.0(`rust-toolchain.toml` 钉版)+ cargo-llvm-cov 0.9.1;node v24.22.1 + pnpm 12.10.1(packageManager 钉版)。
- 网络受限:rustup/crates 走 rsproxy.cn 镜像,git fetch偶发 TLS 失败重试即过。
- 磁盘:C: 是唯一健康卷(M:/N: 为可移除 USB,中途写探针 "Incorrect function" 卡死,弃用);批次中两次磁盘耗尽(LNK1180、rustc 0xc0000409),按任务授权清 cargo 缓存/npm cache/pnpm store,并删除本机多余 stable 工具链与旧 target 后恢复。

## 2. 基线(as-found)

### 2.1 Rust:`cargo test -p kode-mcp`

- 原样(HEAD=cd25c73c,Windows 首跑):**216 测试,200 过 / 8 败**——7 个确定性 POSIX 路径断言失败(config_qa ×3、docs_index ×3、e2e ×1)+ 1 个并行负载偶发(`fts::replace_file_swaps_documents`,tantivy GC "拒绝访问 os error 5";单跑恒绿,生产代码按任务禁改,如实记录)。
- 8 处断言全部为「服务端回传路径 vs 正斜杠字面量」失配(Windows 回 `\`),修法=断言侧 `.replace('\\', "/")` 归一,与生产既有惯例(nodes.rs:267、git_state.rs:57)同口径。**仅动测试,零生产代码**,commit **2481b044**(config_qa 4 处、docs_index 3 处、e2e 2 处;其中 2 处是先修的断言放行后才暴露的同测试后置断言)。
- 修复后基线(2481b044 树,全绿):216/216,0 失败。

### 2.2 Rust:`cargo llvm-cov -p kode-mcp`(真基线,commit 2481b044)

| 指标 | 数值 |
|---|---|
| Lines | **94.98%**(7904 行,missed 397) |
| Regions | 94.50%(13593,missed 747) |
| Functions | 88.98%(753,missed 83) |

行覆盖率最低模块排序(Codecov 口径=lines):

| 模块 | Lines% | Missed | Regions% |
|---|---|---|---|
| **fts.rs** | **84.40%** | 56/359 | 85.46% |
| **kb_index.rs** | **87.99%** | 79/658 | 87.89% |
| server.rs | 88.16% | 63/532 | 85.41% |
| nodes.rs | 90.62% | 18/192 | 91.61% |
| extract.rs | 92.98% | 88/1254 | 92.65% |

### 2.3 TS:`pnpm install && pnpm exec vitest run`

- 测试:**8621 tests,8491 passed / 39 failed / 91 skipped**。39 个失败均为既有 Windows 环境用例(getuid/信号/chmod 等,即 todo.md WIN-4/5 系列在 Linux CI 保绿的 skipIf win32 面),非本批引入。
- `vitest --coverage` **已配置**(vitest.config.ts:v8 provider、all:true、382 文件)。Windows 专项发现:vitest 5 默认 `coverage.reportOnFailure=false`——**测试非全绿时不落 coverage 报告**,必须 `--coverage --coverage.reportOnFailure` 才能在 Windows 存出报告(仅 `--coverage.reportOnFailure` 不开覆盖)。
- 覆盖率(coverage-summary.json):**Lines 96.88%**(37632/38842)、**Branches 91.12%**(23628/25930)、**Functions 94.96%**(6605/6955)、**Statements 96.46%**(39498/40947)。

## 3. 补测(每条锁真实行为,无凑数;不改任何生产代码)

### 3.1 fts.rs +3(5cc9af5c,基线最低 #1)

1. `open_on_a_file_path_is_an_honest_error` — open 首步 create_dir_all 被同名文件占住时必须报携带路径的 Err(MCP 启动面的诚实错误契约)。
2. `limit_zero_and_oversized_limits_still_answer` — limit 0 按契约收敛为 1 条(`limit.max(1)`,不报错不挂起);超规模 limit 如实回全量。
3. `name_match_outranks_content_only_match` — 同词频同规模下 name 字段命中(3.0 boost)必须排在仅正文命中之前(字段加权是排序设计决策)。

### 3.2 kb_index.rs +4(5cc9af5c,新文件 `tests/kb_index_behavior.rs`,基线最低 #2;该模块无 inline 测试,按仓库既有口径走集成测试)

1. `natural_language_query_reports_vector_seam_honestly` — 多词 CJK 短语判定为 NL 形态,走 P3 seam;未配置时如实回报 `vector.configured=false` + `deferred=P3`,不伪装不丢字段。
2. `configured_vector_retriever_fuses_missed_docs_into_nl_results` — 注册 retriever 后 NL 查询融合进 BM25 词面够不到的**真实**节点(保持 BM25 行),score 原样回传(3.5 为 f32/f64 双侧精确值,避免 JSON 表示差)。
3. `watcher_registration_is_idempotent_and_state_honest` — start_watch 二次注册幂等 Ok,watcherActive/dirtyPending 状态如实。
4. `kind_filter_narrows_the_exact_route` — kind 过滤轴:命中类别全保留,类别不符诚实空集。

### 3.3 bonus 面(a5583c4c,非最低两模块,但属基线裸露的真实缺口)

- `tests/e2e.rs` +2:search 精确/强制 BM25 路由(python 格式过滤)、query_assets json/tmx 诚实面、query_excel 空表诚实空集、read_node 截断如实回报、get_dependencies 边/确定性/错误路径——**这 5 个 dispatch 分支此前从未经 stdio e2e 打通**(server.rs 是 dispatch 所在,63 miss → 5 miss)。
- `src/config_catalog.rs` +6:生成器契约面(未知键/大小写严格 miss、键唯一、点路径祖先齐备、source 恒为 kbe/ file:line 锚、group 恒在文档化分类、深键带组别+行段出处)。22 → 77 行全 100%。

## 4. 结果对比(before 2481b044 → after 5cc9af5c)

| 指标 | before | after | Δ |
|---|---|---|---|
| cargo test | 216/216 | **231/231**(lib 178,e2e 6,kb_index_behavior 4,其余 43) | +15 测试,0 失败 |
| **Lines(kode-mcp)** | 94.98%(397 miss) | **96.15%**(308 miss) | **+1.17pp** |
| Regions | 94.50% | 95.72% | +1.22pp |
| Functions | 88.98% | 89.53% | +0.55pp |
| fts.rs lines | 84.40%(56) | 86.47%(54) | +2.07pp(残 54 全在错误传播分支:tantivy open/search 的失败臂,诚实触发需故障注入,不强凑) |
| kb_index.rs lines | 87.99%(79) | 92.25%(51) | +4.26pp(残 51:get_dependencies 封顶截断臂、excel 边 4000 上限臂、watcher 事件回调等重夹具路径) |
| server.rs lines | 88.16%(63) | **99.06%(5)** | +10.90pp |
| config_catalog.rs | 100%(22 行) | 100%(77 行,含新测试行) | 契约面扩了一倍仍是满覆盖 |

llvm-cov 命令:`cargo llvm-cov -p kode-mcp --all-targets --jobs 2`(before 跑在同一 2481b044 树上,after 在 5cc9af5c 树上;两轮均全绿——见 §5,全绿是出真表的硬前提)。

## 5. Windows 专项发现(方法论,后续批次直接受用)

1. **libtest 存在失败用例时,该目标 profraw 落 0 字节**(实测:同一二进制,失败退出码 101 → profraw 0 字节;全绿退出 0 → 519KB)。后果:`--ignore-run-fail` 能「跑完并出表」,但出的是**烂表**——只被该目标覆盖的文件(read_node/protocol_frame/config_catalog 等)整文件 0%,表内部自相矛盾且 TOTAL 低到 44.11%。覆盖率测量必须先全绿(本批次先落 2481b044 断言修复再测基线,正是这个原因)。
2. **git stash 往返 + cargo 指纹的 mtime 粒度复用**:stash 后内容回退,但 cargo 可能按旧指纹复用上一棵树的二进制(实测 lib=更早的 pristine 构建、e2e=第一轮修复树,混合出 169/6 的伪 pristine 结果)。对策:每轮测量前显式删 `target/llvm-cov-target` 下 kode-mcp 的 fingerprint/deps/incremental 与全部 `*.profraw`。
3. 7+1 个基线失败 = 8 处 POSIX 路径断言(已修)+ 1 个并行偶发(fts GC os error 5,单跑恒绿;最终两轮全量中未复现,如实留观)。

## 6. 98% merged badge 算术(如实:不可达,及为什么)

- CI 的 96.1% = Codecov 对 **rust flag(全 16 crates 的 llvm-cov lcov)** 与 **ts flag(382 文件)** 按行加权归并(carryforward)。
- 本批只动了 kode-mcp(≈8.0k 可执行行):单侧 +1.17pp。merged 的传导 ≈ +1.17% × (kode-mcp 行数 / 全仓总行数)。全仓行数远大于 8k(rust 16 crates + TS 39k),传导不足 0.5pp,距 98% 还差 ~1.9pp。
- 剩余缺口位置:TS 分支 91.12%(2.3k miss)、TS 各 96% 面、其余 rust crate 长尾、以及 kode-mcp 残余 308 miss 中的错误分支臂。这些都不在「kode-mcp 最低两模块补测」的任务范围里,留待下一批次点名处理。

## 7. 门禁与复现

```
cargo test -p kode-mcp                          # 231/231 全绿
cargo llvm-cov -p kode-mcp --all-targets --jobs 2   # lines 96.15%
cargo clippy -p kode-mcp --all-targets -- -D warnings   # 0 错
pnpm exec tsc -p tsconfig.mocha.json            # 0 错
pnpm exec vitest run --coverage --coverage.reportOnFailure  # TS 96.88% lines(Windows 需 reportOnFailure)
```

- 过程日志(仓根,未入库):`_rust_test_baseline_full.log`、`_ts_test_baseline.log`、`_ts_cov_baseline.log`、`_rust_llvmcov_baseline5.log`(真基线)、`_rust_test_after.log`、`_rust_llvmcov_after.log`、`_clippy_gate.log`(首跑暴露 bool lint)、`_clippy_gate2.log`(修复后 0 错)、`_tsc_gate.log`。
- 提交:**2481b044**(8 处 Windows 路径断言修复,测试侧)→ **a5583c4c**(config_catalog + e2e dispatch 行为测试)→ **5cc9af5c**(fts + kb_index_behavior 最低两模块行为测试)→ **9d446568**(clippy bool_assert_comparison 3 处 assert! 化;kbb 4/4 复绿)。
- 门禁终值:tsc exit 0(0 错);clippy exit 0(首跑 3 个 `bool_assert_comparison` error,修复后 0);kb_index_behavior 4/4。
