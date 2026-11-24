/**
 * Core 轨道切换写回(kbengine.core.backend,Core 灯点击动作的后端):
 *  - 读归一:缺省 rust / 非法值诚实回落 rust,raw 保留配置原文;
 *  - 写作用域:开着工作区文件夹写工作区级(否则写用户级被工作区压住);
 *  - 写后核对:写回后读不到目标值→如实抛错,不谎报成功;
 *  - 非法轨道值拒绝(不产生写回记录)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  CORE_BACKEND_DEFAULT_MODE,
  readCoreBackendMode,
  writeCoreBackendMode
} from '../src/kodeCoreBackendSwitch';
import {
  configurationOverrides,
  globalConfigurationOverrides,
  workspace,
  workspaceState
} from './fake-vscode/workspaceState';

const oneFolder = (): void => {
  workspace.workspaceFolders = [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }];
};

afterEach(() => {
  configurationOverrides.clear();
  globalConfigurationOverrides.clear();
  workspace.workspaceFolders = [];
  workspaceState.workspaceConfigurationUpdates.length = 0;
});

describe('readCoreBackendMode 读归一', () => {
  it('未配置 → 缺省 rust(与 gate 同判据)', () => {
    expect(readCoreBackendMode()).toEqual({ raw: 'rust', effective: 'rust' });
  });

  it('配置 shadow → 原值即生效值', () => {
    configurationOverrides.set('kbengine', { 'core.backend': 'shadow' });
    expect(readCoreBackendMode()).toEqual({ raw: 'shadow', effective: 'shadow' });
  });

  it('非法值 → raw 保留原文,effective 诚实回落缺省', () => {
    configurationOverrides.set('kbengine', { 'core.backend': 'kobold' });
    expect(readCoreBackendMode().raw).toBe('kobold');
    expect(readCoreBackendMode().effective).toBe(CORE_BACKEND_DEFAULT_MODE);
  });
});

describe('writeCoreBackendMode 写回与作用域', () => {
  it('有工作区文件夹 → 写工作区级,写后读得到新值', async () => {
    oneFolder();
    await writeCoreBackendMode('ts');
    expect(workspaceState.workspaceConfigurationUpdates).toEqual([
      {
        key: 'kbengine.core.backend',
        value: 'ts',
        scope: vscode.ConfigurationTarget.Workspace,
        folder: undefined
      }
    ]);
    expect(readCoreBackendMode().effective).toBe('ts');
  });

  it('没有工作区文件夹 → 写用户级(工作区级不适用)', async () => {
    await writeCoreBackendMode('shadow');
    expect(workspaceState.workspaceConfigurationUpdates[0]?.scope).toBe(
      vscode.ConfigurationTarget.Global
    );
    expect(readCoreBackendMode().effective).toBe('shadow');
    expect(globalConfigurationOverrides.get('kbengine')?.core).toMatchObject({ backend: 'shadow' });
  });

  it('写回后读不到目标值 → 如实抛错(被别的作用域覆盖压住)', async () => {
    oneFolder();
    const original = workspace.getConfiguration;
    const frozen = (): unknown => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      update: async () => undefined
    });
    (workspace as unknown as { getConfiguration: unknown }).getConfiguration = frozen;
    try {
      await expect(writeCoreBackendMode('ts')).rejects.toThrow('写入后未生效');
    } finally {
      (workspace as unknown as { getConfiguration: unknown }).getConfiguration = original;
    }
  });

  it('非法轨道值拒绝:不产生任何写回', async () => {
    oneFolder();
    await expect(writeCoreBackendMode('kobold' as never)).rejects.toThrow('非法 Core 轨道');
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
  });
});
