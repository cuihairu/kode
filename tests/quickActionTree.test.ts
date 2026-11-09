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
    expect(groups.map(group => group.label)).toEqual(['Registered 1', 'All Scripts 1', 'HTTP Requests 2']);
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
    expect(httpRequests[0].command).toMatchObject({ command: 'kbengine.quickActions.runByName', arguments: ['@http:debug:0'] });
    expect(httpRequests[1].label).toBe('POST  127.0.0.1:8080/api/login');
  });

  it('http 目标不是合法 URL 时按原样展示(shortUrl 兜底)', async () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => ({
        registered: [],
        scripts: [],
        httpRequests: [
          { name: 'odd', type: 'http', method: 'GET', target: 'not-a-valid-url', requestIndex: 0 }
        ]
      })
    });
    const groups = await provider.getChildren();
    const httpRequests = await provider.getChildren(groups[2]);
    expect(httpRequests[0].label).toContain('not-a-valid-url');
    expect(httpRequests[0].tooltip).toContain('not-a-valid-url');
  });

  it('offers separate actions for scanning scripts and configuring HTTP requests', async () => {
    const provider = new QuickActionTreeProvider({ getActions: async () => ({ registered: [], scripts: [], httpRequests: [] }) });
    const [row, http] = await provider.getChildren();
    expect(row.label).toBe('Scan workspace scripts');
    expect(row.command).toMatchObject({ command: 'kbengine.quickActions.scanScripts' });
    expect(http.command).toMatchObject({ command: 'workbench.action.openSettings', arguments: ['kbengine.httpRequests'] });
  });

  // UX-REVIEW-003c:文案与实际行为一致——空态条目在工作区已开但无脚本时同样
  // 出现,tooltip 不得谎称「要先打开工作区」;它描述的是点击后的真实行为。
  it('empty state tooltip describes the scan action instead of claiming a workspace is required', async () => {
    const provider = new QuickActionTreeProvider({ getActions: async () => ({ registered: [], scripts: [], httpRequests: [] }) });
    const [row] = await provider.getChildren();
    expect(row.tooltip).toBe('Runs the script scan; you will be guided to open a workspace when none is open');
    expect(row.tooltip).not.toContain('Open a workspace');
  });

  // UX-REVIEW-003c:配置来源可追溯——registered 动作来自 .kbengine/debug.json,
  // 扫描直达脚本(runDirect)的来源就是自身路径,tooltip 不重复标注来源。
  it('marks the config source on registered actions and omits it for direct-run scanned scripts', async () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => ({
        registered: [
          { name: '启动服务', type: 'script', target: 'C:/workspace/scripts/start_server.bat' },
          { name: 'settings-request', type: 'http', method: 'GET', target: 'http://127.0.0.1:8080/health', requestIndex: 0, requestSource: 'settings' }
        ],
        scripts: [{ name: 'cleanup.ps1', type: 'script', target: 'C:/workspace/tools/cleanup.ps1', runDirect: true }],
        httpRequests: [{ name: 'health', type: 'http', method: 'GET', target: 'http://127.0.0.1:8080/health', requestIndex: 0, requestSource: 'debug' }]
      })
    });
    const groups = await provider.getChildren();
    const registered = await provider.getChildren(groups[0]);
    const allScripts = await provider.getChildren(groups[1]);
    const httpRequests = await provider.getChildren(groups[2]);
    expect(registered[0].tooltip).toContain('Source: .kbengine/debug.json');
    // HTTP 行沿用 requestSource 口径:settings 来源点名设置键,debug 来源点名配置文件
    expect(registered[1].tooltip).toContain('Source: kbengine.httpRequests');
    expect(httpRequests[0].tooltip).toContain('Source: .kbengine/debug.json');
    expect(allScripts[0].tooltip).not.toContain('Source:');
  });
});
