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
) as {
  activationEvents: string[];
  extensionKind?: string[];
  capabilities?: { virtualWorkspaces?: boolean };
  browser?: string;
};

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

  it('RUST-010:extensionKind 钉死 workspace——Remote SSH/WSL/Containers 下扩展落在工作区宿主(文件访问/kode-server spawn/telnet 全在远端机)', () => {
    // 缺省虽自 VS Code 1.74 起同为 workspace(engines ^1.82),但「正确执行
    // 位置」必须是显式声明而非依赖上游缺省漂移;identity 报告(extensionIdentity)
    // 据此分列 workspace/ui 宿主侧。
    expect(pkg.extensionKind).toEqual(['workspace']);
  });

  it('RUST-059:virtualWorkspaces=false 显式拒绝 web/虚拟工作区,无 browser 入口——不假装支持本地 native', () => {
    // 本扩展需要真实文件系统(bin/ 二进制发现 fs.statSync、workspace 磁盘路径、
    // 子进程 spawn),浏览器宿主物理不可执行。两处声明面:①virtualWorkspaces
    // =false 让 VS Code 在虚拟工作区(vscode.dev/github.dev 直接开仓)显式停用
    // 而非静默半残;②无 browser 字段=非 web 扩展,市场不会在 web 环境投放。
    // Remote SSH/WSL(远端是真 Node 宿主)不受影响——那不是虚拟工作区。
    expect(pkg.capabilities?.virtualWorkspaces).toBe(false);
    expect(pkg.browser).toBeUndefined();
  });
});
