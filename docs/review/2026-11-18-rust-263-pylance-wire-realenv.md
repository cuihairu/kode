# RUST-263 真机实证:kode Pylance 接线(默认激活链)的识别/变量形态/探测范围

- 日期:2026-11-18
- 结论:**三疑点全部真机收口,全绿**——①(识别/backlog B)桩包在盘+kode 默认激活链写出的接线之下,真 Pylance 对 `import KBEngine` 给出 `.kbengine/stubs/shared/KBEngine/__init__.pyi` 的定义落位与 `(module) KBEngine` hover,且 Pylance 诊断面无 unresolved;②(变量形态/backlog A)`${workspaceFolder}/scripts` 变量形态 extraPaths 在真 Pylance **生效**(`from common import DemoConsts` 定义落 `scripts/common/DemoConsts.py`);③(探测范围/backlog C)范围外布局 kode 对 `python.analysis.*` **零写入**,真 Pylance 照常报 `Import "KBEngine" could not be resolved`。
- 附带裁定(推翻在档前提):**Pylance 实读 kode 写出的 `pyrightconfig.json`**——RUST-170 档「Pylance 不读 pyrightconfig.json」系车道设计前提(该档两配置面内容一致,结果不受影响),本案段2 是首个两配置面分岔的真机反例,已按实测评注三处。
- 车道:`node out/test/electron/runTest.js --pylancewire`(真 VS Code 1.146.0 + 真扩展宿主,`--extensions-dir ~/.vscode/extensions` 挂本机 Pylance)三段发射,套件 `src/test/electron/suite/pylanceWire.test.ts` 按 `KODE_PYLANCE_WIRE_PHASE` 分流;与 RUST-170(手写 settings 测解析优先级)互补,本案被测面=kode **默认激活链自己写出来的接线**。

## 版本与夹具

- Pylance ms-python.vscode-pylance-2026.4.1;VS Code 1.146.0(run7 实测行);
- 段1/段2 工作区=tests/fixtures/kbengine-demo-assets 副本(`scripts/` 标准布局),settings 只关开窗提示——`python.stubExport`/`python.extraPathsSync` 留默认开(被测面就是默认激活链);探针 `scripts/pylance_wire_probe.py`(`import KBEngine` + `from common import DemoConsts`);
- 段3 工作区=`myserver/server/`(entities.xml/entity_defs/base 都在 server/ 下,四前缀 `scripts/`、`assets/scripts`、`server_assets/scripts`、一级 `*_assets/scripts` 全不中);激活不依赖布局(activationEvents 含 `onStartupFinished`)。

## 三段证据(run7,`[rust-263-pylance]` 原文摘录)

### 段1 默认态(stubCopy 默认关)

- settings(python.analysis):`{"extraPaths":["${workspaceFolder}/scripts","${workspaceFolder}/.kbengine/stubs"]}`(变量形态,kode 激活链写入);
- `DemoConsts def targets=["…/kbengine-demo-assets/scripts/common/DemoConsts.py"]`——**疑点 A 正例**:变量形态 extraPaths 被 Pylance 展开解析;
- `default-state KBEngine def targets=[]`——桩包不在盘(stubCopy 默认关=批③ 定案),`import KBEngine` 无定义落位=设计边界而非接线缺陷;
- `.kbengine/stubs` 下 KBEngine 桩包 0 件(断言钉)。

### 段2 同工作区改设 `kbengine.python.stubCopy: true` 重启

- 激活链 silent 自动复制:9 角色桩包落盘(base/bots/cell/client/dbmgr/interfaces/logger/loginapp/shared 各 `KBEngine/__init__.pyi`);
- `KBEngine def targets=["…/.kbengine/stubs/shared/KBEngine/__init__.pyi"]`,hover=` ```python\n(module) KBEngine\n``` `(moduleHash 注释为 Pylance 产物)——**疑点 B 正例**;
- **归属裁决**(诊断面=Pylance 独占,definition API 会聚合 kode provider 故不作数):段2 诊断=`["KBEngine" is not accessed / "marker" is not accessed]`,**无 unresolved**→ Pylance 自身完成了识别;对照段3 同文件同探针=unresolved;
- **机制钉死**:settings 有效值全程只有 `extraPaths=[scripts, stubs]`+`stubPath="typings"`(默认),`stubs/shared` 只存在于 kode 激活链写的 `pyrightconfig.json`(executionEnvironments 每角色 root 配 `[role, shared, stubs]` 搜索根)——Pylance 把 `import KBEngine` 解析到 stubs/shared 的唯一载体是它,即 **Pylance 实读 pyrightconfig.json**。kode 自身 kbe-stub 定义层跳内存虚拟桩文档(kbeModuleIndex buildKbeStubDocument),不可能产出盘上 fsPath,provider 假设排除。

### 段3 探测范围外布局(`myserver/server/`)

- 激活照常(`.kbengine/debug.json present=true`,activationEvents 命中),housekeeping 写入照旧(search.exclude/files.watcherExclude/files.associations 指向 `.kbengine/**`);
- `python.analysis.extraPaths`/`stubPath` **零写入**(断言钉)——范围界=只管 python 解析接线,非零写入主义;
- 诊断(Pylance 独占面):`Import "KBEngine" could not be resolved`;
- `KBEngine def=[]`;`scope_helper def=["…/myserver/server/scope_helper.py"]`——同级普通模块走 RUST-170 C 阶段同款**同目录兜底**(最低位来源,零接线时独活),与 KBEngine 的全 unresolved 成对照。

## 首跑红与迭代实录(七跑到绿,prove-red 性质)

1. run1:manual 命令 `kbengine.python.exportStubs` 尾部 `await showInformationMessage`(pythonStubExport.ts:465)headless 无人关闭→900s 悬死。真拷贝其实已完成,但命令链尾部(syncPythonExtraPaths)被通知卡住;
2. run2:`workbench.action.closeNotifications` 在 1.146 不存在→改道;
3. run3:段3 夹具误用 `myserver/scripts`——`scripts/` 是**文件夹相对**前缀,恰在探测范围内,负例臂作废(布局改 `server/`);同目录兜底断言误期望空(RUST-170 原裁定是排位序非绝对缺席)→翻转;诊断空[]=`openFilesOnly` 需 `showTextDocument` 真可见;
4. run4-5:def 落位 stubs/shared 但 settings 无该条目→归属疑云(kode provider?)→加诊断裁决臂;
5. run6-7:全绿+pyrightconfig 机制钉死。

manual 命令交互面(通知点击路径)headless 不可自动化,不声称;其拷贝/同步函数与 silent 激活路径同源(pythonStubExport copyTemplateIntoFolder + syncPythonExtraPaths),段2 覆盖同一链。

## 对接线面的含义(只读实证,零生产行为改动)

- 默认态(stubCopy 关)用户开箱 `import KBEngine` 是 unresolved——设计如此(批③);用户任一显式动作(开 stubCopy 设置/跑 exportStubs 命令)后 Pylance 即识别,链路全程无需手写任何 python.analysis 设置;
- 用户 2026-11-06 报「清理 `${}` 变量后很多包正常提示」与本案段1 实测(变量形态生效)不符→该现象的更可能解释=布局在探测范围外(段3 证实的零写入面)或桩包不在盘,非变量形态本身;backlog A 的「改绝对路径」方向失去实证依据,维持变量形态;
- Pylance 实读 pyrightconfig.json 意味着 kode 的双面写(settings.json+pyrightconfig.json)都在真机生效;pyright 车道配置(pythonProcessConfig)不再只是 pyright 用户福利。

## 边界(不声称的部分)

- Pylance 捆绑 server 仅在扩展宿主内驱动(RUST-170 已裁),无独立进程车道;
- 「识别」以 executeDefinitionProvider 落位+hover+诊断三面共同裁定,定义 API 的 provider 聚合性已用诊断面规避;未逐符号验证桩包内 API 符号(那是 truth-corpus 面);
- 段2 的 stubCopy:true 是设置面触发;manual 命令通知交互面未覆盖(如上);
- 三段日志为 2026-11-18 本机 run1..7 真机记录(Pylance 2026.4.1/VS Code 1.146.0 单机单日)。
