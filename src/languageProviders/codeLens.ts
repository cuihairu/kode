// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { getDirectChildElements, getLineNumberAt, parseDefDocument } from '../backend/defParser';
import { EntityMappingManager } from '../entityMapping';
import { buildRpcCodeLenses, defaultRpcCodeLensTitle, findPythonMethodDeclarations, RpcMethodHit } from '../backend/rpcCodeLens';
import { buildPropertyCodeLenses, findPythonSelfPropertyAccesses, propertyAccessKey, PropertyCodeLensHit } from '../backend/propertyCodeLens';
import { buildPropertyInitOrderLensSpecs } from '../backend/propertyInitOrderLens';
import { getTypeStorageUsageIndexReadOnly, indexTypeStorageUsageEntries, onTypeStorageUsageIndexPublished, TypeStorageUsage } from '../databaseSchema';
import { findEntityDefinitionFile, getDefinitionWorkspaceLayout, getWorkspaceRootForDocument, resolveEntityAnnotationType } from '../definitionWorkspace';
import { getLineCharacterAtOffset } from '../backend/defRenamer';
import { findPythonReceiverCalls } from '../backend/pythonLanguageUtils';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../sourceRevealCommand';
import { getLanguageFeatureConfig } from './shared';
export class RpcCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private entityMappingManager: EntityMappingManager) {}

  // 批154(用户令 CodeLens/Hover「按功能拆分,每枚独立开关」):RPC 镜链
  // 一枚独立开关(kbengine.codeLens.rpc),关只熄这一类,不牵连事件回调/
  // 属性/types.xml 各自的镜链;开关变更由 extension 配置监听 fire 即时生效
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !getLanguageFeatureConfig().codeLensRpc) {
      return [];
    }
    const declarations = findPythonMethodDeclarations(document.getText());

    // 同名方法只解析一次:闭包脚本里同名方法可能重复出现,而解析结果
    // (是否 def 声明 + 声明位置)与方法名一一对应,按名缓存无歧义
    const hits = new Map<string, RpcMethodHit>();
    // def 声明的 <Arg> 类型序列(按方法名;未声明为 undefined,不作闸门)
    const declaredArgTypesByName = new Map<string, string[]>();
    for (const declaration of declarations) {
      if (cancelled()) return [];
      if (hits.has(declaration.methodName)) {
        continue;
      }
      const location = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      );
      if (cancelled()) return [];
      if (location) {
        hits.set(declaration.methodName, {
          methodName: declaration.methodName,
          section: location.section,
          defFile: location.defFile,
          defLine: location.line,
          exposed: location.exposed
        });
        if (location.declaredArgs && location.declaredArgs.length > 0) {
          declaredArgTypesByName.set(declaration.methodName, location.declaredArgs);
        }
      }
    }

    // 形参闸门(用户令:只凭名字标 RPC 不严谨):def 声明了 <Arg> 时,被标
    // lens 的 python def 行形参个数必须相等、有注解的按内建映射对上类型,
    // 不符则该行不出 lens;未声明 <Arg> 维持现状。闸门本体与全项目回退
    // 扫描同源(EntityMappingManager.pythonSignatureMatchesDeclaredArgs)。
    const documentLines = document.getText().split(/\r?\n/);
    // 形参闸与 hover 同链(用户令 2026-10-21):注解按统一解析链对账
    const lensWorkspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(lensWorkspaceRoot ?? '', raw);
    const gatedDeclarations = declarations.filter(declaration => {
      const declaredArgTypes = declaredArgTypesByName.get(declaration.methodName);
      if (!declaredArgTypes) {
        return true;
      }
      return EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        declaredArgTypes,
        documentLines,
        declaration.line,
        resolveAnnotation
      );
    });

    const rpcLenses = buildRpcCodeLenses(gatedDeclarations, methodName => hits.get(methodName)).map(spec =>
      new vscode.CodeLens(
        new vscode.Range(
          new vscode.Position(spec.declaration.line, spec.declaration.character),
          new vscode.Position(
            spec.declaration.line,
            spec.declaration.character + spec.hit.methodName.length
          )
        ),
        {
          title: spec.title,
          command: KBENGINE_SOURCE_REVEAL_COMMAND,
          arguments: [
            vscode.Uri.file(spec.hit.defFile),
            { selection: createDefinitionSelection(spec.hit.defLine) }
          ]
        }
      )
    );

    // 接收者感知(用户令 2026-10-21):self.cell./self.base./self.client. 调用行
    // 的 RPC 镜。段过滤在解析内先行(resolveMethodDefinition 第三参,只留对应
    // 区块的 def 候选)——段不符解析落空,不出镜;段符合照常出镜、点击跳声明。
    // 形参闸不适用调用行(闸门本体对账的是 def 声明行签名)。
    // kbengine.entity.receiverSections=false 时不出接收者镜。
    const receiverLenses: vscode.CodeLens[] = [];
    const receiverCalls = getLanguageFeatureConfig().entityReceiverSections
      ? findPythonReceiverCalls(document.getText())
      : [];
    if (receiverCalls.length > 0) {
      const receiverHits = new Map<string, RpcMethodHit | null>();
      for (const call of receiverCalls) {
        if (cancelled()) return [];
        const key = `${call.section}::${call.methodName}`;
        if (receiverHits.has(key)) {
          continue;
        }
        let hit: RpcMethodHit | null = null;
        try {
          const location = await this.entityMappingManager.resolveMethodDefinition(
            document.fileName,
            call.methodName,
            call.section
          );
          if (location) {
            hit = {
              methodName: call.methodName,
              section: location.section,
              defFile: location.defFile,
              defLine: location.line,
              exposed: location.exposed
            };
          }
        } catch {
          hit = null;
        }
        if (cancelled()) return [];
        receiverHits.set(key, hit);
      }
      for (const call of receiverCalls) {
        const hit = receiverHits.get(`${call.section}::${call.methodName}`);
        if (!hit) {
          continue;
        }
        receiverLenses.push(
          new vscode.CodeLens(
            new vscode.Range(
              new vscode.Position(call.line, call.character),
              new vscode.Position(call.line, call.character + call.methodName.length)
            ),
            {
              title: defaultRpcCodeLensTitle(hit),
              command: KBENGINE_SOURCE_REVEAL_COMMAND,
              arguments: [
                vscode.Uri.file(hit.defFile),
                { selection: createDefinitionSelection(hit.defLine) }
              ]
            }
          )
        );
      }
    }

    return cancelled() ? [] : [...rpcLenses, ...receiverLenses];
  }
}

export function createDefinitionSelection(defLine: number): vscode.Range {
  const position = new vscode.Position(defLine - 1, 0);
  return new vscode.Range(position, position);
}

// 批135:属性访问标记。Python 脚本里没有类型名可写(脚本即代码,与 RPC 那
// 套「实现里看不出」不同),可行等价是 self.<属性> 访问处出一行 CodeLens,标
// def 声明的类型与可见域,点击回 def 声明行。解析走属性 F12 同一索引
// (resolvePropertyDefinitionInfo),def 侧信息零重复解析。只认 self.<属性>
// 形态,与 F12 口径一致。
export class PropertyCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private entityMappingManager: EntityMappingManager) {}

  // 批154:属性访问镜链一枚独立开关(kbengine.codeLens.property)
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled()) {
      return [];
    }
    const config = getLanguageFeatureConfig();
    if (!config.codeLensProperty && !config.codeLensPropertyInitOrder) {
      return [];
    }

    // IDE-PROP-001:「属性先于 __init__ 装载 · 来自 <实体>.def」镜——实体类
    // __init__ 声明处标引擎装载语义,点击回 def(独立开关,与访问镜互不影响)。
    // 类名 → def 用 findEntityDefinitionFile(与属性 F12 的实体解析同源)。
    const lenses: vscode.CodeLens[] = [];
    if (config.codeLensPropertyInitOrder) {
      for (const spec of buildPropertyInitOrderLensSpecs(
        document.getText(),
        entityName => findEntityDefinitionFile(entityName, document)
      )) {
        if (cancelled()) return [];
        lenses.push(
          new vscode.CodeLens(
            new vscode.Range(spec.line, spec.character, spec.line, spec.character + 3),
            {
              title: spec.title,
              command: KBENGINE_SOURCE_REVEAL_COMMAND,
              arguments: [vscode.Uri.file(spec.defPath), { selection: createDefinitionSelection(0) }]
            }
          )
        );
      }
    }
    if (!config.codeLensProperty) {
      return lenses;
    }
    const accesses = findPythonSelfPropertyAccesses(document.getText());

    // 同一属性多处访问只解析一次:解析结果按 (根段, 完整路径) 一一对应
    const hits = new Map<string, PropertyCodeLensHit | null>();
    for (const access of accesses) {
      if (cancelled()) return [];
      const key = propertyAccessKey(access);
      if (hits.has(key)) {
        continue;
      }
      const location = await this.entityMappingManager.resolvePropertyDefinitionInfo(
        document.fileName,
        access.fullPath,
        access.rootSymbol
      );
      if (cancelled()) return [];
      hits.set(key, location
        ? {
            propertyName: location.identity.symbolName,
            componentSlotName: location.identity.componentSlotName,
            typeName: location.typeName ?? null,
            domains: location.domains,
            persistent: location.persistent,
            defFile: location.defFile,
            defLine: location.line
          }
        : null);
    }

    return [
      ...lenses,
      ...buildPropertyCodeLenses(accesses, access => hits.get(propertyAccessKey(access))).map(
        spec =>
          new vscode.CodeLens(
            new vscode.Range(
              new vscode.Position(spec.access.line, spec.access.character),
              new vscode.Position(
                spec.access.line,
                spec.access.character + spec.access.rootSymbol.length
              )
            ),
            {
              title: spec.title,
              command: KBENGINE_SOURCE_REVEAL_COMMAND,
              arguments: [
                vscode.Uri.file(spec.hit.defFile),
                { selection: createDefinitionSelection(spec.hit.defLine) }
              ]
            }
          )
      )
    ];
  }
}

// 批134:types.xml 类型声明行的引用反扫。一条真实使用出一枚镜(使用处
// 实体.属性 → 落库表.列),点击走 kbengine.database.open 打开 schema 文档
// 并定位到对应列;超过上限折叠成计数镜;类型无引用不出镜。
export interface TypesXmlStorageLensSpec {
  line: number;
  character: number;
  title: string;
  target: { entity: string; table: string; column: string } | null;
}

export const TYPE_STORAGE_LENS_LIMIT = 10;

export function buildTypesXmlStorageLensSpecs(
  content: string,
  workspaceRoot: string,
  typesXmlPath = getDefinitionWorkspaceLayout(workspaceRoot).typesXmlPath
): TypesXmlStorageLensSpec[] {
  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }

  // IDE-SCH-009:渲染只读已发布聚合(暖渲染零快照探测),新鲜度由
  // watcher 事件面承担;无状态时只读面自行冷构建一次
  const usageIndex = getTypeStorageUsageIndexReadOnly(workspaceRoot);
  const usagesBySourceLine = typesXmlPath
    ? indexTypeStorageUsageEntries(usageIndex, typesXmlPath)
    : new Map<number, TypeStorageUsage[]>();
  const specs: TypesXmlStorageLensSpec[] = [];
  for (const node of getDirectChildElements(document.root)) {
    const usages = usageIndex.get(node.name) || [];
    const firstLine = getLineNumberAt(document, node.tagStart);
    const lastLine = getLineNumberAt(document, node.closeTagEnd);
    const expandedUsages: TypeStorageUsage[] = [];
    for (let line = firstLine; line <= lastLine; line += 1) {
      expandedUsages.push(...(usagesBySourceLine.get(line) || []));
    }
    const seen = new Set<string>();
    const appendUsage = (title: string, usage: (typeof usages)[number]): void => {
      const key = `${usage.entity}:${usage.table}:${usage.column}`;
      if (seen.has(key) || seen.size >= TYPE_STORAGE_LENS_LIMIT) {
        return;
      }
      seen.add(key);
      const position = getLineCharacterAtOffset(content, content.indexOf(node.name, node.tagStart));
      specs.push({
        line: position.line,
        character: position.character,
        title,
        target: { entity: usage.entity, table: usage.table, column: usage.column }
      });
    };
    for (const usage of usages) {
      appendUsage(`${usage.entity}.${usage.property} → ${usage.table}.${usage.column}`, usage);
    }
    for (const usage of expandedUsages) {
      appendUsage(`字段 · ${usage.entity}.${usage.property} → ${usage.table}.${usage.column}`, usage);
    }
    const totalUsages = new Set([...usages, ...expandedUsages].map(
      usage => `${usage.entity}:${usage.table}:${usage.column}`
    )).size;
    if (totalUsages > TYPE_STORAGE_LENS_LIMIT) {
      const position = getLineCharacterAtOffset(content, content.indexOf(node.name, node.tagStart));
      specs.push({
        line: position.line,
        character: position.character,
        title: `+${totalUsages - TYPE_STORAGE_LENS_LIMIT} 处落库未列出`,
        target: null
      });
    }
  }
  return specs;
}

// IDE-ARC-005:全仓 watcher(def/types.xml/entities.xml 失效重取)已抽到装配
// 线模块 typeStorageIndexWatchers,由 extension 统一建/释放;本 provider 只
// 做镜渲染与刷新(fireConfigurationChanged),不再私建第二套全仓服务。
export class TypesXmlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly unsubscribeIndexPublished: () => void;

  constructor() {
    // 2026-10-28 审核整改:冷渲染拿空表(构建在后台),构建完成后通知重渲染
    this.unsubscribeIndexPublished = onTypeStorageUsageIndexPublished(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  // 批154:types.xml 落库镜链一枚独立开关(kbengine.codeLens.typesXml)
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getLanguageFeatureConfig().codeLensTypesXml) {
      return [];
    }
    const workspaceRoot = getWorkspaceRootForDocument(document);
    if (!workspaceRoot) {
      return [];
    }

    return buildTypesXmlStorageLensSpecs(document.getText(), workspaceRoot, document.fileName).map(spec =>
      new vscode.CodeLens(
        new vscode.Range(
          new vscode.Position(spec.line, spec.character),
          new vscode.Position(spec.line, spec.character)
        ),
        spec.target
          ? {
            title: spec.title,
            command: 'kbengine.database.open',
            // AUD-055:根身份随命令入参贯穿,目标 schema 文档带根不串根
            arguments: [spec.target.entity, spec.target.table, spec.target.column, workspaceRoot]
          }
          : undefined
      )
    );
  }

  dispose(): void {
    this.unsubscribeIndexPublished();
    this.onDidChangeCodeLensesEmitter.dispose();
  }
}
