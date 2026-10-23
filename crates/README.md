# kode2 crate 落地状态(书 §3 目标树)

已落地:`kode-protocol` + `kode-server`(PR-003)、`kode-vfs`(PR-004,基础版)。
以下 crate 按书的 PR 顺序逐个落地,落地一个加一个,不建空壳假装存在:

| crate | 书章节 | 状态 |
|---|---|---|
| kode-protocol | §4 | ✅ PR-003(帧编解码 + 协议 DTO;PR-004 增补 Position/Range) |
| kode-server | §4 | ✅ PR-003(stdio 状态机;PR-004 文档同步切到 kode-vfs) |
| kode-vfs | §5 | ✅ PR-004(VFS-001..013 基础版,证据 docs/kode2/pr-004.md) |
| kode-parser(任务书命名;书 §3 目标树记 kode-syntax) | §6.1 | ✅ PR-005(字节级 XML 状态机 + .def/entities/types/alias 模型 + 增量注册表,证据 docs/kode2/pr-005.md) |
| kode-root(任务书命名;书 §3 目标树记 kode-project) | §5/§10(root discovery) | ✅ PR-006(ROOT-001..015 基础版:约定链/探针/有界深扫描对齐 TS discovery,平台路径规则 Win/mac/Linux/WSL,submodule/vendored/循环/别名/敏感目录判定,TS 对拍 golden 双向门禁,证据 docs/kode2/pr-006.md) |
| kode-index | §7 | ✅ PR-007(六类符号索引:名称倒排+文件级增量+原子 generation,IDX-001..007+013/014/015 基础版,证据 docs/kode2/pr-007.md;type-graph 语义面随 PR-008,invalidation 调度随 PR-009) |
| kode-types(任务书 PR-008 分发命名;书 §3 目标树记 kode-semantic) | §6.2 | ✅ PR-008(类型图 IR 基础版:Alias/Array/FixedDict/UserType 节点 + 六种边 + 别名链/继承链/全图环检测,SEM-002/004/005/013 基础版,TS 类型面对拍 100%,证据 docs/kode2/pr-008.md) |
| (invalidation/scheduler 并入 kode-index 或独立) | §7 | PR-009 |
| kode-python / kode-typings / kode-diagnostics / kode-runtime / kode-plugins-api / kode-plugin-host | §9/§12 | Phase 4/6 |
