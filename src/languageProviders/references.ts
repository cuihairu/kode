// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parsePythonFile, isPythonCodePosition } from '../backend/pythonClassIndex';
import { DefElementNode, getLineNumberAt } from '../backend/defParser';
import { EntityMappingManager, EntityMethodSection } from '../entityMapping';
import { provideTypesXmlReferences } from '../typesXmlReferences';
import { provideDefSymbolReferences } from '../defSymbolReferences';
import { PYTHON_RECEIVER_BY_SECTION, getPythonSelfAccessAtPosition } from '../backend/pythonLanguageUtils';
import { GlobalDataDictIndex, isKeyInsideLineComment } from '../globalDataIndex';
import { DEF_SYMBOL_SECTIONS, METHOD_SECTIONS, elementFullRange, elementTagRange, parseDefAst, toSectionName } from './shared';
import { findDefSymbolInfo } from './navigation';
import { resolveDataDictSitesAtPosition, resolveSpaceDataSitesAtPosition } from './pythonDefinition';
import { isSpaceDataIndexEnabled } from '../spaceDataIndex';
import { createSelectionRange } from './callHierarchy';
import { cellScriptRoleAndEntity, collectCellDataDefUniverseWithCategory, fetchCellDataKeys } from '../backend/cellDataCompletion';
import { cellDataKeyAccessAtPosition, isCellDataKeyInsideLineComment, scanCellDataKeyAccesses } from '../backend/cellDataKeyAccess';
import { findEntityScriptFile, findDefinitionFileByCategory } from '../definitionWorkspace';
import { buildDefProcessBreadcrumb } from '../backend/processOwnershipLens';
import { serveDocumentSymbolsFromRust } from '../backend/kodeCoreShadowFaces';
import type { LspDocumentSymbolFace } from '../backend/kodeCoreShadowFaces';

/**
 * Rust 段符号 kind 字符串面 → vscode.SymbolKind(投影细节,协议数值映射)。
 * 惰性函数而非模块级查表:模块作用域不得触碰 vscode API(UMD 运行时
 * require 泄漏,bundle 装载即红)。
 */
function symbolKindByName(kind: LspDocumentSymbolFace['kind']): vscode.SymbolKind {
  switch (kind) {
    case 'Struct':
      return vscode.SymbolKind.Struct;
    case 'Class':
      return vscode.SymbolKind.Class;
    case 'Field':
      return vscode.SymbolKind.Field;
    default:
      return vscode.SymbolKind.Method;
  }
}
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
      // KSEM-DATA-06:spaceData 键 Shift+F12 → 同 (spaceID, key) 族全部站点
      // (set/get/del,含自身)。词法掩码在纯核内已剔注释/字符串伪调用;
      // 动态 spaceID/非字面量键不建族不列(动态空间不合并)。
      if (isSpaceDataIndexEnabled()) {
        const spaceHit = await resolveSpaceDataSitesAtPosition(document, position, token);
        if (spaceHit) {
          return spaceHit.sites.map(site =>
            new vscode.Location(
              vscode.Uri.file(site.file),
              new vscode.Position(site.line, site.keyStart)
            ));
        }
      }
      // KSEM-CELL-05:cellData 字符串键 Shift+F12 → 当前实体脚本(cell/base
      // 面)内同键全部字面量访问点(含自身)。实体身份隔离:仅扫当前实体
      // 自身脚本,不跨实体/不混入无关实体;未知键(键宇宙无此键)→ 交回
      // 下方属性链(如实,不伪造声明);内建键是引擎自塞面,脚本内同键
      // 访问仍可列出(引用面如实)。
      const cellRefLine = document.lineAt(position.line).text;
      const cellRefHit = cellDataKeyAccessAtPosition(cellRefLine, position.character);
      if (cellRefHit && !isCellDataKeyInsideLineComment(cellRefLine, cellRefHit.keyStart)) {
        const cellRole = cellScriptRoleAndEntity(document.fileName);
        if (cellRole) {
          const cellDefs = collectCellDataDefUniverseWithCategory(cellRole.entity, (name, category) => {
            const filePath = findDefinitionFileByCategory(name, category, document);
            if (!filePath) {
              return null;
            }
            try {
              return fs.readFileSync(filePath, 'utf8');
            } catch {
              return null; // 读失败 = 缺席贡献,不猜
            }
          });
          const cellKeys = await fetchCellDataKeys(cellRole.entity, cellDefs);
          if (token?.isCancellationRequested) {
            return null;
          }
          if (cellKeys && cellKeys.some(entry => entry.key === cellRefHit.key)) {
            const scriptPath = findEntityScriptFile(cellRole.entity, cellRole.role, document);
            if (scriptPath) {
              const sameFile = path.resolve(scriptPath) === path.resolve(document.fileName);
              let scriptText: string | null;
              if (sameFile) {
                scriptText = document.getText();
              } else {
                try {
                  scriptText = fs.readFileSync(scriptPath, 'utf8');
                } catch {
                  scriptText = null;
                }
              }
              if (scriptText !== null) {
                const sites = scanCellDataKeyAccesses(scriptText);
                return sites
                  .filter(site => site.key === cellRefHit.key)
                  .map(site =>
                    new vscode.Location(
                      vscode.Uri.file(scriptPath),
                      new vscode.Position(site.line, site.keyStart)
                    ));
              }
            }
          }
        }
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
 *
 * PROC-BREADCRUMB-001(2026-11-18):方法段在场时头部插合成根节点
 * 「实体名 · 进程段全列」(Namespace,锚定段带▸排首位),原段符号收编为
 * 其 children 之后的子树(Outline/面包屑单源同现);children 前缀=非锚定
 * 进程段(Event),锚点=本文件对应 def 区块(跨文件跳转 DocumentSymbol 无
 * command 面的诚实降级),detail 携对端 py 路径与 openCell/openBase 提示。
 */
export class KBEngineDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  async provideDocumentSymbols(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[] | null> {
    const ast = parseDefAst(document);
    if (!ast || !ast.root) {
      return null;
    }
    // RUST-139 批 3 接线:段符号面先走 Rust(kode-server
    // textDocument/documentSymbol);命中即用,未命中(null=非服务轨道/文档
    // 未入库/解析无根/任何失败)回 TS 既有逐点实现(同构口径)。面包屑合成根
    // 仍是 TS 投影层职责(Rust 面恒不含合成根)。
    const rustSections = await serveDocumentSymbolsFromRust(
      document,
      () => token?.isCancellationRequested === true
    );
    const { symbols, methodSections } =
      rustSections !== null
        ? rustSectionSymbols(document, rustSections)
        : tsSectionSymbols(document, ast.root);
    const breadcrumb = buildDefProcessBreadcrumb(
      document.fileName,
      methodSections,
      candidate => fs.existsSync(candidate)
    );
    if (!breadcrumb) {
      return symbols;
    }
    const fileHead = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    // 全文档 range 经 positionAt 换算(真 API 与测试替身同面;lineCount 替身缺)
    const fullDocument = new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length)
    );
    const root = new vscode.DocumentSymbol(
      breadcrumb.name,
      `进程段全列:${breadcrumb.processes.join(' · ')}(▸=锚定段=文档序首段)。
子节点=非锚定进程段:点击跳本文件对应区块;对端实现文件与 base↔cell 快捷
键切换(ctrl+alt+shift+b/c=kbengine.processOwnership.openCell/openBase)见各子节点 detail。`,
      vscode.SymbolKind.Namespace,
      fullDocument,
      fileHead
    );
    root.children = [
      ...breadcrumb.children.map(child => {
        const anchorRange = child.anchor
          ? new vscode.Range(
              new vscode.Position(child.anchor.startLine, 0),
              new vscode.Position(child.anchor.endLine, 0)
            )
          : fullDocument;
        return new vscode.DocumentSymbol(
          child.process,
          child.section
            ? `${child.process} 段区块在本文件(${child.section});对端实现:${
                child.siblingPath ?? '未找到同名 py 文件'
              };base↔cell 可用快捷键 ctrl+alt+shift+b/c 切换`
            : child.siblingPath ?? '',
          vscode.SymbolKind.Event,
          anchorRange,
          anchorRange
        );
      }),
      ...symbols
    ];
    return [root];
  }
}

/** 段符号装配产物:Outline 段符号 + 方法段跨度账(面包屑用) */
interface DefSectionSymbols {
  symbols: vscode.DocumentSymbol[];
  methodSections: Array<{ section: string; startLine: number; endLine: number }>;
}

/** TS 逐点实现:ast 段容器 + 段内直接成员(IDE-NAV-005 原口径) */
function tsSectionSymbols(document: vscode.TextDocument, root: DefElementNode): DefSectionSymbols {
  const symbols: vscode.DocumentSymbol[] = [];
  const methodSections: DefSectionSymbols['methodSections'] = [];
  for (const child of root.children) {
    if (child.kind !== 'element') {
      continue;
    }
    const sectionName = toSectionName(child.name);
    if (!sectionName || !DEF_SYMBOL_SECTIONS.has(sectionName)) {
      continue;
    }
    const isProperties = sectionName === 'Properties';
    const fullRange = elementFullRange(document, child);
    if (!isProperties) {
      methodSections.push({
        section: sectionName,
        startLine: fullRange.start.line,
        endLine: fullRange.end.line
      });
    }
    const sectionSymbol = new vscode.DocumentSymbol(
      sectionName,
      '',
      isProperties ? vscode.SymbolKind.Struct : vscode.SymbolKind.Class,
      fullRange,
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
  return { symbols, methodSections };
}

/** LSP 位置面 → vscode.Position(Rust 列域 = UTF-16 code unit,与 positionAt 同语义) */
function toPosition(position: { line: number; character: number }): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

/** Rust 段符号面投影:kind 字符串 → vscode.SymbolKind,区间逐面透传 */
function rustSectionSymbols(
  document: vscode.TextDocument,
  faces: LspDocumentSymbolFace[]
): DefSectionSymbols {
  const toSymbol = (face: LspDocumentSymbolFace): vscode.DocumentSymbol =>
    new vscode.DocumentSymbol(
      face.name,
      face.detail,
      symbolKindByName(face.kind),
      new vscode.Range(toPosition(face.range.start), toPosition(face.range.end)),
      new vscode.Range(toPosition(face.selectionRange.start), toPosition(face.selectionRange.end))
    );
  const symbols = faces.map(face => {
    const symbol = toSymbol(face);
    symbol.children = face.children.map(toSymbol);
    return symbol;
  });
  // 方法段 = Class 容器(Properties 恒 Struct,四段面里二者互斥)。
  const methodSections = symbols
    .filter(symbol => symbol.kind === vscode.SymbolKind.Class)
    .map(symbol => ({
      section: symbol.name,
      startLine: symbol.range.start.line,
      endLine: symbol.range.end.line
    }));
  return { symbols, methodSections };
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
