// C-23 交付②接线层:行为知识三规则(KBE-PY-015/016/017)的发布面。
// 规则纯逻辑各在其模块(fixedDictMutationDiagnostics /
// destroyedEntityCaptureDiagnostics / timerCleanupDiagnostics),数据源 =
// KB-001 结构化条目(src/knowledge/trapsKnowledge.ts)。本模块只做:
//   - 独立诊断集合 kbengine-trap-lints(与既有规则各自独立集合同模式);
//   - 自持事件监听(onDidOpen/onDidChange/onDidClose;与
//     configContractDiagnostics 同款,不进 extension.ts 主调度链);
//   - FIXED_DICT 形态判定:listPropertyDefinitionsForFile 属性面 +
//     getTypeStorageShape(types.xml 类型图,与悬停/存根同源);
//   - quick fix provider:子键赋值 → 整体重赋习语(仅直接赋值单段键)。
// 开关(默认开,现读下一次生效):kbengine.fixedDictMutationDiagnostics /
// kbengine.destroyedEntityReferenceDiagnostics / kbengine.timerCleanupDiagnostics。
// 非实体脚本(路径面与 def 归属双 miss)不接管,不猜。

import * as path from 'path';
import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import { getTypeStorageShape } from './databaseSchema';
import { getDefinitionWorkspaceLayout } from './definitionWorkspace';
import { resolveEntityComponentFaceFromPath } from './backend/entityBuiltinProperties';
import { getKodeCoreShadowGate } from './backend/kodeCoreShadowFaces';
import {
  analyzeFixedDictMutations,
  buildFixedDictWholeReassignText,
  renderFixedDictMutationMessage,
  FIXED_DICT_MUTATION_DIAGNOSTIC_CODE
} from './backend/fixedDictMutationDiagnostics';
import {
  analyzeDestroyedEntityCaptures,
  renderDestroyedEntityReferenceMessage,
  DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE
} from './backend/destroyedEntityCaptureDiagnostics';
import {
  analyzeTimerCleanupOnDestroy,
  renderTimerCleanupMessage,
  TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE
} from './backend/timerCleanupDiagnostics';

/** 独立诊断集合名(extension.test 注册面对账) */
export const TRAP_LINT_DIAGNOSTIC_COLLECTION = 'kbengine-trap-lints';

/** quick fix 标题 */
const WHOLE_REASSIGN_TITLE = 'Reassign the whole FIXED_DICT property';

/** 单条产物的诊断面形态(纯数据;tests 免 vscode) */
export interface TrapDiagnosticItem {
  code: string;
  severity: 'Warning' | 'Information';
  line: number;
  character: number;
  length: number;
  message: string;
}

/** 构建期依赖(测试可注入) */
export interface TrapLintComputeDeps {
  /** FIXED_DICT 属性表:属性名 → 顶层键集(规则 1 判定面) */
  fixedDictProperties: ReadonlyMap<string, readonly string[]>;
  /** 三规则开关态 */
  enabled: {
    fixedDictMutation: boolean;
    destroyedEntityReference: boolean;
    timerCleanup: boolean;
  };
}

/** 纯构建:一份 python 文本的三规则产物(诊断集合发布/测试共用) */
export function buildTrapDiagnosticItems(
  text: string,
  deps: TrapLintComputeDeps
): TrapDiagnosticItem[] {
  const items: TrapDiagnosticItem[] = [];
  if (deps.enabled.fixedDictMutation) {
    for (const finding of analyzeFixedDictMutations(text, deps.fixedDictProperties)) {
      items.push({
        code: FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
        severity: 'Warning',
        line: finding.line,
        character: finding.character,
        length: finding.length,
        message: finding.message
      });
    }
  }
  if (deps.enabled.destroyedEntityReference) {
    for (const finding of analyzeDestroyedEntityCaptures(text)) {
      items.push({
        code: DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE,
        severity: 'Warning',
        line: finding.line,
        character: finding.character,
        length: finding.length,
        message: finding.message
      });
    }
  }
  if (deps.enabled.timerCleanup) {
    for (const finding of analyzeTimerCleanupOnDestroy(text)) {
      items.push({
        code: TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE,
        severity: 'Information',
        line: finding.line,
        character: finding.character,
        length: finding.length,
        message: finding.message
      });
    }
  }
  return items;
}

// ---- Rust 面(AUDIT-005 B2 车道首批:trap 三规则收编) -----------------------
// `$/kode/lint/analyzeTraps` 经 gate.runInRust(命令面,与 analyzeDef 同口径):
// Rust 只回结构面(code/line/character/length + l10n 参数字段),消息渲染
// 留 TS(模板单一来源 = 三 analyzer 的 render*Message)。Rust 不可用
// (无门/未配 serverPath/调用失败)或应答畸形(任一条缺结构字段/缺 l10n
// 参数)整面作废回 TS 同步路径 —— 禁止部分采用(静默丢能力)。

/** Rust 结构面单条产物(`$/kode/lint/analyzeTraps` 应答) */
interface RustTrapItem {
  code: string;
  line: number;
  character: number;
  length: number;
  /** fixedDictNestedMutation 的 l10n 参数(属性名,消息拼 `self.<name>`) */
  property?: string;
  /** destroyedEntityReference 的 l10n 参数(容器名) */
  container?: string;
}

const TRAP_LINT_RUST_METHOD = '$/kode/lint/analyzeTraps';

/** 结构面 → 诊断面(消息渲染+严重级映射);缺 l10n 参数 = 畸形,返回 null */
function renderRustTrapItem(item: RustTrapItem): TrapDiagnosticItem | null {
  if (
    typeof item?.code !== 'string'
    || typeof item.line !== 'number'
    || typeof item.character !== 'number'
    || typeof item.length !== 'number'
  ) {
    return null;
  }
  switch (item.code) {
    case FIXED_DICT_MUTATION_DIAGNOSTIC_CODE:
      if (typeof item.property !== 'string') {
        return null;
      }
      return {
        code: item.code,
        severity: 'Warning',
        line: item.line,
        character: item.character,
        length: item.length,
        message: renderFixedDictMutationMessage(item.property)
      };
    case DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE:
      if (typeof item.container !== 'string') {
        return null;
      }
      return {
        code: item.code,
        severity: 'Warning',
        line: item.line,
        character: item.character,
        length: item.length,
        message: renderDestroyedEntityReferenceMessage(item.container)
      };
    case TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE:
      return {
        code: item.code,
        severity: 'Information',
        line: item.line,
        character: item.character,
        length: item.length,
        message: renderTimerCleanupMessage()
      };
    default:
      return null;
  }
}

/**
 * 结构面数组 → 诊断面数组(消息渲染+严重级映射);任一条畸形返回 null
 * (整面作废,调用方回 TS 兜底 —— 禁止部分采用)。对拍测试共用。
 */
export function renderRustTrapItems(items: readonly unknown[]): TrapDiagnosticItem[] | null {
  const rendered: TrapDiagnosticItem[] = [];
  for (const item of items) {
    const renderedItem = renderRustTrapItem(item as RustTrapItem);
    if (!renderedItem) {
      return null;
    }
    rendered.push(renderedItem);
  }
  return rendered;
}

/**
 * Rust-first 三规则产物:gate.runInRust 跑 `$/kode/lint/analyzeTraps`,
 * 结构面经 renderRustTrapItems 渲染;不可用/失败/畸形回 TS 兜底
 * buildTrapDiagnosticItems(既有行为不变)。
 */
export async function buildTrapDiagnosticItemsWithRust(
  text: string,
  deps: TrapLintComputeDeps
): Promise<TrapDiagnosticItem[]> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return buildTrapDiagnosticItems(text, deps);
  }
  const result = await gate.runInRust<unknown>(TRAP_LINT_RUST_METHOD, {
    text,
    fixedDictProperties: Object.fromEntries(deps.fixedDictProperties),
    enabled: deps.enabled
  });
  if (!result.ok) {
    return buildTrapDiagnosticItems(text, deps);
  }
  const rustItems = (result.result as { items?: unknown }).items;
  if (!Array.isArray(rustItems)) {
    return buildTrapDiagnosticItems(text, deps);
  }
  return renderRustTrapItems(rustItems) ?? buildTrapDiagnosticItems(text, deps);
}

/** 工作区 types.xml 定位(python 文件 → 所属根 → 布局;多根不串,缺根回落首根) */
function resolveTypesXmlPathForFile(fileName: string): string | null {
  const folder = vscode.workspace.workspaceFolders?.find(candidate =>
    fileName.startsWith(`${candidate.uri.fsPath}${path.sep}`) ||
    fileName.startsWith(`${candidate.uri.fsPath}/`)
  );
  const root = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? getDefinitionWorkspaceLayout(root).typesXmlPath : null;
}

/** FIXED_DICT 属性表构建(listPropertyDefinitionsForFile + 类型图) */
async function collectFixedDictProperties(
  manager: EntityMappingManager,
  fileName: string
): Promise<Map<string, readonly string[]>> {
  const result = new Map<string, readonly string[]>();
  const properties = await manager.listPropertyDefinitionsForFile(fileName);
  for (const property of properties) {
    const name = property.identity.propertyPath || property.identity.symbolName;
    if (name.includes('.') || property.identity.componentSlotName) {
      continue;
    }
    if (!property.typeName || result.has(name)) {
      continue;
    }
    const shape = getTypeStorageShape(resolveTypesXmlPathForFile(fileName), property.typeName);
    if (shape.kind === 'fixedDict') {
      result.set(name, shape.topLevelKeys);
    }
  }
  return result;
}

/** 实体脚本判定:路径面命中,或 def 归属命中(与 postDestroy 同口径) */
async function resolveEntityScriptFace(
  manager: EntityMappingManager,
  fileName: string
): Promise<boolean> {
  if (resolveEntityComponentFaceFromPath(fileName)) {
    return true;
  }
  try {
    const faces = await manager.getEntityComponentFacesForPythonFile(fileName);
    return Array.isArray(faces) && faces.length > 0;
  } catch {
    return false;
  }
}

export function wireTrapLintDiagnostics(
  context: vscode.ExtensionContext,
  entityMappingManager: EntityMappingManager
): void {
  const collection = vscode.languages.createDiagnosticCollection(TRAP_LINT_DIAGNOSTIC_COLLECTION);
  context.subscriptions.push(collection);

  const compute = async (document: vscode.TextDocument): Promise<void> => {
    if (document.languageId !== 'python') {
      return;
    }
    const config = vscode.workspace.getConfiguration('kbengine');
    const enabled = {
      fixedDictMutation: config.get<boolean>('fixedDictMutationDiagnostics', true),
      destroyedEntityReference: config.get<boolean>('destroyedEntityReferenceDiagnostics', true),
      timerCleanup: config.get<boolean>('timerCleanupDiagnostics', true)
    };
    if (!enabled.fixedDictMutation && !enabled.destroyedEntityReference && !enabled.timerCleanup) {
      collection.delete(document.uri);
      return;
    }
    if (!(await resolveEntityScriptFace(entityMappingManager, document.fileName))) {
      collection.delete(document.uri);
      return;
    }
    const fixedDictProperties = enabled.fixedDictMutation
      ? await collectFixedDictProperties(entityMappingManager, document.fileName)
      : new Map<string, readonly string[]>();
    const items = await buildTrapDiagnosticItemsWithRust(document.getText(), {
      fixedDictProperties,
      enabled
    });
    collection.set(
      document.uri,
      items.map(item => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(item.line, item.character, item.line, item.character + item.length),
          item.message,
          item.severity === 'Warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information
        );
        diagnostic.source = 'kbengine';
        diagnostic.code = item.code;
        return diagnostic;
      })
    );
  };

  // 激活期不扫全量(与 postDestroy 同口径:首个使用事件即算)
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => { void compute(document); }),
    vscode.workspace.onDidChangeTextDocument(event => { void compute(event.document); }),
    vscode.workspace.onDidCloseTextDocument(document => { collection.delete(document.uri); })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'python', scheme: 'file' },
      new FixedDictWholeReassignCodeActionProvider()
    )
  );
}

/**
 * quick fix:FIXED_DICT 子键赋值 → 整体重赋习语。仅直接赋值单段键;
 * 增强赋值/深链不冒充(纯逻辑判定在 fixedDictMutationDiagnostics)。
 */
export class FixedDictWholeReassignCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== FIXED_DICT_MUTATION_DIAGNOSTIC_CODE) {
        continue;
      }
      const statementLine = document.lineAt(diagnostic.range.start.line).text.trim();
      const target = parseFixedDictTarget(statementLine);
      if (!target) {
        continue;
      }
      const replacement = buildFixedDictWholeReassignText(
        statementLine,
        target.property,
        target.key
      );
      if (!replacement) {
        continue;
      }
      const lineText = document.lineAt(diagnostic.range.start.line).text;
      const indent = lineText.length - lineText.trimStart().length;
      const edit = new vscode.WorkspaceEdit();
      edit.set(document.uri, [
        new vscode.TextEdit(
          new vscode.Range(diagnostic.range.start.line, 0, diagnostic.range.start.line, lineText.length),
          `${' '.repeat(indent)}${replacement}`
        )
      ]);
      const action = new vscode.CodeAction(WHOLE_REASSIGN_TITLE, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.edit = edit;
      actions.push(action);
    }
    return actions;
  }
}

/** 语句 → {property, key}(quick fix 目标解析;不匹配返回 null) */
function parseFixedDictTarget(
  statement: string
): { property: string; key: string } | null {
  const attr = /^\s*self\.(\w+)\.(\w+)\s*(?:=[^=])/.exec(statement);
  if (attr) {
    return { property: attr[1], key: attr[2] };
  }
  const subscript = /^\s*self\.(\w+)\[(?:'([^']+)'|"([^"]+)")\]\s*(?:=[^=])/.exec(statement);
  if (subscript) {
    return { property: subscript[1], key: subscript[2] ?? subscript[3] ?? '' };
  }
  return null;
}
