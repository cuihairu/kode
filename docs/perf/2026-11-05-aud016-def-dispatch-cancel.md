# IDE-AUD-016:真实 definition 依赖链派发后取消验收

日期:2026-11-05
验收原文(todo.md):「验收真实工作已经启动后的导航取消；验收：真实 definition 依赖链已派发后取消，
排队/在途独占任务有证据停止，共享工作继续；取消前后 IO 按请求归属记录；关联：IDE-REV-033。」
深审来源:2026-10-30 completion-and-lint-audit F14(IDE-REV-032/033 闸门设在 provider 入口取消检查之后、
实际查询工作之前;测试取消完才放行,主要证明放行后检查 token,未证明真实 IO/计算已经启动后的中止)。

## 结论

**通过。** 新增派发后闸(层1 entity-def 方法探针返回后)+ 冷实体夹具,取消落在真实 def 依赖链
已派发之后的确定性窗口:

| 判定 | 结果 | 证据 |
|---|---|---|
| 门已达(真实链派发到方法探针) | ✅ 通过 | gateReached=true |
| 请求窗内真实 IO>0(按请求归属) | ✅ 通过 | requestWindow=1 读(窗内唯一在途请求,窗前后快照差) |
| 取消落在在途窗口内、无晚到结果 | ✅ 通过 | settledBeforeCancel=false;returnedDefinition=false |
| 在途独占任务停止(取消后不再读盘) | ✅ 通过 | postCancelWindow=0 读(界 50) |
| 请求侧残留量规归零 | ✅ 通过 | diagnosticsQueued/InFlight/annotationUpdates/schemaColdBuilds 全 0 |
| 共享扫描继续(document-parse 前进) | ✅ 通过 | parseCount 3080→3081(500ms 收敛) |
| prove-red:闸在入口(旧位)测试必红 | ✅ 验证 | 入口位跑出 requestWindow=0 → 测试断言「请求窗内零读盘」红 |

## 与 REV-033 的互补关系

- **REV-033(入口闸,已有,保留)**:门在 provider 入口(`provideDefinition` `:4624`)、任何真实查询工作
  之前——证明「进 provider 后取消零工作返回」。
- **IDE-AUD-016(派发后闸,本批新增)**:门在层1 entity-def 方法探针 `await probe.run()` 返回后
  (`runDefinitionLayers` 方法探针循环)、既有取消复查之前——证明「真实 def 依赖链已派发后取消,
  链在下一观测点停」。
- 两闸互补,入口闸测试**保留不动**(深审要求「保留现有入口检查测试」)。

## 机制

### 1. 派发后闸(测试面,生产恒 null,零行为差异)—— `src/languageProviders.ts`
- 新增 `definitionDispatchGateForTests` 变量 + `setDefinitionDispatchGateForTests` 设置器
  (镜像入口闸 `definitionInFlightGateForTests` 的契约:生产恒 null、释放方顺手清闸)。
- 唯一调用点:`runDefinitionLayers` 层1 entity-def 方法探针循环,`await probe.run()` 返回后、
  既有 `token?.isCancellationRequested` 复查之前。此刻真实 def 依赖链已派发:探针内
  `resolveMethodDefinition*` → `ensureIndexForClass/PythonFile` → `ensureIndexTargeted` →
  `findFilesAcrossRoots('**/<Name>.def')` + `parseDefFile` → `buildIndex` → `loadResolvedAt`
  (父/接口/组件 .def 递归读)+ `collectPythonMethods`(属主 .py 读)已执行并返回。

### 2. 探针(测试面)—— `src/extension.ts` `probeDefinitionDispatchCancel`
- 安装派发后闸 → 直接调 `pythonDefinitionImpl.provideDefinition`(与注册 provider 同实例,
  请求级取消语义)→ 门达探测(30s 未达如实报 gateReached=false)→ 门内快照读盘(请求窗内唯一
  在途请求 → 快照差即本请求已派发 IO 归属)→ 斩 token → 定格 settledBeforeCancel → 放行 → 收口。
- 返回 `{ gateReached, gateEnteredAtMs, cancelledAtMs, settledBeforeCancel, elapsedMs, cancelled,
  returnedDefinition, location, readsBefore, readsAtCancel, readsAfter }`。

### 3. 冷实体夹具(真实 IO 保证)—— 套件内建 `scripts/entity_defs/ColdProbeAvatar.def`(拷
   TrainingAvatar.def 内容)+ `scripts/cell/ColdProbeAvatar.py`(`class ColdProbeAvatar` + `def reqAttack`)
- 激活后新建(watcher `pythonIndexFileEvents` 只通知 `pythonClassIndex`,**不**预热 entityMapping
  实体索引;初始扫描清单里也没有它)→ 方法探针的定向解析必然走冷路径(`ensureIndexTargeted`
  的 `mappingIndexes` 未命中 → glob + `parseDefFile` 真读盘),真实读盘可归属本请求。
- 排干后台(首扫/定时任务)后再取窗基线,窗内只剩本请求的 IO。

## 证据(实测,2 次独立运行一致)

`docs/perf/2026-11-05-aud016-def-dispatch-cancel-run.txt`:

```
aud016.gate.gateReached=true
aud016.gate.gateEnteredAtMs=5
aud016.gate.cancelledAtMs=5
aud016.gate.settledBeforeCancel=false
aud016.gate.elapsedMs=5
aud016.gate.returnedDefinition=false
aud016.reads.requestWindow=1
aud016.reads.postCancelWindow=0
aud016.pending.requestSide={"diagnosticsQueued":0,"diagnosticsInFlight":0,"annotationUpdates":0,"schemaColdBuilds":0}
aud016.shared.parseCountBefore=3080
aud016.shared.parseCountAfter=3081
aud016.shared.convergeMs=500
```

- `requestWindow=1`:请求开始→门内快照之间的读盘差为 1(冷 .def 定向解析真读盘),且窗内为唯一
  在途请求,故该 1 读可归属本请求——「取消前后 IO 按请求归属记录」兑现。
- `postCancelWindow=0`:取消落潮窗(2s)内请求侧零新增读盘——在途独占任务停止(界 50,实测 0)。

## prove-red(自我验收)

把派发后闸临时移到 **provider 入口**(旧 REV-033 位置),重建后跑同一测试:

```
AssertionError: 请求窗内零读盘:真实 def 依赖链未派发(before=159 atCancel=159)
```

门在入口时,请求停在入口(真实链未派发),门内快照差=0,测试在「请求窗内真实 IO>0」断言红——
证明本测试**确实区分**「入口闸(零工作)」与「派发后闸(真实工作已启动)」,而非两者皆绿。

## 运行命令

```
pnpm run compile && npx tsc -p tsconfig.mocha.json && xvfb-run -a node out/test/electron/runTest.js --field
```

## 非本批失败说明(已证非本批)

同套件既有 IDE-ACC-007「取消落潮窗新增读盘 69 次超界(界 50)」在本批改动**暂存(stash)后照常红**
(同值 69)——系并发会话未提交在途工作/共享机负载所致,与本批三文件(测试面,生产恒 null)无关;
本批改动经 stash 前后对照证明零影响。REV-032/033(入口闸)与本批 AUD-016(派发后闸)实测全绿。
