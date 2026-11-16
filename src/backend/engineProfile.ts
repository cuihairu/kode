// RUST-173 Engine profile:官方版本、fork、commit、特性探测四道面的统一
// 汇报模型。原语全部复用既有件(不重造):设置值/预设/归一走 engineVersion,
// 版本宏+git commit/describe 走 engineApiMetadata.readEngineApiMetadata 的
// 结果(unknown 哨兵如实透传),特性分层聚合走 kbeModuleIndex.KBE_SYMBOLS
// 的 KB-VER-002 三档,「需 fork」标注状态复算 engineApiVersionAnnotation。
// 纯函数零 vscode,命令面只做装配与输出。

import {
  ENGINE_VERSION_PRESETS,
  isKnownEnginePreset,
  normalizeEngineVersion
} from '../engineVersion';
import {
  KBE_SYMBOLS,
  engineApiVersionAnnotation,
  type KbeSymbolEntry
} from '../kbeModuleIndex';
import { UNKNOWN_ENGINE_VALUE, type EngineApiMetadata } from './engineApiMetadata';

/** 设置版本的分类:与 engineApiVersionAnnotation 的 fork 口径对齐。 */
export type EngineVersionClassification = 'official' | 'fork' | 'custom';

/**
 * 版本分类:命中预设且非 fork 前缀=official;fork- 前缀(大小写不敏感,
 * 与 engineApiVersionAnnotation 同口径)=fork;其余自由串=custom——
 * 不猜是官方旧版还是魔改 fork,如实标「未归类自定义」。
 */
export function classifyEngineVersion(version: string): EngineVersionClassification {
  const normalized = normalizeEngineVersion(version);
  if (normalized.trim().toLowerCase().startsWith('fork')) {
    return 'fork';
  }
  return isKnownEnginePreset(normalized) ? 'official' : 'custom';
}

/** KB-VER-002 三档符号数聚合(undefined 归 baseline,与标注口径一致)。 */
export interface EngineFeatureCounts {
  baseline: number;
  fork: number;
  pending: number;
}

export function countEngineFeatures(
  symbols: readonly Pick<KbeSymbolEntry, 'version'>[] = KBE_SYMBOLS
): EngineFeatureCounts {
  const counts: EngineFeatureCounts = { baseline: 0, fork: 0, pending: 0 };
  for (const symbol of symbols) {
    const layer = symbol.version ?? 'baseline';
    if (layer === 'fork' || layer === 'pending') {
      counts[layer] += 1;
    } else {
      counts.baseline += 1;
    }
  }
  return counts;
}

/** 一次引擎档案汇报:每道面只记事实,unknown 不伪造。 */
export interface EngineProfileReport {
  /** normalize 后的 kbengine.engineVersion 设置值 */
  settingVersion: string;
  /** 命中的预设 label;自由串 null(如实未命中) */
  presetLabel: string | null;
  /** 设置版本分类(official/fork/custom) */
  classification: EngineVersionClassification;
  /** 版本宏探测(readEngineApiMetadata.version;unknown → null 不伪造) */
  detectedVersion: string | null;
  /** git rev-parse HEAD(unknown → null;无 git/非仓如实 unknown) */
  commit: string | null;
  /** git describe --tags --always --dirty(unknown → null) */
  describe: string | null;
  /** KB-VER-002 三档符号数(策展子集,非完整引擎 API 目录) */
  featureCounts: EngineFeatureCounts;
  /** 当前设置下 fork 档符号是否带「需 fork」标注(false=fork 语境已含) */
  forkLayerAnnotated: boolean;
}

export function buildEngineProfileReport(input: {
  /** 原始设置值(非字符串/空串经 normalize 回落默认) */
  settingVersion: unknown;
  /** readEngineApiMetadata 结果(注入;装配方负责真实探测) */
  metadata: EngineApiMetadata;
  /** 特性符号表(缺省策展 KBE_SYMBOLS;测试注入小表) */
  symbols?: readonly Pick<KbeSymbolEntry, 'version'>[];
}): EngineProfileReport {
  const settingVersion = normalizeEngineVersion(input.settingVersion);
  const preset = ENGINE_VERSION_PRESETS.find(candidate => candidate.value === settingVersion) ?? null;
  return {
    settingVersion,
    presetLabel: preset ? preset.label : null,
    classification: classifyEngineVersion(settingVersion),
    detectedVersion: input.metadata.version === UNKNOWN_ENGINE_VALUE ? null : input.metadata.version,
    commit: input.metadata.commit === UNKNOWN_ENGINE_VALUE ? null : input.metadata.commit,
    describe: input.metadata.describe === UNKNOWN_ENGINE_VALUE ? null : input.metadata.describe,
    featureCounts: countEngineFeatures(input.symbols),
    forkLayerAnnotated: engineApiVersionAnnotation({ version: 'fork' }, settingVersion) !== null
  };
}

/** 分类展示词(分类值本身是技术词,展示层按语言给人话)。 */
export function describeClassification(
  classification: EngineVersionClassification,
  ideLanguage?: string
): string {
  const zh = ideLanguage?.startsWith('zh');
  if (classification === 'official') {
    return zh ? '官方预设版本' : 'official preset version';
  }
  if (classification === 'fork') {
    return zh ? 'fork 版本（fork- 前缀）' : 'fork version (fork- prefix)';
  }
  return zh
    ? '自定义版本（未归类——不猜官方也不猜 fork）'
    : 'custom version (not classified — neither guessed official nor fork)';
}

/**
 * 档案文本渲染(输出通道用,整段可复制):逐道面一行,unknown 面如实写
 * 「未探测到/未知」,绝不占位编造。
 */
export function renderEngineProfileReport(report: EngineProfileReport, ideLanguage?: string): string {
  const zh = ideLanguage?.startsWith('zh');
  const lines: string[] = [];
  lines.push(zh ? 'KBEngine 引擎档案' : 'KBEngine engine profile');
  lines.push('======================================');
  lines.push(
    `${zh ? '设置 kbengine.engineVersion' : 'kbengine.engineVersion setting'}: ${report.settingVersion}`
  );
  lines.push(
    report.presetLabel
      ? `${zh ? '命中预设' : 'preset match'}: ${report.presetLabel}`
      : (zh ? '未命中预设（自由串版本，合法）' : 'no preset match (free-form version string, valid)')
  );
  lines.push(
    `${zh ? '分类' : 'classification'}: ${describeClassification(report.classification, ideLanguage)}`
  );
  lines.push(
    report.detectedVersion
      ? `${zh ? '探测到的版本标记' : 'detected version marker'}: ${report.detectedVersion}`
      : (zh ? '未探测到版本标记（不伪造版本）' : 'version marker not detected (no fabricated version)')
  );
  lines.push(
    report.commit
      ? `commit: ${report.commit}`
      : (zh ? 'commit 未知（非 git 仓或探测失败）' : 'commit unknown (no git repository or probe failed)')
  );
  lines.push(
    report.describe
      ? `describe: ${report.describe}`
      : (zh ? 'describe 未知' : 'describe unknown')
  );
  const { baseline, fork, pending } = report.featureCounts;
  lines.push(
    zh
      ? `特性分层（策展子集，非完整引擎 API 目录）：baseline ${baseline} / fork ${fork} / 待取证 ${pending}`
      : `feature layers (curated subset, not a complete engine API catalog): baseline ${baseline} / fork ${fork} / pending ${pending}`
  );
  lines.push(
    report.forkLayerAnnotated
      ? (zh
        ? 'fork 层标注：启用——当前版本下 fork 档符号带「需 fork」提示'
        : 'fork-layer annotation: enabled — fork symbols carry a "requires fork" hint at the current version')
      : (zh
        ? 'fork 层标注：关闭——当前版本按 fork 语境'
        : 'fork-layer annotation: suppressed — current version reads as fork context')
  );
  return lines.join('\n');
}
