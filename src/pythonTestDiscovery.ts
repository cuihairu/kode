/**
 * 发现项目声明的 Python 测试(IDE-TSK-004):只扫所选 profile 的测试
 * 范围——<assetsRoot>/scripts 一个根,递归收 test_*.py / *_test.py
 * (pytest/unittest 通用命名约定);工作区里其他 *_assets 根与引擎仓
 * (kbe/…)是依赖库,结构性不进清单:发现只从 profile 的 scripts 根
 * 起步,不接收任何别的入口。用例=文件内静态可见的 def test_* /
 * class Test* + 其 def test_* 方法,带行号列号(TSK-005 测试面板跳
 * 源码用);解析是行级启发(缩进界定类体),动态生成的用例不在静态
 * 发现面内,如实不算。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectProfile } from './projectProfiles';

/** 一条测试用例(文件内静态可见) */
export interface PythonTestCase {
  name: string;
  /** 顶层函数 or 类内方法 */
  kind: 'function' | 'method';
  /** kind=method 时所属类名 */
  className?: string;
  /** 1-based 源码行号 */
  line: number;
  /** 0-based 列号(def 关键字起始列,跳源码用) */
  column: number;
}

/** 一个测试文件(相对 scripts 根路径 + 其用例) */
export interface PythonTestFile {
  /** posix 风格相对路径(展示用) */
  relativePath: string;
  cases: PythonTestCase[];
}

export interface PythonTestDiscoveryResult {
  /** 实际扫描的根(= profile 的 scripts 根) */
  scriptsRoot: string;
  /** 按相对路径排序 */
  files: PythonTestFile[];
}

export interface PythonTestDiscoveryDeps {
  exists(candidate: string): boolean;
  readDir(dir: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(file: string): string;
}

/** 文件名按 pytest/unittest 通用约定:test_ 前缀或 _test.py 后缀 */
export function isPythonTestFile(fileName: string): boolean {
  return fileName.endsWith('.py') && (fileName.startsWith('test_') || fileName.endsWith('_test.py'));
}

/**
 * 行级静态解析:顶层 def test_* 收 function;class Test*(顶层)体内
 * 的 def test_* 收 method;类内方法体更深一层的嵌套 def test_*(indent
 * 大于类内首个方法)与类外非 test_ 函数不收;顶层 def 一出现即结束
 * 当前类上下文。
 */
export function parsePythonTestCases(source: string): PythonTestCase[] {
  const cases: PythonTestCase[] = [];
  let currentClass: string | undefined;
  let classMethodIndent: number | undefined;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const classMatch = /^class\s+(Test\w*)\s*[(:]/.exec(line);
    if (classMatch) {
      currentClass = classMatch[1];
      classMethodIndent = undefined;
      continue;
    }
    const defMatch = /^(\s*)def\s+(test_\w+)\s*\(/.exec(line);
    if (!defMatch) {
      continue;
    }
    const indent = defMatch[1].length;
    if (indent === 0) {
      currentClass = undefined;
      classMethodIndent = undefined;
      cases.push({ name: defMatch[2], kind: 'function', line: index + 1, column: line.indexOf('def') });
      continue;
    }
    if (currentClass && (classMethodIndent === undefined || indent === classMethodIndent)) {
      if (classMethodIndent === undefined) {
        classMethodIndent = indent;
      }
      cases.push({
        name: defMatch[2],
        kind: 'method',
        className: currentClass,
        line: index + 1,
        column: line.indexOf('def')
      });
    }
    // indent > classMethodIndent:类内方法体里的嵌套函数,不是用例
  }
  return cases;
}

/** 发现只从 profile 的 scripts 根起步(依赖库结构性不进清单) */
export function discoverProjectPythonTests(
  profile: Pick<ProjectProfile, 'assetsRoot'>,
  deps: PythonTestDiscoveryDeps = fileSystemTestDiscoveryDeps
): PythonTestDiscoveryResult {
  const scriptsRoot = path.join(profile.assetsRoot, 'scripts');
  const files: PythonTestFile[] = [];
  if (!deps.exists(scriptsRoot)) {
    return { scriptsRoot, files };
  }
  const walk = (dir: string, prefix: string): void => {
    for (const entry of deps.readDir(dir)) {
      if (entry.isDirectory) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__') {
          continue;
        }
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile && isPythonTestFile(entry.name)) {
        files.push({
          relativePath: prefix ? `${prefix}/${entry.name}` : entry.name,
          cases: parsePythonTestCases(deps.readFile(path.join(dir, entry.name)))
        });
      }
    }
  };
  walk(scriptsRoot, '');
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { scriptsRoot, files };
}

/** 装配层默认注入:真 fs 三面(存在/列目录/读文件) */
export const fileSystemTestDiscoveryDeps: PythonTestDiscoveryDeps = {
  exists: candidate => fs.existsSync(candidate),
  readDir: dir => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
    } catch {
      return [];
    }
  },
  readFile: file => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
};

/** 列表命令的 QuickPick 行(label=相对路径,description=用例数) */
export interface PythonTestPickItem {
  label: string;
  description: string;
  detail: string;
  absolutePath: string;
}

export interface PythonTestListDeps {
  /** 发现面(默认真 fs) */
  discovery?: PythonTestDiscoveryDeps;
  pick(items: PythonTestPickItem[]): Promise<PythonTestPickItem | undefined>;
  /** 打开测试文件(绝对路径) */
  open(absolutePath: string): void;
  notify(message: string): void;
}

/**
 * 列表命令体:发现 → 空结果一条如实提示(带 scripts 根与命名约定,
 * 不弹空列表);有结果 QuickPick 列文件(用例数+用例名),选中打开
 * 对应源文件,Esc 不开。
 */
export function showPythonTestList(
  profile: Pick<ProjectProfile, 'assetsRoot'>,
  deps: PythonTestListDeps
): void {
  const result = discoverProjectPythonTests(profile, deps.discovery ?? fileSystemTestDiscoveryDeps);
  if (result.files.length === 0) {
    deps.notify(
      `未发现 Python 测试(test_*.py / *_test.py):所选 profile 的 scripts 根 ${result.scriptsRoot} 下没有匹配文件`
    );
    return;
  }
  const items: PythonTestPickItem[] = result.files.map(file => ({
    label: file.relativePath,
    description: `${file.cases.length} 个用例`,
    detail: file.cases.length > 0 ? file.cases.map(item => item.name).join(', ') : '(静态未见 test_* 定义)',
    absolutePath: path.join(result.scriptsRoot, file.relativePath)
  }));
  void deps.pick(items).then(picked => {
    if (picked) {
      deps.open(picked.absolutePath);
    }
  });
}
