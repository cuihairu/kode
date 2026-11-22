import { afterEach, expect, it } from 'vitest';
import { configurationOverrides } from './fake-vscode/workspaceState';
import { cloneProbeTimeoutMs } from '../src/databaseWiring';
import { CLONE_PROBE_TIMEOUT_MS_DEFAULT } from '../src/backend/playerDataCloneCommands';

// UX-2026-11-22 整改2「配置项读取」臂:装配面 kbengine.clone.probeTimeoutMs
// 读值——缺省 5s;探针档在 fire time 读(provider 注入),配置改动下一次
// 探针即生效。导出执行侧超时不受此配置影响(独立档)。

afterEach(() => {
  configurationOverrides.clear();
});

it('reads kbengine.clone.probeTimeoutMs with the documented 5s default', () => {
  expect(CLONE_PROBE_TIMEOUT_MS_DEFAULT).toBe(5000);
  expect(cloneProbeTimeoutMs()).toBe(5000);
});

it('reads the configured override (fire-time provider, no reload needed)', () => {
  configurationOverrides.set('kbengine.clone', { probeTimeoutMs: 250 });
  expect(cloneProbeTimeoutMs()).toBe(250);
  configurationOverrides.set('kbengine.clone', { probeTimeoutMs: 10000 });
  expect(cloneProbeTimeoutMs()).toBe(10000);
});
