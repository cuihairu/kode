import { describe, expect, it } from 'vitest';
import {
  buildScannedActions,
  classifyBatchScript,
  parseQuickActionConfigs,
  parseHttpRequestConfigs,
  resolveActionVariables
} from '../src/quickActionConfig';
import type { BatchScriptCandidate } from '../src/quickActionScanner';

// 快速执行动作的纯函数层:配置解析校验、变量替换、脚本词表分类、扫描条目构造。
// 设计口径见 docs/design/quick-actions-and-db-hint.md 1.8/1.5/1.4;未知变量
// 一律抛错而非空串替换(1.5 拒绝静默空串)。

const FOLDERS = [
  { fsPath: '/ws/main', name: 'Main' },
  { fsPath: '/ws/engine', name: 'Engine' }
];

describe('parseQuickActionConfigs', () => {
  it('accepts all three backends and fills the documented defaults', () => {
    const { actions, invalidCount } = parseQuickActionConfigs([
      { name: 'restart', type: 'command', command: 'kbengine.server.restart', args: ['baseapp'] },
      { name: 'start_server', type: 'script', script: '${workspaceFolder}/start_server.bat' },
      { name: 'hotfix', type: 'http', url: 'http://127.0.0.1:9000/reload' }
    ]);

    expect(invalidCount).toBe(0);
    expect(actions).toEqual([
      {
        name: 'restart',
        type: 'command',
        command: 'kbengine.server.restart',
        args: ['baseapp'],
        confirm: true,
        source: 'manual'
      },
      {
        name: 'start_server',
        type: 'script',
        script: '${workspaceFolder}/start_server.bat',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'manual'
      },
      {
        name: 'hotfix',
        type: 'http',
        url: 'http://127.0.0.1:9000/reload',
        method: 'POST',
        confirm: true,
        source: 'manual'
      }
    ]);
  });

  it('keeps explicit values and optional fields', () => {
    const { actions } = parseQuickActionConfigs([
      {
        name: 'stop_all',
        type: 'script',
        script: './stop.bat',
        cwd: '${workspaceFolder}',
        background: true,
        confirm: false,
        source: 'scan',
        category: 'server'
      },
      { name: 'ping', type: 'http', url: 'http://127.0.0.1/ping', method: 'GET', body: '' }
    ]);

    expect(actions).toEqual([
      {
        name: 'stop_all',
        type: 'script',
        script: './stop.bat',
        cwd: '${workspaceFolder}',
        background: true,
        confirm: false,
        source: 'scan',
        category: 'server'
      },
      { name: 'ping', type: 'http', url: 'http://127.0.0.1/ping', method: 'GET', body: '', confirm: true, source: 'manual' }
    ]);
  });

  it('drops every malformed entry and counts them', () => {
    const raw = [
      null,
      'not-an-object',
      {},
      { name: '  ', type: 'command', command: 'kbengine.refreshExplorer' },
      { name: 'nope', type: 'shell' },
      { name: 'no-target', type: 'command' },
      { name: 'no-target', type: 'script' },
      { name: 'no-target', type: 'http' },
      { name: 'bad-method', type: 'http', url: 'http://127.0.0.1', method: 'DELETE' },
      { name: 'bad-args', type: 'command', command: 'kbengine.refreshExplorer', args: 'baseapp' },
      { name: 'bad-confirm', type: 'command', command: 'kbengine.refreshExplorer', confirm: 'yes' },
      { name: 'bad-source', type: 'command', command: 'kbengine.refreshExplorer', source: 'auto' },
      { name: 'bad-category', type: 'script', script: './x.bat', category: 'misc' }
    ];

    const { actions, invalidCount } = parseQuickActionConfigs(raw);
    expect(actions).toEqual([]);
    expect(invalidCount).toBe(13);
  });

  it('skips invalid entries while keeping the valid ones', () => {
    const { actions, invalidCount } = parseQuickActionConfigs([
      { name: 'keep', type: 'command', command: 'kbengine.refreshExplorer' },
      { name: 'drop', type: 'command' }
    ]);

    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('keep');
    expect(invalidCount).toBe(1);
  });

  it('accepts an empty and non-array raw shape as an empty action list', () => {
    expect(parseQuickActionConfigs([])).toEqual({ actions: [], invalidCount: 0, warnings: [] });
    expect(parseQuickActionConfigs(undefined as unknown as unknown[])).toEqual({ actions: [], invalidCount: 0, warnings: [] });
  });

  it('background 非布尔不再静默:条目保留按前台执行,告警说清写法(2026-10-27 ①)', () => {
    // 用户 JSON5 习惯写 "background": "true" 此前无声回落 false 走前台,
    // 「写了 true 还是弹终端」查无实据;现在逐条告警,动作仍执行不断工作流
    const { actions, invalidCount, warnings } = parseQuickActionConfigs([
      { name: '起服', type: 'script', script: 'start_server.bat', background: 'true' },
      { name: '导表', type: 'script', script: 'export.bat', background: 1 }
    ]);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ name: '起服', background: false });
    expect(actions[1]).toMatchObject({ name: '导表', background: false });
    expect(invalidCount).toBe(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('「起服」');
    expect(warnings[0]).toContain('"true"');
    expect(warnings[0]).toContain('不带引号');
    expect(warnings[1]).toContain('1');
  });

  it('background 布尔与缺省零告警(写法正确不该被打扰)', () => {
    const { actions, warnings } = parseQuickActionConfigs([
      { name: 'a', type: 'script', script: 'a.bat', background: true },
      { name: 'b', type: 'script', script: 'b.bat' }
    ]);

    expect(actions.map(action => action.background)).toEqual([true, false]);
    expect(warnings).toEqual([]);
  });
});

describe('parseHttpRequestConfigs', () => {
  it('parses headers/body and rejects missing method or url', () => {
    expect(parseHttpRequestConfigs([
      { method: 'post', url: '${workspaceFolder}/api/login', headers: { Authorization: 'Bearer ${env:TOKEN}' }, body: '{"ok":true}' },
      { url: '/missing-method' }, { method: 'GET' }
    ])).toEqual({
      requests: [{ method: 'POST', url: '${workspaceFolder}/api/login', headers: { Authorization: 'Bearer ${env:TOKEN}' }, body: '{"ok":true}' }],
      invalidCount: 2
    });
    expect(resolveActionVariables('${workspaceFolder}/api/login', FOLDERS)).toBe('/ws/main/api/login');
    expect(resolveActionVariables('{"path":"${workspaceFolder}/cfg"}', FOLDERS)).toBe('{"path":"/ws/main/cfg"}');
  });
});

describe('resolveActionVariables', () => {
  it('substitutes ${workspaceFolder} with the first workspace folder', () => {
    expect(resolveActionVariables('${workspaceFolder}/start.bat', FOLDERS)).toBe('/ws/main/start.bat');
  });

  it('substitutes ${workspaceFolder:Name} by folder name', () => {
    expect(resolveActionVariables('${workspaceFolder:Engine}/build.bat', FOLDERS)).toBe('/ws/engine/build.bat');
  });

  it('substitutes ${env:NAME} from the process environment', () => {
    process.env['KODE_QA_PORT'] = '9000';
    process.env['KODE_QA_PATH'] = '/tmp/hotfix';
    try {
      expect(
        resolveActionVariables('http://127.0.0.1:${env:KODE_QA_PORT}/reload?next=${env:KODE_QA_PATH}', FOLDERS)
      ).toBe('http://127.0.0.1:9000/reload?next=/tmp/hotfix');
    } finally {
      delete process.env['KODE_QA_PORT'];
      delete process.env['KODE_QA_PATH'];
    }
  });

  it('throws naming the variable when it is unknown', () => {
    expect(() => resolveActionVariables('${config:kbengine.x}', FOLDERS)).toThrow(/config:kbengine\.x/);
  });

  it('throws when no workspace folder is available', () => {
    expect(() => resolveActionVariables('${workspaceFolder}/x.bat')).toThrow(/workspaceFolder/);
  });

  it('throws when the named workspace folder does not exist', () => {
    expect(() => resolveActionVariables('${workspaceFolder:Missing}/x.bat', FOLDERS)).toThrow(/workspaceFolder:Missing/);
  });

  it('throws when the env variable is not set', () => {
    delete process.env['KODE_QA_UNSET_VAR'];
    expect(() => resolveActionVariables('${env:KODE_QA_UNSET_VAR}', FOLDERS)).toThrow(/env:KODE_QA_UNSET_VAR/);
  });

  it('returns the text unchanged when it has no variables', () => {
    expect(resolveActionVariables('kbengine.server.restart', FOLDERS)).toBe('kbengine.server.restart');
  });

  it('substitutes several variables inside one string', () => {
    const text = '${workspaceFolder:Engine}/${workspaceFolder}/start.bat';
    expect(resolveActionVariables(text, FOLDERS)).toBe('/ws/engine/ws/main/start.bat');
  });
});

describe('classifyBatchScript', () => {
  it('classifies server scripts by the stop/start word list', () => {
    expect(classifyBatchScript('start_server.bat')).toBe('server');
    expect(classifyBatchScript('START_ALL.bat')).toBe('server');
    expect(classifyBatchScript('boot.bat')).toBe('server');
    expect(classifyBatchScript('restart_cell.bat')).toBe('server');
    expect(classifyBatchScript('stop.bat')).toBe('server');
    expect(classifyBatchScript('server_ctl.bat')).toBe('server');
  });

  it('classifies export scripts by the export word list', () => {
    expect(classifyBatchScript('export_tables.bat')).toBe('export');
    expect(classifyBatchScript('Convert.bat')).toBe('export');
    expect(classifyBatchScript('导表.bat')).toBe('export');
  });

  it('prefers the server category when both word lists match', () => {
    expect(classifyBatchScript('start_export.bat')).toBe('server');
  });

  it('returns null for unmatched names', () => {
    expect(classifyBatchScript('readme.bat')).toBeNull();
    expect(classifyBatchScript('tools/setup.bat')).toBeNull();
  });
});

describe('buildScannedActions', () => {
  it('builds script entries with variable paths and the scanned defaults', () => {
    const candidates: BatchScriptCandidate[] = [
      { path: '/ws/start_server.bat', category: 'server' },
      { path: '/ws/stop_server.bat', category: 'server' },
      { path: '/ws/EXPORT_TABLES.bat', category: 'export' }
    ];

    expect(buildScannedActions(candidates, '/ws')).toEqual([
      {
        name: 'start_server',
        type: 'script',
        script: '${workspaceFolder}/start_server.bat',
        cwd: '${workspaceFolder}',
        background: true,
        confirm: true,
        source: 'scan',
        category: 'server'
      },
      {
        name: 'stop_server',
        type: 'script',
        script: '${workspaceFolder}/stop_server.bat',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'scan',
        category: 'server'
      },
      {
        name: 'EXPORT_TABLES',
        type: 'script',
        script: '${workspaceFolder}/EXPORT_TABLES.bat',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'scan',
        category: 'export'
      }
    ]);
  });

  it('omits the category when the script is outside the word list', () => {
    const actions = buildScannedActions(
      [{ path: '/ws/docs-dev.bat', category: null }, { path: '/ws/build.ps1', category: null }],
      '/ws'
    );

    expect(actions).toHaveLength(2);
    expect(actions[0]).not.toHaveProperty('category');
    expect(actions[1]).not.toHaveProperty('category');
    expect(actions[1].script).toBe('${workspaceFolder}/build.ps1');
  });

  it('marks boot-named scripts as background as well', () => {
    const actions = buildScannedActions(
      [{ path: '/ws/BOOT.bat', category: 'server' }],
      '/ws'
    );
    expect(actions[0].background).toBe(true);
  });

  it('returns an empty list for no candidates', () => {
    expect(buildScannedActions([], '/ws')).toEqual([]);
  });

  it('keeps the relative path and script directory for candidates under assetsRoot', () => {
    const actions = buildScannedActions(
      [{ path: '/other/scripts/boot_cell.bat', category: 'server' }],
      '/ws'
    );

    expect(actions[0].script).toBe('${workspaceFolder}/../other/scripts/boot_cell.bat');
    expect(actions[0].cwd).toBe('${workspaceFolder}/../other/scripts');
    expect(actions[0].name).toBe('boot_cell');
    expect(actions[0].background).toBe(true);
  });

  it('sets cwd to the directory containing a scanned nested script', () => {
    const action = buildScannedActions(
      [{ path: '/assets/scripts/restart.bat', category: 'server' }], '/workspace'
    )[0];
    expect(action.script).toBe('${workspaceFolder}/../assets/scripts/restart.bat');
    expect(action.cwd).toBe('${workspaceFolder}/../assets/scripts');
  });
});

describe('parseQuickActionConfigs venv option', () => {
  it('accepts optional venv settings for script actions and rejects malformed settings', () => {
    expect(parseQuickActionConfigs([
      { name: 'task', type: 'script', script: '${workspaceFolder}/task.bat', venv: { enabled: true, path: '${workspaceFolder}/.venv' } },
      { name: 'bad', type: 'script', script: 'task.bat', venv: { enabled: 'yes' } }
    ])).toMatchObject({
      actions: [{ venv: { enabled: true, path: '${workspaceFolder}/.venv' } }],
      invalidCount: 1
    });
  });
});
