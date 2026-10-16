/**
 * 批142(用户 2026-10-16 单 kode-debug-json.md):`.kbengine/debug.json` 缺失
 * 即自动生成带注释的空骨架,并按本仓既有扫描逻辑(quickActionScanner)把工作
 * 目录下的启停/导表脚本填进 quickActions;工作目录支持环境变量指定,优先级
 * 环境变量 / 配置文件 / 默认值,冲突如实说明取舍。纯层注入 deps 不碰真 fs。
 */
import { describe, expect, it } from 'vitest';
import {
  DEBUG_WORKSPACE_ENV_VAR,
  WORKSPACE_ROOT_SOURCE_LABELS,
  buildDebugConfigSkeleton,
  ensureDebugConfig,
  parseDebugConfigText,
  resolveDebugWorkspaceRoot,
  stripJsonComments,
  type DebugConfigBootstrapDeps
} from '../src/debugConfigBootstrap';
import type { QuickAction } from '../src/quickActionConfig';
import { type DirectoryEntry } from '../src/quickActionScanner';

const FOLDERS = [
  { name: 'proj', fsPath: '/ws/proj' },
  { name: 'other', fsPath: '/ws/other' }
];

describe('resolveDebugWorkspaceRoot', () => {
  it('环境变量优先于配置文件与默认工作区根', () => {
    const resolved = resolveDebugWorkspaceRoot({
      env: { [DEBUG_WORKSPACE_ENV_VAR]: '/env/root' },
      fileConfig: { workspaceRoot: '/file/root' },
      workspaceFolders: FOLDERS
    });
    expect(resolved).toEqual({
      root: '/env/root',
      source: 'env',
      overridden: ['配置文件 workspaceRoot=/file/root', '默认值=/ws/proj']
    });
  });

  it('无环境变量时取配置文件 workspaceRoot', () => {
    const resolved = resolveDebugWorkspaceRoot({
      env: {},
      fileConfig: { workspaceRoot: '/file/root' },
      workspaceFolders: FOLDERS
    });
    expect(resolved?.source).toBe('config');
    expect(resolved?.root).toBe('/file/root');
    expect(resolved?.overridden).toEqual(['默认值=/ws/proj']);
  });

  it('两者都没有时回落首个工作区根', () => {
    const resolved = resolveDebugWorkspaceRoot({ env: {}, fileConfig: null, workspaceFolders: FOLDERS });
    expect(resolved?.source).toBe('default');
    expect(resolved?.root).toBe('/ws/proj');
    expect(resolved?.overridden).toEqual([]);
  });

  it('没有工作区根也没有任何来源时返回 null', () => {
    expect(resolveDebugWorkspaceRoot({ env: {}, fileConfig: null, workspaceFolders: [] })).toBeNull();
  });

  it('取值走 VS Code 官方变量替换(批141 单一真源)', () => {
    const resolved = resolveDebugWorkspaceRoot({
      env: { [DEBUG_WORKSPACE_ENV_VAR]: '${workspaceFolder}/server' },
      fileConfig: null,
      workspaceFolders: FOLDERS
    });
    expect(resolved?.root).toBe('/ws/proj/server');
    expect(resolved?.source).toBe('env');
  });

  it('变量替换后为空串按未配置处理,顺位回落下一来源', () => {
    const resolved = resolveDebugWorkspaceRoot({
      env: { [DEBUG_WORKSPACE_ENV_VAR]: '${env:NOT_SET_ANYWHERE}' },
      fileConfig: { workspaceRoot: '/file/root' },
      workspaceFolders: FOLDERS
    });
    expect(resolved?.source).toBe('config');
    expect(resolved?.root).toBe('/file/root');
  });

  it('来源标签说明每档取值出处', () => {
    expect(WORKSPACE_ROOT_SOURCE_LABELS.env).toContain(DEBUG_WORKSPACE_ENV_VAR);
    expect(WORKSPACE_ROOT_SOURCE_LABELS.config).toContain('workspaceRoot');
    expect(WORKSPACE_ROOT_SOURCE_LABELS.default).toContain('默认');
  });
});

describe('stripJsonComments / parseDebugConfigText', () => {
  it('剥行注释与块注释,保留字符串里的注释符', () => {
    const text = `{
  // 行注释
  "a": "http://example.com//x",
  /* 块
     注释 */
  "b": "/* 不是注释 */"
}`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      a: 'http://example.com//x',
      b: '/* 不是注释 */'
    });
  });

  it('转义引号内的注释符不参与剥除', () => {
    expect(JSON.parse(stripJsonComments('{"a": "say \\"//hi\\""}'))).toEqual({ a: 'say "//hi"' });
  });

  it('坏 JSON 返回 null,不抛', () => {
    expect(parseDebugConfigText('{ 不是 json')).toBeNull();
    expect(parseDebugConfigText('')).toBeNull();
  });

  it('合法 JSON 原样解析', () => {
    expect(parseDebugConfigText('{"version": 1}')).toEqual({ version: 1 });
  });
});

const sampleAction: QuickAction = {
  name: 'start-server',
  type: 'script',
  script: '${workspaceFolder}/start_server.bat',
  background: true,
  confirm: true,
  source: 'scan',
  category: 'server'
};

describe('buildDebugConfigSkeleton', () => {
  const workspace = { root: '/ws/proj', source: 'env' as const, overridden: [] };

  it('逐字段带注释说明,写明当前生效值与来源', () => {
    const skeleton = buildDebugConfigSkeleton({ workspace, actions: [] });
    expect(skeleton).toContain('${workspaceFolder}');
    expect(skeleton).toContain(DEBUG_WORKSPACE_ENV_VAR);
    expect(skeleton).toContain('/ws/proj');
    expect(skeleton).toContain(WORKSPACE_ROOT_SOURCE_LABELS.env);
    expect(skeleton).toContain('defaultTelnetHost');
    expect(skeleton).toContain('telnetEnableCommands');
    expect(skeleton).toContain('pathMappings');
  });

  it('骨架剥注释后是合法 JSON 且带 version/debug/quickActions 三段', () => {
    const parsed = parseDebugConfigText(buildDebugConfigSkeleton({ workspace, actions: [] }));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual(expect.arrayContaining(['version', 'debug', 'quickActions']));
    expect(Array.isArray(parsed!.quickActions)).toBe(true);
    expect((parsed!.debug as { components: Record<string, unknown> }).components).toBeTypeOf('object');
  });

  it('扫到脚本时把动作写进 quickActions', () => {
    const parsed = parseDebugConfigText(buildDebugConfigSkeleton({ workspace, actions: [sampleAction] }));
    expect(parsed!.quickActions).toEqual([sampleAction]);
  });

  it('无脚本时 quickActions 留空数组并给注释示例', () => {
    const skeleton = buildDebugConfigSkeleton({ workspace, actions: [] });
    expect(skeleton).toContain('"quickActions": []');
    expect(skeleton).toContain('"type": "script"');
    expect(skeleton).toContain('"type": "command"');
    expect(skeleton).toContain('"type": "http"');
  });

  it('冲突取舍逐条写进骨架注释', () => {
    const skeleton = buildDebugConfigSkeleton({
      workspace: {
        root: '/env/root',
        source: 'env',
        overridden: ['配置文件 workspaceRoot=/file/root']
      },
      actions: []
    });
    expect(skeleton).toContain('配置文件 workspaceRoot=/file/root');
  });
});

interface Script {
  existing?: string[];
  entries?: DirectoryEntry[];
  writeFails?: boolean;
  readFails?: boolean;
}

function makeDeps(script: Script = {}): {
  deps: DebugConfigBootstrapDeps;
  writes: Array<{ path: string; content: string }>;
  mkdirs: string[];
  logs: string[];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    mkdirs,
    logs,
    deps: {
      exists: (candidate: string): boolean => (script.existing ?? []).includes(candidate),
      readFile: (): string => {
        if (script.readFails === true) {
          throw new Error('读不到');
        }
        return '';
      },
      writeFile: (path: string, content: string): void => {
        if (script.writeFails === true) {
          throw new Error('只读文件系统');
        }
        writes.push({ path, content });
      },
      mkdir: (dir: string): void => {
        mkdirs.push(dir);
      },
      listDir: (): DirectoryEntry[] => script.entries ?? [],
      log: (line: string): void => {
        logs.push(line);
      }
    }
  };
}

describe('ensureDebugConfig', () => {
  it('配置文件已存在时零写零日志', () => {
    const { deps, writes, mkdirs, logs } = makeDeps({ existing: ['/ws/proj/.kbengine/debug.json'] });
    const result = ensureDebugConfig(deps, { env: {}, workspaceFolders: FOLDERS });
    expect(result.status).toBe('exists');
    expect(writes).toEqual([]);
    expect(mkdirs).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('缺失时建目录并生成骨架,日志说明生效值来源', () => {
    const { deps, writes, mkdirs, logs } = makeDeps();
    const result = ensureDebugConfig(deps, {
      env: { [DEBUG_WORKSPACE_ENV_VAR]: '/ws/proj/server' },
      workspaceFolders: FOLDERS
    });
    expect(result.status).toBe('created');
    expect(result.workspaceRoot).toBe('/ws/proj/server');
    expect(result.workspaceSource).toBe('env');
    expect(mkdirs).toEqual(['/ws/proj/server/.kbengine']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/ws/proj/server/.kbengine/debug.json');
    expect(logs.join('\n')).toContain(DEBUG_WORKSPACE_ENV_VAR);
  });

  it('扫到词表外 .bat/.ps1 也写进 quickActions(不带 category)', () => {
    const { deps, writes } = makeDeps({
      entries: [
        { name: 'build.ps1', type: 1 },
        { name: 'docs-dev.bat', type: 1 },
        { name: 'README.md', type: 1 }
      ]
    });
    const result = ensureDebugConfig(deps, { env: {}, workspaceFolders: FOLDERS });

    expect(result.scannedActions).toBe(2);
    const actions = parseDebugConfigText(writes[0].content)!.quickActions as QuickAction[];
    expect(actions.map(action => action.name)).toEqual(['build', 'docs-dev']);
    expect(actions[0]).not.toHaveProperty('category');
    expect(actions[1]).not.toHaveProperty('category');
  });

  it('无配置时扫到启停脚本就写进 quickActions', () => {
    const { deps, writes } = makeDeps({
      entries: [
        { name: 'start_server.bat', type: 1 },
        { name: 'export_tables.bat', type: 1 },
        { name: 'readme.md', type: 1 }
      ]
    });
    const result = ensureDebugConfig(deps, { env: {}, workspaceFolders: FOLDERS });
    expect(result.scannedActions).toBe(2);
    const parsed = parseDebugConfigText(writes[0].content);
    const actions = parsed!.quickActions as QuickAction[];
    expect(actions.map(action => action.name)).toEqual(['start_server', 'export_tables']);
    expect(actions[0].script).toBe('${workspaceFolder}/start_server.bat');
    expect(actions[0].category).toBe('server');
    expect(actions[1].category).toBe('export');
  });

  it('目录读不到时按无脚本生成空 quickActions', () => {
    const { deps, writes } = makeDeps();
    const result = ensureDebugConfig(deps, {
      env: {},
      workspaceFolders: FOLDERS,
      listDir: () => {
        throw new Error('权限不足');
      }
    });
    expect(result.status).toBe('created');
    expect(result.scannedActions).toBe(0);
    expect(parseDebugConfigText(writes[0].content)!.quickActions).toEqual([]);
  });

  it('写入失败如实回报,不抛', () => {
    const { deps, logs } = makeDeps({ writeFails: true });
    const result = ensureDebugConfig(deps, { env: {}, workspaceFolders: FOLDERS });
    expect(result.status).toBe('write-failed');
    expect(logs.join('\n')).toContain('写入失败');
  });

  it('没有工作区根时不动手', () => {
    const { deps, writes } = makeDeps();
    const result = ensureDebugConfig(deps, { env: {}, workspaceFolders: [] });
    expect(result.status).toBe('no-workspace');
    expect(writes).toEqual([]);
  });
});