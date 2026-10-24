import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// 激活门(用户 2026-10-16 调查「PythonClassIndex 在真实路径上没起作用」):
// Python 定义提供者(extension.ts registerDefinitionProvider({language:'python'}))
// 随扩展激活无条件注册,但激活事件里若没有 onLanguage:python,纯 .py 场景
// (无 .def 可 workspaceContains、未跑过 kbengine 命令、没开过 .def 文档)
// 扩展从不激活 → 提供者从未注册 → F12 永远只有 Pylance 的
// "No definition found",与解析逻辑/包新旧无关。此测试锁住激活门。
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
) as { activationEvents: string[] };

describe('activationEvents 激活门', () => {
  it('包含 onLanguage:python:打开 .py 即激活,python 定义提供者才能注册', () => {
    expect(pkg.activationEvents).toContain('onLanguage:python');
  });

  it('既有激活入口保持( kbengine-def 与 .def 工作区 )', () => {
    expect(pkg.activationEvents).toContain('onLanguage:kbengine-def');
    expect(pkg.activationEvents).toContain('workspaceContains:**/*.def');
  });

  it('declares Python call-chain command activation', () => {
    expect(pkg.activationEvents).toContain('onCommand:kbengine.python.showCallChain');
  });
});
