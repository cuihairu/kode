# RUST-150 批 1:UI 大结果 Webview 渲染上限盘点与回放面截断落地

日期:2026-11-17

## 盘点矩阵(12 面全量审计)

| 面 | 渲染入口 | 上限现状 | 万级风险 |
|---|---|---|---|
| logWebView | displayedLimit=5000 缓冲剪枝(:40/:73)+enqueueWebviewBatch 批量 | 5000 行硬顶 | 无 |
| telnetWebView | service MAX_OUTPUT_LINES=500(telnetService.ts:244/:384)+webview DOM childElementCount>500 剪旧(:406) | 双面 500 | 无 |
| databaseManagementWebView | backend/databaseTablePreview SELECT LIMIT,默认 100/硬顶 1000+runner 多回行 slice | 1000 | 无 |
| traceReplayPanel→backend/traceReplayHtml | lanes.map(laneHtml) 全量拼接,**无上限** | 批 1 前:无 | **有**:FLOW-025 采集预算 20000 事件,帧/流可达万级;零脚本静态页一次渲染 |
| entityFlowWebView | renderEdgeDetails edges.map | 单实体语义域,天然小 | 无 |
| configVisualizerPanel | configVisualizerModel 单值 120 字符截断;键树节点数无上限 | 部分(defaults 数百-千键级) | 低,登记 |
| monitoringWebView | getMetricsHistory(component, duration).slice(-duration) 窗口 | 采样窗口有界 | 无 |
| runtimeQueryWebView | watcherResultRows 单查询直系子项 | 天然小 | 无 |
| entityDependencyWebView | CALLGRAPH_MAX_FILES=10,000 收集截断+面板警告条(KODE-PERF-004) | 10k 文件截断 | 无 |
| flowSwimlanePanel | FLOW_FILE_LIMIT=10,000+深度界 6+「继续展开」续开(FLOW-019) | 有防护 | 无 |
| defFingerprintInspector | 判定备注 reasons 列表 | 天然小 | 无 |
| logErrorScan | 64MB 文件字节上限+签名 160 字符折叠+去重;结果面 VSCode 原生 UI | 有防护 | 无 |

## 裁定:零脚本面板的「虚拟列表」形态

RUST-150 标题的「虚拟列表和延迟节点加载」需要脚本(滚动事件驱动追加)。回放页零脚本硬纪律(enableScripts=false,FLOW-028,零交互语义可丢)使虚拟列表结构性不可行——**渲染面上限+如实截断提示是该约束下的正确形态**。增量面板(log/telnet)已有滑动窗口等价物(缓冲剪枝+DOM 剪枝),不属缺口。

## 批 1 交付(backend/traceReplayHtml.ts)

1. 四常量 export:TRACE_REPLAY_MAX_LANES=24 / MAX_LANE_FRAMES=2000 / MAX_LANE_FLOWS=2000 / MAX_LANE_MARKERS=500;
2. 帧预算跨 segment 按序消耗(前段尽取后段余量),预算尽后剩余段如实空+泳道级截断尾注;flows/markers 各自独立预算切片;顶层 lanes 切片+notes 全局截断行;
3. 尾注 `.truncated-note`(warning 色 dashed 边框)如实计数「仅渲染前 N 项(共 M);数据完整,仅渲染面截断」——模型(数据面)不截断,只防一次渲染万级 DOM,不静默。

## 测试与验证

- tests/traceReplayHtml.test.ts 新建 5 钉:未超限零提示/单段超预算前缀+计数尾注/跨段消耗总量钉预算/流与标记独立截断/泳道数超限前缀+全局 notes;
- prove-red:framesRemaining 恒 MAX_SAFE_INTEGER 变异→2 钉红,cp+cmp 字节还原→5 绿;
- 门禁:eslint 0 / tsc 0 / vitest 861 文件 10406+8skip EXIT=0 / xvfb demo 25 RC=0。

## 登记(批 2 候选,不阻塞)

configVisualizerPanelHtml 键树节点数无上限:defaults 键树实际数百-千键级,低风险;若未来大配置项目出现渲染卡顿,补节点数预算+尾注。
