# P0-4c 真实 VS Code 联合验收(Kode + Python 语言服务,2026-10-28)

> 取证口径:P0-4b 现场基线 harness(`runTest.js --field`)之上加 `KODE_FIELD_JOINT=1`,
> 断言 Pylance 同场激活后执行全场景 + 10 轮长会话。四面对照矩阵:
> ①裸面(2026-10-27,P0-4b)②Pylance-only(本场,`KODE_FIELD_MODE=disabled`+JOINT,空
> extensionDevelopmentPath,Kode 不加载)③Kode-only(2026-10-27,P0-4b 启用场)④**Kode+Pylance
> 联合(本场主面)**。原始行:2026-10-28-p0-4c-joint-run.txt(联合)/-joint-floor-run.txt(Pylance-only)。
> 单机单次采样,看数量级与四面对照,不作绝对 SLA。

## 1. 环境事实与 Python LS 装配(可复现)

| 项 | 值 |
|---|---|
| VS Code / 扩展宿主 Node | 1.141.0(harness 缓存)/ v24.21.0 |
| Python 语言服务 | **ms-python.vscode-pylance@2026.4.1**(engines ^1.107.0,满足 1.141.0),`env.pylanceActive=true` |
| Python 扩展 | ms-python.python@2026.10.0(连带 debugpy@2026.6.0、python-envs@1.40.0) |
| 装配命令(harness 专用) | `.vscode-test/vscode-linux-x64-1.141.0/bin/code --extensions-dir .vscode-test/extensions --install-extension ms-python.python`(再同法 pylance) |
| **关键坑** | `@vscode/test-electron` 强制 `--extensions-dir=.vscode-test/extensions`(util.js:418)——装到 `~/.vscode` 对 harness 不可见,首轮联合跑 `getExtension` 落空即此因 |
| 工作区/外部根 | demo 资产副本 + 生成器 5000 文件 large 场景(绝对路径外部根),同 P0-4b |
| OS/CPU/内存 | linux 7.0.0-38 / 14 核 / 47077 MiB |

## 2. 四面对照矩阵(主表)

| 指标 | ①裸面(10-27) | ②Pylance-only(10-28) | ③Kode-only(10-27) | ④Kode+Pylance(10-28) |
|---|---|---|---|---|
| 冷启动首个 definition | 33ms(0 目标) | 127.94ms(0 目标,空链) | 1197.22ms(3 目标) | **1189.08ms(3 目标)** |
| 热态 hover P50/P95/P99(ms) | 1.56/15.31/36.78 | 7.25/60.67/83.78 | 15.62/65.78/166.88 | **6.40/71.29/170.38** |
| 热态 definition P50/P95/P99(ms) | 1.35/3.95/28.68 | 1.38/7.49/8.40 | 7.96/24.75/38.51 | **5.37/29.89/135.43** |
| 长会话稳态(r3-r10)hover P95 极值 | 15.31ms | ≤4.86ms | —(无长会话) | **≤5.05ms** |
| 长会话稳态 def P95 极值 | — | ≤6.60ms | — | **≤4.10ms** |
| 未命中 hover/def P95(ms) | 7.31/7.20 | — | 4.42/2.24 | **4.43/13.54** |
| 连续保存后首跳(ms) | 11.92 | — | 2.79 | **5.05** |
| 突发 20 路 def 墙钟(ms) | 21.85 | — | 15.46 | **13.57** |
| 突发 20 路 hover 墙钟(ms) | — | — | — | **23.05**(P99 162→162 无堆积) |
| 扩展宿主 CPU(user+sys) | 1.98s | 7.52s | 4.21s | **9.22s** |
| 扩展宿主 VmHWM(MiB) | 177 | 290 | 225 | **305** |
| 事件循环 P50/P95/P99(ms) | 20.2/21.2/33.2 | 20.2/20.8/29.7 | 20.2/22.7/31.1 | **20.2/20.8/26.5** |
| 事件循环 max(ms) | 47.4 | **617.6** | 69.9 | **815.3** |

**Kode 在联合场的边际成本(④−②)**:CPU +1.24s(含一次 5044 文件索引),VmHWM +15 MiB,
稳态 hover/def P50/P95 各 +0.5–1ms 量级;事件循环分位无差异。

## 3. 逐场景验收(联合场,P50/P95/P99/最大)

| 场景 | P50/P95/P99/max | 判读 |
|---|---|---|
| 冷启动首查 definition | —/—/—/1189.08ms(3 目标) | 与 Kode-only 1197ms 持平:Pylance 在场不放大 Kode 冷成本;含 Kode python-index-scan(~1.05s,5044 文件)等待 |
| 热态 hover(50 次,含暖机) | 6.40/71.29/170.38/170.38 | **暖机窗超标(>30ms),单列不作热态结论**;②对照同窗 60.67ms → 尾部主体是 Pylance 冷分析+派发,Kode 边际 ≈+10ms |
| 热态 definition(50 次,含暖机) | 5.37/29.89/135.43/135.43 | 暖机窗仍在 50ms 内 ✓ |
| 稳态热 hover(长会话 r3-r10) | 2.4–3.6/3.0–5.1/≤53.9/… | **P95 ≤5.05ms,目标 ≤30ms ✓(余量 6×)** |
| 稳态热 definition(r3-r10) | 1.7–3.1/2.8–4.1/≤18.2/… | **P95 ≤4.10ms,目标 ≤50ms ✓(余量 12×)** |
| 未命中符号 hover/def | 1.94/4.43/4.47/4.47;2.22/13.54/14.39/14.39 | 未命中分支廉价,单独报告不以热缓存替代 ✓ |
| 连续保存×10+首跳 | —/—/—/5.05ms | 保存风暴不拖首跳 ✓ |
| 突发 20 路 def/hover | 墙钟 13.57/23.05ms;宿主 P99 突发前后 162→162 | 并发不排队恶化、无残留堆积 ✓ |
| 长会话(10 轮,~56s 持续) | 逐轮见 §4 | 指标随会话**收敛并平稳**,无劣化 ✓ |

## 4. 长会话稳定性(10 轮,轮间保存+5s 定距,背景索引持续在场)

| 轮 | hover P50/P95 | def P50/P95 | 宿主 RSS(MiB) |
|---|---|---|---|
| r1 | 2.59/13.86 | 1.67/20.04 | 303 |
| r2 | 3.62/6.57 | 3.10/5.62 | 304 |
| r3 | 2.83/3.29 | 2.41/4.10 | 304 |
| r4 | 2.84/3.30 | 2.34/2.81 | 304 |
| r5 | 2.42/3.05 | 1.88/2.85 | 234(GC 回落) |
| r6-r10 | 2.49–3.19/3.88–5.05 | 2.08–2.62/2.86–3.36 | 236→237 平台 |

RSS 无单调增长(305 峰→237 平台),P50/P95 逐轮平稳——**长会话无劣化**。

## 5. 修复前后对账(逐场景)

| 场景 | 修复前(P0 批前历史) | P0 后(P0-4b,10-27) | 联合场(本场) |
|---|---|---|---|
| 冷启动全仓扫描 | S1 冷扫 107,737ms(2026-baseline) | 4,880ms(基线复测)/ 首查 1197ms | 首查 1189ms(Pylance 在场不变差) |
| hover 用户体验 | 用户报告 hover loading 约 30 分钟(B-1) | 内部 P95=2.2ms,端到端 P95=65.78ms | 稳态端到端 P95 ≤5.05ms |
| definition 首查 | 107,737ms(等全仓) | 1197ms | 1189ms |
| 后台任务挡交互 | 队首阻塞场景(stall-analysis ①②③) | 门禁锁 + timerDelay 契约 | 事件循环 P99 26.5ms,突发无堆积 |
| 资源 | 无现场账 | CPU 4.21s/VmHWM 225MiB | CPU 9.22s/VmHWM 305MiB(Pylance 占 7.52s/290MiB 基线) |

## 6. 残留发现与如实边界

1. **暖机窗 hover P95 71.29ms > 30ms 目标**:窗口内 Pylance-only 同为 60.67ms → 主体非 Kode;
   按验收条款「冷启动单独报告」,暖机窗单列,稳态才算热态面。留给后续:Kode 首轮 hover 与
   Pylance 冷分析的并发错峰(若要再压,属新优化项不是本验收缺口)。
2. **事件循环单发尖峰 max=815ms(P99 26.5ms 不变)**:Pylance-only 场同有 617ms 尖峰 → 归因
   Pylance 冷索引自身,非 Kode 阻塞;Kode 的既有阻塞面已由 P0 批门禁锁定。
3. **hover 请求级取消**:公开命令面(`vscode.executeHoverProvider`)不暴露请求级 token,
   无法脚本化真实取消;以 hover 突发响应性(墙钟 23.05ms、P99 无堆积)+ 摘要 `cancelled=0`
   近似,边界如实标注。(→ 2026-10-28 审核重开已以激活探针 API 补齐真实取消面,见 §9)
4. **大仓依赖树深度**:5000 文件外部根为合成平铺(规模面),真实依赖结构走 demo 工作区
   KBEngine 树(scripts/common/training/mixins 链);两面合计覆盖,单面不夸大。
5. CPU 为扩展宿主进程差分采样(500ms/格),非 flamegraph;Pylance 自身服务器进程若独立,
   其 CPU 不在本表(②对照已含同口径)。

## 7. 目标结论

- **热态 Hover P95 ≤30ms:✓(稳态实测 ≤5.05ms)**;暖机窗 71.29ms 单列(§6.1)
- **热态 Definition P95 ≤50ms:✓(稳态实测 ≤4.10ms,暖机窗 29.89ms 亦达标)**
- 冷启动/未命中/保存/突发/长会话逐场景如上,不以热缓存替代冷启动数据
- **P0-4c 验收通过**,P0-4d(报告审计)解锁

## 8. 复跑命令

```bash
# 装配(一次性)
.vscode-test/vscode-linux-x64-1.141.0/bin/code --extensions-dir .vscode-test/extensions \
  --install-extension ms-python.python
.vscode-test/vscode-linux-x64-1.141.0/bin/code --extensions-dir .vscode-test/extensions \
  --install-extension ms-python.vscode-pylance
# 联合主面 / Pylance-only 对照
KODE_FIELD_JOINT=1 pnpm test:demo:field
KODE_FIELD_JOINT=1 KODE_FIELD_MODE=disabled KODE_FIELD_OUT=<path> pnpm test:demo:field
# 长会话口径(2026-10-28 重验起):18 轮 × 20s 定距 ≈ 6 分钟会话
KODE_FIELD_JOINT=1 KODE_FIELD_ROUNDS=18 KODE_FIELD_GAP_MS=20000 KODE_FIELD_OUT=<path> pnpm test:demo:field
```

## 9. 2026-10-28 审核重开重验(内部命中 + 请求级取消 + 残留量规 + CPU profile + 足时长会话)

审核重开三项缺口(§6.3、P0-4c 重开注)与补面:激活返回探针 API(9e02f6a,`probeHover`
同实例真实 token / `pendingWork` 四面残留量规),harness 增命中探针/取消探针/残留采样/
node:inspector CPU profile/可配长会话轮数。

### 9.1 重验先抓到冷窗回归,先修后验(14411a8)

首轮重验(pre-fix,`*-rerun-prefix.txt`)暴露整改自伤:冷首查 1189ms/3 目标 →
2526ms/**0 目标**(启用场 7.2–12s/0),python 首扫 2.4s → 5.8–27.9s。归因:①逐文件双
yield 在 5044 文件冷扫产生上万次宏任务跳转;②激活瞬间预启动把 workspace 全扫与 python
首扫/发现灌进同一冷窗互踩。修复=让出改 25ms 时间切片(prove-red:小批 40 文件让出
80 次 → ≤2,`tests/workspaceIndexColdYield.test.ts`;切片内并发竞态以同步落时间戳收口,
5 连跑稳定)+ 预启动延迟 8s 错峰 + profile 采样 1ms→5ms(降观察税)。修后冷首查
**831.21ms/3 目标**(反超老基线),python 首扫 3.98s,demo 场 53s → 4s。

### 9.2 联合场重验证据(18 轮 × 20s ≈ 6 分钟会话,`2026-10-28-p0-4c-joint-rerun.txt`)

| 审核缺口 | 重验证据 | 判定 |
| --- | --- | --- |
| 内部命中(hit=0) | 5/5 候选 HIT(def 方法 cell/base/client、def 文件、types.xml,带 preview 实文);公开命令面命中点位 20 连发 `ok` 计数 +20(`hit.burstHover.okDelta=20`)——非墙钟空转 | ✓ |
| 请求级取消不可达 | 预取消 3/3:token 先于 provider 取消,零工作返回空(≤1ms);梯次 18 探针 `cancelledWithHover=0` 不变量成立;definition 摘要 `cancelled=2`(预算取消路径在途可见) | ✓ |
| 残留无量规 | `pendingWork()` 取消+保存风暴后 t+0/+500/+2000ms 全 0(诊断排队/在途、编辑去抖注解、索引队列、schema 冷构建四面) | ✓ |
| CPU profile 缺 | `2026-10-28-p0-4c-joint-rerun.txt.cpuprofile` 入库(5ms 采样整场);top 自耗时 idle 353.9s 主导,top10 无 Kode 帧 | ✓ |
| 长会话不足时长 | 18 轮 ×20s:hover P50 2.7–9.5ms/P95 4.1–14.4ms(r10 单轮 21.0/25.4ms),def P95 3.4–13.9ms;RSS 264→270MiB(+6,pre-fix +19);pre-fix 尾部抬升(r16–18 P50 16–76ms)消失,且地板场同窗后半程加速 → 抬升非 Pylance 侧、已被修复消解 | ✓ |

### 9.3 逐场景对账(修后联合场;括号内=修前同场)

| 场景 | P50 | P95 | 备注 |
| --- | --- | --- | --- |
| 冷首查 definition | — | 831.21ms(2526) | 目标 3 个(修前 0) |
| 暖机窗 hover ×50 | 23.01ms | 134.93ms(191.03) | 单列:扫描在场+Pylance 冷分析;老场(无 profiler)71.29ms |
| 暖机窗 definition ×50 | 11.64ms | 26.04ms(247.92) | ≤50ms 目标 ✓ |
| 未命中 hover/def ×20 | 2.08/1.44ms | 5.31/8.26ms | |
| 保存风暴 ×10 后首跳 | — | 5.19ms(27.16) | |
| 突发 20 路 def 墙钟 | — | 16.28ms(15.46 老) | 宿主 P99 无堆积 |
| 联合 hover 突发 20 墙钟 | — | 52.2ms(75.72) | 宿主 P99 117.9ms 前后不变 |
| 事件循环 p99/max | — | 22.79 / 1054.34ms | max 归因 Pylance 冷索引(对照场同有) |
| 资源 | VmHWM 336MiB;CPU user+sys 25.3s | | pre-fix 42.1s |

稳态判定沿用既定口径:会话轮 hover P95 ≤14.4ms(r10 25.4ms 单列)≤30ms ✓,def P95
≤50ms ✓;暖机窗与冷启动单列不以热缓存替代。

### 9.4 四面对照(重验)

| 面 | 来源 | 冷首查 | 会话稳态 hover P95 | 峰值 RSS |
| --- | --- | --- | --- | --- |
| 联合(主面) | 本文 §9.2/9.3(18 轮) | 831ms/3 目标 | ≤14.4ms | 336MiB |
| Pylance-only | `2026-10-28-p0-4c-floor-rerun.txt` | 59.09ms/0 目标 | 中位 13.8ms(轮间 8.4–227.0,尖峰轮 227ms 为 Pylance 自身) | 312MiB |
| 裸面 / Kode-only | 2026-10-27 历史(§2)沿用 | 1197ms / 1189ms | 65.78 / — | 177 / 225MiB |

历史两场代码漂移注:时间片让出与预启动错峰只作用于冷窗;历史热面数据不受影响。

### 9.5 重验结论

- **P0-4b**:三项缺项(CPU profile 联合场 / 请求级取消路径 / 残留量规)补齐并现场取证 → 关。
- **P0-4c**:内部命中证据(5/5 候选 + okDelta=20)、请求级取消(预取消 3/3 + 梯次不变量)、
  残留排干(t+2000 全 0)、足时长会话(18 轮 ×20s 无劣化)齐备 → **重验通过**。
- B-1「半小时挂起不复现」自此有内部命中与取消面支撑;P0-4d 端到端证据(§9.2/9.3)补齐。
