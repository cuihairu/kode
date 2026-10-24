# ADR-001 — LSP stdio 为默认常驻通信通道

- 状态:已接受(2026-10-23,PR-003)
- 关联:书 BUILD-001、CORE-001、PH1-01;备选方案:自定义 socket RPC、HTTP、内嵌 FFI

## 术语

| 术语 | 本 ADR 中的含义 | 术语表 |
|---|---|---|
| 常驻 Core | 与扩展宿主分离、随会话存活的 `kode-server` 进程。 | [2.1](../glossary.md#terms-architecture) |
| 传输层 | 扩展宿主与 Core 之间的消息通道;本 ADR 决定只有 stdio 一种常驻实现。 | [2.1](../glossary.md#terms-architecture) |
| LSP stdio | 以 `Content-Length` 分帧的 JSON-RPC 标准输入/输出通道。 | [2.1](../glossary.md#terms-architecture) |
| 扩展协议 | 仅使用 `$/kode/*` 命名空间的非标准方法,不新增传输层。 | [2.1](../glossary.md#terms-architecture) |

## 背景

kode 2.0 的 Rust Core 要与 VS Code 扩展(以及潜在的远端/CLI 宿主)通信。
候选通道:stdio、本地 socket、HTTP、FFI 内嵌进程内库。

## 决策

**LSP stdio 帧协议(Content-Length framed JSON-RPC)为默认且唯一的常驻通信方式**,本地与远端场景一致:

1. stdio 天然匹配 LSP 规范,`--stdio` 传输是所有 LSP 客户端库的公共分母;
2. 生命周期即进程生命周期:进程退出=会话结束,崩溃检测与重启(CORE-015)不需要额外心跳协议;
3. 无端口管理/防火墙/端口冲突问题;Remote SSH/Web 宿主场景下进程随 extension host 落位(BUILD-009 前提)。

扩展协议(kode2 专属交互,书 §12/§11 的后台任务、热更新等)**只走 LSP 命名空间
(`$/kode/*` 自定义方法),不引入第二传输层**。

## 后果

- 正面:transport 只需一套实现(PR-003 `src/kodeCoreClient.ts` + `crates/kode-protocol`);取消/日志追踪沿 request_id 走单一通道(CORE-003)。
- 负面/约束:
  - stdio 是字节流,大 payload 需分帧限流(CORE-012 的职责,帧解码器已设 64MB 上限);
  - 单通道串行分派,长任务必须可取消且不能阻塞泵(已由 reader 线程 + poll 间隙落实);
  - stdout 只能承载协议帧,一切日志/诊断走 stderr(服务端已按此实现);
  - 未来如需 HTTP 面板类长连接(书 §11),必须是独立服务进程,不复用 LSP 通道。
- 验证:`tests/kodeCoreE2E.test.ts` 真实二进制握手/取消/重启 e2e。

## 替代方案否决理由

- FFI 内嵌:崩溃即拖垮 VS Code 主进程,与 CORE-015 隔离要求冲突。
- 本地 socket:多实例端口管理、残留 socket 清理、远端场景不可用。
- HTTP:为编辑器交互引入无谓的连接/超时/序列化层,与 LSP 生态不兼容。
