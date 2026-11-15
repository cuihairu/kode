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

- **本扩展 `activate()` 同步体精确耗时**:见上,需扩展内常驻埋点,未接线。
- **RUST-022 的 publish 端到端段**:仍未测(本行不勾)。
- 本批量的是**扩展开发态**(`extensionDevelopmentLocationURI` 指向仓库根),不是
  安装态 VSIX。安装态的激活发现成本不同,两者不可混用。
