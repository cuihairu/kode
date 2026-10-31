import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPytestArgs,
  buildPythonTestSessionReport,
  describePythonTestExecIssue,
  resolvePytestEntries,
  runPythonTests,
  selectSessionFailures,
  spawnTestProcess,
  type PythonTestExecIssue,
  type PythonTestRunItem
} from '../src/pythonTestRunner';

// IDE-TSK-005 测试面板跑单个测试:逐条目 <解释器> -m pytest <file>::<case>
// -v --tb=line -p no:cacheprovider(不在 scripts 根落 .pytest_cache);
// -v 行定通过失败,short summary 行给失败消息;输出原文入账面板;
// 取消=下一跳发起前探针拦截(验收:取消不继续执行下一测试);
// 解释器无 pytest 时如实 errored 一条指明缺口。真 python3+pytest 实跑
// 用例锁输出格式(skipIf 环境无 pytest,CI 面不赌预装)。

const ITEM: PythonTestRunItem = {
  id: 'base/test_avatar.py::test_login',
  file: '/ws/assets/scripts/base/test_avatar.py',
  caseName: 'test_login'
};

describe('buildPytestArgs', () => {
  it('单用例挂 ::节点,整文件只传文件', () => {
    expect(buildPytestArgs(ITEM)).toEqual([
      '-m',
      'pytest',
      '-v',
      '--tb=line',
      '-p',
      'no:cacheprovider',
      '/ws/assets/scripts/base/test_avatar.py::test_login'
    ]);
    expect(buildPytestArgs({ id: 'f', file: '/ws/a/test_x.py' })).toEqual([
      '-m',
      'pytest',
      '-v',
      '--tb=line',
      '-p',
      'no:cacheprovider',
      '/ws/a/test_x.py'
    ]);
  });
});

describe('resolvePytestEntries(输出→逐条目结果)', () => {
  const PASSED_OUTPUT = [
    '============================= test session starts ==============================',
    'collected 1 item',
    '',
    '/ws/assets/scripts/base/test_avatar.py::test_login PASSED          [100%]',
    '',
    '============================== 1 passed in 0.02s ==============================='
  ].join('\n');

  it('-v 行定通过', () => {
    expect(resolvePytestEntries(PASSED_OUTPUT, [ITEM])).toEqual([
      { id: ITEM.id, outcome: 'passed', output: PASSED_OUTPUT }
    ]);
  });

  it('-v 行定失败,short summary 行给消息', () => {
    const output = [
      '/ws/assets/scripts/base/test_avatar.py::test_login FAILED          [100%]',
      '',
      '=================================== FAILURES ===================================',
      'E   assert (1 + 1) == 3',
      '/ws/assets/scripts/base/test_avatar.py:5: assert (1 + 1) == 3',
      '=========================== short test summary info ============================',
      'FAILED /ws/assets/scripts/base/test_avatar.py::test_login - assert (1 + 1) == 3',
      '============================== 1 failed in 0.03s ==============================='
    ].join('\n');

    const entries = resolvePytestEntries(output, [ITEM]);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('failed');
    expect(entries[0].message).toBe('assert (1 + 1) == 3');
  });

  it('整文件条目聚合子用例:最差面+首条失败消息', () => {
    const file = '/ws/a/test_x.py';
    const output = [
      '/ws/a/test_x.py::test_ok PASSED          [ 50%]',
      '/ws/a/test_x.py::test_bad FAILED          [100%]',
      '=========================== short test summary info ============================',
      'FAILED /ws/a/test_x.py::test_bad - assert 2 == 3',
      '============================== 1 failed, 1 passed in 0.04s ==============================='
    ].join('\n');

    const entries = resolvePytestEntries(output, [{ id: 'f', file }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('failed');
    expect(entries[0].message).toBe('assert 2 == 3');
  });

  it('pytest 归一相对路径的节点行(实测 rootdir 相对形态)也能匹配', () => {
    const output = [
      'collected 1 item',
      '',
      'base/test_avatar.py::test_login PASSED          [100%]',
      '============================== 1 passed in 0.02s ==============================='
    ].join('\n');

    const entries = resolvePytestEntries(output, [ITEM]);
    expect(entries[0].outcome).toBe('passed');
  });

  it('解释器无 pytest:如实 errored 指明缺口', () => {
    const output = "/ws/py/python3: No module named pytest";

    const entries = resolvePytestEntries(output, [ITEM]);
    expect(entries[0].outcome).toBe('errored');
    expect(entries[0].message).toContain('pytest');
  });

  it('输出里找不到该条目:errored 未收集到,不猜', () => {
    const entries = resolvePytestEntries('some unrelated stdout\n', [ITEM]);
    expect(entries[0].outcome).toBe('errored');
    expect(entries[0].message).toContain('未收集到测试');
  });
});

describe('runPythonTests(逐条执行+取消语义)', () => {
  const OTHER: PythonTestRunItem = {
    id: 'base/test_avatar.py::test_move',
    file: '/ws/assets/scripts/base/test_avatar.py',
    caseName: 'TestAvatar::test_move'
  };
  const passedOutput = (item: PythonTestRunItem): string =>
    `${item.file}${item.caseName ? `::${item.caseName}` : ''} PASSED          [100%]\n`;

  it('逐条目各出一项结果', async () => {
    const calls: string[][] = [];
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM, OTHER] },
      {
        exec: async ({ args }) => {
          calls.push(args);
          const node = args[args.length - 1];
          return { stdout: `${node} FAILED          [100%]\nFAILED ${node} - boom\n`, stderr: '', code: 1 };
        },
        isCancelled: () => false
      }
    );

    expect(calls).toHaveLength(2);
    expect(entries.map(entry => entry.id)).toEqual([ITEM.id, OTHER.id]);
    expect(entries.every(entry => entry.outcome === 'failed')).toBe(true);
  });

  it('取消:已完成的入账,未发起的下一跳被拦截(验收:取消不继续执行下一测试)', async () => {
    const calls: string[][] = [];
    let cancelled = false;
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM, OTHER] },
      {
        exec: async ({ args }) => {
          calls.push(args);
          const node = args[args.length - 1];
          // 用户在第一跳执行期间点了取消
          cancelled = true;
          return { stdout: passedOutput({ id: 'x', file: node, caseName: undefined }), stderr: '', code: 0 };
        },
        isCancelled: () => cancelled
      }
    );

    expect(calls).toHaveLength(1);
    expect(entries.map(entry => entry.id)).toEqual([ITEM.id]);
    expect(entries[0].outcome).toBe('passed');
  });

  it('开跑前已取消:零发起零结果', async () => {
    const calls: string[][] = [];
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM, OTHER] },
      {
        exec: async ({ args }) => {
          calls.push(args);
          return { stdout: '', stderr: '', code: 0 };
        },
        isCancelled: () => true
      }
    );

    expect(calls).toHaveLength(0);
    expect(entries).toEqual([]);
  });

  it('PASSED 节点但进程退出非零:节点主体保留 passed,退出码入账不再丢弃 (R2-F19)', async () => {
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM] },
      {
        exec: async () => ({
          stdout: passedOutput(ITEM),
          stderr: 'teardown error text',
          code: 1
        }),
        isCancelled: () => false
      }
    );

    expect(entries[0].outcome).toBe('passed');
    expect(entries[0].exec?.code).toBe(1);
    expect(entries[0].exec?.stderr).toContain('teardown');
  });

  it('解释器缺失(spawn 错误):节点 errored 显式说明,exec 带 spawnError', async () => {
    const entries = await runPythonTests(
      { interpreterPath: '/ws/missing/python3', cwd: '/ws/assets/scripts', items: [ITEM] },
      {
        exec: async () => ({
          stdout: '',
          stderr: '/ws/missing/python3: No such file',
          code: null,
          spawnError: 'spawn ENOENT'
        }),
        isCancelled: () => false
      }
    );

    expect(entries[0].outcome).toBe('errored');
    expect(entries[0].message).toContain('解释器启动失败');
    expect(entries[0].exec?.spawnError).toBe('spawn ENOENT');
  });

  it('被信号终止:节点 errored 显式说明,exec 带 signal', async () => {
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM] },
      {
        exec: async () => ({ stdout: '', stderr: '', code: null, signal: 'SIGTERM' }),
        isCancelled: () => false
      }
    );

    expect(entries[0].outcome).toBe('errored');
    expect(entries[0].message).toContain('SIGTERM');
    expect(entries[0].exec?.signal).toBe('SIGTERM');
  });

  it('退出码 0 且无 spawn/信号:不挂 exec 会话问题', async () => {
    const entries = await runPythonTests(
      { interpreterPath: '/ws/py/python3', cwd: '/ws/assets/scripts', items: [ITEM] },
      {
        exec: async () => ({ stdout: passedOutput(ITEM), stderr: '', code: 0 }),
        isCancelled: () => false
      }
    );

    expect(entries[0].outcome).toBe('passed');
    expect(entries[0].exec).toBeUndefined();
  });
});

describe('会话失败选取与报告(R2-F19)', () => {
  const passedEntry = (exec: PythonTestExecIssue) => ({ id: 'a', outcome: 'passed' as const, output: '', exec });
  const failedEntry = (exec: PythonTestExecIssue) => ({ id: 'b', outcome: 'failed' as const, output: '', exec });

  it('describePythonTestExecIssue 三面:spawn/信号/退出码', () => {
    expect(describePythonTestExecIssue({ code: null, spawnError: 'spawn ENOENT', stderr: '' })).toContain(
      '解释器启动失败'
    );
    expect(describePythonTestExecIssue({ code: null, signal: 'SIGTERM', stderr: '' })).toContain('SIGTERM');
    expect(describePythonTestExecIssue({ code: 1, stderr: '' })).toContain('退出码 1');
  });

  it('selectSessionFailures:只取 passed/skipped 却挂进程问题的条目(不冒充成功)', () => {
    expect(selectSessionFailures([passedEntry({ code: 1, stderr: 'boom' })])).toHaveLength(1);
    expect(selectSessionFailures([failedEntry({ code: 1, stderr: 'boom' })])).toHaveLength(0);
    expect(selectSessionFailures([{ id: 'c', outcome: 'passed', output: '' }])).toHaveLength(0);
  });

  it('buildPythonTestSessionReport:无问题 null,有问题横幅含原因与 stderr', () => {
    expect(buildPythonTestSessionReport([])).toBeNull();
    const report = buildPythonTestSessionReport([passedEntry({ code: 1, stderr: 'teardown boom' })]);
    expect(report).toContain('测试会话');
    expect(report).toContain('a');
    expect(report).toContain('退出码 1');
    expect(report).toContain('teardown boom');
  });
});

describe('真 python3+pytest 实跑(格式不是抄文档)', () => {
  const pytestAvailable = spawnSync('python3', ['-m', 'pytest', '--version'], { encoding: 'utf8' }).status === 0;
  const dir = mkdtempSync(join(tmpdir(), 'kode-pytest-'));

  it.skipIf(!pytestAvailable)('坏用例失败带 assert 消息,好用例通过', async () => {
    writeFileSync(
      join(dir, 'test_sample.py'),
      'def test_ok():\n    assert 1 + 1 == 2\n\ndef test_bad():\n    assert 1 + 1 == 3\n'
    );
    const file = join(dir, 'test_sample.py');

    const entries = await runPythonTests(
      { interpreterPath: 'python3', cwd: dir, items: [
        { id: 'ok', file, caseName: 'test_ok' },
        { id: 'bad', file, caseName: 'test_bad' }
      ] },
      { exec: spawnTestProcess, isCancelled: () => false }
    );

    expect(entries.map(entry => [entry.id, entry.outcome])).toEqual([['ok', 'passed'], ['bad', 'failed']]);
    expect(entries[1].message).toContain('assert');
    expect(entries[1].output).toContain('FAILED');

    rmSync(dir, { recursive: true, force: true });
  });
});
