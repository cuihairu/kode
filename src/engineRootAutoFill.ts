/**
 * 活动 profile 引擎根自动补录(2026-11-18 用户亲报 P0:
 * 「kode 扫描之后提示缺引擎 未记录引擎根」)。
 *
 * 病根:profile 记录的 engineRoot 为空串时,profileHealth 恒报
 * engine-missing「未记录引擎根(engine 面未识别)」,而探测能力
 * (引擎根探测,双 marker)与持久化接口(saveRoots)本就现成,
 * 只是没人把它们接起来。
 *
 * 纪律(巡检单故障 A):
 * - 只在启动做一次,低频幂等,不挂文件监听(引擎树不在工作区高频变动);
 * - 已记录非空 → 不重探(不覆盖用户手填);
 * - 显式配置 kbengine.engineRoot 优先于自动探测;
 * - 探测不中 → **不写**(如实保持缺失,不伪造路径),engine-missing 仍照报。
 *
 * 语义迁移(2026-11-24 用户令):engineRoot 语义从「kbe 的仓库根」改为
 * 「kbe 目录本身(引擎安装根)」,身份锚 = <根>/res/server/kbengine_defaults.xml。
 * 旧语义记下的仓库根在新锚下必然验不过——只此一种情况放行迁移:记录值验
 * 身份锚不过,且其一**唯一**一层孩子验过 → 下移写入;零命中/多命中(歧义)
 * 都不写,保持原值由健康面/版本面如实降级。这不是重探(不碰合法记录值),
 * 是字段语义变更下保用户原意的一次性下移。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectProfileStore } from './projectProfiles';
import { resolveActiveProfile } from './activeProfile';
import { findEngineRootInDefaultPlaces } from './backend/engineCompatibility';
import { hasEngineTreeMarker } from './backend/engineApiMetadata';

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
 * 旧语义记录值迁移(2026-11-24 语义改版,见文件头):记录值验身份锚不过时,
 * 唯一一层结构孩子验过才下移;已合规返回 null(无需迁移),零/多命中返回
 * null(缺失如实、歧义不猜)。
 */
export function migrateLegacyEngineRoot(root: string): string | null {
  const trimmed = root.trim();
  if (!trimmed) {
    return null;
  }
  const exists = (probe: string): boolean => fs.existsSync(probe);
  if (hasEngineTreeMarker(trimmed, exists)) {
    return null;
  }
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = fs.readdirSync(trimmed, { withFileTypes: true });
  } catch {
    return null;
  }
  const hits = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(trimmed, entry.name))
    .filter(dir => hasEngineTreeMarker(dir, exists));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 兄弟目录名扫描已废止(2026-11-23 用户令:引擎根默认只找两处——当前目录
 * 下有 kbe 引擎树或上一层目录下有,都没有就提示用户配置)。探测统一走
 * findEngineRootInDefaultPlaces(与向导/配置链同一两处口径),不再向上多级
 * 递归、不再按目录名猜兄弟;未命中如实保持缺失,engine-missing 照报。
 */
function probeEngineRoot(
  assetsRoot: string,
  explicitRoot?: string
): string | null {
  if (explicitRoot) {
    return hasEngineTreeMarker(explicitRoot, probe => fs.existsSync(probe))
      ? explicitRoot
      : null;
  }
  return findEngineRootInDefaultPlaces(assetsRoot);
}

/**
 * 活动 profile 引擎根为空 → 探测默认两处(当前目录/上一层目录下有 kbe
 * 引擎树,2026-11-23 用户令);命中即 saveRoots 持久化并刷新
 * resolveActiveProfile 读到的快照,未命中不写。无活动 profile / 无
 * assetsRoot → 如实返回 stillMissing。
 */
export async function ensureActiveProfileEngineRoot(
  memento: vscode.Memento | undefined,
  deps: {
    readonly probeEngineRootFn?: (assetsRoot: string, explicitRoot?: string) => string | null;
    /** 显式配置的引擎根(kbengine.engineRoot);读不到 → '' */
    readonly explicitEngineRoot?: () => string;
  } = {}
): Promise<EngineRootAutoFillResult> {
  const probe = deps.probeEngineRootFn ?? probeEngineRoot;
  const explicitOf = deps.explicitEngineRoot ?? (() =>
    vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '')
  );

  const profile = resolveActiveProfile(memento);
  if (!profile) {
    return { stillMissing: true, recorded: null };
  }
  const kept = keepExisting(profile.engineRoot);
  if (kept) {
    // 语义迁移:旧语义记录值在新身份锚下验不过且唯一结构孩子在 → 下移写入
    const migrated = migrateLegacyEngineRoot(kept);
    if (!migrated) {
      return { stillMissing: false, recorded: null };
    }
    const moved = await new ProjectProfileStore(memento).saveRoots(profile.id, { engineRoot: migrated });
    return moved ? { stillMissing: false, recorded: migrated } : { stillMissing: true, recorded: null };
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