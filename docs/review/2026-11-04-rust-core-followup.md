# Rust 核心后续源码审计（2026-11-04）

审计基线：HEAD c6e8ba1 + 当前工作区；工作区有其他未提交修改。本轮只分析，不修改业务实现或 todo.md。已检索 todo.md 全文，并按任务标题和问题机制排除重复；以下不重复 KR-AUD 的 AST、调度、MD5、接口和 TS 索引已知问题。

## 新发现

### F1 · P1 · 调用图节点跨文件碰撞，真实 base/cell 同名实体被合并

位置：crates/kode-server/src/python_callgraph.rs:206、219；src/entityDependencyWebView.ts:448、483。

方法 ID 只有 Class.method；函数 ID 只有 stem::function，模块只有 stem。两个文件 /p/base/Avatar.py、/p/cell/Avatar.py 都定义 Avatar.tick 时，RPC 生成两个完全相同的 Avatar.tick ID。TS normalizeCallGraph 用 Map.set(node.id, ...) 收种子，后者覆盖前者；两文件调用边也生成相同 from ID，因此混到同一节点，点击源码落向最后一个文件。这是实际常见的 base/cell 布局，不限多工作区。

探针实际输出两条 id=Avatar.tick，filePath 分别为 base/cell。应由 Rust 生成包含文件身份与限定作用域的稳定 symbol ID，边直接携带 callerId/calleeId；TS 消费 ID，不再用名字重新推导。测试需验证同类同方法、同 stem 函数和多根三面。

### F2 · P2 · 组件编解码接口丢失所属组件，无法正确选择 schema

位置：crates/kode-server/src/wire_codec.rs:856、884、935、985、1000。

属性解码读出了 (parent, child)，但布局回调只接收 child。组件 6 的 child=1 为 UINT8、组件 7 的 child=1 为 UINT16 时，同一个纯回调无法区分。探针先用真实 encoder 编码上述两个条目，再用 child→UINT8 回调解码，返回 Truncated { need: 2, have: 1 }：第二个属性只消费一个字节，剩余字节被当下一条头。若长度碰巧匹配，也可能静默错解。

方法解码同根问题：已经读出 component_alias，但 arg_layouts_of 只收 MethodRef，无法区分组件中相同方法 alias 的不同签名。应分别改为 (parent, child) 与 (component_alias, method) 的查询接口；输入身份必须由核心保留到底。

### F3 · P2 · 方法参数数量不匹配仍编码成功

位置：crates/kode-server/src/wire_codec.rs:971。

arg_layouts.zip(args) 只编码较短侧，未检查长度相等。两个参数配一个布局，第二个参数静默丢失；两个布局配一个参数，缺参帧仍返回 Ok。探针两种输入均返回 Ok(())，且字节相同。应在写入输出前校验参数数量；分别覆盖少参、多参、零参和完整参数，不依赖 encoder/decoder 自己往返证明协议正确。

### F4 · P2 · 方法编号模式转换静默截断

位置：crates/kode-server/src/wire_codec.rs:959。

Alias 模式接受 MethodRef::Utype(u)，直接 u as u8。探针 Utype(257) 编码为 alias=1，返回 Ok。编号改变可能指向另一个方法；即使编号小于 256，utype 与 alias 也不能由整数强转证明语义等价。应要求 MethodRef 与模式匹配，或显式通过消息表做映射；非法模式组合在写任何字节前失败。

### F5 · P3 · VFS 根注册两条基础契约失效

位置：crates/kode-vfs/src/store.rs:42、49、121。

RootRegistry 派生 Default 将 next_id 初始化为 0，而 new() 初始化为 1。探针 RootRegistry::default().register("/project") 返回 RootId(0)，与 UNROOTED 冲突。当前 server 使用 new()，所以这不是现有服务器主路径的必现故障，但公共构造契约已错误。

另一个独立边界：注册根 / 后，prefix_len_at_boundary 对 /project/a.py 取剩余 project/a.py，因不以 / 开头而拒绝，探针归属仍为 RootId(0)。应手写 Default 委托 new()，并针对以分隔符结束的文件系统根处理边界；覆盖 Unix / 和规范化后的 Windows 卷根。

## 与 Rust 核心目标的关系

当前 Rust 已有多项纯计算 RPC，但语言服务权威仍在 TS：src/kodeCoreGate.ts:299 serveFromRust 恒 false；命令 runInRust 与该开关正交。因此“已存在 Rust 实现”不等于“生产查询已由核心持有”。此迁移状态已有账，不另报缺陷。

从实际依赖看，kode-server 的 Cargo.toml 没有接 kode-scheduler、kode-corpus；server 的文档通知直接更新 HoverEngine。这说明独立 crate 的调度/语料能力尚未成为常驻服务的统一生命周期。迁移验收需要证明同一输入身份、版本、失效和取消贯穿真实 server 请求，而不仅是 crate 单测通过。这也是已有迁移范围的实现解释，不新增重复任务。

本轮新缺陷暴露出更具体的收口原则：Rust 输出稳定且完整的语义身份；schema 查询不丢组件上下文；编码器拒绝不能表示的输入。TS 保留 VS Code API、输入收集和展示，避免在展示层重新推导符号身份。

建议先修 F1/F2（身份契约），再修 F3/F4（编码拒绝规则），最后修 F5。不要在这些契约修好前扩大依赖图或协议分析器的消费范围。

## 验证与边界

最小探针目录：/tmp/kode-core-audit，命令：

```sh
cargo run --offline --manifest-path /tmp/kode-core-audit/Cargo.toml --target-dir /home/cui/workspaces/kode/target -q
```

探针直接通过 #[path] 编译当前 wire_codec.rs、python_callgraph.rs、rpc.rs，VFS 使用当前 path dependency，无业务源码拷贝修改。实际运行成功，输出覆盖上述反例。图形覆盖后果另经 TS Map.set 与边 ID 构造源码核对，未启动 VS Code UI。

初次尝试整库依赖编译失败：message_table.rs:352 的 Assembly 初始化缺 interface_path（E0063）。该文件已有未提交修改，因此仅记录当时验证障碍，不把在途编辑认定为新增稳定缺陷。未运行全仓测试，也不宣称完整核心已审计无遗漏。
