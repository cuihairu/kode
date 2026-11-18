# ADR-104 — 标准编辑器功能走标准 LSP,专用交互走 `$/kode/*` 命名空间 RPC

- 状态:已接受(2026-11-17,RUST-291 裁决落档;de-facto 双面在役,本 ADR 追认)
- 关联:书 §18 ADR-104、RUST-291、ADR-001(stdio 传输)、pr-003(协议握手)、RUST-055(协议契约门)
- 证据:`crates/kode-server/src/server.rs`(标准 LSP 面+自命名空间面同服务)、`tests/protocolContract.test.ts`(全协议面清单钉,RUST-055 第二增量)
- 证据(结构面):`crates/kode-protocol/protocol.schema.json` + `src/generated/protocolTypes.ts`(wire DTO 单一真源三锁链,RUST-055 第三增量,见 `docs/design/protocol-schema-single-source.md`;行为面观测钉与结构面生成钉互补)

## 背景

书 ADR-104 要求裁决:编辑器功能用标准 LSP 还是自造 RPC。约束:VS Code 生态
的补全/跳转/悬停等由编辑器以标准 LSP 方法发起;kode 专属交互(语义查询、
依赖图、快照/指纹、执行面)无标准方法可映射。

## 决策

**双面并存,按任务书立场分工:**

1. **标准 LSP 面**:`textDocument/*` 标准方法(hover/definition/completion/
   diagnostics/documentSymbol/references 等,server.rs 现面 17 处
   `textDocument/`)+ didOpen/didChange/didClose 语料视图联动 + capabilities
   注册。任何 VS Code 原生可消费的能力一律走标准面,不自造等价物。
2. **自命名空间 RPC 面**:`$/kode/*`(35 项字面量全集:信封 rpc 1+单向通知
   fileChanged 1+health 1+请求方法 32,protocolContract.test.ts:281 逐一
   形状钉)承载 kode 专属交互——语义事实/依赖图/调用链/快照指纹/桥接执行。

## 后果

- 正面:编辑器原生功能零适配层(Rust Core 直接实现标准 LSP,provider 侧
  只做装配);kode 专属协议不受标准演进约束;`tests/protocolContract.test.ts`
  对 TS 消费面 32 方法逐一形状钉,SURFACE_PINS 递归指纹咬 wire 漂移
  (RUST-055 prove-red:serde rename 一键即红)。
- 负面/约束:自命名空间面无标准工具链可调试(自建 health/wait/roots 面
  补偿);新旧两侧方法清单必须同步演进(契约测试强制)。
- reopen 条款:若 VS Code 标准化 kode 专属能力(如 call hierarchy 已标准化
  textDocument/prepareCallHierarchy),对应面迁标准方法,`$/kode/*` 同面退役。
