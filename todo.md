# TODO

> 生成于 2026-10-11（巡检发现本仓无 todo 文件，按仓内文档整理）。来源标注在每组前。

## Marketplace 发布（来源：PROJECT_SUMMARY.md 未完成项）
- [ ] 准备 Marketplace 截图
- [ ] 发布到 VSCode Marketplace

## KBEngine 源码对照复核（来源：KBENGINE_SOURCE_AUDIT_PLAN.md，13 个功能块）
- [ ] 逐块核对「当前功能块」12 号「日志收集与日志界面」的降级状态——文中记「logger watcher 注册协议号与回包处理缺少源码依据，已下调为明确不支持当前未完成适配」，需给出结论：补齐依据实现，或正式记为不支持并同步 README/docs
- [ ] 其余 1-13 号功能块（.def 高亮/提示/悬停/诊断/跳转、Python↔def 映射、实体浏览器、依赖分析、代码生成、服务器管理、调试、监控面板）按计划文档逐块复核，产出「已对照 / 待对照 / 偏差」表

## 导航与配置文档在途核对（来源：本轮巡检派单记录）
- [ ] 核对此前派单是否全部落地：最终配置默认开启（showFinalConfigOnOpen / autoRefreshFinalConfig）、configuration.md 逐字段重写、features.md telnet 配置源纠错（5 处）、CellMethods/Properties 导航补充口径四形态——逐项给出 commit 或标未完成

验收：真实验证（VSCode 实装截图 / dotnet 或 pnpm 测试全绿 / 文档与代码一致），测试绿才 push，commit 英文简短。
