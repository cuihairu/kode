// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { DefElementNode, getDirectChildElements, getElementText, getLineNumberAt } from '../defParser';
import { DEF_METHOD_MISSING_DIAGNOSTIC_CODE, KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND, buildMethodStubCode, type MethodStubBody } from '../defMethodConsistency';
import { EntityMappingManager, EntityMethodSection } from '../entityMapping';
import { buildPythonMethodSkeletonWithTypes, entityNameOfDefFile } from '../defPythonParity';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import { RECEIVER_NONE_DIAGNOSTIC_CODE, buildReceiverNoneGuardEdit, buildReceiverNoneWrapEdit } from '../receiverNoneDiagnostics';
import { KBEngineSectionName, METHOD_SECTIONS, getLanguageFeatureConfig, getNodeValue, parseDefAst } from './shared';
import { UNKNOWN_TYPE_DIAGNOSTIC_CODE } from './validation';
import { findDefSymbolInfo } from './navigation';
import { FIXED_DICT_NESTED_MUTATION_CODE } from '../behaviorKnowledge';
import { buildFixedDictWholeReassignEdit } from '../behaviorLints';
import { findRegisteredTypeSuggestions, getKnownTypeContext } from './completion';
export class KBEngineTypeCodeActionProvider implements vscode.CodeActionProvider {
  /**
   * IDE-NAV-013:未注册类型诊断的修正候选——仅提供已注册类型(内建+
   * types.xml 自定义+实体)的近拼替换编辑(QuickFix),候选与诊断同 code
   * 对账;不自动创建 types.xml 声明(硬边界,没有任何命令型/跨文件动作)。
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const known = getKnownTypeContext(document);
    const registered = [...known.builtins, ...known.customTypes, ...known.entityTypes];
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== UNKNOWN_TYPE_DIAGNOSTIC_CODE) {
        continue;
      }
      if (!diagnosticRangeIntersects(diagnostic.range, range)) {
        continue;
      }
      const unknownName = document.getText(diagnostic.range).trim();
      if (!unknownName) {
        continue;
      }
      for (const candidate of findRegisteredTypeSuggestions(unknownName, registered)) {
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, [new vscode.TextEdit(diagnostic.range, candidate)]);
        const action = new vscode.CodeAction(
          vscode.l10n.t('Replace with registered type {name}', { name: candidate }),
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.edit = edit;
        actions.push(action);
      }
    }
    return actions;
  }
}

/** 诊断区间与请求区间相交(行/列直比,替身 Range 无 intersection 面) */
export function diagnosticRangeIntersects(left: vscode.Range, right: vscode.Range): boolean {
  const positionValue = (position: vscode.Position): number => position.line * 1_000_000 + position.character;
  return positionValue(left.start) <= positionValue(right.end)
    && positionValue(right.start) <= positionValue(left.end);
}

/**
 * IDE-NAV-014:python 类块插入点。类头(`class <名>` 顶格)之后到首个
 * 缩进 <4 的非空行为类体;插入点=类体末非空行下一行(空体=类头下一行,
 * 不加空行前缀,非空体加一空行分隔)。类块找不到返回 null——不猜。
 */
export function findPythonClassInsertionPoint(
  content: string,
  className: string
): { line: number; blankPrefix: boolean } | null {
  const lines = content.split('\n');
  const classRegex = new RegExp(`^class\\s+${className}(\\s|\\(|:|$)`);
  let classLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (classRegex.test(lines[index])) {
      classLine = index;
      break;
    }
  }
  if (classLine < 0) {
    return null;
  }

  let lastBodyLine = classLine;
  for (let index = classLine + 1; index < lines.length; index += 1) {
    const text = lines[index];
    if (!text.trim()) {
      continue;
    }
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    if (indent < 4) {
      break;
    }
    lastBodyLine = index;
  }
  return { line: lastBodyLine + 1, blankPrefix: lastBodyLine > classLine };
}

/** 空方法骨架:def 名(self, 形参自 <Arg> 类型映射) + 体(pass/raise 可配)。
 * C-19 交付②:签名参数从 def 类型映射(内建注解 int/float/str/bool/bytes,
 * 其余裸 argN 不发射未导入名);体经 kbengine.entity.methodStubBody 可配。 */
export function buildPythonMethodSkeleton(
  methodName: string,
  argTypes: string[],
  body: MethodStubBody
): string {
  return buildMethodStubCode(methodName, argTypes, body);
}

export class KBEngineMethodImplementationCodeActionProvider implements vscode.CodeActionProvider {
  /**
   * IDE-NAV-014:缺实现 def 方法的空方法生成。验收口径:已有同名实现
   * (Go to Implementations 同一查询面)不重复生成;动作展示目标文件与
   * 插入点;插入点按目标文件当前文本(打开缓冲区优先)计算;编辑只是
   * 目标脚本内的插入,不建文件、不碰 def;属性段/非 def/取消位空。
   */
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    if (
      document.languageId !== 'kbengine-def' &&
      !document.fileName.toLowerCase().endsWith('.def')
    ) {
      return [];
    }
    const wordRange = document.getWordRangeAtPosition(range.start, /\w+/);
    if (!wordRange) {
      return [];
    }
    const symbolInfo = findDefSymbolInfo(document, range.start, document.getText(wordRange));
    if (!symbolInfo || !METHOD_SECTIONS.has(symbolInfo.section)) {
      return [];
    }
    const ast = parseDefAst(document);
    if (!ast) {
      return [];
    }
    const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
      document.fileName,
      getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
      symbolInfo.symbolNode.name,
      symbolInfo.section as EntityMethodSection
    );
    if (!identity || token?.isCancellationRequested) {
      return [];
    }

    // 已有同名实现:不重复生成(与 Go to Implementations 同一实现查询面)
    const implementations =
      await this.entityMappingManager.listMethodImplementationsByIdentity(identity, token);
    if (token?.isCancellationRequested) {
      return [];
    }
    if (implementations.length > 0) {
      return [];
    }

    const ownerFiles =
      await this.entityMappingManager.listOwnerScriptFilesForIdentity(identity, token);
    if (token?.isCancellationRequested || ownerFiles.length === 0) {
      return [];
    }
    const targetFile = ownerFiles[0];

    const snapshot = readSharedFileSnapshot(targetFile);
    if (!snapshot) {
      return [];
    }
    const insertion = findPythonClassInsertionPoint(snapshot.content, identity.ownerName);
    if (!insertion) {
      return [];
    }

    // C-19 交付②:形参从 def <Arg> 文本映射(与索引 declaredArgs 同源,单一
    // 事实源),体经配置(pass 默认 / raise 可配)。
    const argTypes = getDirectChildElements(symbolInfo.symbolNode)
      .filter(node => node.name === 'Arg')
      .map(node => getElementText(node).trim());
    const skeleton = buildPythonMethodSkeleton(
      symbolInfo.symbolNode.name,
      argTypes,
      getLanguageFeatureConfig().methodStubBody
    );

    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      vscode.Uri.file(targetFile),
      new vscode.Position(insertion.line, 0),
      insertion.blankPrefix ? `\n${skeleton}` : skeleton
    );
    const action = new vscode.CodeAction(
      vscode.l10n.t('Generate empty implementation {name} → {file}:{line}', {
        name: symbolInfo.symbolNode.name,
        file: targetFile,
        line: insertion.line + 1
      }),
      vscode.CodeActionKind.Refactor
    );
    action.edit = edit;
    // C-19 交付②:编辑应用后重算源 def 文档的缺实现诊断(诊断消除)。VS Code
    // 先应用 action.edit 再执行 action.command;命令按 def URI 重排一致性
    // 计算,不依赖 Python 文件是否打开(编辑作用于磁盘文件时事件不必然触发)。
    action.command = {
      command: KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND,
      title: 'Revalidate def method consistency',
      arguments: [document.uri.toString()]
    };
    return [action];
  }
}

/**
 * C-19 def↔Python 一致性诊断 code(单一事实源=defMethodConsistency 的
 * DEF_METHOD_MISSING_DIAGNOSTIC_CODE = Rust lint 规则 id `def-method-missing-in-python`)。
 * KODE-AUD-002:三方(TS producer/Provider CodeAction/Rust lint)同值,否则 CodeAction
 * 严格比较不命中 → 恒空。反向规则(python-method-not-in-def)无 CodeAction 对接口,
 * 不在本对账范围。
 */
export const DEF_PYTHON_PARITY_DIAGNOSTIC_CODE = DEF_METHOD_MISSING_DIAGNOSTIC_CODE;

/**
 * C-19 交付②:def-method-missing-in-python 诊断的一键生成 CodeAction。
 * 仅出现在「def 有 Python 无」方法上(诊断 code 对账),在目标 Python 类
 * 末尾生成方法骨架(签名参数从 def `<Arg>` 类型映射,体默认 raise
 * NotImplementedError,可配 pass);生成后一致性自动重算(诊断消除,走
 * 既有 observeRustDefFindings 重扫)。目标文件取自诊断双向定位面
 * (relatedInformation),与 lint 规则同一解析口径,不重新猜测。
 */
export class KBEngineDefPythonParityCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    if (
      document.languageId !== 'kbengine-def' &&
      !document.fileName.toLowerCase().endsWith('.def')
    ) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== DEF_PYTHON_PARITY_DIAGNOSTIC_CODE) {
        continue;
      }
      if (!diagnosticRangeIntersects(diagnostic.range, range)) {
        continue;
      }
      // 双向定位面:目标 Python 文件 + 类名(lint 规则同一解析口径)。
      const related = diagnostic.relatedInformation?.[0];
      if (!related) {
        continue;
      }
      const targetFile = related.location.uri.fsPath;
      const className = related.message || entityNameOfDefFile(document.fileName);
      const methodName = document.getText(diagnostic.range).trim();
      if (!methodName) {
        continue;
      }
      const dedupeKey = `${targetFile}:${methodName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const argTypes = collectMethodArgTypes(document, methodName);
      const snapshot = readSharedFileSnapshot(targetFile);
      if (!snapshot) {
        continue;
      }
      const insertion = findPythonClassInsertionPoint(snapshot.content, className);
      if (!insertion) {
        continue;
      }
      const skeleton = buildPythonMethodSkeletonWithTypes(methodName, argTypes);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        vscode.Uri.file(targetFile),
        new vscode.Position(insertion.line, 0),
        insertion.blankPrefix ? `\n${skeleton}` : skeleton
      );
      const action = new vscode.CodeAction(
        vscode.l10n.t('Generate method {name} → {file}:{line}', {
          name: methodName,
          file: targetFile,
          line: insertion.line + 1
        }),
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.edit = edit;
      actions.push(action);
    }
    return actions;
  }
}

/**
 * 取 def 文档中同名方法节点的 `<Arg>` 类型序列(签名类型映射输入);
 * 解析不到(属性段同名/位置未落在方法名)→ 空数组(仅 (self) 签名)。
 */
export function collectMethodArgTypes(document: vscode.TextDocument, methodName: string): string[] {
  const ast = parseDefAst(document);
  if (!ast?.root) {
    return [];
  }
  const methodNode = findMethodElementByName(ast.root, methodName);
  if (!methodNode) {
    return [];
  }
  return getDirectChildElements(methodNode)
    .filter(node => node.name === 'Arg')
    .map(getNodeValue);
}

/** DFS 在方法段(BaseMethods/CellMethods/ClientMethods)内找同名方法元素。 */
export function findMethodElementByName(root: DefElementNode, name: string): DefElementNode | null {
  const stack: DefElementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (METHOD_SECTIONS.has(node.name as KBEngineSectionName)) {
      for (const child of node.children) {
        if (child.kind === 'element' && child.name === name) {
          return child;
        }
      }
    }
    for (const child of node.children) {
      if (child.kind === 'element') {
        stack.push(child);
      }
    }
  }
  return null;
}

/**
 * IDE-LINT-012:诊断行上按区间归属取 receiver——扫描 `self.<cell|base|client>.<方法>`
 * 调用,取方法名 token 与诊断区间 `[startChar, endChar)` 相交的那个 receiver;
 * 返回其角色,或 null(区间不覆盖任何 self.<receiver>.<方法>,不猜)。真实诊断
 * 区间紧贴方法名 token(交集即唯一);宽松区间也按第一个相交归属,同行两个
 * 不同 receiver 不会互串。
 */
export function receiverFromDiagnosticLine(
  lineText: string,
  startChar: number,
  endChar: number
): 'cell' | 'base' | 'client' | null {
  const callRe = /\bself\.(cell|base|client)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(lineText)) !== null) {
    const methodStart = match.index + match[0].length - match[2].length;
    const methodEnd = methodStart + match[2].length;
    if (startChar < methodEnd && endChar > methodStart) {
      return match[1] as 'cell' | 'base' | 'client';
    }
  }
  return null;
}

export class KBEngineReceiverNoneGuardCodeActionProvider implements vscode.CodeActionProvider {
  /**
   * B-7(2026-10-29 用户令):receiver-none 诊断的快速修复——使用行之前
   * 插入早退守卫 `if not self.<receiver>:\n    return`(守卫文本由
   * receiverNoneDiagnostics.buildReceiverNoneGuardEdit 纯函数产出,形态即
   * 诊断面自认的 early-exit guard 一族,插入后重算该位不再报)。code 对账
   * kbengine.receiverNone:段错配码/无码诊断不出(路由问题不是判空问题);
   * 接收者从诊断行文本提取(self.<cell|base|client>.),提不出不猜;
   * 同行同码多诊断去重只出一条;只插本文档,无命令型动作。
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== RECEIVER_NONE_DIAGNOSTIC_CODE) {
        continue;
      }
      if (!diagnosticRangeIntersects(diagnostic.range, range)) {
        continue;
      }
      const line = diagnostic.range.start.line;
      // IDE-LINT-012:接收者从诊断锚定的调用取——诊断区间覆盖 `self.<r>.<方法>` 的
      // 方法名 token,同行两个不同 receiver(如 `self.cell.a(); self.base.b()`)时
      // 必须按区间归属取对应 receiver,不能取行首个 self.<r>. 否则会把第一个
      // receiver 的修复错套给第二个的诊断。区间内定位不到 receiver 则不出(不猜)。
      const receiver = receiverFromDiagnosticLine(
        document.lineAt(line).text,
        diagnostic.range.start.character,
        diagnostic.range.end.character
      );
      if (receiver === null) {
        continue;
      }
      const dedupeKey = `${receiver}:${line}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      const text = document.getText();
      const wrap = buildReceiverNoneWrapEdit(text, line, receiver);
      const guard = buildReceiverNoneGuardEdit(text, line, receiver);
      if (!wrap && !guard) {
        continue;
      }
      seen.add(dedupeKey);
      // 包裹式(2026-10-30 用户令):判非 None 后继续,常见操作,首选靠前
      if (wrap) {
        const lines = text.split(/\r?\n/);
        const trailingNewline =
          wrap.endLine < lines.length || (wrap.endLine === lines.length && text.endsWith('\n'));
        const wrapEdit = new vscode.WorkspaceEdit();
        wrapEdit.replace(
          document.uri,
          new vscode.Range(wrap.startLine, 0, wrap.endLine, 0),
          trailingNewline ? `${wrap.text}\n` : wrap.text
        );
        const wrapAction = new vscode.CodeAction(
          vscode.l10n.t('Wrap with null guard (if self.{receiver}:)', { receiver }),
          vscode.CodeActionKind.QuickFix
        );
        wrapAction.diagnostics = [diagnostic];
        wrapAction.edit = wrapEdit;
        actions.push(wrapAction);
      }
      // 早退式:维持既有 B-7 口径,次选
      if (guard) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(guard.line, 0), guard.text);
        const action = new vscode.CodeAction(
          vscode.l10n.t('Insert None guard (if not self.{receiver}: return)', { receiver }),
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.edit = edit;
        actions.push(action);
      }
    }
    return actions;
  }
}

/**
 * C-23(交付②):FIXED_DICT 子键赋值诊断(kbengine.fixedDictNestedMutation)
 * 的快速修复——整行子键赋值改写为整体重赋习语(`_fd = self.<属性>` →
 * `_fd[子键] = 值` → `self.<属性> = _fd`;编辑由 behaviorLints
 * buildFixedDictWholeReassignEdit 纯函数产出,替换后顶层赋值走引擎同步
 * 路径,重算该位不再报)。code 对账:非本码诊断不出;行文本形态不匹配
 * (多语句行/跨行)不出(不猜);只动本文档该行。
 */
export class KBEngineFixedDictWholeReassignCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<number>();
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== FIXED_DICT_NESTED_MUTATION_CODE) {
        continue;
      }
      if (!diagnosticRangeIntersects(diagnostic.range, range)) {
        continue;
      }
      const line = diagnostic.range.start.line;
      if (seen.has(line)) {
        continue;
      }
      const edit = buildFixedDictWholeReassignEdit(document.getText(), line);
      if (!edit) {
        continue;
      }
      seen.add(line);
      const workspaceEdit = new vscode.WorkspaceEdit();
      const lines = document.getText().split(/\r?\n/);
      const trailingNewline = edit.endLine < lines.length;
      workspaceEdit.replace(
        document.uri,
        new vscode.Range(edit.startLine, 0, edit.endLine, 0),
        trailingNewline ? `${edit.text}\n` : edit.text
      );
      const action = new vscode.CodeAction(
        vscode.l10n.t('Whole reassign: rewrite FIXED_DICT sub-key assignment as top-level assignment'),
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.edit = workspaceEdit;
      actions.push(action);
    }
    return actions;
  }
}
