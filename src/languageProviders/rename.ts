// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../entityMapping';
import { computeDefRenameEdits, findDefRenameConflict, findDefRenameConflictInClosure, getLineCharacterAtOffset, renameInputsDrifted, resolveRenameSymbolAtOffset, DefRenameFileEdits, RenameInputVersionRef } from '../defRenamer';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import { PYTHON_RECEIVER_BY_SECTION } from '../pythonLanguageUtils';
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
