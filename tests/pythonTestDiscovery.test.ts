import { describe, expect, it } from 'vitest';
import {
  discoverProjectPythonTests,
  isPythonTestFile,
  parsePythonTestCases,
  showPythonTestList,
  type PythonTestDiscoveryDeps
} from '../src/pythonTestDiscovery';

// IDE-TSK-004 发现项目声明的 Python 测试:只扫所选 profile 的测试范围
// (<assetsRoot>/scripts 一个根,递归收 test_*.py / *_test.py),工作区
// 里其他 *_assets 根与引擎仓是依赖库,结构性不进清单;用例=文件内静
// 态可见的 def test_* / class Test* + 其 test_* 方法,带行号列号
// (TSK-005 测试面板跳源码用)。

const PROFILE = {
  id: 'p',
  displayName: '工程',
  assetsRoot: '/ws/proj/assets',
  engineRoot: '/ws/engine',
  interpreterPath: 'python3',
  interpreterSource: 'path'
};

/** 文件路径→内容 的假树;目录从文件路径派生(发现只会走进 scripts 根) */
const buildFakeDeps = (files: Record<string, string>): PythonTestDiscoveryDeps => {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    let dir = file.slice(0, file.lastIndexOf('/'));
    while (dir) {
      dirs.add(dir);
      const slash = dir.lastIndexOf('/');
      dir = slash > 0 ? dir.slice(0, slash) : '';
    }
  }
  return {
    exists: candidate => dirs.has(candidate),
    readDir: dir => {
      const seen = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${dir}/`)) {
          continue;
        }
        const rest = file.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          seen.set(rest, { name: rest, isDirectory: false, isFile: true });
        } else {
          const name = rest.slice(0, slash);
          seen.set(name, { name, isDirectory: true, isFile: false });
        }
      }
      for (const candidate of dirs) {
        if (!candidate.startsWith(`${dir}/`)) {
          continue;
        }
        const rest = candidate.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name) {
          seen.set(name, { name, isDirectory: true, isFile: false });
        }
      }
      return [...seen.values()];
    },
    readFile: file => files[file] ?? ''
  };
};

describe('isPythonTestFile(pytest/unittest 通用命名)', () => {
  it('test_ 前缀与 _test 后缀收,其余不收', () => {
    expect(isPythonTestFile('test_avatar.py')).toBe(true);
    expect(isPythonTestFile('avatar_test.py')).toBe(true);
    expect(isPythonTestFile('testing.py')).toBe(false);
    expect(isPythonTestFile('tests.py')).toBe(false);
    expect(isPythonTestFile('avatar.py')).toBe(false);
    expect(isPythonTestFile('test_avatar.pyi')).toBe(false);
  });
});

describe('discoverProjectPythonTests(只扫所选 profile 的范围)', () => {
  it('scripts 根内递归收测试文件;兄弟资产根与引擎仓(依赖库)不混入', () => {
    const deps = buildFakeDeps({
      '/ws/proj/assets/scripts/base/test_avatar.py': [
        'def test_login():',
        '    pass',
        '',
        'class TestAvatar:',
        '    def test_move(self):',
        '        pass'
      ].join('\n'),
      '/ws/proj/assets/scripts/data/test_tables.py': '',
      // 依赖库面:兄弟资产根与引擎仓各有测试文件,不许进清单
      '/ws/proj/other_assets/scripts/test_dep.py': 'def test_dep():\n    pass\n',
      '/ws/engine/kbe/res/test_engine.py': 'def test_engine():\n    pass\n'
    });

    const result = discoverProjectPythonTests(PROFILE, deps);

    expect(result.scriptsRoot).toBe('/ws/proj/assets/scripts');
    expect(result.files.map(file => file.relativePath)).toEqual([
      'base/test_avatar.py',
      'data/test_tables.py'
    ]);
    expect(result.files[0].cases).toEqual([
      { name: 'test_login', kind: 'function', line: 1, column: 0 },
      { name: 'test_move', kind: 'method', className: 'TestAvatar', line: 5, column: 4 }
    ]);
    // 空用例文件(静态无 test_* 定义)也按文件收录,用例数如实为 0
    expect(result.files[1].cases).toEqual([]);
    const allPaths = result.files.map(file => file.relativePath).join('\n');
    expect(allPaths).not.toContain('test_dep');
    expect(allPaths).not.toContain('test_engine');
  });

  it('隐藏目录与 __pycache__ 跳过', () => {
    const deps = buildFakeDeps({
      '/ws/proj/assets/scripts/.git/test_hidden.py': 'def test_hidden():\n    pass\n',
      '/ws/proj/assets/scripts/__pycache__/test_cached.py': 'def test_cached():\n    pass\n',
      '/ws/proj/assets/scripts/test_ok.py': 'def test_ok():\n    pass\n'
    });

    const result = discoverProjectPythonTests(PROFILE, deps);

    expect(result.files.map(file => file.relativePath)).toEqual(['test_ok.py']);
  });

  it('scripts 根不在盘:空结果不猜', () => {
    const result = discoverProjectPythonTests(PROFILE, buildFakeDeps({}));

    expect(result.scriptsRoot).toBe('/ws/proj/assets/scripts');
    expect(result.files).toEqual([]);
  });
});

describe('parsePythonTestCases(行级静态解析)', () => {
  it('类内方法收、方法内嵌套函数不收、类后顶层函数回到 function', () => {
    const source = [
      'import unittest',
      '',
      'class TestAvatar:',
      '    def test_move(self):',
      '        pass',
      '',
      '    def helper(self):',
      '        def test_nested(self):',
      '            pass',
      '',
      'def test_top_after_class():',
      '    pass'
    ].join('\n');

    expect(parsePythonTestCases(source)).toEqual([
      { name: 'test_move', kind: 'method', className: 'TestAvatar', line: 4, column: 4 },
      { name: 'test_top_after_class', kind: 'function', line: 11, column: 0 }
    ]);
  });

  it('非 Test 前缀类与非 test_ 前缀函数不收', () => {
    const source = [
      'class Avatar:',
      '    def test_move(self):',
      '        pass',
      '',
      'def move_test():',
      '    pass'
    ].join('\n');

    expect(parsePythonTestCases(source)).toEqual([]);
  });
});

describe('showPythonTestList(列表命令体)', () => {
  const deps = buildFakeDeps({
    '/ws/proj/assets/scripts/base/test_avatar.py': 'def test_login():\n    pass\n'
  });

  it('空结果:一条如实提示带 scripts 根,不弹列表', async () => {
    const emptyDeps = buildFakeDeps({});
    const messages: string[] = [];
    const picks: unknown[][] = [];
    const opened: string[] = [];

    showPythonTestList(PROFILE, {
      discovery: emptyDeps,
      notify: message => messages.push(message),
      pick: async items => {
        picks.push(items);
        return undefined;
      },
      open: file => opened.push(file)
    });
    await Promise.resolve();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('未发现 Python 测试');
    expect(messages[0]).toContain('/ws/proj/assets/scripts');
    expect(picks).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('有结果:QuickPick 列文件(用例数+用例名),选中打开对应文件,Esc 不开', async () => {
    const picks: unknown[][] = [];
    const opened: string[] = [];

    showPythonTestList(PROFILE, {
      discovery: deps,
      pick: async items => {
        picks.push(items);
        return items[0];
      },
      open: file => opened.push(file)
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(picks).toHaveLength(1);
    const items = picks[0] as Array<Record<string, string>>;
    expect(items[0].label).toBe('base/test_avatar.py');
    expect(items[0].description).toBe('1 个用例');
    expect(items[0].detail).toContain('test_login');
    expect(opened).toEqual(['/ws/proj/assets/scripts/base/test_avatar.py']);
  });
});
