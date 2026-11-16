/**
 * 创建向导命令层(RUST-179):RPC 方法/组件/类型别名三类追加创建。
 * 插入计算全部在 backend/entityCreateWizard 纯核(零 vscode);本层只做
 * 交互编排与落盘应用——写入走共享快照口径(打开文档走缓冲 WorkspaceEdit
 * 可 Ctrl+Z,未打开才原子写盘),事务账本交 generator 登记/回滚,
 * 与既有生成面同一套撤销与预检纪律:预览确认前不写任何字节。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findFilesAcrossRoots } from './scanRoots';
import { joinWorkspacePath } from './backend/workspacePath';
import { writeFileAtomic } from './backend/atomicFileWrite';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { confirmGenerationPlanItems, type GenerationPlanItem } from './generationConfirm';
import {
  buildComponentDefContent,
  buildComponentSlotInsertion,
  buildRpcMethodDefInsertion,
  buildRpcMethodPythonInsertion,
  buildTypeAliasInsertion,
  ENTITY_METHOD_SECTIONS,
  type DefInsertionFailure,
  type EntityMethodSection,
  type PythonInsertionFailure,
  type TextInsertion
} from './backend/entityCreateWizard';
import type { GenerationRollbackLedger, KBEngineCodeGenerator } from './codeGenerator';

/** 方法段 → 脚本目录(KBEngine 口径:base/cell/client 三面同名实体脚本) */
const SECTION_SCRIPT_DIR: Record<EntityMethodSection, string> = {
  BaseMethods: 'base',
  CellMethods: 'cell',
  ClientMethods: 'client'
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KBEngine 内建类型清单(类型别名目标;ARRAY/FIXED_DICT 需手写结构故不列) */
const BUILTIN_ALIAS_TARGETS: readonly string[] = [
  'UINT8', 'UINT16', 'UINT32', 'UINT64',
  'INT8', 'INT16', 'INT32', 'INT64',
  'FLOAT', 'DOUBLE', 'STRING', 'UNICODE_STRING', 'BLOB',
  'VECTOR2', 'VECTOR3', 'VECTOR4',
  'PyDict', 'PyList', 'PyTuple'
];

function relativeToWorkspace(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).split(path.sep).join('/');
}

function identifierValidator(hint: string): (value: string) => string | undefined {
  return (value: string) => {
    if (!value) {
      return undefined;
    }
    return IDENTIFIER_PATTERN.test(value) ? undefined : hint;
  };
}

/**
 * 单点插入落盘(与 registerInEntitiesXml/appendFixedDictTypeToTypesXml 同一口径):
 * 打开文档走缓冲 WorkspaceEdit(登记 bufferEdits,可 Ctrl+Z、按「恰好含该插入」
 * 守卫撤回),未打开文件原子写盘(登记 overwrittenFiles 前值)。
 */
async function applyTextInsertion(
  targetPath: string,
  insertion: TextInsertion,
  ledger: GenerationRollbackLedger
): Promise<void> {
  const snapshot = readSharedFileSnapshot(targetPath);
  if (snapshot && snapshot.source === 'document') {
    const doc = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === snapshot.fsPath);
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, doc.positionAt(insertion.offset), insertion.text);
      await vscode.workspace.applyEdit(edit);
      ledger.bufferEdits.push({ filePath: targetPath, uri: doc.uri, offset: insertion.offset, text: insertion.text });
      return;
    }
    // 快照时在位、应用时已关闭:按快照内容走盘写分支(前值仍准确)
  }
  const base = snapshot ? snapshot.content : '';
  const updated = base.slice(0, insertion.offset) + insertion.text + base.slice(insertion.offset + insertion.length);
  writeFileAtomic(targetPath, updated);
  ledger.overwrittenFiles.push({ filePath: targetPath, previous: base });
}

function defFailureMessage(failure: { reason: DefInsertionFailure['reason']; section?: string }, targetPath: string): string {
  switch (failure.reason) {
    case 'parse-failed':
      return `def 文件解析失败(请检查 XML 格式): ${targetPath}`;
    case 'no-root':
      return `def 文件缺少 <root> 根元素: ${targetPath}`;
    case 'method-exists':
      return `方法已存在于 ${failure.section ?? ''}: 请换一个方法名`;
    case 'slot-exists':
      return `同名槽已存在,请换一个组件名`;
    case 'alias-exists':
      return `同名类型别名已存在: ${targetPath}`;
    default:
      return `无法插入: ${targetPath}`;
  }
}

function pythonFailureMessage(failure: { reason: PythonInsertionFailure['reason'] }, pyPath: string): string {
  switch (failure.reason) {
    case 'parse-failed':
      return `Python 文件解析失败: ${pyPath}`;
    case 'no-class':
      return `实体脚本中没有实体类,无法插入方法: ${pyPath}`;
    case 'method-exists':
      return `同名方法已存在于脚本: 请换一个方法名`;
    default:
      return `无法插入: ${pyPath}`;
  }
}

/** def 文件清单(defRoot 优先展示;相对路径作 label) */
async function pickDefFile(workspaceRoot: string, placeHolder: string): Promise<string | undefined> {
  const defFiles = await findFilesAcrossRoots('**/*.def', null);
  const items = defFiles
    .map(uri => uri.fsPath)
    .sort()
    .map(fsPath => ({ label: relativeToWorkspace(workspaceRoot, fsPath), fsPath }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.fsPath;
}

/** 实体脚本落点:pythonRoot/<face>/<实体名>.py(def 同名) */
function resolveEntityScriptPath(pythonRoot: string, section: EntityMethodSection, entityName: string): string {
  return joinWorkspacePath(pythonRoot, SECTION_SCRIPT_DIR[section], `${entityName}.py`);
}

/**
 * RPC 方法追加:选 def → 选方法段 → 方法名/参数 → Exposed → 纯核计算
 * def+py 两处插入 → 计划预览确认 → 落盘登记账本。py 文件缺失时如实提供
 * 「仅改 def」选项(声明无实现),绝不静默新建脚本面。
 */
export async function runAddRpcWizard(generator: KBEngineCodeGenerator): Promise<void> {
  let paths;
  try {
    paths = generator.resolveCreationTargetPaths();
  } catch (error) {
    vscode.window.showErrorMessage(`${error}`);
    return;
  }

  let defPath = vscode.window.activeTextEditor?.document.fileName;
  if (!defPath || !defPath.endsWith('.def')) {
    defPath = await pickDefFile(paths.workspaceRoot, '选择要添加 RPC 方法的实体 def');
  }
  if (!defPath) {
    return;
  }

  const sectionPick = await vscode.window.showQuickPick(
    ENTITY_METHOD_SECTIONS.map(section => ({
      label: section,
      description: SECTION_SCRIPT_DIR[section],
      section
    })),
    { placeHolder: '选择方法所在段(KBEngine 三面方法段)' }
  );
  if (!sectionPick) {
    return;
  }
  const section = sectionPick.section;

  const methodName = await vscode.window.showInputBox({
    prompt: '输入 RPC 方法名',
    placeHolder: '如 reqCastSkill',
    validateInput: identifierValidator('方法名必须是合法标识符(字母/下划线开头)')
  });
  if (!methodName) {
    return;
  }

  const args: string[] = [];
  for (;;) {
    const arg = await vscode.window.showInputBox({
      prompt: `输入参数类型(第 ${args.length + 1} 个,留空结束)`,
      placeHolder: '如 UINT32 / STRING'
    });
    if (!arg) {
      break;
    }
    args.push(arg.trim());
  }

  let exposed = false;
  if (section !== 'ClientMethods') {
    const exposedPick = await vscode.window.showQuickPick(
      [
        { label: '是(Exposed:暴露给客户端可调用)', value: true },
        { label: '否(仅引擎内部调用)', value: false }
      ],
      { placeHolder: '该方法是否 Exposed(客户端可见)?' }
    );
    if (!exposedPick) {
      return;
    }
    exposed = exposedPick.value;
  }

  const defSnapshot = readSharedFileSnapshot(defPath);
  if (!defSnapshot) {
    vscode.window.showErrorMessage(`def 文件不存在: ${defPath}`);
    return;
  }
  const defResult = buildRpcMethodDefInsertion(defSnapshot.content, section, methodName, args, exposed);
  if (!defResult.ok) {
    vscode.window.showErrorMessage(defFailureMessage(defResult, defPath));
    return;
  }

  const entityName = path.basename(defPath).replace(/\.def$/i, '');
  const pyPath = resolveEntityScriptPath(paths.pythonRoot, section, entityName);
  const pySnapshot = readSharedFileSnapshot(pyPath);
  let pyInsertion: { insertion: TextInsertion } | undefined;
  if (pySnapshot) {
    const pyResult = buildRpcMethodPythonInsertion(pySnapshot.content, pyPath, methodName, args);
    if (!pyResult.ok) {
      vscode.window.showErrorMessage(pythonFailureMessage(pyResult, pyPath));
      return;
    }
    pyInsertion = pyResult;
  } else {
    const onlyDef = await vscode.window.showQuickPick(
      [
        { label: '继续:仅改 def(py 脚本不存在,声明无实现)', value: true },
        { label: '取消', value: false }
      ],
      { placeHolder: `实体脚本不存在: ${relativeToWorkspace(paths.workspaceRoot, pyPath)}` }
    );
    if (!onlyDef?.value) {
      return;
    }
  }

  const plan: GenerationPlanItem[] = [
    {
      label: relativeToWorkspace(paths.workspaceRoot, defPath),
      description: `<${methodName}> → ${section}${defResult.createdSection ? '(新建段)' : ''}`
    }
  ];
  if (pyInsertion) {
    plan.push({
      label: relativeToWorkspace(paths.workspaceRoot, pyPath),
      description: `def ${methodName}(self${args.length ? ', …' : ''}) 实现骨架`
    });
  }
  if (!(await confirmGenerationPlanItems(plan))) {
    return;
  }

  const ledger = createLedger();
  try {
    await applyTextInsertion(defPath, defResult.insertion, ledger);
    if (pyInsertion) {
      await applyTextInsertion(pyPath, pyInsertion.insertion, ledger);
    }
  } catch (error) {
    await generator.rollbackLedger(ledger);
    vscode.window.showErrorMessage(`生成失败: ${error}`);
    return;
  }
  generator.persistGenerationLedger(ledger);
  vscode.window.showInformationMessage(`✅ 已添加 RPC 方法 ${methodName}(${section})`);
}

/**
 * 组件创建:组件 def 落 entity_defs/components/(不覆盖已存在),可选挂载
 * 宿主实体 def 的 <Components> 槽(缺段自动创建),形态对齐真资产
 * bag/Inventory 槽结构。
 */
export async function runNewComponentWizard(generator: KBEngineCodeGenerator): Promise<void> {
  let paths;
  try {
    paths = generator.resolveCreationTargetPaths();
  } catch (error) {
    vscode.window.showErrorMessage(`${error}`);
    return;
  }
  const componentsDir = joinWorkspacePath(paths.defRoot, 'components');

  const componentName = await vscode.window.showInputBox({
    prompt: '输入组件名',
    placeHolder: '如 Inventory',
    validateInput: identifierValidator('组件名必须是合法标识符(字母/下划线开头)')
  });
  if (!componentName) {
    return;
  }
  const componentDefPath = joinWorkspacePath(componentsDir, `${componentName}.def`);
  if (fs.existsSync(componentDefPath)) {
    vscode.window.showErrorMessage(`组件 def 已存在,不覆盖: ${relativeToWorkspace(paths.workspaceRoot, componentDefPath)}`);
    return;
  }

  const hostPath = await pickDefFile(paths.workspaceRoot, '选择挂载组件的宿主实体 def(可取消跳过)');
  let slotInsertion: { insertion: TextInsertion } | undefined;
  let slotName: string | undefined;
  let hostPlan: GenerationPlanItem | undefined;
  if (hostPath) {
    const persistentPick = await vscode.window.showQuickPick(
      [
        { label: '是( Persistent: true,组件状态持久化)', value: true },
        { label: '否(不持久化)', value: false }
      ],
      { placeHolder: '组件槽是否持久化?' }
    );
    if (!persistentPick) {
      return;
    }
    const hostSnapshot = readSharedFileSnapshot(hostPath);
    if (!hostSnapshot) {
      vscode.window.showErrorMessage(`宿主 def 文件不存在: ${hostPath}`);
      return;
    }
    slotName = componentName.charAt(0).toLowerCase() + componentName.slice(1);
    const slotResult = buildComponentSlotInsertion(hostSnapshot.content, slotName, componentName, persistentPick.value);
    if (!slotResult.ok) {
      vscode.window.showErrorMessage(defFailureMessage(slotResult, hostPath));
      return;
    }
    slotInsertion = slotResult;
    hostPlan = {
      label: relativeToWorkspace(paths.workspaceRoot, hostPath),
      description: `<${slotName}><Type> ${componentName} </Type> 槽${slotResult.createdSection ? '(新建 Components 段)' : ''}`
    };
  }

  const plan: GenerationPlanItem[] = [
    {
      label: relativeToWorkspace(paths.workspaceRoot, componentDefPath),
      description: '新建组件 def(root + 空 Properties)'
    }
  ];
  if (hostPlan) {
    plan.push(hostPlan);
  }
  if (!(await confirmGenerationPlanItems(plan))) {
    return;
  }

  const ledger = createLedger();
  try {
    fs.mkdirSync(componentsDir, { recursive: true });
    writeFileAtomic(componentDefPath, buildComponentDefContent(componentName));
    ledger.createdFiles.push(componentDefPath);
    if (slotInsertion && hostPath) {
      await applyTextInsertion(hostPath, slotInsertion.insertion, ledger);
    }
  } catch (error) {
    await generator.rollbackLedger(ledger);
    vscode.window.showErrorMessage(`生成失败: ${error}`);
    return;
  }
  generator.persistGenerationLedger(ledger);
  vscode.window.showInformationMessage(
    slotName ? `✅ 已创建组件 ${componentName} 并挂载到宿主(槽 ${slotName})` : `✅ 已创建组件 ${componentName}`
  );
}

/**
 * 类型别名创建:types.xml 追加 `<别名> 类型 </别名>` 单行条目(真资产
 * ITEM_ID 口径),不覆盖同名条目;目标类型从内建类型清单选择。
 */
export async function runNewTypeAliasWizard(generator: KBEngineCodeGenerator): Promise<void> {
  let paths;
  try {
    paths = generator.resolveCreationTargetPaths();
  } catch (error) {
    vscode.window.showErrorMessage(`${error}`);
    return;
  }

  const aliasName = await vscode.window.showInputBox({
    prompt: '输入类型别名(惯用大写下划线)',
    placeHolder: '如 ITEM_ID',
    validateInput: identifierValidator('别名必须是合法标识符(字母/下划线开头)')
  });
  if (!aliasName) {
    return;
  }
  const targetTypePick = await vscode.window.showQuickPick(
    BUILTIN_ALIAS_TARGETS.map(target => ({ label: target })),
    { placeHolder: '选择别名指向的内建类型' }
  );
  if (!targetTypePick) {
    return;
  }

  const typesSnapshot = readSharedFileSnapshot(paths.typesXmlPath);
  if (!typesSnapshot) {
    vscode.window.showErrorMessage(`types.xml 不存在: ${paths.typesXmlPath}`);
    return;
  }
  const aliasResult = buildTypeAliasInsertion(typesSnapshot.content, aliasName, targetTypePick.label);
  if (!aliasResult.ok) {
    vscode.window.showErrorMessage(defFailureMessage(aliasResult, paths.typesXmlPath));
    return;
  }

  if (!(await confirmGenerationPlanItems([
    {
      label: relativeToWorkspace(paths.workspaceRoot, paths.typesXmlPath),
      description: `<${aliasName}> ${targetTypePick.label} </${aliasName}>`
    }
  ]))) {
    return;
  }

  const ledger = createLedger();
  try {
    await applyTextInsertion(paths.typesXmlPath, aliasResult.insertion, ledger);
  } catch (error) {
    await generator.rollbackLedger(ledger);
    vscode.window.showErrorMessage(`生成失败: ${error}`);
    return;
  }
  generator.persistGenerationLedger(ledger);
  vscode.window.showInformationMessage(`✅ 已添加类型别名 ${aliasName} = ${targetTypePick.label}`);
}

function createLedger(): GenerationRollbackLedger {
  return { createdFiles: [], overwrittenFiles: [], bufferEdits: [] };
}

/** 注册四命令(RUST-179):三类创建向导 + 撤销最近一次生成 */
export function registerEntityCreateCommands(
  context: vscode.ExtensionContext,
  generator: KBEngineCodeGenerator
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.entity.addRpc', () => {
      void runAddRpcWizard(generator);
    }),
    vscode.commands.registerCommand('kbengine.component.new', () => {
      void runNewComponentWizard(generator);
    }),
    vscode.commands.registerCommand('kbengine.types.new', () => {
      void runNewTypeAliasWizard(generator);
    }),
    vscode.commands.registerCommand('kbengine.generator.undoLast', () => {
      void generator.undoLastGeneration().then(undone => {
        if (undone) {
          vscode.window.showInformationMessage('✅ 已撤销最近一次生成(def/py/types.xml 已还原)');
        } else {
          vscode.window.showInformationMessage('没有可撤销的生成记录');
        }
      });
    })
  );
}
