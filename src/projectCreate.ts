/**
 * 最小项目创建命令体(IDE-PRJ-008):把 IDE-PRJ-007 的模板清单接到
 * 命令面,全程遵守生成器保护——已有目标冲突直接拒绝不出预览(GEN-003
 * 整体中止口径)、确认面用生成器同一 QuickPick(GEN-008)、文件落盘走
 * 原子写(GEN-005)、任一步失败逆序回收本次新增(文件先删,空目录再逆序
 * 删,GEN-006 同口径)。成功后按导入命令同一识别链与档案存储建 profile
 * (IDE-PRJ-003 identifyProjectLayout + PRJ-001 ProjectProfileStore),
 * 引擎仓不在模板里,engineRoot 如实空。任一步取消(Esc/关对话框)零写入。
 *
 * DEMO-GAME-006:保护流下沉为共享 createProjectFromTemplate,demo 游戏
 * 模板(templates/demo-game,磁盘装载)与最小清单同面创建。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildProjectCreationPreviewItems, listMinimalProjectTemplate, planProjectCreation } from './projectTemplate';
import type { ProjectTemplateEntry } from './projectTemplate';
import { loadDemoGameTemplateEntries } from './demoGameTemplate';
import { confirmGenerationPlanItems } from './generationConfirm';
import { writeFileAtomic } from './atomicFileWrite';
import { identifyProjectLayout } from './projectImport';
import { ProjectProfileStore } from './projectProfiles';
import {
  describeInterpreterState,
  resolveProfileInterpreter,
  type InterpreterResolution
} from './profileInterpreter';

/** 测试注入面:解释器解析与落盘原语(产品面走真实实现) */
export interface ProjectCreateDeps {
  resolveInterpreter?: () => InterpreterResolution;
  writeFile?: (filePath: string, content: string) => void;
  mkdir?: (dirPath: string) => void;
}

/** 本次新建文件记账(含写入字节,供回收字节比对) */
interface CreatedFileRecord {
  filePath: string;
  content: string;
}

/** 失败回收:先逆序删本次写的文件,再逆序删本次建的目录(逆序保证子先于父,删得动) */
function rollbackCreation(
  createdFiles: readonly CreatedFileRecord[],
  createdDirs: readonly string[],
  implicitRoot: string | null
): void {
  for (const { filePath, content } of [...createdFiles].reverse()) {
    try {
      // AUD-032(R2-F08):仅当盘上字节仍是本次写入的内容才回收;他人并发
      // 替换过(内容已变)则如实留下,不越权删他人新增
      if (fs.readFileSync(filePath, 'utf8') === content) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // 文件已不在或读取失败:不动别的内容
    }
  }
  for (const dirPath of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(dirPath);
    } catch {
      // 目录非空或已删:不动别的内容
    }
  }
  // 递归建 scripts 时顺带建出的目标根(mkdir 侧产物,不在清单里):只在
  // 本次创建前它不存在时才回收,且仅在已空时删得动——用户预先选好的空
  // 目录不属于本次新增,不越权删
  if (implicitRoot !== null) {
    try {
      fs.rmdirSync(implicitRoot);
    } catch {
      // 根下还有别的内容:如实留下
    }
  }
}

export async function createMinimalProject(
  context: {
    workspaceState?: vscode.Memento;
  },
  deps: ProjectCreateDeps = {}
): Promise<void> {
  await createProjectFromTemplate(
    context,
    // 最小模板条目防御性拷贝(008 既有口径:清单不被调用方改动影响)
    { entries: listMinimalProjectTemplate(), successNoun: '最小项目' },
    deps
  );
}

/**
 * demo 游戏项目创建(DEMO-GAME-006):templates/demo-game(夹具游戏子集)
 * 装载后走与最小项目完全相同的保护面。模板读取失败/为空如实报错返回,
 * 不落半套;成功后同样按导入识别链建 profile。
 */
export async function createDemoGameProject(
  context: {
    workspaceState?: vscode.Memento;
  },
  options: { templateRoot: string },
  deps: ProjectCreateDeps = {}
): Promise<void> {
  let entries: ProjectTemplateEntry[];
  try {
    entries = loadDemoGameTemplateEntries(options.templateRoot);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `demo 游戏模板读取失败(${options.templateRoot}): ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  if (entries.length === 0) {
    await vscode.window.showErrorMessage(`demo 游戏模板为空，拒绝创建: ${options.templateRoot}`);
    return;
  }
  await createProjectFromTemplate(context, { entries, successNoun: 'demo 游戏' }, deps);
}

/** 共享创建流:选根→预检→确认→落盘(原子写)→失败回收→建档(008 面) */
async function createProjectFromTemplate(
  context: {
    workspaceState?: vscode.Memento;
  },
  options: { entries: readonly ProjectTemplateEntry[]; successNoun: string },
  deps: ProjectCreateDeps = {}
): Promise<void> {
  const pickedFolders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    canSelectFiles: false,
    openLabel: '选择项目根目录'
  });
  const targetRoot = pickedFolders?.[0]?.fsPath;
  if (!targetRoot) {
    return;
  }

  const plan = planProjectCreation(targetRoot, { exists: candidate => fs.existsSync(candidate) }, options.entries);
  if (plan.conflicts.length > 0) {
    for (const conflict of plan.conflicts) {
      await vscode.window.showErrorMessage(`目标已存在，拒绝创建: ${conflict.absolutePath}`);
    }
    return;
  }

  if (!(await confirmGenerationPlanItems(buildProjectCreationPreviewItems(plan)))) {
    return;
  }

  // AUD-032(R2-F08):确认后、落盘前重查——预览期间另一来源新增/替换任何
  // 目标(如 entities.xml)即整次拒绝,不写半套,不覆盖并发出现的文件
  const landedConflicts = plan.entries.filter(({ absolutePath }) => fs.existsSync(absolutePath));
  if (landedConflicts.length > 0) {
    for (const { absolutePath } of landedConflicts) {
      await vscode.window.showErrorMessage(`目标已存在，拒绝创建: ${absolutePath}`);
    }
    return;
  }

  const writeFile =
    deps.writeFile ?? ((filePath: string, content: string) => writeFileAtomic(filePath, content, { noClobber: true }));
  const mkdir = deps.mkdir ?? ((dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }));
  const createdFiles: CreatedFileRecord[] = [];
  const createdDirs: string[] = [];
  // 目标根预先不存在时,首个递归 mkdir 会把它一并建出——回收面覆盖它
  const targetRootPreexisting = fs.existsSync(targetRoot);
  const implicitRoot = targetRootPreexisting ? null : targetRoot;
  try {
    for (const { entry, absolutePath } of plan.entries) {
      if (entry.kind === 'directory') {
        mkdir(absolutePath);
        createdDirs.push(absolutePath);
      } else {
        // 文件条目隐含父目录:磁盘装载的模板(demo 游戏)文件与目录条目
        // 按名交错,父先于子不由排序保证——落盘前确保父目录在(与目录
        // 条目同一 mkdir 原语,记入回收面;已存在的不重复记账)
        const parentDir = path.dirname(absolutePath);
        if (!fs.existsSync(parentDir)) {
          mkdir(parentDir);
          createdDirs.push(parentDir);
        }
        writeFile(absolutePath, entry.content);
        createdFiles.push({ filePath: absolutePath, content: entry.content });
      }
    }
  } catch (error) {
    rollbackCreation(createdFiles, createdDirs, implicitRoot);
    await vscode.window.showErrorMessage(
      `创建失败，已回收本次新增: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const identification = identifyProjectLayout(targetRoot);
  const interpreter = (deps.resolveInterpreter ?? resolveProfileInterpreter)();
  const store = new ProjectProfileStore(context.workspaceState);
  const profile = await store.create({
    displayName: path.basename(targetRoot) || targetRoot,
    assetsRoot: targetRoot,
    engineRoot: identification.engineRoot ?? '',
    interpreterPath: interpreter.interpreterPath,
    interpreterSource: interpreter.interpreterSource
  });
  await vscode.window.showInformationMessage(
    `已创建${options.successNoun} profile: ${profile.displayName} (${profile.id});${describeInterpreterState(profile)}`
  );
}
