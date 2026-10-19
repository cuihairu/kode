import { describe, expect, it } from 'vitest';
import { QuickActionTreeProvider } from '../src/quickActionTree';

describe('QuickActionTreeProvider', () => {
  it('groups registered and scanned scripts with counts and direct click execution', async () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => ({
        registered: [{ name: '启动服务', type: 'script', target: 'C:/workspace/scripts/start_server.bat' }],
        scripts: [{ name: 'cleanup.ps1', type: 'script', target: 'C:/workspace/tools/cleanup.ps1', runDirect: true }],
        httpRequests: [
          { name: 'health', type: 'http', method: 'GET', target: 'http://127.0.0.1:8080/health', requestIndex: 0 },
          { name: 'login', type: 'http', method: 'POST', target: 'http://127.0.0.1:8080/api/login', requestIndex: 1 }
        ]
      })
    });
    const groups = await provider.getChildren();
    expect(groups.map(group => group.label)).toEqual(['已登记 1', '全部脚本 1', 'HTTP 请求 2']);
    const registered = await provider.getChildren(groups[0]);
    const allScripts = await provider.getChildren(groups[1]);
    const httpRequests = await provider.getChildren(groups[2]);
    expect(registered[0].label).toBe('start_server.bat');
    expect(registered[0].description).toBe('C:/workspace/scripts/start_server.bat');
    expect(registered[0].command).toMatchObject({ command: 'kbengine.quickActions.runByName', arguments: ['启动服务'] });
    expect(allScripts[0].label).toBe('cleanup.ps1');
    expect(allScripts[0].command).toMatchObject({ command: 'kbengine.quickActions.runByName', arguments: ['@script:C:/workspace/tools/cleanup.ps1'] });
    expect(httpRequests[0].label).toBe('GET  127.0.0.1:8080/health');
    expect(httpRequests[0].tooltip).toContain('http://127.0.0.1:8080/health');
    expect(httpRequests[0].command).toMatchObject({ command: 'kbengine.quickActions.runByName', arguments: ['@http:0'] });
    expect(httpRequests[1].label).toBe('POST  127.0.0.1:8080/api/login');
  });

  it('shows a configuration hint and makes the empty row trigger script scanning', async () => {
    const provider = new QuickActionTreeProvider({ getActions: async () => ({ registered: [], scripts: [], httpRequests: [] }) });
    const [row] = await provider.getChildren();
    expect(row.label).toContain('.kbengine/debug.json');
    expect(row.label).toContain('quickActions');
    expect(row.description).toContain('HTTP');
    expect(row.command).toMatchObject({ command: 'kbengine.quickActions.scanScripts' });
  });
});
