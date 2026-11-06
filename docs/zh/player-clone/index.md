# 玩家数据克隆（db-clone）

玩家数据克隆子系统（crate `kode-db-clone` + `kbengine.clone.*` 命令面）的文档：

- [db-clone 总览：能力边界与克隆全链路](./db-clone-overview.md) —
  权威口径页：这个 crate 是什么、克隆全链路（只读导出→规划→加密归档→导入→ID
  回填）、已落与如实未落的对照、命名由来、测试面。
- [引擎侧事实取证（source-evidence）](/player-clone/source-evidence) — crate 所编码的引擎持久化事实
  （parentID、子表、autoLoad）。
- [运维与安全（ops-and-security）](/player-clone/ops-and-security) — 命令面、敏感数据处理、归档留存/销毁、
  已知限制。

设计口径：[玩家数据克隆计划书 (v0.2.1)](../design/v0.2.1-player-data-clone-plan.md)。
