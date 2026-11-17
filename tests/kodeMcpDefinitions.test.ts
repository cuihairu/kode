/**
 * KODE-MCP-HOST 纯核单测(2026-11-13 用户令「内置 mcp,点击开启,默认开启」)。
 * buildKodeMcpServerSpecs 归约锁:默认开启、二进制缺失/关闭诚实零定义、
 * assets 根落空跳过、同名文件夹 label 去重、args=[assets 根](kode-mcp CLI
 * 契约)。vscode 装配面(src/kodeMcpHost.ts)经 electron 集成面兜底。
 */
import { describe, expect, it } from 'vitest';
import { buildKodeMcpServerSpecs } from '../src/backend/kodeMcpDefinitions';

const resolve = (root: string): string => `${root}/assets`;

describe('buildKodeMcpServerSpecs (pure)', () => {
  it('default enabled: one server per folder with binary + assets root', () => {
    const specs = buildKodeMcpServerSpecs({
      workspaceFolders: ['/ws/kbengine-demo'],
      binaryPath: '/ext/bin/kode-mcp',
      enabled: true,
      resolveAssetsRoot: resolve
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].command).toBe('/ext/bin/kode-mcp');
    expect(specs[0].args).toEqual(['/ws/kbengine-demo/assets']);
    expect(specs[0].label).toContain('kbengine-demo');
  });

  it('enabled=false yields zero definitions (click-to-off is honest)', () => {
    const specs = buildKodeMcpServerSpecs({
      workspaceFolders: ['/ws/a', '/ws/b'],
      binaryPath: '/ext/bin/kode-mcp',
      enabled: false,
      resolveAssetsRoot: resolve
    });
    expect(specs).toEqual([]);
  });

  it('missing binary yields zero definitions (no dead servers)', () => {
    const specs = buildKodeMcpServerSpecs({
      workspaceFolders: ['/ws/a'],
      binaryPath: '',
      enabled: true,
      resolveAssetsRoot: resolve
    });
    expect(specs).toEqual([]);
  });

  it('folder without resolvable assets root is skipped, not fabricated', () => {
    const specs = buildKodeMcpServerSpecs({
      workspaceFolders: ['/ws/with-assets', '/ws/plain'],
      binaryPath: '/ext/bin/kode-mcp',
      enabled: true,
      resolveAssetsRoot: root => (root === '/ws/plain' ? '' : resolve(root))
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].args).toEqual(['/ws/with-assets/assets']);
  });

  it('duplicate folder basenames get deterministic ordinal labels', () => {
    const specs = buildKodeMcpServerSpecs({
      workspaceFolders: ['/a/server', '/b/server'],
      binaryPath: '/ext/bin/kode-mcp',
      enabled: true,
      resolveAssetsRoot: resolve
    });
    expect(specs).toHaveLength(2);
    expect(specs[0].label).toBe('Kode MCP: server');
    expect(specs[1].label).toBe('Kode MCP: server (2)');
  });

  it('empty workspace yields zero definitions', () => {
    expect(
      buildKodeMcpServerSpecs({
        workspaceFolders: [],
        binaryPath: '/ext/bin/kode-mcp',
        enabled: true,
        resolveAssetsRoot: resolve
      })
    ).toEqual([]);
  });
});

// 写键回归锁(2026-11-17 用户报错「Unable to write to user settings because
// kbengine.kbengine.mcp.enabled is not a registered configuration」):toggle
// 曾把全限定名传给 sectioned config.update —— update 键相对 section,叠出
// kbengine.kbengine.* 双前缀(未注册,VS Code 拒写,状态栏点击静默失效)。
// 锁死:落账键必须恰为 kbengine.mcp.enabled。
import { toggleKodeMcpEnabled } from '../src/kodeMcpHost';
import {
  ConfigurationTarget,
  globalConfigurationOverrides,
  workspaceState
} from './helpers/vscodeStub';

describe('toggleKodeMcpEnabled(写键回归锁)', () => {
  it('update 走相对键:落账 kbengine.mcp.enabled,不产出 kbengine.kbengine.* 双前缀', async () => {
    globalConfigurationOverrides.clear();
    workspaceState.workspaceConfigurationUpdates.length = 0;
    await toggleKodeMcpEnabled();
    const updates = workspaceState.workspaceConfigurationUpdates as Array<{
      key: string;
      value: boolean;
      scope: unknown;
    }>;
    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe('kbengine.mcp.enabled');
    expect(updates[0].value).toBe(false); // 默认开启(true),首次点击即关
    expect(updates[0].scope).toBe(ConfigurationTarget.Global);
    // 替身写回覆写表(写后 get 立即可见):再点翻回开启
    await toggleKodeMcpEnabled();
    expect(updates[1].key).toBe('kbengine.mcp.enabled');
    expect(updates[1].value).toBe(true);
    globalConfigurationOverrides.clear();
  });
});
