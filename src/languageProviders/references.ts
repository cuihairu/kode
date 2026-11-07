// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { parsePythonFile, isPythonCodePosition } from '../pythonClassIndex';
import { DefElementNode, getLineNumberAt } from '../defParser';
import { EntityMappingManager, EntityMethodSection } from '../entityMapping';
import { provideTypesXmlReferences } from '../typesXmlReferences';
import { provideDefSymbolReferences } from '../defSymbolReferences';
import { PYTHON_RECEIVER_BY_SECTION, getPythonSelfAccessAtPosition } from '../pythonLanguageUtils';
import { GlobalDataDictIndex, isKeyInsideLineComment } from '../globalDataIndex';
import { DEF_SYMBOL_SECTIONS, METHOD_SECTIONS, elementFullRange, elementTagRange, parseDefAst, toSectionName } from './shared';
import { findDefSymbolInfo } from './navigation';
import { resolveDataDictSitesAtPosition } from './pythonDefinition';
import { createSelectionRange } from './callHierarchy';
/**
 * IDE-NAV-001:def 原生引用查询入口(Shift+F12)。引用结果复用统一符号
 * 身份——与调用层级 prepare 完全同链(findDefSymbolInfo →
 * resolveDefinitionSymbolAtPosition → resolveMethodImplementationByIdentity),
 * 解析到 python 实现后经 getIncomingPythonMethodCalls 出调用点,不另起
 * 名字搜索。本批收方法段;属性 self 访问(NAV-002)与 receiver RPC
 * (NAV-003)在引用收录面上后续批扩展。
 */
export class KBEngineReferencesProvider implements vscode.ReferenceProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    // GLOBDATA-001:数据字典键索引(单例);python 文档分支查同键族全量写+读点
    private dataDictIndex?: GlobalDataDictIndex
  ) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    // GLOBDATA-001:python 文档——落点在数据字典键表达式上时,返回同键族
    // 全部写+读点(含自身);不在键上或索引未装配交回 null(无 .def 面)。
    if (document.languageId === 'python' || document.fileName.toLowerCase().endsWith('.py')) {
      const hit = await resolveDataDictSitesAtPosition(this.dataDictIndex, document, position, token);
      if (hit && !isKeyInsideLineComment(document.lineAt(position.line).text, hit.access.keyStart)) {
        return hit.sites.map(site =>
          new vscode.Location(
            vscode.Uri.file(site.file),
            new vscode.Position(site.line, site.keyStart)
          ));
      }
      // 2026-11-04 用户反馈:py 侧 self.<属性> 的 Shift+F12(含 Shift+Alt+F12,
      // 同一 ReferenceProvider)此前无条件 null——补 def 声明 + py 使用处;
      // 非 self 属性访问/未解析到 def 归属时如实 null(调用方约定)。
      return this.providePythonPropertyReferences(
        document,
        position,
        context.includeDeclaration === true,
        token
      );
    }
    // IDE-NAV-017:types.xml 符号引用查询(Shift+F12)——光标在类型符号上时
    // 返回工作区 .def/<Type>/<Arg>/<of> 值使用处与 types.xml 内引用位;
    // 不在类型符号上/空结果如实 null(调用方约定)。
    if (document.fileName.endsWith('types.xml')) {
      return provideTypesXmlReferences(document, position, token);
    }
    if (
      document.languageId !== 'kbengine-def' &&
      !document.fileName.toLowerCase().endsWith('.def')
    ) {
      return null;
    }
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }
    const word = document.getText(range);
    const symbolInfo = findDefSymbolInfo(document, position, word);
    if (!symbolInfo) {
      // IDE-NAV-018:类型名/实体名/接口名不在 Properties/方法段,findDefSymbolInfo
      // 不识别(返回 null)——交由 defSymbolReferences 补查(自定义类型/实体
      // Parent/Type/Interface 引用位);非此类符号时其内部解析同样如实 null。
      return provideDefSymbolReferences(
        document,
        position,
        context.includeDeclaration === true,
        token
      );
    }
    // 引用 API 补项:includeDeclaration 支配「是否把精确声明(def 内该符号的
    // 名字范围)计入结果」——true 时前置声明,false 时不含;实现(Python def)
    // 与调用点都不当声明。声明在 def 文档,引用位在 .py,天然不重复。
    const declarationLocation = new vscode.Location(document.uri, range);
    const includeDeclaration = context.includeDeclaration === true;
    // IDE-NAV-002:属性段 self 访问——归属由 owner 注册面决定
    // (getIncomingPythonPropertyAccesses 只扫本 def 的 owner 文件),
    // 无关实体同名属性不进来;方法调用不带括号断言,不混入。
    if (symbolInfo.section === 'Properties') {
      const accesses = await this.entityMappingManager.getIncomingPythonPropertyAccesses(
        document.fileName,
        symbolInfo.symbolNode.name,
        token
      );
      if (token?.isCancellationRequested) {
        return null;
      }
      const locations = accesses.map(access =>
        new vscode.Location(
          vscode.Uri.file(access.filePath),
          createSelectionRange(access.line, access.character, symbolInfo.symbolNode.name)
        ));
      return includeDeclaration ? [declarationLocation, ...locations] : locations;
    }
    if (!METHOD_SECTIONS.has(symbolInfo.section)) {
      return null;
    }
    const ast = parseDefAst(document);
    if (!ast) {
      return null;
    }
    const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
      document.fileName,
      getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
      symbolInfo.symbolNode.name,
      symbolInfo.section as EntityMethodSection
    );
    if (!identity || token?.isCancellationRequested) {
      return null;
    }
    const implementation =
      await this.entityMappingManager.resolveMethodImplementationByIdentity(identity);
    if (token?.isCancellationRequested) {
      return null;
    }
    // IDE-NAV-003:receiver RPC 调用按段收录——CellMethods 配 self.cell.X(、
    // BaseMethods 配 self.base.X(、ClientMethods 配 self.client.X(,同名方法
    // 跨段互不串账;纯声明方法(无 python 实现)也有 receiver 引用面。
    const receiver =
      PYTHON_RECEIVER_BY_SECTION[symbolInfo.section as EntityMethodSection];
    const receiverCalls = receiver
      ? await this.entityMappingManager.getIncomingPythonReceiverCalls(
          document.fileName,
          symbolInfo.symbolNode.name,
          receiver,
          token
        )
      : [];
    if (token?.isCancellationRequested) {
      return null;
    }
    const receiverLocations = receiverCalls.map(call =>
      new vscode.Location(
        vscode.Uri.file(call.filePath),
        createSelectionRange(call.line, call.character, symbolInfo.symbolNode.name)
      ));
    if (!implementation) {
      if (receiverLocations.length > 0) {
        return includeDeclaration ? [declarationLocation, ...receiverLocations] : receiverLocations;
      }
      // 无实现且无调用:includeDeclaration=true 时声明本身仍是合法引用位。
      return includeDeclaration ? [declarationLocation] : null;
    }
    const calls = await this.entityMappingManager.getIncomingPythonMethodCalls(
      implementation.filePath,
      symbolInfo.symbolNode.name,
      token
    );
    if (token?.isCancellationRequested) {
      return null;
    }
    const locations = [
      ...calls.map(call =>
        new vscode.Location(
          vscode.Uri.file(call.caller.filePath),
          createSelectionRange(call.callLine, call.callCharacter, symbolInfo.symbolNode.name)
        )),
      ...receiverLocations
    ];
    return includeDeclaration ? [declarationLocation, ...locations] : locations;
  }

  /**
   * 2026-11-04 用户反馈:py 侧 self.<属性> 的引用收录(Shift+F12 / Shift+Alt+F12,
   * 同一 ReferenceProvider)。光标落在简单 self.<prop>(单段)上时,按 F12 层1
   * 同口径探针解析属性归属(对象级→文件级),命中后返回 def 属性声明行
   * (includeDeclaration)与 owner 文件里全部 self.<prop> 使用处;不在 self 属性
   * 访问上/未解析到归属 → 如实 null(调用方约定)。
   */
  private async providePythonPropertyReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    includeDeclaration: boolean,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    // 与 F12 层同口径:注释/字符串里的伪 self 访问不作属性引用(4546 守卫)
    if (!isPythonCodePosition(document.getText(), position.line, position.character)) { return null; }
    const access = getPythonSelfAccessAtPosition(
      document.lineAt(position.line).text,
      position.character
    );
    if (!access) { return null; }
    // 只认简单 self.<prop>(单段);接收者段(self.cell.x 等)交回方法/接收者面
    if (access.fullPath.includes('.')) { return null; }
    // 对象级(类粒度)探针优先,文件级兜底(与 F12 层1 同口径)。
    let hit: { defFile: string; line: number } | null = null;
    const enclosing = enclosingPythonClassAt(document, position.line);
    if (enclosing) {
      try {
        hit = await this.entityMappingManager.resolvePropertyDefinitionForClass(
          enclosing,
          access.fullPath,
          access.rootSymbol,
          document.fileName
        );
      } catch {
        hit = null;
      }
    }
    if (!hit) {
      try {
        hit = await this.entityMappingManager.resolvePropertyDefinition(
          document.fileName,
          access.fullPath,
          access.rootSymbol
        );
      } catch {
        return null;
      }
    }
    if (!hit || token?.isCancellationRequested) { return null; }
    const accesses = await this.entityMappingManager.getIncomingPythonPropertyAccesses(
      hit.defFile,
      access.currentSymbol,
      token
    );
    if (token?.isCancellationRequested) { return null; }
    const locations = accesses.map(accessSite =>
      new vscode.Location(
        vscode.Uri.file(accessSite.filePath),
        createSelectionRange(accessSite.line, accessSite.character, access.currentSymbol)
      ));
    if (includeDeclaration) {
      locations.unshift(
        new vscode.Location(vscode.Uri.file(hit.defFile), new vscode.Position(hit.line - 1, 0))
      );
    }
    return locations.length ? locations : null;
  }
}

/** 光标所在最内层 Python 类名(供对象级探针);解析失败 → undefined */
export function enclosingPythonClassAt(document: vscode.TextDocument, line: number): string | undefined {
  try {
    const parsed = parsePythonFile(document.getText(), document.fileName);
    return parsed.classes
      .filter(cls => line >= cls.startLine && line < cls.endLine)
      .sort((left, right) => right.startLine - left.startLine)[0]?.name;
  } catch {
    return undefined;
  }
}

/**
 * IDE-NAV-005:def 文档符号(Outline):Properties/三方法段作容器
 * (Properties=Struct,方法段=Class),段内声明作子符号(属性=Field,方法=
 * Method)。精确范围:range=元素全跨度(开标签到闭标签,selfClosing 到开
 * 标签尾),selectionRange=名字所在开标签跨度(⊆ range);只出在场段,
 * 非符号段(Parent/Interfaces/Components/Volatile)不进 Outline。
 */
export class KBEngineDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  async provideDocumentSymbols(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[] | null> {
    const ast = parseDefAst(document);
    if (!ast || !ast.root) {
      return null;
    }

    const symbols: vscode.DocumentSymbol[] = [];
    for (const child of ast.root.children) {
      if (child.kind !== 'element') {
        continue;
      }
      const sectionName = toSectionName(child.name);
      if (!sectionName || !DEF_SYMBOL_SECTIONS.has(sectionName)) {
        continue;
      }
      const isProperties = sectionName === 'Properties';
      const sectionSymbol = new vscode.DocumentSymbol(
        sectionName,
        '',
        isProperties ? vscode.SymbolKind.Struct : vscode.SymbolKind.Class,
        elementFullRange(document, child),
        elementTagRange(document, child)
      );
      sectionSymbol.children = child.children
        .filter((member): member is DefElementNode => member.kind === 'element')
        .map(member => new vscode.DocumentSymbol(
          member.name,
          '',
          isProperties ? vscode.SymbolKind.Field : vscode.SymbolKind.Method,
          elementFullRange(document, member),
          elementTagRange(document, member)
        ));
      symbols.push(sectionSymbol);
    }
    return symbols;
  }
}

/**
 * IDE-NAV-006:根范围工作区符号查询(Ctrl+T)——已索引 def 符号按名称前缀
 * 查询,manager.searchDefSymbolsByPrefix 只读内存索引,查询面不触发全仓
 * 扫描;containerName 带 root/段信息(方法=`root · 段`,属性=root),
 * location 指向 def 声明行。
 */
export class KBEngineWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideWorkspaceSymbols(
    query: string,
    token?: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[] | null> {
    if (token?.isCancellationRequested) {
      return null;
    }
    const hits = this.entityMappingManager.searchDefSymbolsByPrefix(query, token);
    if (token?.isCancellationRequested) {
      return null;
    }
    return hits.map(hit => new vscode.SymbolInformation(
      hit.symbolName,
      hit.kind === 'property' ? vscode.SymbolKind.Field : vscode.SymbolKind.Method,
      hit.section ? `${hit.rootName} · ${hit.section}` : hit.rootName,
      new vscode.Location(
        vscode.Uri.file(hit.defFile),
        new vscode.Position(Math.max(0, hit.line - 1), 0)
      )
    ));
  }
}

/**
 * IDE-NAV-007:def 方法到 Python 的实现查询(Go to Implementations)——
 * 统一符号身份链(与引用/调用层级同源:findDefSymbolInfo →
 * resolveDefinitionSymbolAtPosition)后经 listMethodImplementationsByIdentity
 * 出实现列表;属性段与非 def 文档不接管,取消位 null。
 */
export class KBEngineImplementationProvider implements vscode.ImplementationProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    if (
      document.languageId !== 'kbengine-def' &&
      !document.fileName.toLowerCase().endsWith('.def')
    ) {
      return null;
    }
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }
    const symbolInfo = findDefSymbolInfo(document, position, document.getText(range));
    if (!symbolInfo || !METHOD_SECTIONS.has(symbolInfo.section)) {
      return null;
    }
    const ast = parseDefAst(document);
    if (!ast) {
      return null;
    }
    const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
      document.fileName,
      getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
      symbolInfo.symbolNode.name,
      symbolInfo.section as EntityMethodSection
    );
    if (!identity || token?.isCancellationRequested) {
      return null;
    }
    const implementations =
      await this.entityMappingManager.listMethodImplementationsByIdentity(identity, token);
    if (token?.isCancellationRequested) {
      return null;
    }
    return implementations.map(implementation => new vscode.Location(
      vscode.Uri.file(implementation.filePath),
      new vscode.Position(Math.max(0, implementation.line - 1), implementation.character)
    ));
  }
}
