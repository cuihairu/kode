import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostLabel,
  renderExtensionIdentityReport,
  type ExtensionIdentityEntry,
  type ExtensionHostContext
} from '../src/extensionIdentity';
import { readBuildCommit } from '../src/buildCommit';

// IDE-MET-001:扩展身份报告的纯函数面——报告必须区分「安装目录存在」与
// 「当前窗口已激活」两个正交事实(装了没激活/激活中目录已消失都要如实分列),
// 并标注宿主位置(远程 remote(name) / 本地 local)与扩展宿主侧
// (workspace/ui)。采集面(vscode.extensions/fs)在 extension.ts 接线,
// 这里零桩锁定渲染契约。

const entry = (over: Partial<ExtensionIdentityEntry> = {}): ExtensionIdentityEntry => ({
  id: 'cuihairu.kode-kbengine',
  version: '0.2.0',
  extensionPath: '/home/u/.vscode/extensions/cuihairu.kode-kbengine-0.2.0',
  installExists: true,
  isActive: true,
  extensionKind: 'workspace',
  ...over
});

const localHost: ExtensionHostContext = { remoteName: undefined, appName: 'Visual Studio Code' };

describe('extensionIdentity.hostLabel', () => {
  it('远程窗口标注 remote(name),本地窗口标注 local', () => {
    expect(hostLabel({ remoteName: 'ssh-remote+buildbox', appName: 'x' })).toBe('remote(ssh-remote+buildbox)');
    expect(hostLabel(localHost)).toBe('local');
  });
});

describe('extensionIdentity.renderExtensionIdentityReport', () => {
  it('报告头列构建提交:可追溯源码 SHA,不只 package version(IDE-MET-002)', () => {
    const report = renderExtensionIdentityReport(
      [entry()],
      localHost,
      'b'.repeat(40)
    );
    expect(report).toContain(`build commit: ${'b'.repeat(40)}`);
    // 产物无构建信息时如实 unknown,不省略该行(读者不误以为 package version 即源码版本)
    expect(renderExtensionIdentityReport([entry()], localHost, 'unknown')).toContain('build commit: unknown');
    expect(readBuildCommit('/nonexistent-kode-path')).toBe('unknown');
  });

  it('区分安装目录存在与当前窗口已激活:两列事实分列,不合并成一个状态', () => {
    const report = renderExtensionIdentityReport([
      entry({ installExists: true, isActive: false }),
      entry({ id: 'cuihairu.kode-kbengine-dev', installExists: false, isActive: true })
    ], localHost, 'unknown');

    // 第一份:装了但本窗口未激活
    expect(report).toContain('cuihairu.kode-kbengine v0.2.0');
    expect(report).toMatch(/installed=yes .*kode-kbengine-0\.2\.0/);
    expect(report).toMatch(/active=no/);
    // 第二份:激活中但安装目录已从文件系统消失
    expect(report).toContain('cuihairu.kode-kbengine-dev v0.2.0');
    expect(report).toMatch(/installed=no/);
    expect(report).toMatch(/active=yes/);
    // 宿主位置(本地)与扩展宿主侧一并列出
    expect(report).toContain('host: local in Visual Studio Code');
    expect(report).toContain('side=workspace host');
  });

  it('远程宿主位置带 remote 名;ui 侧标注 ui host', () => {
    const report = renderExtensionIdentityReport(
      [entry({ extensionKind: 'ui' })],
      { remoteName: 'wsl+Ubuntu', appName: 'Visual Studio Code' },
      'unknown'
    );
    expect(report).toContain('host: remote(wsl+Ubuntu) in Visual Studio Code');
    expect(report).toContain('side=ui host');
  });

  it('无匹配安装时给出空态,不输出事实行', () => {
    const report = renderExtensionIdentityReport([], localHost, 'unknown');
    expect(report).toContain('host: local in Visual Studio Code');
    expect(report).toContain('no matching extension installs found');
    expect(report).not.toMatch(/installed=/);
  });
});
