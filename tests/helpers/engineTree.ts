import * as fs from 'fs';
import * as path from 'path';
import { describe } from 'vitest';

// V-07·a(C-8):真引擎源码树探测 + 无树 skipIf。
// 探测口径与产品侧 src/engineApiMetadata.ts 的 findEngineRoot 保持一致
// (标记文件 kbe/src/lib/common/version.h;KBENGINE_ROOT=off 显式关;
// 环境变量优先,其次 <起始目录>/../kbengine 兄弟目录)——测试跳过的条件
// 与产品报 unknown 的条件同源,不会出现「产品找得到、测试却跳过」的错位。
// C-9 的 fantasydemo 真实样例批挂在 describeWithEngineTree 之下。

/** 引擎源码树标记文件(与 src/engineApiMetadata.ts 同一 marker) */
export const ENGINE_TREE_MARKER = path.join('kbe', 'src', 'lib', 'common', 'version.h');

export interface EngineTreeProbe {
  root: string | null;
  /** root 为 null 时的人读原因,进 skip 套件标题使 CI 输出可见 */
  reason: string;
}

export interface EngineTreeProbeOptions {
  env?: Record<string, string | undefined>;
  startDirectory?: string;
  existsSync?: (candidate: string) => boolean;
}

export function detectEngineTree(options: EngineTreeProbeOptions = {}): EngineTreeProbe {
  const env = options.env ?? process.env;
  const startDirectory = options.startDirectory ?? process.cwd();
  const exists = options.existsSync ?? ((candidate: string) => fs.existsSync(candidate));

  if (env.KBENGINE_ROOT === 'off') {
    return { root: null, reason: 'KBENGINE_ROOT=off explicitly disables the engine tree' };
  }
  if (env.KBENGINE_ROOT) {
    if (exists(path.join(env.KBENGINE_ROOT, ENGINE_TREE_MARKER))) {
      return { root: env.KBENGINE_ROOT, reason: '' };
    }
    return { root: null, reason: `KBENGINE_ROOT=${env.KBENGINE_ROOT} has no ${ENGINE_TREE_MARKER}` };
  }
  const sibling = path.resolve(startDirectory, '..', 'kbengine');
  if (exists(path.join(sibling, ENGINE_TREE_MARKER))) {
    return { root: sibling, reason: '' };
  }
  return {
    root: null,
    reason: 'no engine tree: set KBENGINE_ROOT or place kbengine next to the repo (no ../kbengine sibling found)'
  };
}

const probe = detectEngineTree();

/** 进程级探测结果:真树绝对路径,无树为 null */
export const ENGINE_TREE_ROOT: string | null = probe.root;

/** 有树为空串;无树为人读原因(与 ENGINE_TREE_ROOT 互斥非空) */
export const ENGINE_TREE_REASON: string = probe.reason;

/**
 * 真树才跑的套件:无树环境(CI 默认)整套 skip,原因写进套件标题,
 * vitest 输出行内可见,不需要翻日志找跳过理由。
 */
export function describeWithEngineTree(name: string, fn: () => void): void {
  const suite = ENGINE_TREE_ROOT ? describe : describe.skip;
  suite(ENGINE_TREE_ROOT ? name : `${name} — skipped: ${ENGINE_TREE_REASON}`, fn);
}
