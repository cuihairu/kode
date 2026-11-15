# RUST-076(旧 CORE-011)审计:IO/CPU 泳道分离、锁跨 await、contention 与优先级反转

2026-11-15。范围 = 清洁区四 crate(kode-vfs / kode-parser / kode-index /
kode-scheduler);kode-server 属并发会话产权,其 async 面审计随 server 装配
单另行,本文不覆盖(诚实边界)。

## 机制面:泳道分离门(kode-scheduler/src/lane.rs)

- `LaneBudget::from_total`:交互预留 1,其余容量 IO/CPU 平分(io=floor,
  cpu=余量);`validate` 拒绝零总量与「io+cpu+预留 > total」带病预算;
- `LaneGate`:三泳道独立硬顶 + 总量守恒;**IO 饱和不得压缩 CPU 准入**
  (反向同理)——慢操作只饿死自己的泳道;交互预留位恒保留(与 CORE-010
  `WorkerPoolGate` 预留语义同源);
- `release` 拒绝超释放(下溢 = 调用方 bug,如实拒绝不静默);
- 测试 6 例:缺省预算分劈/校验拒绝/IO 饱和不压 CPU(分离核心考场)/
  交互永不因泳道满载被拒/交替准入总量守恒+记账一致/释放按泳道隔离且不下溢。
- prove-red:摘 `cpu_max` 泳道硬顶 → 分离考场红(详见本单勾行)。

## 审计面:三轴证据

### 1. 禁止锁跨 await

清洁区四 crate grep(2026-11-15 实测):

```
kode-vfs:        async fn = 0   Mutex/RwLock = 0
kode-parser:     async fn = 0   Mutex/RwLock = 0
kode-index:      async fn = 0   Mutex/RwLock = 0
kode-scheduler:  async fn = 0   Mutex/RwLock = 0
```

纯核零 `async fn`、零 std 锁——**不存在可跨 await 持锁的位置**,该纪律在
纯核层结构性成立(非靠审查维持)。新增 Rust 模块的守门口径:清洁区维持
零 async/零锁;确需并发原语时须先立 ADR 说明为何纯核模型不再成立。

### 2. contention 审计

- 调度核单并发(无运行时依赖,pump 同步执行),无跨线程争用面;
- VFS/索引层无共享可变状态锁(见上);快照一致性(读写代际一致)属
  RUST-079(CORE-014),不与本单混装;
- kode-server 的 spawn/handshake 面属脏区,审计随其装配单。

### 3. priority inversion 审计

- 结构性反转为「低优任务持有高优任务所需容量」:调度核层,后台首扫永不
  持有交互任务所需队列位(pick_next 交互恒先;RUST-074 测试钉死);
- 容量层,后台满载不得吞交互预留(RUST-075 `WorkerPoolGate` 测试钉死);
  泳道层,IO/CPU 满载不得吞交互预留(RUST-076 `LaneGate` 测试钉死);
- 失败任务不缓存成永久 pending(调度核 keyed 面既有语义),无「僵尸持位」
  形态的反转源。

## 边界

- 真线程池/异步运行时接线属 server 装配单;届时锁纪律转由该单审计
  (本单纯核口径不冒领)。
- ARCH-012:本文不做 Rust↔TS 性能对比。
