# RUST-022 extension activation 段实测(2026-11-15)

PERF-005 分段时延口径里唯一记为 Untested 的扩展侧段:
**extension activation(真实 VS Code)**。本批把它量出来,并把归属边界写成机器可核的字段。

## 做了什么

| 面 | 落点 |
| --- | --- |
| 纯解析核 | `src/backend/activationTiming.ts`:`parseActivationLog(text, extensionId)` 读宿主自带 exthost.log 文本,输出分段时刻 + 派生时延 + **尾随启动激活计数** |
| 单测(离线) | `tests/activationTiming.test.ts` 9 例,合成日志文本,不起宿主,进默认单测门 |
| 测量脚本 | `scripts/activation-latency.mjs`:同产物连开 N 次真 VS Code,每次**全新 user-data 冷启**,读宿主日志解析 |
| 取数缝 | `src/test/electron/runTest.ts`:env `KODE_ACTIVATION_BENCH_UD` 时把该路径当 `--user-data-dir` 传宿主(未设=零行为变化) |
| 原始证据 | `docs/perf/activation-run.txt` |

数据源**只有宿主自己写的 exthost.log**(info 级就有激活行)。实测 VS Code 1.141 的
`--prof-startup` 不额外落盘产物(冷启 + 干净 user-data 全盘找 `Code*`/`*Startup*.json`
为空),故不用它;`--verbose` 也未用(多出来的 trace 行不提供更精确的信号,见下)。

## 实测数字

环境:本机 14 核,xvfb,`tests/fixtures/kbengine-demo-assets` 工作区,VS Code 1.141,
`loadavg=5.48 9.88 18.22`(低载窗口),n=5。

| 段 | p50 | p90 | max | min |
| --- | --- | --- | --- | --- |
| hostStartToActivateMs(宿主起 → 本扩展激活入口) | 943 | 1059 | 1059 | 796 |
| activateToEagerMs(激活入口 → 启动期激活全量完成) | 1049 | 1190 | 1190 | 893 |
| hostStartToEagerMs(宿主起 → 启动期激活全量完成) | 1986 | 2084 | 2084 | 1785 |
| 单次冷启 wall(含 mocha 套件与宿主退出) | ~10.5 s | | | |

激活事件实测为 `workspaceContains:**/*.def`(`ACTIVATION_EVENT` 行)——即激活由
工作区里出现 .def 触发,不是 `onStartup`,故空工作区/无 KBEngine 资产的工作区不付出
这段成本。

## 归属边界(必读,否则上面的数字会误导)

宿主日志**没有 `activate()` 返回时刻**,所以这三段都不是本扩展 `activate()` 同步体的
精确耗时。可归属度依次递减:

1. **hostStartToActivateMs**——含宿主自身启动、扩展发现、以及本扩展之前所有启动期
   激活者的耗时。它是「到本扩展被调度为止」的墙钟,不是本扩展成本。
2. **activateToEagerMs**——混合窗口。本扩展激活入口之后、`Eager extensions activated`
   之前通常还有排队的启动期激活者(实测同宿主里 `ms-python.vscode-python-envs` 紧随其后),
   它们的时间会落进这一段。为免把别人的耗时算成本扩展的,解析核**每次输出
   `trailingStartup`**:本扩展入口后、Eager 前另有几个启动期激活者。本次 5 次里 3 次为
   1、2 次为 0(排程顺序不定),故 **activateToEager 必须与 trailingStartup 同看**,
   单读该段等于把其他扩展的激活体记在本扩展头上。
3. **本扩展 `activate()` 同步体的精确耗时——本批未测**,如实登记。要它就得扩展内埋点
   (`src/backend/activationProfile.ts` 的 `KODE_ACTIVATE_PROFILE_OUT` 阶段计时器已在库,
   但 `activate` 未常驻接线,属复测工具;2026-11-07 那份阶段耗时是用**临时布线**采的,
   期二终态不接线)。

另一处刻意不做的:trace 级 `ExtensionService#_callActivateOptional <id>` 看着像
「本扩展收尾」信号,但它在日志里同样覆盖其他扩展、且语义无法从日志自证为「完成」,
硬当成本扩展完成时间会造假精度。故解析核不收这个字段。

## 复跑

```bash
pnpm run compile && tsc -p tsconfig.mocha.json
xvfb-run -a node scripts/activation-latency.mjs --runs 5 --out docs/perf/activation-run.txt
```

脚本顶层不跑宿主、不进默认单测门(它 shell-out 真 VS Code);解析核的离线单测在
`tests/activationTiming.test.ts`,进默认门。

## 未覆盖

- **本扩展 `activate()` 同步体精确耗时**:已落地(见下「续批」),常驻埋点已接线。
- **RUST-022 的 publish 端到端段**:已落地(见下「续批」),`--pubbench` 真机套件已入仓。
- 本批量的是**扩展开发态**(`extensionDevelopmentLocationURI` 指向仓库根),不是
  安装态 VSIX。安装态的激活发现成本不同,两者不可混用。

## 续批(2026-11-15 第二轮):两段未覆盖均已落地

### activate() 同步体精确耗时(常驻埋点)

`src/extension.ts` `activate()` 已接线 `activationProfile` 常驻埋点:入口
`markActivateStage('enter')` 起,九个装配段位各落一标(L0 基础设施/L1 共享核心/L2
语言服务/L3 诊断调度/L4 服务器控制/L5 视图/L5 工具/end),返回前
`flushActivateProfile()` 落盘。仅调用方设置 `KODE_ACTIVATE_PROFILE_OUT`(输出文件
路径)时有行为,未设置时全部调用零开销直通(常态门禁与生产零影响;离线钉
`tests/activationProfile.test.ts` 3 例,进默认门)。

实测(同一 `KODE_ACTIVATE_PROFILE_OUT` 跨 5 次真实宿主激活累加,证据
`docs/perf/activation-profile-run.txt`;4 次 `--pubbench` 最小工作区 + 1 次
`--panelopen` 默认工作区):activate() 同步体 total **min 134.69ms / p50 156.08ms /
max 522.84ms**(522 为首启动与宿主其他启动期激活者争用的离群样本,其余落在
134.7-232.0ms)。分段构成(典型样本):L0 基础设施 60.7-67.6ms 为最大单段,
L5 工具命令 35.4-74.0ms 次之,L1 共享核心/L3 诊断调度均 <1-4ms 量级——「一直卡在
扫描」类用户感知与同步体无关,同步体本身 150ms 上下文,重量都在激活后异步段。

prove-red 两面:①模块面——摘 `flushActivateProfile` 的落盘写入 → 离线钉 2 例红,
`cp`/`cmp` 字节还原复绿;②接线面——摘 activate 里的 `flushActivateProfile()` 调用
→ `--panelopen` 真机轮(扩展照常激活)profile 文件 md5 不变(无新表),还原后同
命令新表追加(36→45 行)。接线面红=「埋点在库但 activate 不接线」的旧行为,检测器
是文件本身,不靠套件断言。

### publish 端到端(publish-to-editor)

新真机模式 `node out/test/electron/runTest.js --pubbench`(套件
`src/test/electron/suite/publishBench.test.ts`,storm 同形最小工作区:def BaseMethods
声明 mA/mB、python `self.cell.mA()` 必出段错配诊断),量诊断从「编辑落定」到「诊断
集合可见」的全链(PERF-005 记 Untested 的 UI 序列化+provider 派发段)。等待面=
`onDidChangeDiagnostics` 事件先到即取 + 25ms 轮询兜底(量化误差 ≤ 轮询粒度);诊断
不出=断言红,不静默装通过。证据 `docs/perf/publish-run.txt`(KODE_PUBBENCH_OUT 可
覆盖)。

实测(本机 xvfb,负载中等):`open.publish(any)` 845ms(open 起到首个诊断可见,
waitMs=0 即首诊在 open 调用序列内已落集合);`edit.publish` n=6 p50=25ms / max=71ms
(25ms=轮询量化地板;前一日同夹具低载窗实测 57-142ms,量级一致)。

两个诚实口径(写进套件注释,防后人误读):
1. **冷开注册表暖态**:def 注册表激活后异步装载,先于装载完成的 open 不会在注册
   完成时补触发段错配面(实测 open 后只见 receiverNone 警告,段错配要等首个编辑
   事件)——open 面因此量「首个任何诊断可见」=发布管道本身;段错配专面时延由
   edit.publish 各轮覆盖(注册表暖态,首编辑 142ms 内可见)。
2. **谓词 locale 无关**:段错配文案 en=`section mismatch`/zh=`段错配`
   (`l10n/bundle.l10n.zh-cn.json`),断言只认 `self.cell.<方法名> ` 前缀,两种
   locale 都成立;方法名互斥,mA/mB 不会互相假命中。

prove-red(接线面同上②);套件自身的红面=「20s 未见诊断即断言红」(首轮误用
zh-only 文案断言在 en 宿主红过一次,改 locale 无关谓词后绿,该教训已入套件注释)。

### 锚点锁步

`extension.ts` 顶部 import +1(activationProfile)、同步体埋点 +10 行 →
`onDidChangeTextDocument` 430→440、`flushQueued()` 529→539,`tests/perfCallChainDoc.test.ts`
ANCHORS 表与 `docs/perf/2026-baseline.md` 出处同笔锁步,迁移即红面复绿。

### 复跑(publish 端到端)

```bash
pnpm run compile && tsc -p tsconfig.mocha.json
KODE_ACTIVATE_PROFILE_OUT=/tmp/activation-profile.txt \
  xvfb-run -a node out/test/electron/runTest.js --pubbench
```
