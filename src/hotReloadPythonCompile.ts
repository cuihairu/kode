import { spawn } from 'child_process';

import type { SyntaxVerdict } from './backend/hotReloadSavePipeline';

/**
 * HR-WATCH-012 真编译面:解释器子进程跑 compile()——只编译不执行,不跑
 * 用户代码。内容走 stdin(不经命令行参数,避免引号/长度上限);stderr 取
 * 最后一条非空行(SyntaxError 摘要行)。基础设施故障(spawn 失败/超时)
 * 以 reject 表达,由语法闸核转译为 fail-open 放行。
 */
export const PYTHON_COMPILE_TIMEOUT_MS = 5000;

const COMPILE_SNIPPET = 'import sys; compile(sys.stdin.read(), "<kbengine-hotreload>", "exec")';

export function runPythonCompile(interpreter: string, content: string): Promise<SyntaxVerdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, ['-c', COMPILE_SNIPPET], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`编译超时(${PYTHON_COMPILE_TIMEOUT_MS}ms)`));
    }, PYTHON_COMPILE_TIMEOUT_MS);
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    // 解释器异常退出时 stdin 写入会报 EPIPE:不掩 close 码语义,静默即可
    child.stdin.on('error', () => undefined);
    child.on('error', error => {
      finish(() => reject(error));
    });
    child.on('close', code => {
      finish(() => {
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        const lines = stderr
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
        resolve({ ok: false, ...(lines.length > 0 ? { errors: [lines[lines.length - 1]] } : {}) });
      });
    });
    child.stdin.end(content);
  });
}
