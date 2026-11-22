# PYLANCE-CRASH-001 kode 侧自查取证（2026-11-19）

用户原话锚定:「装了插件 pylance 就是反复报错崩溃 不安装就没有事」。
任务书:`~/.hermes/cache/scratch/tasks/kode-pylance-crash.md`。纪律=先取证
再动代码,禁止无证据改 provider 行为——本记录是 kode 侧可自主完成的取证面,
**未做任何代码改动**。

## 1. pylanceWire 真机验证链复跑(耦合面⑤)

当前 main(70d26383,kode-fixverify worktree)复跑
`node ./out/test/electron/runTest.js --pylancewire`(三段共用套件
`src/test/electron/suite/pylanceWire.test.ts`,挂**本机用户真实扩展目录**
`~/.vscode/extensions`,真 Pylance 2026.4.1 + VS Code 1.146.0 + xvfb):

| 段 | 被测面 | 结果 |
| --- | --- | --- |
| 1 | demo 标准布局默认激活链(stubCopy 关,extraPaths 变量形态) | 2 passing |
| 2 | 同工作区 stubCopy:true 重启,激活链 silent 复制桩包 | 2 passing |
| 3 | 探测范围外布局(kode 零写入+真 Pylance 全 unresolved 负例臂) | 2 passing |

EXIT=0,extension host 正常退出(code 0)。日志关键行
(`[rust-263-pylance] pylance version=2026.4.1`、
`settings python keys={"extraPaths":["${workspaceFolder}/scripts","${workspaceFolder}/.kbengine/stubs"]}`、
`DemoConsts def targets=[.../scripts/common/DemoConsts.py]`)与
2026-11-18 收官基线一致。**结论:kode 默认链+真 Pylance 共存在本机当前
main 上无可复现崩溃。**

诚实边界:夹具=demo 资产副本,非用户真实工程;用户工程的体量/内容/其他
扩展组合不在本复跑覆盖内。且用户装的 kode 版本未取证(可能是 nightly 滚动
件,非本仓 HEAD)——已列入待用户回帖项。

## 2. 五耦合面审计(静态取证)

### ① stub 文件面 — 干净

内置桩包 `typings/`(51 个 .pyi,2026-11-19 机核):

- 编码:51/51 UTF-8 有效(iconv 全过),零非 UTF8;
- 语法:51/51 `ast.parse` 通过(python3 实测);
- 循环 import:import 图机核——进程包(base/bots/cell/client/dbmgr/
  interfaces/logger/loginapp)→ `_kbengine_shared.*` 严格单向;shared 内部
  EntityCall→EntityComponentCall→{_vectors,_types}、_types→._vectors,
  无回边,cycle-candidates=[](**零循环 import**);
- 路径:最长路径 <200 字符,零超长路径;
- 写盘:三条动态生成链(KBEngine 桩复制/pythonTypeStubs/entityTypeStubs)
  共用 `fileSystemStubExportDeps`→`writeFileAtomic`
  (src/pythonStubExport.ts:278-299,utf8+临时文件+rename);内置桩包
  copy-if-absent 零覆盖(src/pythonStubExport.ts:7);
- pyrightconfig.json:写点 `syncProcessPythonConfiguration`
  (src/pythonProcessConfig.ts:72 起)——JSONC 解析合并,用户键/用户执行
  环境永不覆盖,extends 与 tool.pyright 场景告警保留原文件。注意 RUST-263
  附带裁定(2026-11-18):**Pylance 实读 pyrightconfig.json**,故该面在
  Pylance 耦合里真实在役,本审计覆盖其写点。

### ② 语义 token 冲突 — 默认关,与冲突矩阵一致

`kbengine.semanticTokens.enabled` default **false**(package.json:1692-1696)。
用户未显式开过即无双注册。

### ③ 诊断/completion 双注册 — kode 不抢 Pylance 诊断面

python 文档选择器(src/activate/infrastructure.ts:192-194)上注册的只有:
completion(languageServices.ts:131,含 .def 合选)、signature-help
(:182)、hover(:213)、entity_types CodeLens(generators.ts:155)——
全部是 VS Code 多提供者聚合面。**kode 无任何 python 诊断 collection
注册**,诊断面 Pylance 独占(RUST-148 冲突矩阵在役核实)。

### ④ 文件监听风暴 — 设计上自收敛,无 kode↔Pylance 环

- 托管目录 watcher(`**/.kbengine`+`**/.kbengine/**`,
  src/activate/generators.ts:222-227)任何事件→silent 重导链,重导=内容
  比对零写或缺失才写——一回合收敛,不自激;
- Pylance 不写工作区文件,环需要两边都写,构造上不成立;
- settings 同步无 churn:extraPaths `plan.changed` 差分闸
  (pythonExtraPaths.ts:330-340)、stubPath 现值对齐零写(:354-362)、
  diagnosticSeverityOverrides 键级合并值对齐零写——对齐态零写盘,
  不会反复触发 Pylance 重分析。

## 3. 待用户取证项(自主模式不可得,如实登记)

kode 侧五面自查全部干净+真机复跑绿,但**崩溃定性仍缺原文**。请用户提供:

1. `Output → Python Language Server` 面板报错原文(反复报错的具体文案);
2. `Output → Window` 面板报错原文(判断是扩展宿主崩还是 Pylance 语言
   服务器自身 crash loop);
3. 三个版本号:VS Code 版本、Pylance 版本、kode 扩展版本(用户装的可能是
   nightly 滚动件,非本仓 HEAD);
4. 崩溃工作区形态:哪个工程、scripts 规模、是否开过
   `kbengine.python.stubCopy`/`kbengine.semanticTokens.enabled`。

## 4. 临时绕过指引(取证期间)

> 注:本节基于 2026-11-19 的默认态(stubCopy 默认关)。2026-11-20 用户裁定
> `kbengine.python.stubCopy` 默认**开**、`kbengine.infer.enabled` 默认**开**
> 后,本节前提已过时,默认态接触面清单与绕过指引以 §6 为准。

两项写入面默认已是关态(本记录 §2 核实):`kbengine.python.stubCopy`
default false(不自动往工作区复制桩包)、`kbengine.semanticTokens.enabled`
default false。若用户曾手动开过请先关;默认态下 kode 对 Pylance 的接触面
只剩 settings 差分写入(零 churn)与聚合类 provider(hover/completion/
signatureHelp/codeLens),无诊断抢占无写盘风暴。

## 5. 结论

kode 侧自查:五耦合面零命中已知崩溃模式(循环 import/超长路径/非 UTF8/
诊断双注册/监听环/settings churn),真机复跑当前 main 三段全绿。崩溃定性
挂起等用户 crash 原文——若最终定性为 Pylance 自身 bug 与 kode 无关,将按
任务书第 4 步落版本对+复现步骤的独立记录。

## 6. 默认态复验(2026-11-23)——stubCopy/infer 默认翻后新接触面

### 前提更正(§4 已过时)

2026-11-20 用户裁定:`kbengine.python.stubCopy` 默认**开**(17570cb5 落地)、
`kbengine.infer.enabled` 默认**开**(77021bd6 落地);`kbengine.semanticTokens.enabled`
仍默认**关**。工作树实测:stubCopy default true(package.json:2096-2099)、
infer.enabled default true(:1941-1944)、semanticTokens default false
(:1789-1792)。§4「两项写入面默认已是关态」前提作废,默认态下 kode 对
Pylance 的接触面比 §4 所述**更大**:多出激活期桩包复制与 infer 生成桩两条
写盘面。本复验把这两条新面纳入环分析。

### 新接触面 A——激活期桩包复制(默认开)

`exportKbeStubs`(src/pythonStubExport.ts:386)双闸:总闸
`kbengine.python.stubExport`(默认开)先行,窄闸 `kbengine.python.stubCopy`
(默认开,非 manual 时)其次——默认态激活期 silent 复制确实走。复制实现
`copyTemplateIntoFolder`(:326)=**copy-if-absent 铁律**:目标已存在直接
`continue`(:360),零覆盖零删;唯一删=旧单文件 KBEngine.pyi 带 kode 生成
标记的一次性迁移(:346-352),迁移后不再出现,单回合收敛。行为锚:
`tests/pythonStubExport.test.ts:259`「copy-if-absent 铁律:目标已存在
零字节动(用户魔改保留),缺的补上」,2026-11-23 复跑 25/25 绿。

### 新接触面 B——infer 生成桩车道(默认开)

`runInfer`(src/inferPipeline.ts:445)先核 `kbengine.infer.enabled`,再
`discoverPyrefly`;`kbengine.infer.pyreflyPath` 默认空串且未安装时静默
`status:'not-found'` 返回(:456-463),零写零崩——**默认开但未装 pyrefly 时
infer 是 no-op**。生成的 `.pyi` 由 **pyrefly 子进程**写
(:538 `spawn(pyreflyPath,['stubgen',...])`):pyrefly 是 Pylance 同源工具,
产物格式 Pylance 原生可解析,**格式面排除「生成 .pyi 崩 Pylance」**。
`infer.sourceWrite` 默认 "managed"(写权限闸 `assertWritable` 限 managed 域)。

### 环断证明(关键)——无 kode↔Pylance 自持环

托管目录 watcher(`**/.kbengine`+`**/.kbengine/**`,src/activate/generators.ts:222-236)
**只挂 `onDidDelete`**(:229)——全仓唯一 `.kbengine` watcher,无任何
onDidCreate/onDidChange 挂点,故 kode 往 `.kbengine` 的**写**永不触发 kode
重导。`generatePythonStubs`(generators.ts:60,watcher 重导入口)调
**`exportKbeStubs`(copy-if-absent,零删)** 而非 `resetKbeStubs`;
`resetKbeStubs`(delete+rewrite,src/pythonStubExport.ts:479)**仅**显式命令
`kbengine.python.resetStubs`+用户确认(generators.ts:102-111)触发。
`exportPythonTypeStubs`/`exportEntityTypeStubs` 零删(源码 grep 无
deleteFile)。→「删→重导→删」环需要重导路径删文件,而 watcher 路径的重导
(copy-if-absent)不删;**结构上无自持环**。Pylance 只读消费 kode 输出
(pyrightconfig.json 实读,RUST-263 裁定)不写回——互触发环需要两边都写,
构造不成立。

### 结论

当前默认态下 kode 侧无自持写/删环,§4「默认态只剩 settings 差分写入+聚合
provider」表述按新默认态修正为:settings 差分写入+激活期桩包复制
(copy-if-absent 零覆盖)+infer 生成桩(pyrefly 原生格式)+聚合 provider。
若用户怀疑 kode 面,可关 `kbengine.python.stubCopy`/`kbengine.infer.enabled`
(semanticTokens 已默认关)作交叉排除。**崩溃定性仍挂等用户报错原文+三
版本号**——本行不勾,待用户回帖后按原文定性(Pylance 自身 crash loop vs
kode 挤轧)再定修复批。
