/**
 * 活动 profile 引擎根自动补录(2026-11-18 用户亲报 P0:
 * 「kode 扫描之后提示缺引擎 未记录引擎根」)。
 *
 * 病根:profile 记录的 engineRoot 为空串时,profileHealth 恒报
 * engine-missing「未记录引擎根(engine 面未识别)」,而探测能力
 * (findEngineRoot,双 marker 向上递归)与持久化接口(saveRoots)本就现成,
 * 只是没人把它们接起来。
 *
 * 纪律(巡检单故障 A):
 * - 只在启动做一次,低频幂等,不挂文件监听(引擎树不在工作区高频变动);
 * - 已记录非空 → 不重探(不覆盖用户手填);
 * - 显式配置 kbengine.engineRoot 优先于自动探测;
 * - 探测不中 → **不写**(如实保持缺失,不伪造路径),engine-missing 仍照报。
 */

import * as vscode from 'vscode';
import { ProjectProfileStore } from './projectProfiles';
import { resolveActiveProfile } from './activeProfile';
import { findEngineRoot } from './backend/engineCompatibility';

export interface EngineRootAutoFillResult {
  /** 活动 profile 是否仍缺引擎根(false=本次补录成功或本已记录) */
  readonly stillMissing: boolean;
  /** 本次写入的引擎根;未写入 → null */
  readonly recorded: string | null;
}

/** 显式 > 自动探测:已记录的引擎根原样不动(幂等,不覆盖用户手填) */
function keepExisting(root: string): string | null {
  return root.trim() ? root : null;
}

/**
 * 活动 profile 引擎根为空 → 以 assetsRoot 为起点向上探双 marker;
 * 命中即 saveRoots 持久化并刷新 resolveActiveProfile 读到的快照,未命中
 * 不写。无活动 profile / 无 assetsRoot → 如实返回 stillMissing。
 */
export async function ensureActiveProfileEngineRoot(
  memento: vscode.Memento | undefined,
  deps: {
    readonly probeEngineRoot?: (assetsRoot: string, explicitRoot?: string) => string | null;
    /** 显式配置的引擎根(kbengine.engineRoot);读不到 → '' */
    readonly explicitEngineRoot?: () => string;
  } = {}
): Promise<EngineRootAutoFillResult> {
  const probe = deps.probeEngineRoot ?? findEngineRoot;
  const explicitOf = deps.explicitEngineRoot ?? (() =>
    vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '')
  );

  const profile = resolveActiveProfile(memento);
  if (!profile) {
    return { stillMissing: true, recorded: null };
  }
  const kept = keepExisting(profile.engineRoot);
  if (kept) {
    return { stillMissing: false, recorded: null };
  }
  if (!profile.assetsRoot) {
    // 空基底 join 出相对路径会拿进程 cwd 误探(ensureDefaultProfile 同口径)
    return { stillMissing: true, recorded: null };
  }
  const explicit = explicitOf().trim();
  const found = explicit ? probe(profile.assetsRoot, explicit) : probe(profile.assetsRoot);
  if (!found) {
    return { stillMissing: true, recorded: null };
  }
  const saved = await new ProjectProfileStore(memento).saveRoots(profile.id, { engineRoot: found });
  return saved ? { stillMissing: false, recorded: found } : { stillMissing: true, recorded: null };
}