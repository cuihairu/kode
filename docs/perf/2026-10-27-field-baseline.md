# P0-4b 现场基线(2026-10-27)

> 取证口径:真 VS Code 扩展宿主(`@vscode/test-electron`,缓存 VS Code 1.141.0)内脚本化执行
> hover/definition/保存/突发请求;启用(Kode 激活)与禁用(VS Code 裸面)两场对照。
> 采集脚本 `src/test/electron/suite/fieldBaseline.test.ts`,入口 `pnpm test:demo:field`
> (`runTest.js --field`);原始行 `FIELD-METRIC`/`FIELD-SUMMARY` 落
> `docs/perf/2026-10-27-field-baseline-run.txt`(启用)与
> `docs/perf/2026-10-27-field-baseline-disabled-run.txt`(裸面)。
> 单次 CI(xvfb)采样,非统计硬化;数字为现场一次实测,读数看数量级与两面对照,不作绝对 SLA。

## 1. 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| VS Code(harness) | 1.141.0(`.vscode-test/vscode-linux-x64-1.141.0`) | `env.vscodeVersion` |
| 本机已装扩展(实测) | `cuihairu.kode-kbengine-0.1.2`、`cuihairu.kode-0.1.0`(共 3 个,无 Python 语言服务) | 现场检查 |
| OS / CPU / 内存 | linux 7.0.0-38-generic x64 / 14 核 / 47077 MiB | `env.platform/cpus/totalmemMiB` |
| Node | v24.21.0(扩展宿主) | `env.nodeVersion` |
| 工作区 | `/tmp/kode-kbengine-field-*/kbengine-demo-assets`(demo 资产副本) | `env.workspace` |
| 外部资产根 | `/tmp/kode-kbengine-field-*/perf-assets/large`,生成器现造 5000 个 `.py`(绝对路径,真扫描外部根) | `env.assetsRoot` |
| **Python 语言服务** | **未安装(本机无 Pylance 等)** → 下文「Python 语言服务索引」一栏为空,本场的 `python-index-scan` 是 **Kode 自有 Python 索引**,非外部 Python LS | 现场检查 |

## 2. 禁用对照的方法(为何是「真裸面」)

开发扩展经 `extensionDevelopmentPath` 强制加载,且其激活由 `workspaceContains`/`onLanguage`
自动触发;`--disable-extension` 对开发扩展无效,仅跳过 suite 的 `activate()` 也不足以关掉它
(首轮对照实测 definition ok=51,扩展仍激活)。最终禁用模式把 `extensionDevelopmentPath`
指向**空目录**——扩展完全不加载,provider 不注册,suite 仍经 `extensionTestsPath` 在宿主内运行。
签名:`cold.firstDefinitionTargets=0`、除 `sessionEnd` 外**无任何 FIELD-SUMMARY**、
CPU/内存显著低于启用场 → 确为 VS Code 裸面下限。

## 3. 启用(Kode)vs 禁用(裸面)对照

| 指标 | 启用(Kode) | 禁用(裸面) | 增量 |
|---|---|---|---|
| 冷启动首个 definition | 1197.22ms(3 目标) | 33ms(0 目标,空命令往返) | 含 python-index-scan 首查等待 |
| 热态 hover P50 / P95 / P99(ms) | 15.62 / 65.78 / 166.88 | 1.56 / 15.31 / 36.78 | +14.1 / +50.5 / +130.1 |
| 热态 definition P50 / P95 / P99(ms) | 7.96 / 24.75 / 38.51 | 1.35 / 3.95 / 28.68 | +6.6 / +20.8 / +9.8 |
| 未知符号 hover/def P50(ms) | 1.44 / 1.21 | 3.80 / 1.47 | 未命中分支廉价(裸面更高是抖动) |
| 连续保存后首跳(ms) | 2.79 | 11.92 | 保存风暴不拖首跳 |
| 突发 20 路 definition 墙钟(ms) | 15.46 | 21.85 | 并发不排队恶化 |
| 突发前后宿主事件循环 P99(ms) | 31.11 → 31.11 | 33.19 → 33.19 | 突发未推高 P99(无残留堆积) |
| 扩展宿主 CPU(user+sys, 采样窗) | 3.24 + 0.97 = 4.21s | 1.58 + 0.40 = 1.98s | +2.23s |
| 扩展宿主内存(VmHWM / RSS 峰) | 225 / 225 MiB | 177 / 176 MiB | +48 MiB(+27%) |
| 事件循环延迟 P50 / P95 / P99 / max(ms) | 20.20 / 22.69 / 31.11 / 69.93 | 20.20 / 21.22 / 33.19 / 47.35 | Kode 未显著抬高事件循环 P50/P95 |

读法:热态 hover 端到端 P95 65.78ms **超既定 30ms 目标**,但需拆两层看——
Kode 侧内部计时(`FIELD-SUMMARY hover`)P50=1.2ms/P95=2.2ms,远低于预算;
端到端 = VS Code provider 派发(裸面 P95 已 15.31ms)+ 背景索引未完时的前几次重叠
(冷首查 1197ms 期间的 hover 计入尾部)。裸面下限本身即带 CI 抖动(裸面 miss.hover P95
41.91ms 高于启用场),故尾部读数应看数量级与对照,单次采样不作绝对结论——P0-4c 需长会话
统计硬化后才能定性。

## 4. 索引账(Kode 索引 vs Python 语言服务索引)

| 事件 | 次数 | P50 / P95 / P99 / max(ms) | 发现 / 读取 / 解析文件数 | 状态 |
|---|---|---|---|---|
| `python-index-scan` | 1 | 1051.2 / — / — / 1051.2 | 5044 / 5044 / 5044 | ok=1 |
| `entity-mapping-scan` | 1 | 834.4 / — / — / 834.4 | 11 / 8 / 8 | ok=1 |
| `python-composition-roots` | 1 | 159.2 / — / — / 159.2 | 15 / 15 / 15 | ok=1 |
| `file-discovery` | 7 | 114 / 233.1 / — / 233.1 | 5070 / 0 / 0 | ok=7 |
| `document-parse` | 5047 | 0 / 0.1 / 0.1 / 2.1 | — / — / 5047 | ok=5047 |
| `hover`(Kode 内部) | 70 | 1.2 / 2.2 / 4.8 / 4.8 | — | missStatus=70(未命中语义) |
| `definition` / `semantic-query` | 92 / 92 | 1.8 / 4.7 / 1130.3 / 1130.3 | — | ok=51 miss=41 |
| `diagnostics` | 11 | 0.4 / 3.7 / 3.7 / 3.7 | — | ok=11,miss=11 |

- **区分口径**:本机无 Python 语言服务,故「Python 语言服务索引」=空;表中 `python-index-scan`
  是 Kode 自有 Python 索引(扫描外部根 5044 个 `.py`,单次 1051ms)。
- `definition` P99=1130.3ms 为**冷首查**(含 python-index-scan 未完成时的等待),热态 P95=4.7ms
  (Kode 内部)/24.75ms(端到端)。冷启动与热缓存严格分开报告,不互相替代。

## 5. 取消与残留(如实)

- 公开命令面(`vscode.executeHoverProvider/DefinitionProvider`)不暴露请求级取消 token,
  故**不虚构**单请求取消语义;取消以两面近似:①突发 20 路并发的宿主响应性
  (墙钟 15.46ms,事件循环 P99 突发前后 31.11→31.11 无堆积);②指标摘要 `cancelled` 计数
  (本场全 0,索引扫描均 ok 收尾,无取消中断残留)。
- 无专用「取消后残留任务」量规;残留以「突发后事件循环 P99 回落 + 无 cancelled/error」双面佐证。
- CPU 为进程级差分采样(500ms 一格),**非 flamegraph**;内存为 VmHWM + RSS 峰。

## 6. 对 P0-4c 的移交

- 本场已覆盖:冷启动、外部根、未知符号、连续保存、首次跳转、突发/响应性、事件循环、资源账、
  启用/禁用对照。
- P0-4c 尚缺:①真实 Python 语言服务(Pylance 等)同时启用的联合面(本机未装,需装后再验);
  ②长会话统计硬化(本场单次采样);③hover 取消的请求级 token 面(公开命令不可达)。
- 目标对账:热态 Hover 端到端 P95 65.78ms(目标 ≤30ms)、Definition P95 24.75ms(目标 ≤50ms,
  已达标)——Hover 差距需在 P0-4c 长会话 + 装上 Python LS 后重测定性。

## 7. 复跑命令

```bash
pnpm test:demo:field                          # 启用场(写 2026-10-27-field-baseline-run.txt)
KODE_FIELD_MODE=disabled pnpm test:demo:field  # 裸面场(写 ...-disabled-run.txt;须先设 KODE_FIELD_OUT)
```
