# TS 后端独立目录抽取 · 批次 13(log/异常族)2026-11-09

续批次 1-12,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

logHub / logParser / consoleLogTail / fileReadMetrics / exceptionSourceLocator

选族依据:零 `from 'vscode'` 的日志采集/解析/控制台尾随/读取度量/异常源
定位(共 ~1.3k 行)。**留 src/**:kbengineConsoleHub(vscode 混合,
consoleLogTail 经 `../` 回引)、logHub 装配面 wiring。

## 改动面

- import 重基 61 处,UNRESOLVED 恰为既有 13 假阳性零新增;consoleLogTail
  出向留守件(kbengineConsoleHub / nlsRuntime)与 backend 件(kbengineProtocol
  属后续批次,先改 `../`)——注意 kbengineProtocol 仍在 src/ 根,规则 (a)
  改 `../kbengineProtocol`,批次 14 挪入后如引用需再收敛(重基脚本幂等覆盖)。
- 反向面核验:tests/registry 零静态锚,零动态拼路径读。
- 活文档路径对账 4 处:features.md en+zh 各 2。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- **提交 02f3de97**(2026-11-09 推 main):50 文件 79+/53-,并发会话面零牵连。
