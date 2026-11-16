# RUST-241 验收纪要:Protocol compatibility(旧客户端×新 Core、新客户端×旧 Core 均有正确握手/错误)(纯对账)

日期:2026-11-17。本纪要对账 RUST-241(旧 QA-012,主 todo 排队项)的验收口径与交付证据。**结论:双向不兼容的既有面=启动协议版本门(RUST-008 已勾,7a5000ba)+请求失败回落 TS+CI 形状指纹门(RUST-055),零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| 握手 | **启动协议版本门**:TS 侧 `KODE_PROTOCOL_VERSION='0.2.0'` 与 Rust 侧 kode-protocol 常量经 serverInfo.version 首交换比对——**双向对称**(旧客户端+新 Core、新客户端+旧 Core 同一门),不一致=`protocol version mismatch: extension expects X, server reports Y` 杀子进程,拒绝以旧形状对讲 | `src/backend/kodeCoreClient.ts:24-27,265-273`;RUST-008 已勾(todo.md:233,7a5000ba) |
| 正确错误 | mismatch 错误面含两侧版本(可诊断);fallback TS 一次性 notice 存照(RUST-009 轴1);版本门杀进程保留可再 spawn(修复二进制后重开窗口恢复);请求级失败=各消费面 null→TS(RUST-226 条款原样适用:无 per-request 版本协商,不兼容形状=请求失败如实回落) | kodeCoreClient 错误构造;`kodeCoreGate.ts:325-327`;RUST-226 纪要(b53b9236) |
| 形状漂移防线(CI 时) | RUST-055 契约门:32 请求方法逐一 SURFACE_PINS 递归形状指纹(对象=排序键集递归/数组=首元素形状)+fileChanged 跨语言字面量锁+方法清单完整性钉——形状漂移在 CI 即红,不靠运行时撞 | RUST-055(171b5da5+8712ffbe,部分勾,形状面已收);framing_fuzz(PA-003 三长度形状/粘包拆包) |

## 自我验收证据

- RUST-008 版本门测试在勾行记录(prove-red+门禁在案);kodeCoreClient 套件当日 unit 10659(2113d5f4 门禁)内绿;framing_fuzz 当日 cargo 三 crate 全绿(RUST-231 批实测)。

## 诚实条款

- **版本门是启动时单向比对,非协商**:不一致即拒绝回落 TS,不存在「降级到旧协议子集继续用 Rust」的协商路径——裁定=语义面演进快,部分兼容比全回落更危险(诚实原则);如实记账。
- RUST-226 条款协调:该条款说的是「无 per-request 运行时版本握手」,与本条「启动版本门」不矛盾——两层面各司其职。
- 「旧客户端」场景=用户混装旧 VSIX+新二进制(或反之);版本门以 `0.2.0` 单值承载(无兼容区间),如实。
