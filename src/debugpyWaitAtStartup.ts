/**
 * 启动前等待调试器连接(IDE-DBG-004):kbengine.debug.waitAtStartup(默认
 * 关,显式 opt-in)。telnet 注入发生在组件起来之后,entitydef/早期 config
 * 已过;要在用户入口脚本早期断点前暂停,只能让引擎进程里最早执行的
 * python 就是 listen+wait_for_client——在入口脚本(scripts/kbengine.py,
 * 引擎侧约定文件)顶部插一段带标记的引导块:读环境变量
 * KODE_DEBUGPY_WAIT_PORT(serverManager 启动表内组件的默认实例时按端口
 * 表注入),有值即 listen+wait,无值/无 debugpy 包/任何异常都静默放行,
 * 绝不阻塞引擎启动。off 命令删块逐字节还原。限制如实:命名实例的逐实例
 * 口由启动联动窗口分配,等待模式暂不覆盖(不带环境变量,引导块 no-op,
 * 仍走 telnet 注入路径)。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { debugpyPortFor } from './autoDebugpy';
import { findEntityDefinitionsRoot } from './definitionWorkspace';

/** opt-in 开关(kbengine.debug.waitAtStartup,默认关) */
export const WAIT_AT_STARTUP_DEFAULT = false;
/** 引导块读的启动环境变量(有值才 listen+wait) */
export const WAIT_PORT_ENV_KEY = 'KODE_DEBUGPY_WAIT_PORT';

export function debugpyWaitAtStartupEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('debug.waitAtStartup', WAIT_AT_STARTUP_DEFAULT);
}

export const WAIT_BOOTSTRAP_BEGIN =
  '# kode:debugpy-wait BEGIN (kbengine.debug.waitAtStartup;运行 kbengine.debug.waitAtStartup.off 移除本块)';
export const WAIT_BOOTSTRAP_END = '# kode:debugpy-wait END';

/** 引导块文本(独立常量面:标记/环境变量键/行为被测试逐项锁定) */
export function buildWaitBootstrapBlock(): string {
  const lines = [
    WAIT_BOOTSTRAP_BEGIN,
    'try:',
    `    _kode_debugpy_wait_port = __import__("os").environ.get("${WAIT_PORT_ENV_KEY}")`,
    '    if _kode_debugpy_wait_port:',
    '        import debugpy',
    '        debugpy.listen(("127.0.0.1", int(_kode_debugpy_wait_port)))',
    '        debugpy.wait_for_client()',
    'except Exception:',
    '    pass',
    WAIT_BOOTSTRAP_END
  ];
  return `${lines.join('\n')}\n\n`;
}

/**
 * 入口脚本:scripts/entity_defs 同级的 kbengine.py(引擎侧约定的启动
 * 引导模块);不在盘如实 null,不猜别的落点。
 */
export function findEngineEntryScript(assetsRoot: string): string | null {
  const entityDefsRoot = findEntityDefinitionsRoot(assetsRoot);
  if (!entityDefsRoot) {
    return null;
  }
  const candidate = path.join(path.dirname(entityDefsRoot), 'kbengine.py');
  return fs.existsSync(candidate) ? candidate : null;
}

/** 块标记行的识别前缀(行首比对,不依赖整行相等) */
const BEGIN_LINE_PREFIX = '# kode:debugpy-wait BEGIN';
const END_LINE_PREFIX = '# kode:debugpy-wait END';

interface WaitBootstrapDeps {
  readFileText(candidate: string): string;
  writeFile(candidate: string, text: string): void;
}

const defaultDeps: WaitBootstrapDeps = {
  readFileText: candidate => fs.readFileSync(candidate, 'utf8'),
  writeFile: (candidate, text) => fs.writeFileSync(candidate, text, 'utf8')
};

export interface WaitBootstrapResult {
  status: 'written' | 'unchanged' | 'absent' | 'removed' | 'error';
  message: string;
}

/** 删块:返回去块后的文本(无块返回原文);块后紧跟的一个空行一并删 */
function stripWaitBlock(text: string): { text: string; hadBlock: boolean } {
  const lines = text.split('\n');
  const begin = lines.findIndex(line => line.trimLeft().startsWith(BEGIN_LINE_PREFIX));
  if (begin === -1) {
    return { text, hadBlock: false };
  }
  const end = lines.findIndex(
    (line, index) => index > begin && line.trimLeft().startsWith(END_LINE_PREFIX)
  );
  const stop = end === -1 ? lines.length : end + 1;
  if (lines[stop] !== undefined && lines[stop].trim() === '') {
    lines.splice(begin, stop - begin + 1);
  } else {
    lines.splice(begin, stop - begin);
  }
  return { text: lines.join('\n'), hadBlock: true };
}

/**
 * 头部识别:插入点在模块 docstring(若有)之后——shebang/编码声明/注释/
 * 空行与首段三引号字符串归头,块插头后,不破坏 __doc__ 与文件头约定。
 */
function splitEntryHead(text: string): { head: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    break;
  }
  const first = lines[i]?.trim() ?? '';
  if (first.startsWith('"""') || first.startsWith("'''")) {
    const quote = first.slice(0, 3);
    if (first.length > 3 && first.endsWith(quote)) {
      i += 1;
    } else {
      i += 1;
      while (i < lines.length && !lines[i].includes(quote)) {
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
    }
  }
  return { head: lines.slice(0, i).join('\n'), body: lines.slice(i).join('\n') };
}

/** 注入(幂等):已有块先剥再插新块;结果逐字节一致则零写入 */
export function injectWaitBootstrap(
  entryPath: string,
  deps: WaitBootstrapDeps = defaultDeps
): WaitBootstrapResult {
  let text: string;
  try {
    text = deps.readFileText(entryPath);
  } catch {
    return { status: 'error', message: `入口脚本不可读: ${entryPath}` };
  }
  const stripped = stripWaitBlock(text).text;
  const { head, body } = splitEntryHead(stripped);
  const block = buildWaitBootstrapBlock();
  const next = head.length > 0 ? `${head}\n${block}${body}` : `${block}${body}`;
  if (next === text) {
    return { status: 'unchanged', message: `引导块已是最新,零写入: ${entryPath}` };
  }
  try {
    deps.writeFile(entryPath, next);
  } catch (error) {
    return { status: 'error', message: `写入失败: ${String(error)}` };
  }
  return { status: 'written', message: `已在入口脚本顶部插入 debugpy 等待引导块: ${entryPath}` };
}

/** 移除:删块还原;无块 absent 零写入 */
export function removeWaitBootstrap(
  entryPath: string,
  deps: WaitBootstrapDeps = defaultDeps
): WaitBootstrapResult {
  let text: string;
  try {
    text = deps.readFileText(entryPath);
  } catch {
    return { status: 'error', message: `入口脚本不可读: ${entryPath}` };
  }
  const { text: stripped, hadBlock } = stripWaitBlock(text);
  if (!hadBlock) {
    return { status: 'absent', message: `入口脚本没有等待引导块,零写入: ${entryPath}` };
  }
  try {
    deps.writeFile(entryPath, stripped);
  } catch (error) {
    return { status: 'error', message: `写入失败: ${String(error)}` };
  }
  return { status: 'removed', message: `已移除入口脚本的 debugpy 等待引导块: ${entryPath}` };
}

/**
 * 启动环境变量(serverManager 在 buildComponentEnvironment 之后调):
 * 开关开且组件在端口表内才带 KODE_DEBUGPY_WAIT_PORT——引导块读到即
 * listen+wait;默认实例口径(命名实例不带,见模块头注记)。
 */
export function applyWaitAtStartupEnv(env: NodeJS.ProcessEnv, componentName: string): void {
  if (!debugpyWaitAtStartupEnabled()) {
    return;
  }
  const port = debugpyPortFor(componentName);
  if (port === undefined) {
    return;
  }
  env[WAIT_PORT_ENV_KEY] = String(port);
}
