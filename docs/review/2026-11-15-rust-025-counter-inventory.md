# RUST-025 审计:文件枚举/读取/解析次数、局部失效节点数、索引版本、RPC 消息字节数

日期:2026-11-15。审计对象:todo.md RUST-025(旧 PERF-008)四个统计维度。方法:逐维找现役采集面。**结论:前三维现役在案,第四维(RPC 字节数)是唯一真缺口,本批补齐(KodeCoreClient.rpcTraffic)。**

## 维度 → 采集面

| 维度 | 采集面 | 位置 |
|---|---|---|
| 文件枚举/读取/解析次数 | `MetricsSample.fileDiscoveryCount / fileReadCount / fileParseCount`(单请求)+ `OperationSummary` 同名聚合(采样窗口外全程累计) | src/languageServiceMetrics.ts:55-57/:81-83 |
| 局部失效节点数 | `notifySemanticFilesChanged(changedFiles): number` 返回作废快照数(依赖精确裁断;path 空集=全量作废仅测试/关停用);`removeRoot(rootPath): number` 整根摘除计数 | src/backend/semanticIndex.ts:313-327/:330 |
| 索引版本 | `OperationMeta.indexGeneration / documentVersion`(每请求记录) | src/languageServiceMetrics.ts:41-42 |
| RPC 消息字节数(本批新增) | `KodeCoreClient.rpcTraffic: {bytesIn, bytesOut}`——JSON body 双向累计(不含 LSP 帧头常量开销),出向=sendRaw 成功写入后累计 body.length,入向=完整帧提取处累计 body.length;跨重启累加(观测进程生命周期总量口径);跨进程重启后账本语义=累计不重置(读方按 client 实例生命周期解读) | src/backend/kodeCoreClient.ts |

## 本批增量(RPC 字节计数)

- 采集位:帧级(发送 body / 接收完整帧 body),不量帧头(`Content-Length: N\r\n\r\n` 为常量开销);
- 测试钉:tests/kodeCoreClient.test.ts「RUST-025 RPC 字节流量」——握手后双向 >0;一轮真实 RPC 后双向各增(假替身 delayRpc=0 回 {ret} 面);
- prove-red:摘除入向计数增量 → 新钉红(1 failed | 14 passed)→ cp/cmp 还原字节同;
- 门禁:lint 0 / tsc 0 / unit 全量(见提交前记录)。

## 与相邻条目边界

- 阈值/回归门=RUST-027/028;字节计数当前为**采集面**,metrics channel 呈现面(renderActiveTasksReport)与周期日志接线留待消费需求出现时再接(如实登记,不假装已呈现)。
