# RUST-009 审计与落地:UI 在降级、Core 崩溃、无 KBEngine 引擎源码时仍可用

日期:2026-11-15。审计对象:todo.md RUST-009。方法:三轴全谱扫(src/ 激活面、面板、命令、状态栏)+ 既有降级测试网盘点。**结论:三轴架构性 PASS(降级面全走「Rust 失败→null→TS」与诚实空态),扫出 3 个小缺口,A1(激活期裸奔异步链)本批修,A2/A3 登记裁定不修。**

## 1. 三轴判定(全 PASS)

### 轴1 `kbengine.core.backend=ts`(降级)

- `resolveBackendMode`(kodeCoreGate.ts:59-70):非法值一律回落 ts,安全侧恒 TS;`serveFromRust()` 要求 rust 字面量且 serverPath 非空,否则回落 TS + 一次性 notice 存照(:325-327)。
- 全部 provider/命令消费面统一「Rust 失败→null/ok:false→TS」:serving 面 `serveInRust()` 注入 fallback;命令面 ~30 处 `runInRust` 消费(如 processTopologyRust.ts:71-73 失败→null→零发现不误报;configDerive.ts:246-265 失败→degraded:true+warning 诊断+消费面回旧链;spaceNavRust.ts:28-31 失败→null)。
- TS 轨道即完整历史特性面(Rust 全部是附加面),kill-switch 收回=完整功能照常。
- 状态栏明示轨道:`Kode LSP: TS` / `Rust` / `$(warning) Rust fallback TS`(kodeServiceStatus.ts:29-40),配置变化即重读。

### 轴2 kode-server 缺失/崩溃

- 发现落空→TS 轨道(kodeCoreGateWiring.ts:32-50 自动发现 miss 返回空串,不误伤)。
- 崩溃中会话:kodeCoreClient 意外退出→在途请求 `rejectAll(EXITED)`→各消费面 null→TS;有界自动重启(10s 窗 3 次,超出 RESTART_GAVE_UP 放弃);spawn 失败转 EXITED(stdin EPIPE 吞,CORE-015/016)。
- `runInRust` 命令面 ok:false 带原因,调用方回退 TS 路径;spawn 冷却 30s 防高频查询刷风暴;交互面 2s 预算壳(awaitWithInteractiveBudget)超时/取消→null→TS,败方 promise 挂 catch 无未处理 rejection。
- RUST-008 版本门:版本不一致杀子进程保留可再 spawn,gate catch 归入回落 TS 面。
- UI 面:callgraph 模式「Rust 不可用」徽标+空图说明(entityDependencyWebViewHtml.ts:92,162);依赖模式 Rust 错误→TS analyzer 兜底(entityDependencyWebView.ts:283-291);flow 泳道失败/取消分报+「重试」动作(flowSwimlanePanel.ts:551-571);trace 回放拒绝空面板打开(traceReplayPanel.ts:61-65);telnet 面板断连保持存活(telnetWebView.ts:12-13);def MD5 判 unverifiable(defMd5Check.ts:253);clone 类 Rust-only 面显式「需要 Rust 后端」消息不假装(playerDataCloneCommands.ts)。

### 轴3 无 KBEngine 引擎源码树

- 引擎树全部探测式消费:双标记+existsSync,`KBENGINE_ROOT=off` 显式关;缺失→`unknown` 元数据不造假(engineApiMetadata.ts:90-106)、兼容性检查 warning「Engine source not found」(engineCompatibility.ts:77-78)、profile 健康 message 不 throw(profileHealth.ts:76-85)。
- 桩不依赖引擎 checkout:KBEngine.pyi 走内置模板 copy-if-absent(pythonStubExport.ts),kbe 模块面走 KBE_SYMBOLS 策展表(kbeModuleIndex.ts);模板缺失→warning,无工作区→info。
- 激活韧性:占位树 provider 先注册(startupViewPlaceholders,infrastructure.ts:63-68);引擎 API catalog `.catch(()=>null)`(:75-78);工作区门 fail-open 按需 ensureStartup(entityMapping.ts:291-327 initialScanFailed+冷查询重试);实体映射/热更/发现均有显式空态。
- 系统性证据:CI 全量(10186+)即无引擎树跑绿(KBENGINE_ROOT=off 口径);demo 门禁同。

## 2. 缺口与本批处置

| 缺口 | 位置 | 处置 |
|---|---|---|
| A1 激活期裸奔异步链(未预期失败=未处理 rejection) | generators.ts:128(桩导出链)、inferPipeline.ts:543(infer 静默链)、serverControls.ts:429(autoDebugpy 注入链);根因 readFile 未包裹(pythonStubExport.ts:89) | **本批修**:三链 IIFE 内部 try/catch 兜底(前两链 console.error+warning 存照;autoDebugpy 走既有 log/recordInjection failed 面不弹窗);readFile 单文件不可读跳过不炸收集链(与同函数 statSync 守护同风格)。prove-red=readFile 守护摘除→新钉红→cp/cmp 还原复绿 |
| A2 exportReproSummary 裸读自身 package.json | utilityCommands.ts:366-368 | **登记不修**:打包态 manifest 恒存在,非降级轴可达路径;真失败走 VS Code 通用「命令失败」提示,UI 不死 |
| A3 flow 泳道先建面板后装配,装配败留空白窗(带重试) | flowSwimlanePanel.ts:403-408/464-475 | **登记不修**:状态只在装配成功后落账(:476-487),失败分报+重试动作已诚实;先装后建会改面板创建时序(进度展示依赖既有面板),churn>收益 |

## 3. 既有降级测试网(盘点)

kodeCoreGate 31 例、kodeCoreClient 崩溃重启/超时/dispose 竞态 12+ 例(kodeCore 家族合计 126 例含真二进制 E2E/parity)、kodeServiceStatus 6、engineApiMetadata 6、entityMappingFallback 7、serverConfigFallbackCore/Parity、methodDefinitionAllFilesFallback;本批 +1(readFile 毒文件跳过钉)。

## 4. 门禁

`tsc` RC=0;`eslint` RC=0(触面 4 文件+全量见 todo 勾行注);触面家族 pythonStubExport 18+inferPipeline/serverControls/autoDebugpy/generators/debugpy 65 绿;prove-red 闭环。
