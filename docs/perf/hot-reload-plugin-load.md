# 热更新插件 0/5/20 load test 与插件崩溃隔离（RUST-426 / 旧 HR-QA-014,2026-11-22）

- 任务口径:「存在热更新插件 0/5/20 个分别做 load test,插件崩溃不影响核心与主线程」——
  本车道验证 ①发送 provider 注册表在 0/5/20 插件档的解析正确性与成本模型（load scaling）
  ②插件崩溃（`canSend`/`send` 抛错）不打断核心/主线程。
- 车道:tests/hotReloadPluginLoad.test.ts(主 unit 门,12 例,确定性纯核;与主 unit 门
  其余测试无真二进制/端口/墙钟依赖)。真二进制 perf 车道不适用(插件层是纯 TS 微操作,
  见诚实边界③)。

## 0/5/20 load test 结论

| 档 | 注册序 | 解析结果 | canSend 调用数(成本) |
|---|---|---|---|
| 0 | 空册 | `null`(不回落默认——热更是写引擎内存的动作) | 0 |
| 5 | a,b,c,d,e | `c`(第一个 `canSend` 应答者胜,a/b 不应答,c 应答) | a1 b1 c1 d0 e0 = 3(= 首应答者位置) |
| 20 | p0..p19 | 全不应答=`null`;第 3 位应答者胜 | 全不应答:每家恰好 1(线性);第 3 位应答:p0-p2 各 1,其后 17 家 0 |
| 20 → dispose | 清全册 | `null`,id 空 | 重注册即重建,不半态 |

成本模型 = **canSend 调用数恒等首应答者位置**:首应答早=不全量扫,20 全不应答=逐个
问完(线性),无 O(n²)/无「答早也扫全」回退。插件数线性加在「首应答前的问询」,
非整册重扫——20 档比 0 档多出的成本 = 首应答前的应答者数,常数级。

## 插件崩溃隔离

| 崩溃点 | 修复前 | 修复后 |
|---|---|---|
| `canSend` 抛错(`resolveSendProvider` 逐家问) | **未隔离**——同步抛错直接传播到调用方(hotReload.ts:1130),核心热更触发链被打断 | **隔离**:`try` 包住单家 `canSend`,抛错=如实上报(`onProviderError`)+跳过继续问下一家,绝不传播;全员崩溃=逐条上报+如实 `null` |
| `send` 抛错(`runViaProvider` 编排) | 已隔离(hotReload.ts:753 `Promise.resolve().then(() => provider.send(...)).then(onOk, onError)`,同步抛错也落拒绝分支) | 不变;本车道以同形编排模式钉住「同步抛错的 send 落拒绝分支」 |
| 装配面接线 | `onProviderError` 无出口,插件崩溃无处落 | 装配面(hotReload.ts:633)把崩溃报 `status.log`(与既有 `onRejection` 同位),不静默吞 |

崩溃隔离的「不静默吞」纪律:`onProviderError` 是可选面;未接时崩溃仍被隔离(跳过+继续),
仅无上报面——隔离是注册表固有行为,不依赖装配面接面。

## 读法与诚实边界

1. **崩溃面收敛在 2 处**:`canSend`(resolve 路径)与 `send`(编排路径)。生命周期槽
   (`resolveModule`/`prepareRequest`/`interpretResponse`/`queryAppliedRevision`)在 src 内
   无调用点(未接线,属 RUST-406/接线批),本车道不为其虚构崩溃面;接线批落地时须按
   同纪律补隔离。
2. **崩溃上报的「核心不受影响」判据**:resolve 返回 `null`(全员崩溃)/后继应答者胜,
   且 `resolveSendProvider` 不抛——上层(hotReload.ts:1130)照常走回落默认热更面。
   主线程不受影响=无未捕获异常逃出触发链(热更触发链本身在事件回调里,同步抛错会上
   到 VS Code 宿主报错弹窗)。
3. **load test 是算法性(成本模型)非墙钟**:插件层 `resolveSendProvider` 是纯 TS 微操作
   (单档 20 次 `canSend` 调用 ≪ 1µs×20),墙钟测量被计时噪声与共享 runner 负载支配
   (本批 RUST-425 实证:同一门在 load1 21→62→82 下同一面 21→80→175ms 漂移,见
   docs/perf/hot-reload-rebuild-tail.md)。故 0/5/20 load test 钉在**确定性成本模型**
   (canSend 调用数=首应答者位置),这是比墙钟更严的判据(捕 O(n²)/整册重扫回退,
   且不依赖 runner 负载)。跨机器绝对微秒值不做比较(PERF-015 同口径)。
4. **`send` 隔离未在本车道跑真编排**:真编排(`runViaProvider`)在 hotReload.ts 装配层,
   需 vscode 装配面(单测不可直接驱动);本车道以同形 `Promise.resolve().then(...).then(onOk,
   onError)` 模式钉住语义,并核读装配面实现确认 `send` 抛错落 `onError`(已存在,本批未
   新增)。若后续把发送编排下沉到纯核,应把该臂并进本车道。
5. **0 插件档的语义**:`resolveSendProvider` 对空册返回 `null`,上层(hotReload.ts:1129
   `sendViaProviders` 键开+`providerHost.registry.resolveSendProvider`)无应答者→回落
   默认热更面,不冒充、不空转——0 档与「无插件」语义等价,非配置错误。
