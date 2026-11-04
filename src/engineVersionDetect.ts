/**
 * KB-VER-004 版本自动探测：从引擎安装目录读版本标记(version.h 单宏 legacy
 * | kbeversion.h 2.5.10+ 三宏)并对用户建议 kbengine.engineVersion 值。
 *
 * 只建议、绝不自动改用户设置(用户点「设置」才写)。探测面与
 * engineCompatibility/extension 漂移校验同源(findEngineRoot +
 * readEngineVersionMarker)；fork 树实测 kbeversion.h 报 2.5.10,仓库内
 * 无 res/version 文件,故版本宏是权威标记面。任何标记缺失/畸形→null,
 * 绝不编造版本值。
 */
import { normalizeEngineVersion } from './engineVersion';

/** 探测依赖注入面(纯函数,fs 由装配方注入便于单测)。 */
export interface EngineVersionDetectorDeps {
  /** 从起始目录向上找引擎根(与 engineCompatibility.findEngineRoot 同口径)。 */
  findRoot(startDirectory: string, explicitRoot?: string): string | null;
  /** 读引擎根的版本宏(与 readEngineVersionMarker 同口径),null=未知。 */
  readMarker(engineRoot: string): string | null;
}

/** 一次成功的探测:版本标记 + 命中引擎根(根供后续诊断/跳转用)。 */
export interface EngineVersionDetection {
  version: string;
  engineRoot: string;
}

/**
 * 依 workspace 根序列探测引擎版本标记。explicitRoot 优先(设置/profile
 * 显式根),多根时首个命中即返回;全 miss → null。
 */
export function detectEngineVersionMarker(
  workspaceRoots: string[],
  explicitEngineRoot: string | undefined,
  deps: EngineVersionDetectorDeps
): EngineVersionDetection | null {
  for (const root of workspaceRoots) {
    const engineRoot = deps.findRoot(root, explicitEngineRoot);
    if (!engineRoot) continue;
    const version = deps.readMarker(engineRoot);
    if (version) return { version, engineRoot };
  }
  return null;
}

/** 建议决策:是否值得弹提示(以及弹什么值)。 */
export type EngineVersionSuggestion =
  | { kind: 'none'; reason: 'no-marker' | 'matches' | 'dismissed' }
  | { kind: 'suggest'; version: string };

/**
 * 只在「探测到标记 且 标记≠当前设置 且 未对该标记值忽略过」时建议。
 * 当前设置经 normalize 归一(容错:非串/trim 空串回落默认),与已忽略值
 * 同版本比——忽略按「探测到的版本值」记,版本变了可再建议。
 */
export function engineVersionSuggestion(
  currentSetting: string,
  detected: EngineVersionDetection | null,
  dismissedVersion: string | undefined
): EngineVersionSuggestion {
  if (!detected) return { kind: 'none', reason: 'no-marker' };
  if (detected.version === normalizeEngineVersion(currentSetting)) {
    return { kind: 'none', reason: 'matches' };
  }
  if (dismissedVersion === detected.version) return { kind: 'none', reason: 'dismissed' };
  return { kind: 'suggest', version: detected.version };
}
