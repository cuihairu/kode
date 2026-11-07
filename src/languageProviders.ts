// KODE-ARCH-001 pure-move split from the original languageProviders.ts (zero behavior change).
// KODE-ARCH-001 (in progress): providers are being moved to ./languageProviders/*
// in pure-move steps; this file keeps remaining code + re-exports the moved surface.

import * as path from 'path';
import * as vscode from 'vscode';
import { DefElementNode, getDirectChildElements, getElementText, getLineNumberAt } from './defParser';
import { DEF_METHOD_MISSING_DIAGNOSTIC_CODE, KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND, buildMethodStubCode, type MethodStubBody } from './defMethodConsistency';
import { EntityMappingManager, EntityMethodSection } from './entityMapping';
import { buildPythonMethodSkeletonWithTypes, entityNameOfDefFile } from './defPythonParity';
import { computeDefRenameEdits, findDefRenameConflict, findDefRenameConflictInClosure, getLineCharacterAtOffset, renameInputsDrifted, resolveRenameSymbolAtOffset, DefRenameFileEdits, RenameInputVersionRef } from './defRenamer';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { PYTHON_RECEIVER_BY_SECTION } from './pythonLanguageUtils';
import { RECEIVER_NONE_DIAGNOSTIC_CODE, buildReceiverNoneGuardEdit, buildReceiverNoneWrapEdit } from './receiverNoneDiagnostics';
import { KBEngineSectionName, METHOD_SECTIONS, getLanguageFeatureConfig, getNodeValue, parseDefAst } from './languageProviders/shared';
import { UNKNOWN_TYPE_DIAGNOSTIC_CODE } from './languageProviders/validation';
import { findDefSymbolInfo } from './languageProviders/navigation';
import { findRegisteredTypeSuggestions, getKnownTypeContext } from './languageProviders/completion';

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

export class KBEngineRenameProvider implements vscode.RenameProvider {
  /**
   * .def 属性/方法重命名(重构支持):符号解析与引用编辑计算在 defRenamer
   * 纯模块,这里只做 vscode 值类型的装配。作用域与边界见 defRenamer 头注。
   * IDE-NAV-010:一次重命名手势(输入框从打开到确认)内逐次计算记录输入版本
   * 集合,目标文档版本漂移→拒绝;prepareRename 是手势起点,在此重置记录。
   */
  private lastRenameGestureKey: string | null = null;
  private lastRenameInputs: RenameInputVersionRef[] = [];
  private lastTargetVersion: number | undefined;

  /**
   * IDE-NAV-011:属性重命名要改写已解析的 python self 访问,需注入
   * EntityMappingManager(owner 注册面判定归属);缺省 null 时只出 def 编辑。
   */
  constructor(private entityMappingManager: EntityMappingManager | null = null) {}

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<{ range: vscode.Range; placeholder: string }> {
    // 新手势起点:清掉上一手势的输入版本记录
    this.lastRenameGestureKey = null;
    this.lastRenameInputs = [];
    this.lastTargetVersion = undefined;
    const symbol = resolveRenameSymbolAtOffset(document.getText(), document.offsetAt(position));
    if (!symbol) {
      return null;
    }
    return {
      range: new vscode.Range(
        document.positionAt(symbol.wordStart),
        document.positionAt(symbol.wordEnd)
      ),
      placeholder: symbol.name
    };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token?: vscode.CancellationToken
  ): Promise<vscode.WorkspaceEdit | null> {
    // IDE-AUD-027:捕获起始版本——异步 python 查找在途时输入再变,发布前
    // 复核拒绝,不返回旧区间(NAV-010 只比上一手势,挡不住单次手势内漂移)
    const startVersion = document.version;
    const symbol = resolveRenameSymbolAtOffset(document.getText(), document.offsetAt(position));
    if (!symbol) {
      return null;
    }
    // IDE-NAV-008:目标名冲突先拒——同段方法/属性·组件占名时抛错说明冲突面
    // 与行号(rename 输入框直接展示),不进入编辑计算
    const conflict = findDefRenameConflict(document.getText(), symbol, newName);
    if (conflict) {
      throw new Error(
        `cannot rename to "${newName}": already declared in ${conflict.surface} `
        + `at line ${conflict.line} of ${path.basename(document.fileName)}`
      );
    }
    // IDE-AUD-061(R3-F05):声明文件之外,祖先/后代闭包同声明面占名也拒——
    // 只查声明文件会让"改 Hero.hp→vigor 撞继承者 Monster.vigor"静默通过,
    // 改名后 analyzer 从 0 变 1。冲突位带文件,拒绝信息指出真实位置。
    const closureConflict = findDefRenameConflictInClosure({
      targetFilePath: document.fileName,
      targetText: document.getText(),
      symbol,
      newName,
      readCrossFileContent: filePath => readSharedFileSnapshot(filePath)?.content ?? null
    });
    if (closureConflict) {
      throw new Error(
        `cannot rename to "${newName}": already declared in ${closureConflict.surface} `
        + `at line ${closureConflict.line} of ${path.basename(closureConflict.filePath ?? document.fileName)}`
      );
    }
    const fileEdits = computeDefRenameEdits({
      targetFilePath: document.fileName,
      targetText: document.getText(),
      symbol,
      newName,
      // IDE-NAV-009:跨文件编辑按各文件当前文本(打开文档缓冲区优先)换算
      readCrossFileContent: filePath => readSharedFileSnapshot(filePath)?.content ?? null
    });
    if (fileEdits.length === 0) {
      return null;
    }
    // IDE-NAV-010:同手势内输入漂移——目标文档版本变→拒绝(符号可能已不在
    // 原位,套旧范围会错改);跨文件缓冲区漂移→已按当前文本重算,照常返回
    const gestureKey = `${document.fileName}:${symbol.name}:${symbol.wordStart}`;
    const inputs = this.collectRenameInputs(document, fileEdits);
    if (this.lastRenameGestureKey === gestureKey && renameInputsDrifted(this.lastRenameInputs, inputs)) {
      const targetDrifted = this.lastRenameInputs.length > 0
        && inputs[0].version !== this.lastRenameInputs[0].version;
      if (targetDrifted) {
        throw new Error(
          'cannot apply rename: target document was modified; rename again to recompute'
        );
      }
      // 跨文件漂移:重算已完成,更新输入记录
    }
    this.lastRenameGestureKey = gestureKey;
    this.lastRenameInputs = inputs;
    this.lastTargetVersion = document.version;
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const fileEdit of fileEdits) {
      const uri = path.resolve(fileEdit.filePath) === path.resolve(document.fileName)
        ? document.uri
        : vscode.Uri.file(fileEdit.filePath);
      // 偏移区间相对 fileEdit.text(各文件自己的行表),不能借目标文档换算
      workspaceEdit.set(uri, fileEdit.edits.map(edit => {
        const start = getLineCharacterAtOffset(fileEdit.text, edit.start);
        const end = getLineCharacterAtOffset(fileEdit.text, edit.end);
        return new vscode.TextEdit(
          new vscode.Range(
            new vscode.Position(start.line, start.character),
            new vscode.Position(end.line, end.character)
          ),
          newName
        );
      }));
    }
    // IDE-NAV-011/012:重命名改写已解析的 python 引用——归属由 owner 注册面
    // 决定,无关实体同名(歧义)不在结果里,不猜测;行列已按快照当前文本
    // (打开文档缓冲区优先)计算,每次调用重查,不套旧范围。属性面=NAV-002
    // self 访问;方法面=NAV-003 receiver 调用,调用端 receiver 段与声明段
    // 一致才收(PYTHON_RECEIVER_BY_SECTION),跨段同名不串改。
    if (this.entityMappingManager) {
      const accesses = symbol.kind === 'property'
        ? await this.entityMappingManager.getIncomingPythonPropertyAccesses(
          document.fileName,
          symbol.name
        )
        : symbol.section && PYTHON_RECEIVER_BY_SECTION[symbol.section]
          ? await this.entityMappingManager.getIncomingPythonReceiverCalls(
            document.fileName,
            symbol.name,
            PYTHON_RECEIVER_BY_SECTION[symbol.section]
          )
          : [];
      // IDE-AUD-027 复核(异步查找结束后,不只比上一手势):
      // ① 手势取消 → 不发布晚到编辑(编辑器已放弃本次重命名)
      if (token?.isCancellationRequested) {
        return null;
      }
      // ② 目标文档在异步查找期间被编辑 → 拒绝(旧区间按旧文本算,套到
      //    新版本会错改;NAV-010 的版本检查在 await 之前,挡不住此面)
      if (document.version !== startVersion) {
        throw new Error(
          'cannot apply rename: target document was modified; rename again to recompute'
        );
      }
      // ③ 依赖 def(跨文件编辑)在异步期间变化 → 拒绝(不套旧行)
      const postInputs = this.collectRenameInputs(document, fileEdits);
      if (renameInputsDrifted(inputs.slice(1), postInputs.slice(1))) {
        throw new Error(
          'cannot apply rename: referenced files changed; rename again to recompute'
        );
      }
      // ④ python 源文件在异步期间变化 → 访问位置失效,拒绝(不发布旧区间)
      if (this.pythonAccessesDrifted(accesses, symbol.name)) {
        throw new Error(
          'cannot apply rename: python files changed; rename again to recompute'
        );
      }
      const pythonEditsByFile = new Map<string, vscode.TextEdit[]>();
      for (const access of accesses) {
        const list = pythonEditsByFile.get(access.filePath) ?? [];
        list.push(new vscode.TextEdit(
          new vscode.Range(
            new vscode.Position(access.line - 1, access.character),
            new vscode.Position(access.line - 1, access.character + symbol.name.length)
          ),
          newName
        ));
        pythonEditsByFile.set(access.filePath, list);
      }
      for (const [filePath, edits] of pythonEditsByFile) {
        workspaceEdit.set(vscode.Uri.file(filePath), edits);
      }
    }
    return workspaceEdit;
  }

  /**
   * IDE-AUD-027:python 访问位置复核——异步查找后重读共享快照,访问位置
   * 不再指向 self.<name>(行漂移/内容改)即输入在途已变,拒绝不发布旧区间;
   * 内容未变(无关处编辑)位置仍有效,照常返回(编辑范围本就正确)。
   */
  private pythonAccessesDrifted(
    accesses: ReadonlyArray<{ filePath: string; line: number; character: number }>,
    name: string
  ): boolean {
    for (const access of accesses) {
      const snapshot = readSharedFileSnapshot(access.filePath);
      // 文件消失:输入面变了,不能安全改写
      if (!snapshot) {
        return true;
      }
      const line = snapshot.content.split('\n')[access.line - 1];
      // 行漂移(插入/删除)或内容改:该位置不再持有 self.<name>
      if (!line || line.slice(access.character, access.character + name.length) !== name) {
        return true;
      }
    }
    return false;
  }

  /**
   * IDE-NAV-010:本次计算消费的输入版本引用——目标文档(首条)为文档版本,
   * 各跨文件编辑文件为快照 {source,version}(document=编辑序号,disk=mtimeMs)。
   */
  private collectRenameInputs(
    document: vscode.TextDocument,
    fileEdits: DefRenameFileEdits[]
  ): RenameInputVersionRef[] {
    const refs: RenameInputVersionRef[] = [
      {
        filePath: path.resolve(document.fileName),
        source: 'document',
        version: typeof document.version === 'number' ? document.version : undefined
      }
    ];
    for (const fileEdit of fileEdits) {
      if (path.resolve(fileEdit.filePath) === path.resolve(document.fileName)) {
        continue;
      }
      const snapshot = readSharedFileSnapshot(fileEdit.filePath);
      refs.push({
        filePath: path.resolve(fileEdit.filePath),
        source: snapshot?.source ?? 'disk',
        version: snapshot?.version
      });
    }
    return refs;
  }
}

export { EventCodeLensProvider } from './eventApi';
export { RECEIVER_NONE_DIAGNOSTIC_CODE } from './receiverNoneDiagnostics';
export { KbengineSourceRevealArgs, revealSourceCommand, prewarmKbengineIndex } from './languageProviders/reveal';
export { validateDocument, validateEntitiesXmlDocument, UNKNOWN_TYPE_DIAGNOSTIC_CODE } from './languageProviders/validation';
export { KBEngineCompletionProvider, findRegisteredTypeSuggestions, PythonCompletionProvider } from './languageProviders/completion';
export { KBEngineBuiltinTypeInlayHintsProvider } from './languageProviders/inlay';
export { HoverPhaseTimer, setHoverInFlightGateForTests, KBEngineHoverProvider, KBEngineSignatureHelpProvider, describeTypeStorageShape } from './languageProviders/hover';
export { KBEngineDefinitionProvider, resolvePropertyLandingLine } from './languageProviders/navigation';
export { setPythonMroJumpEnabled, isPythonMroJumpEnabled, setPythonDataDictIndexEnabled, isPythonDataDictIndexEnabled, getPythonDataDictIndexGeneration, JumpLayerTrace, TracedDefinitionResult, setDefinitionInFlightGateForTests, setDefinitionDispatchGateForTests, PythonDefinitionProvider } from './languageProviders/pythonDefinition';
export { RpcCodeLensProvider, createDefinitionSelection, PropertyCodeLensProvider, TypesXmlStorageLensSpec, buildTypesXmlStorageLensSpecs, TypesXmlCodeLensProvider } from './languageProviders/codeLens';
export { KBEngineCallHierarchyProvider } from './languageProviders/callHierarchy';
export { KBEngineReferencesProvider, KBEngineDocumentSymbolProvider, KBEngineWorkspaceSymbolProvider, KBEngineImplementationProvider } from './languageProviders/references';
