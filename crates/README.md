# kode2 crate 占位说明(书 §3 目标树)

PR-003 只落地最小集 `kode-protocol` + `kode-server`(书 §17 PR-003 范围)。
以下 crate 按书的 PR 顺序逐个落地,落地一个加一个,不建空壳假装存在:

| crate | 书章节 | 计划 PR |
|---|---|---|
| kode-vfs | §5 | PR-004 |
| kode-syntax | §6.1 | PR-005 |
| kode-project | §5/§10(root discovery) | PR-006 |
| kode-index | §7 | PR-007/008 |
| kode-semantic | §6.2 | PR-008 |
| (invalidation/scheduler 并入 kode-index 或独立) | §7 | PR-009 |
| kode-python / kode-typings / kode-diagnostics / kode-runtime / kode-plugins-api / kode-plugin-host | §9/§12 | Phase 4/6 |
