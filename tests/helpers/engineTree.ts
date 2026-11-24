import * as fs from 'fs';
import * as path from 'path';
import { describe } from 'vitest';

import {
  ENGINE_IDENTITY_MARKER,
  hasEngineTreeMarker
} from '../../src/backend/engineApiMetadata';

// V-07·a(C-8):真引擎源码树探测 + 无树 skipIf。
// 探测口径与产品侧 src/engineApiMetadata.ts 保持一致:2026-11-24 语义,
// 引擎根 = 引擎安装根(kbe 目录本身),身份锚 = <根>/res/server/kbengine_defaults.xml
// (结构特征,不认目录名);KBENGINE_ROOT=off 显式关。环境变量优先,
// 其次 <起始目录>/../kbengine 兄弟仓(仓库根本身或其 kbe/ 安装根两形态)
// ——测试跳过的条件与产品报 engine-absent 的条件同源,不会出现
// 「产品找得到、测试却跳过」的错位。C-9 的 fantasydemo 真实样例批挂在
// describeWithEngineTree 之下。

/** 身份锚相对形态(res/server/kbengine_defaults.xml) */
export const ENGINE_TREE_MARKER = path.join(...ENGINE_IDENTITY_MARKER);
/** 与 ENGINE_TREE_MARKER 同形单元素数组(历史双 marker 出口,收拢为一) */
export const ENGINE_TREE_MARKERS = [path.join(...ENGINE_IDENTITY_MARKER)];

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
    // KBENGINE_ROOT 双形态兼容:安装根本身(2026-11-24 语义)或其仓库根
    // (engine-integration sparse clone 布局,安装根在 kbe/ 孩子)
    const direct = env.KBENGINE_ROOT;
    if (hasEngineTreeMarker(direct, exists)) {
      return { root: direct, reason: '' };
    }
    const nested = path.join(direct, 'kbe');
    if (hasEngineTreeMarker(nested, exists)) {
      return { root: nested, reason: '' };
    }
    return {
      root: null,
      reason: `KBENGINE_ROOT=${direct} has none of the engine tree markers: ${ENGINE_TREE_MARKERS.join(' | ')}`
    };
  }
  const sibling = path.resolve(startDirectory, '..', 'kbengine');
  // 兄弟仓两形态:仓库根(旧布局)/其 kbe 安装根(2026-11-24 语义根)
  const candidates = [sibling, path.join(sibling, 'kbe')];
  for (const candidate of candidates) {
    if (hasEngineTreeMarker(candidate, exists)) {
      return { root: candidate, reason: '' };
    }
  }
  return {
    root: null,
    reason: 'no engine tree: set KBENGINE_ROOT (engine install root holding res/server/kbengine_defaults.xml) or place kbengine next to the repo (no ../kbengine sibling found)'
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
