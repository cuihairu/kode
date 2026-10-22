# PR2 文档快照与解析缓存 — 接入前后指标对比(2026-10-23)

- 评审单:docs/review/2026-10-22-unified-semantic-index-refactor.md §3.1(PR2)
- 代码:src/documentStore.ts;接入面:src/languageProviders.ts(hover/inlay/签名闸门/parseDefAst)、src/extension.ts(文档开/改喂快照、关文档释放、停用清空)
- 复现:`KODE_PR2_OUT=docs/perf/pr2-documentstore-run.txt npx vitest run --config vitest.bench.config.ts tests/perf/documentStore.bench.ts`
- 原始输出:docs/perf/pr2-documentstore-run.txt(PR1 埋点 document-parse 事件口径)
- 环境:Linux,node v24.21.0,14 逻辑核(i9-10880H,同 PR1 基线机器);big-py=24,002 行 .py,def-heavy=生成资产

## 1. Hover 行准备(废除逐次 getText().split 全文拆行)

| 口径 | n | P50 | P95 | P99 | avg |
|---|---|---|---|---|---|
| 接入前:getText().split(每次) | 50 | 1.66 ms | 4.77 ms | 6.78 ms | 2.09 ms |
| 接入后:getDocumentLines(同版本复用) | 50 | **0 ms** | **0.01 ms** | 0.14 ms | 0.01 ms |
| 接入后:编辑后快照重建(一次/版本) | 20 | 7.28 ms | 12.56 ms | 14.45 ms | 8.61 ms |

- 热路径收益:每次 hover 的行准备 P50 1.66ms → <0.01ms(≥100×),且不再随文档增大线性重拆。
- 代价前移:每次编辑重建一次行索引(7-15ms/24k 行文件),替代原先「每次请求都重拆」;输入一次、查询 N 次 时净赚。与 PR1 基线场景 4(编辑后 P99 79.9ms MRO 重建尖峰)同数量级,后续由 indexScheduler 合并。

## 2. Diagnostics def AST(同版本只解析一次)

| 口径 | n | P50 | P95 | P99 | avg |
|---|---|---|---|---|---|
| 接入前:每次 parseDefDocument(小 .def) | 50 | 0 ms | 0.01 ms | 4.52 ms | 0.09 ms |
| 接入后:同版本缓存命中 | 50 | 0.01 ms | 0.05 ms | 0.51 ms | 0.03 ms |
| 接入前:每次解析(合成 300 连拼大 .def) | 30 | 0 ms | 0.02 ms | 38.64 ms | 1.29 ms |
| 接入后:缓存命中(同上大文档) | 30 | 0.01 ms | 0.06 ms | 3.38 ms | 0.13 ms |
| 接入后:编辑后重解析(大文档,一次/版本) | 1 | 1.01 ms | — | — | — |

- 仓库真实 .def 单文件解析本就亚毫秒(印证 PR1 基线 §4「单位文件解析非主要矛盾」);接入的净收益是**调用面去重**:validateDocument/hover/definition 等同版本调用面共享一次解析(document-parse 埋点:51 次请求 49 命中,hitRate 96.1%),P99 尾部不再随重复解析叠加(38.6ms → 3.4ms)。

## 3. 门禁与正确性

- `pnpm test:unit`:**2740 passed / 7 skipped**(基线 2721,净增 19 条 documentStore 锁定测试,0 回归)。
- `tsc -p ./`、`eslint src --ext ts`:零错误。
- 新增锁定面(tests/documentStore.test.ts):URI 规范化、版本/文本/行索引与 `getText().split(/\r?\n/)` 逐行等价(含 \r\n)、内存优先(缓冲区 ≠ 磁盘时以缓冲区为准,磁盘后续改写不影响快照)、同版本只解析一次、in-flight 合并、解析中再编辑旧结果不覆盖新版本、解析失败可恢复、关文档释放计数归零。

## 4. 待测(如实标注)

- [ ] VS Code 真实编辑器内 hover 端到端(含 provider 调度与 UI 序列化):本报告为 fake-vscode + 真实实现的服务层耗时,同 PR1 口径。
- [ ] 编辑后快照重建(7-15ms/大文件)与 indexScheduler 的合并策略:PR3 落地时复测。
- [ ] 大 .def 连续输入下的诊断发布次数统计(§7.3 验收):document-parse 埋点已就位,待真实编辑会话采集。
