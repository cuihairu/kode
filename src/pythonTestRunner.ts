/**
 * 测试面板跑单个测试(IDE-TSK-005)的执行面:逐条目
 * `<解释器> -m pytest <file>::<case> -v --tb=line -p no:cacheprovider`
 * ——cwd=profile 的 scripts 根;-v 行定通过/失败,short summary 行给
 * 失败消息,输出原文入账(面板 Output);`-p no:cacheprovider` 不在
 * scripts 根落 .pytest_cache。取消语义(验收:取消不继续执行下一测
 * 试)= 下一跳发起前探针拦截:已完成的入账,未发起的不再执行;解释
 * 器没有 pytest 时如实 errored 一条指明缺口,不冒充测试失败。
 */

import { spawn } from 'child_process';

/** 一个待跑条目(来自 TSK-004 的发现面) */
export interface PythonTestRunItem {
  /** 面板条目 id */
  id: string;
  /** 测试文件绝对路径 */
  file: string;
  /** pytest 节点后缀:'test_x' / 'TestX::test_x';undefined=整个文件 */
  caseName?: string;
}

export type PythonTestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

/** 一条目的执行结果 */
export interface PythonTestRunEntry {
  id: string;
  outcome: PythonTestOutcome;
  /** failed/errored 的消息(short summary 行或缺口说明) */
  message?: string;
  /** 本次执行的原始输出(stdout+stderr,面板 Output 用) */
  output: string;
  /**
   * 该条目进程的会话问题(R2-F19):退出非零/被信号终止/spawn 失败时
   * 挂上;节点主体真实结果(outcome)不受影响,由消费面另行呈报。
   */
  exec?: PythonTestExecIssue;
}

/** 一条目 pytest 进程的会话级问题(节点结果之外) */
export interface PythonTestExecIssue {
  /** 进程退出码;null=被信号终止或 spawn 失败 */
  code: number | null;
  /** 被信号终止时的信号名(如 SIGTERM) */
  signal?: string;
  /** spawn 失败消息(解释器缺失等,进程根本没起来) */
  spawnError?: string;
  stderr: string;
}

/** pytest 固定参数(-p no:cacheprovider:不在用户 scripts 根落缓存) */
export const PYTEST_ARGS = ['-m', 'pytest', '-v', '--tb=line', '-p', 'no:cacheprovider'];

export function buildPytestArgs(item: PythonTestRunItem): string[] {
  const node = item.caseName ? `${item.file}::${item.caseName}` : item.file;
  return [...PYTEST_ARGS, node];
}

const VERBOSE_OUTCOME_PATTERN = /^(\S+\.py(?:::\S+)?) (PASSED|FAILED|ERROR|SKIPPED)\b/;
const SUMMARY_PATTERN = /^(FAILED|ERROR) (\S+) - (.+)$/;
const NO_PYTEST_PATTERN = /No module named ['"]?pytest/;

interface PytestNodeResult {
  outcome: PythonTestOutcome;
  message?: string;
}

/**
 * 解析 pytest -v 输出:节点行定结果,summary 行补失败/错误消息。
 * 节点键=传给 pytest 的形态(`<file>` 或 `<file>::<case>`)。
 */
export function parsePytestOutput(output: string): Map<string, PytestNodeResult> {
  const results = new Map<string, PytestNodeResult>();
  const outcomeRank: Record<PythonTestOutcome, number> = { failed: 0, errored: 1, skipped: 2, passed: 3 };
  for (const line of output.split('\n')) {
    const verbose = VERBOSE_OUTCOME_PATTERN.exec(line);
    if (verbose) {
      const node = verbose[1];
      const outcome = verbose[2].toLowerCase() as PythonTestOutcome;
      const existing = results.get(node);
      if (!existing || outcomeRank[outcome] < outcomeRank[existing.outcome]) {
        results.set(node, existing ? { ...existing, outcome } : { outcome });
      }
      continue;
    }
    const summary = SUMMARY_PATTERN.exec(line);
    if (summary) {
      const node = summary[2];
      const outcome = summary[1].toLowerCase() as PythonTestOutcome;
      const existing = results.get(node);
      if (existing) {
        if (outcomeRank[outcome] < outcomeRank[existing.outcome]) {
          existing.outcome = outcome;
        }
        existing.message = summary[3];
      } else {
        results.set(node, { outcome, message: summary[3] });
      }
    }
  }
  return results;
}

const NO_PYTEST_MESSAGE =
  '所选解释器没有 pytest(python3 -m pytest 不可用):先给该解释器安装 pytest,或换 profile 解释器';

/**
 * 节点行匹配:pytest 实测会把节点归一成 rootdir 相对路径(传绝对
 * 路径,`-v` 行打 `test_x.py::test_ok`),故按「用例名精确+文件后
 * 缀」匹配(绝对直传与相对归一两种形态都吃)。
 */
const pathSuffixMatch = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

function nodeMatchesItem(node: string, item: PythonTestRunItem): boolean {
  const separator = node.indexOf('::');
  const filePart = separator === -1 ? node : node.slice(0, separator);
  const casePart = separator === -1 ? undefined : node.slice(separator + 2);
  if (item.caseName) {
    return casePart === item.caseName && pathSuffixMatch(filePart, item.file);
  }
  return pathSuffixMatch(filePart, item.file);
}

/**
 * 输出→逐条目结果:单用例条目按节点匹配直取;整文件条目聚合其全部
 * 匹配子节点取最差面,消息取首条失败/错误。节点缺席(节点写错/收集
 * 为空/没跑起来)如实 errored「未收集到测试」,不猜。
 */
export function resolvePytestEntries(output: string, items: PythonTestRunItem[]): PythonTestRunEntry[] {
  const results = parsePytestOutput(output);
  if (results.size === 0) {
    const noPytest = NO_PYTEST_PATTERN.test(output);
    return items.map(item => ({
      id: item.id,
      outcome: 'errored' as const,
      message: noPytest ? NO_PYTEST_MESSAGE : '未收集到测试(pytest 未产出该条目的结果)',
      output
    }));
  }
  return items.map(item => {
    const hits = [...results.entries()].filter(([node]) => nodeMatchesItem(node, item));
    if (hits.length === 0) {
      return {
        id: item.id,
        outcome: 'errored' as const,
        message: '未收集到测试(pytest 未产出该条目的结果)',
        output
      };
    }
    // 最差面:failed > errored > skipped > passed;消息取首条失败/错误
    const rank = (outcome: PythonTestOutcome): number => ({ failed: 0, errored: 1, skipped: 2, passed: 3 })[outcome];
    const sorted = [...hits].sort((a, b) => rank(a[1].outcome) - rank(b[1].outcome));
    const message = sorted.find(([, result]) => result.message !== undefined)?.[1].message;
    return { id: item.id, outcome: sorted[0][1].outcome, message, output };
  });
}

export interface PythonTestRunRequest {
  interpreterPath: string;
  /** 执行 cwd=profile 的 scripts 根(模块导入上下文) */
  cwd: string;
  items: PythonTestRunItem[];
}

export interface PythonTestExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** 进程被信号终止时的信号名(如 SIGTERM) */
  signal?: string;
  /** spawn 失败消息(解释器缺失等,进程根本没起来) */
  spawnError?: string;
}

export interface PythonTestRunDeps {
  exec(request: { command: string; args: string[]; cwd: string }): Promise<PythonTestExecResult>;
  /** 取消探针:每发起下一跳前问一次,真即停(已完成的照常入账) */
  isCancelled(): boolean;
}

/**
 * 逐条目串行执行:条目间逐跳探针取消(取消不继续执行下一测试),
 * 每跳结果独立入账。开跑前已取消则零发起。
 */
export async function runPythonTests(
  request: PythonTestRunRequest,
  deps: PythonTestRunDeps
): Promise<PythonTestRunEntry[]> {
  const entries: PythonTestRunEntry[] = [];
  for (const item of request.items) {
    if (deps.isCancelled()) {
      break;
    }
    const { stdout, stderr, code, signal, spawnError } = await deps.exec({
      command: request.interpreterPath,
      args: buildPytestArgs(item),
      cwd: request.cwd
    });
    // R2-F19:退出码不再丢弃——spawn 失败/被信号终止/退出非零都挂会话
    // 问题(节点主体真实结果仍由 pytest 输出判读,不因退出码翻案)
    const issue: PythonTestExecIssue | undefined =
      spawnError !== undefined
        ? { code: null, spawnError, stderr }
        : signal !== undefined
          ? { code: null, signal, stderr }
          : code !== 0
            ? { code, stderr }
            : undefined;
    const resolved = resolvePytestEntries(`${stdout}\n${stderr}`, [item]);
    for (const entry of resolved) {
      if (issue) {
        entry.exec = issue;
        // 解释器缺失/被信号终止:节点本就 errored(无 pytest 输出),
        // 消息显式化,不冒充「未收集到测试」也不冒充测试失败
        if (issue.spawnError) {
          entry.message = `解释器启动失败: ${issue.spawnError}`;
        } else if (issue.signal) {
          entry.message = `测试进程被信号终止(${issue.signal})`;
        }
      }
    }
    entries.push(...resolved);
  }
  return entries;
}

/** 会话问题的中文描述(报告与工作台报错共用) */
export function describePythonTestExecIssue(issue: PythonTestExecIssue): string {
  if (issue.spawnError) {
    return `解释器启动失败: ${issue.spawnError}`;
  }
  if (issue.signal) {
    return `进程被信号终止(${issue.signal})`;
  }
  return `进程退出码 ${issue.code}`;
}

/**
 * R2-F19 会话失败选取:只挑「节点看起来成功(passed/skipped)却挂了
 * 进程问题」的条目——退出非零而没有任何失败/错误节点,正是「整个
 * 运行冒充成功」的形态;失败/错误节点的非零退出已被节点主体解释,
 * 不再重复呈报。
 */
export function selectSessionFailures(entries: PythonTestRunEntry[]): PythonTestRunEntry[] {
  return entries.filter(entry => entry.exec !== undefined && (entry.outcome === 'passed' || entry.outcome === 'skipped'));
}

/**
 * 会话失败横幅(输出面板用):逐失败条目列出原因与 stderr;
 * 无问题返回 null。
 */
export function buildPythonTestSessionReport(entries: PythonTestRunEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  const lines: string[] = ['========== 测试会话错误(节点结果仍如实保留) =========='];
  for (const entry of entries) {
    const issue = entry.exec!;
    lines.push(`- ${entry.id}: ${describePythonTestExecIssue(issue)}`);
    if (issue.stderr) {
      lines.push(issue.stderr);
    }
  }
  return lines.join('\n');
}

/** 装配层默认注入:真子进程捕获 stdout/stderr 与退出码/信号 */
export function spawnTestProcess(request: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<PythonTestExecResult> {
  return new Promise(resolve => {
    const child = spawn(request.command, request.args, { cwd: request.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      resolve({
        stdout,
        stderr: `${stderr}${request.command}: ${error.message}`,
        code: null,
        spawnError: error.message
      });
    });
    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal: signal ?? undefined });
    });
  });
}
