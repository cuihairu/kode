/**
 * 最小项目创建模板清单(IDE-PRJ-007):一份明确的目录/文件清单,定义
 * "新建一个最小 KBEngine 空项目"要落盘的全部内容。清单与
 * workspaceDiscovery.DISCOVERY_CONVENTIONS 的 scripts 布局对齐
 * (demo/assets 同构),建出的骨架可被 projectImport.identifyProjectLayout
 * 在 entities/defs/scripts 三面全部识别(IDE-PRJ-008 的"可被导入"前置)。
 *
 * 本模块是纯清单+预检+预览面:planProjectCreation 只做存在性探测不改盘,
 * 已有目标冲突如实摊开在 plan.conflicts(拒绝语义=冲突非空,命令层接线);
 * 预览项逐条给准确绝对路径,与生成器确认面(generationConfirm)同构。
 */

import * as path from 'path';
import type { GenerationPlanItem } from './generationConfirm';

/** 清单条目:目录(只建空目录)或文件(相对路径+完整内容) */
export interface ProjectTemplateDirectory {
  kind: 'directory';
  relativePath: string;
}

export interface ProjectTemplateFile {
  kind: 'file';
  relativePath: string;
  content: string;
}

export type ProjectTemplateEntry = ProjectTemplateDirectory | ProjectTemplateFile;

/**
 * 最小模板(scripts 布局,父目录先于子条目):
 * scripts/entities.xml 空注册表 + scripts/entity_defs(含空 types.xml)
 * + scripts/base、scripts/cell 两个服务端角色目录(与角色分析根同口径)。
 * 引擎仓不是模板的一部分——空项目 engineRoot 未识别是常态,导入如实 null。
 */
export const MINIMAL_PROJECT_TEMPLATE: readonly ProjectTemplateEntry[] = [
  { kind: 'directory', relativePath: 'scripts' },
  { kind: 'file', relativePath: 'scripts/entities.xml', content: '<root>\n</root>\n' },
  { kind: 'directory', relativePath: 'scripts/entity_defs' },
  { kind: 'file', relativePath: 'scripts/entity_defs/types.xml', content: '<root>\n</root>\n' },
  { kind: 'directory', relativePath: 'scripts/base' },
  { kind: 'directory', relativePath: 'scripts/cell' }
];

/** 清单读取(防御性拷贝,调用方改Listing 不影响清单本身) */
export function listMinimalProjectTemplate(): ProjectTemplateEntry[] {
  return MINIMAL_PROJECT_TEMPLATE.map(entry => ({ ...entry }));
}

/** 预检依赖(注入以便测试;产品面走真实 fs.existsSync) */
export interface ProjectCreationDeps {
  exists: (path: string) => boolean;
}

export interface ProjectCreationPlanEntry {
  entry: ProjectTemplateEntry;
  absolutePath: string;
}

export interface ProjectCreationConflict {
  absolutePath: string;
  reason: string;
}

export interface ProjectCreationPlan {
  targetRoot: string;
  entries: ProjectCreationPlanEntry[];
  /** 已有目标冲突全集(非空 = 命令层必须拒绝,不写半套) */
  conflicts: ProjectCreationConflict[];
}

/**
 * 落盘预检:清单逐条映射到目标根下的绝对路径,已存在的目标(文件或目录
 * 皆算)如实进 conflicts;冲突不截短 entries——清单始终完整摊开,拒绝由
 * 调用方按 conflicts 非空执行。
 */
export function planProjectCreation(targetRoot: string, deps: ProjectCreationDeps): ProjectCreationPlan {
  const entries = MINIMAL_PROJECT_TEMPLATE.map(entry => ({
    entry,
    absolutePath: path.join(targetRoot, entry.relativePath)
  }));
  const conflicts = entries
    .filter(({ absolutePath }) => deps.exists(absolutePath))
    .map(({ absolutePath }) => ({ absolutePath, reason: `目标已存在: ${absolutePath}` }));
  return { targetRoot, entries, conflicts };
}

/**
 * 预览项:每条清单一行,标签区分新增目录/新增文件,description 为准确
 * 绝对路径(与写入同源:同一 absolutePath)。供确认面(008 命令层接
 * generationConfirm.confirmGenerationPlanItems)直接使用。
 */
export function buildProjectCreationPreviewItems(plan: ProjectCreationPlan): GenerationPlanItem[] {
  return plan.entries.map(({ entry, absolutePath }) => ({
    label: entry.kind === 'directory' ? `新增目录 ${entry.relativePath}` : `新增文件 ${entry.relativePath}`,
    description: absolutePath
  }));
}
