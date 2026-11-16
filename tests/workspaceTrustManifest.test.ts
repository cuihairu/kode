import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// RUST-198(旧 EXEC-010):执行命令必须遵守 workspace trust——manifest 层声明
// 「不受信任的工作区不支持」,扩展在未信任工作区不被启用,一切按工作区配置
// 拉起引擎/Python 进程的面(引擎组件/快速动作/测试运行)在信任门前零执行。
// 描述文案走 %key% nls 占位(两语言包),与 manifestI18n 契约同构。

const REPO_ROOT = path.resolve(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  capabilities: {
    untrustedWorkspaces?: { supported: boolean; description?: string };
  };
};

function readNls(file: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) as Record<string, string>;
}

describe('workspace trust manifest gate (RUST-198)', () => {
  it('声明 untrustedWorkspaces supported=false(不受信任工作区零执行)', () => {
    expect(manifest.capabilities.untrustedWorkspaces).toBeDefined();
    expect(manifest.capabilities.untrustedWorkspaces?.supported).toBe(false);
  });

  it('声明描述走 %key% nls 占位且两语言包同键非空', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const key = 'kbengine.capability.untrustedWorkspaces.description';
    expect(raw).toContain(`"description": "%${key}%"`);
    expect(readNls('package.nls.json')[key]).toBeTruthy();
    expect(readNls('package.nls.zh-cn.json')[key]).toBeTruthy();
  });
});
