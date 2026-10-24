# kode Phase 1 术语表

- 范围:Phase 1 骨架、解析、双轨、对拍与性能文档。
- 用途:统一 ADR、PR 报告与基准文档中的用词;同一术语只在本表定义一次。
- 关联:[ADR-001](adr/ADR-001-stdio-default-transport.md)、[ADR-002](adr/ADR-002-benchmark-first-rust-migration.md)、[ADR-102](adr/ADR-102-parser-tech-choice.md)。

<a id="terms-usage"></a>
## 1. 使用约定

1. 中文术语优先,括号保留首次出现的英文原词或代码标识;后续文档直接引用本表,不另造同义词。
2. 代码标识、配置键、LSP 方法名使用反引号原样书写,不翻译。
3. 性能数字必须带单位、样本量与口径;P95 不与 P50 混写,热态不与冷态混写。
4. 倍差必须写明方向。本表与基线默认:延迟为 `Rust/TS`,吞吐为 `Rust/TS`,内存为 `TS/Rust`。
5. “正本”指可直接复核的原始输出或判定文档,不以口头摘要替代。

<a id="terms-glossary"></a>
## 2. 术语表

<a id="terms-architecture"></a>
### 2.1 架构与运行

| 术语 | 英文/别名 | 定义 | 相关 ADR |
|---|---|---|---|
| 常驻 Core | Core、`kode-server` | 与扩展宿主分离、随会话存活的 Rust 语言服务进程。 | [ADR-001](adr/ADR-001-stdio-default-transport.md) |
| 传输层 | transport | 扩展宿主与 Core 之间的消息通道;默认且唯一常驻通道为 LSP stdio。 | [ADR-001](adr/ADR-001-stdio-default-transport.md) |
| LSP stdio | `--stdio` | 通过标准输入/输出承载 LSP 的常驻通信方式;stdout 只承载协议帧。 | [ADR-001](adr/ADR-001-stdio-default-transport.md) |
| 帧协议 | Content-Length framed JSON-RPC | 以 `Content-Length` 头分帧的 JSON-RPC 字节流;解码器负责短读、分包与非法帧重同步。 | [ADR-001](adr/ADR-001-stdio-default-transport.md) |
| 扩展协议 | `$/kode/*` | kode 在 LSP 命名空间内定义的非标准方法与通知;不引入第二传输层。 | [ADR-001](adr/ADR-001-stdio-default-transport.md) |
| Provider | language provider | 对外提供 hover、definition、completion、diagnostics 等语言功能的入口实现;双轨期区分 TS Provider 与 Rust 对应面。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| VFS 快照 | document snapshot | 以 root、规范化 URI 与文档版本唯一标识的只读文件视图;打开文件优先使用内存内容。 | — |
| 资产根 | root | 一个 KBEngine 资产树(`*_assets`)的扫描与归属边界;多根工作区允许同名实体并存。 | — |
| 索引代次 | generation | 索引快照的单调版本;用于拒绝旧代次结果覆盖新结果。 | — |
| 文档版本 | document version | LSP `didOpen`/`didChange` 携带的文档版本;与索引代次共同构成结果新鲜度判据。 | — |
| 部分结果 | partial、incomplete | 索引尚未完成或被禁用时明确标注的结果状态;禁止伪装为完整结果。 | — |
| 影子模式 | shadow | `kbengine.core.backend=shadow`;TS 照常服务,Rust 接收镜像请求并只记录比对结果。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 双轨 | dual-track | TS 与 Rust 同时接收同参请求、比较延迟与正确性的迁移模式;TS 为现行真相。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 切流 | cutover | 把实际服务路径从 TS 切换到 Rust;必须先满足切流前置条件清单。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| kill-switch | 一键回退 | 把 `kbengine.core.backend` 改回 `ts`;非法值同样回落 `ts`,并停止 Rust 进程。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| `serveFromRust()` | serving gate | 控制 Rust 是否可直接服务的唯一放行点;Phase 1/2 首片保持 `false`。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 差异日志 | `ShadowDiffLog` | 影子模式的环形差异记录,容量 500,含 `match`/`diff`/`rust-error`/`rust-timeout`/`rust-unavailable` 五类 verdict。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |

<a id="terms-parser"></a>
### 2.2 解析与语义

| 术语 | 英文/别名 | 定义 | 相关 ADR |
|---|---|---|---|
| 解析器 | parser、`kode-parser` | 把 KBEngine 声明文件解析为带源位置的语法模型的 Rust crate。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| `.def` | entity definition | KBEngine 实体定义文件;包含属性、方法、Parent、DetailLevels 与组件段。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| `entities.xml` | entity registry | 实体注册表;定义面找不到脚本层落点时的注册回落来源。 | — |
| `types.xml` | type registry | 类型注册表;提供内建/自定义类型与别名的声明位置。 | — |
| `alias.xml` | alias registry | 别名注册表;与 `types.xml` 的类型别名面分开解析。 | — |
| 字节级状态机 | byte-level state machine | 直接扫描原始字节、零第三方 XML 依赖的解析实现;保留精确 span。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 源区间 | span、byte span | 节点或词法单元在原始文件中的字节起止位置;位置层与原始文件逐字节对应。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 伪注释 | pseudo comment | `.def` 中以 `#` 开头的截断头等行;解析时按等长空格掩码,不改变 span。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 错误恢复 | error recovery | 遇到非法片段时记录结构化诊断并局部跳过,保留已解析树前缀。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| AST | syntax tree | 解析器输出的语法树;节点携带父子关系、源区间与诊断信息。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 语义面 | semantic surface | 对拍时实际比较的可观察结果集合,如 hover 文本、definition 落点、diagnostics 列表。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 声明词 | declaration word | `.def` 属性/方法段中的名称词;definition 可落到脚本层或注册层。 | — |
| 注册词 | registry word | `entities.xml`、`types.xml`、`alias.xml` 中的注册项名称;用于注册面落点与回落。 | — |
| 对拍 | parity | 同一输入分别喂 TS 与 Rust,逐字段比较输出的过程。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| golden | golden fixture | 已入库的期望输出;Rust 重生成比对,TS 独立复算同一 golden。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 增量扫描 | incremental scan | 只重建内容或依赖发生变化的文件/节点;零重建是增量扫描的通过条件。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 内容指纹 | content fingerprint | 用于判断文件内容是否变化的摘要;TS 侧为 BigInt FNV-1a,是其二扫耗时的主要来源。 | [ADR-102](adr/ADR-102-parser-tech-choice.md) |
| 金丝雀 | SURFACE canary | bench 每轮输出的语义面计数(如 props/methods);两侧同值才认定“没有少干活”。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |

<a id="terms-performance"></a>
### 2.3 性能与文档

| 术语 | 英文/别名 | 定义 | 相关 ADR |
|---|---|---|---|
| P50/P95/P99/max | 分位数 | 样本分布的分位点与最大值;必须同时给出样本量与冷热态。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 热态 | warm | 缓存、索引或进程已就绪后的测量状态。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 冷态 | cold | 首次扫描、首次请求或缓存未命中的测量状态。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 吞吐 | throughput | 单位时间处理的输入字节数;本文使用十进制 MB/s。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 峰值内存 | `VmHWM`、RSS | 进程运行期间的常驻内存峰值;`VmHWM` 取自 `/proc/self/status`,RSS 为采样值。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| early-signal | 早期信号 | 含 transport 往返、只用于判断方向的影子测量;不可替代去掉 transport 的正式对拍。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 倍差 | ratio | 两侧指标的比值;必须标注方向与口径,禁止跨机比较绝对值。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| 正本 | canonical record | 可复核的原始输出、复现命令与判定文档;摘要数字必须能回溯到正本。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| ARCH-012 | 无数据不声称快 | 没有同机同口径实测数据不得声称 Rust 更快;禁止靠删功能换性能。 | [ADR-002](adr/ADR-002-benchmark-first-rust-migration.md) |
| ADR | Architecture Decision Record | 记录决策背景、选择、后果与否决方案的文档;实现与门禁须能回溯到 ADR。 | — |

<a id="terms-maintenance"></a>
## 3. 维护规则

1. 新增术语先进本表,再在 ADR 或报告中引用;废弃术语保留一行并标注“已废弃”,不静默删除。
2. 术语定义与实现冲突时,以代码、测试和正本数据为准,并回改本表与相关 ADR。
3. 术语改名必须同步 ADR 术语条目、性能基线、原始输出索引与跨文档引用。
