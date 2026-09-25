// vscode 测试替身的兼容 re-export 薄壳(docs/redesign.md 阶段 3)。
// 实现源已迁移 tests/fake-vscode/:值类型在 core,workspace/window/commands/
// languages/panel 的状态化实现各占一模块。这里仅 re-export——既有 700+ 用例
// 的 import 路径与 vitest 的 'vscode' alias 全部不变,monkey-patch 语义
// (共享同一可变对象)也保持不变。
export * from '../fake-vscode/core';
export * from '../fake-vscode/workspaceState';
export * from '../fake-vscode/windowState';
export * from '../fake-vscode/commandRegistry';
export * from '../fake-vscode/languages';
export * from '../fake-vscode/panelRegistry';
