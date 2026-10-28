import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  KBE_COMPILEALL_MATCHER_NAME,
  COMPILEALL_INLINE_SOURCE,
  COMPILEALL_HEADER_SOURCE,
  COMPILEALL_LOCATION_SOURCE,
  COMPILEALL_MESSAGE_SOURCE,
  CompileallErrorParser
} from '../src/buildProblemMatcher';
import { buildTaskFromSpec } from '../src/buildTaskProvider';
import { buildScriptCheckTaskSpec } from '../src/buildTaskSpec';

// IDE-TSK-003 构建错误定位到源码:compileall -q 的两种错误格式(旧版
// 单行「in file ... on line」/3.13+ 多行 traceback)都解析成
// 文件+行+消息;本机真 python3 实跑一条坏脚本锁输出格式;任务挂
// $kbengine-compileall;package.json 贡献的 matcher 与模块四源逐字同源。

const runCompileall = (target: string): string => {
  const result = spawnSync('python3', ['-m', 'compileall', '-q', target], {
    encoding: 'utf8'
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
};

describe('CompileallErrorParser(两种格式都吃)', () => {
  it('旧版单行:文件/行/消息一次成条', () => {
    const parser = new CompileallErrorParser();
    const problem = parser.feed(
      '*** SyntaxError: invalid syntax in file /ws/demo/assets/scripts/Bad.py on line 3'
    );

    expect(problem).toEqual({
      file: '/ws/demo/assets/scripts/Bad.py',
      line: 3,
      message: 'SyntaxError: invalid syntax'
    });
  });

  it('3.13+ 多行:头/定位/错误类三段凑齐一条,源码与插入符行零动作', () => {
    const parser = new CompileallErrorParser();
    const lines = [
      "*** Error compiling '/ws/demo/assets/scripts/Bad.py'...",
      '  File "/ws/demo/assets/scripts/Bad.py", line 1',
      '    def broken(:',
      '               ^',
      'SyntaxError: invalid syntax'
    ];

    const problems = lines.map(line => parser.feed(line)).filter(Boolean);

    expect(problems).toEqual([
      {
        file: '/ws/demo/assets/scripts/Bad.py',
        line: 1,
        message: 'SyntaxError'
      }
    ]);
  });

  it('非错误行与未知悬空错误类行不成条', () => {
    const parser = new CompileallErrorParser();

    expect(parser.feed('Compiling /ok.py...')).toBeNull();
    // 没有文件/行上下文的悬空错误类行:不猜(File 行之后才成条,单独
    // 出现的 Error 行零上下文不成条)
    expect(parser.feed('ValueError: something')).toBeNull();
  });
});

describe('真 python3 实跑(格式不是抄文档,是本机实测)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kode-compileall-'));
  writeFileSync(join(dir, 'Bad.py'), 'def broken(:\n    pass\n');
  writeFileSync(join(dir, 'Good.py'), 'value = 1\n');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('坏脚本:一条问题,行号/文件/错误类全对', () => {
    const output = runCompileall(dir);

    const parser = new CompileallErrorParser();
    const problems = output
      .split('\n')
      .map(line => parser.feed(line))
      .filter(Boolean);

    expect(problems).toHaveLength(1);
    expect(problems[0].file).toBe(join(dir, 'Bad.py'));
    expect(problems[0].line).toBe(1);
    expect(problems[0].message).toContain('SyntaxError');
  });

  it('只编好脚本:解析零问题', () => {
    const output = runCompileall(join(dir, 'Good.py'));

    const parser = new CompileallErrorParser();
    const problems = output
      .split('\n')
      .map(line => parser.feed(line))
      .filter(Boolean);

    expect(problems).toEqual([]);
  });
});

describe('任务挂 matcher 与 manifest 同源锁', () => {
  it('buildTaskFromSpec 挂 $kbengine-compileall', () => {
    const task = buildTaskFromSpec(
      buildScriptCheckTaskSpec({
        id: 'p',
        displayName: '工程',
        assetsRoot: '/ws/a',
        interpreterPath: 'python3'
      })
    );

    expect(task.problemMatchers).toEqual([`$${KBE_COMPILEALL_MATCHER_NAME}`]);
  });

  it('package.json 贡献的 matcher 四正则与模块逐字同源', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const matchers = pkg.contributes.problemMatchers ?? [];
    const matcher = matchers.find(
      (item: { name?: string }) => item.name === KBE_COMPILEALL_MATCHER_NAME
    );

    expect(matcher).toBeDefined();
    const patterns = Array.isArray(matcher.pattern) ? matcher.pattern : [matcher.pattern];
    const regexps = patterns.map((pattern: { regexp: string }) => pattern.regexp);
    expect(regexps).toEqual([
      COMPILEALL_INLINE_SOURCE,
      COMPILEALL_HEADER_SOURCE,
      COMPILEALL_LOCATION_SOURCE,
      COMPILEALL_MESSAGE_SOURCE
    ]);
    expect(matcher.fileLocation).toBe('absolute');
  });
});
