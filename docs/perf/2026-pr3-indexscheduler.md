# PR3 统一索引调度(indexScheduler)行为说明

- 代码: `src/indexScheduler.ts`;EntityMappingManager 首扫迁入: `src/entityMapping.ts:178-196`;
  扩展注入共享调度器: `src/extension.ts:292-296`。
- 测试: `tests/indexScheduler.test.ts` 16 例;全量 unit 2756 通过(基线 2740)。

## 冷启动行为变化

1. 首扫入口不变、语义等价:EntityMappingManager 构造期全量 .def 扫描仍推迟一个
   宏任务(setImmediate),`await initialScan` 等待链不变;变化只在执行通道——
   扫描以 `initial-scan` 任务经调度器单并发入队,不再与其他索引工作抢主线程。
2. 后台让路:首扫属后台全量优先级,编辑高峰(交互任务入队/完成后的 50ms 冷却
   窗口,可配)内不启动、不续跑新的全量块;冷启动首答(首个 hover/跳转的定向
   解析)不被首扫挤压。首扫本体内部仍按原有 25 文件一让的协作式让路。
3. 失败可恢复:首扫被杀(任务体拒绝)不再留下任何永久 pending 句柄——keyed
   任务回落 failed,下一次请求重新入队重跑(`ensureTask`,recoveries 计数)。
4. PR1 唯一秒级瓶颈(全量 .py 索引 107.7s@3 万文件)的执行体 PythonClassIndex
   本 PR 未动(迁入调度器属 PR5);本 PR 只建立调度与限流通道并先行接入
   EntityMappingManager 首扫。
