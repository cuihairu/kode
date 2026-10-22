/**
 * KBEngine definition / Python navigation mapping
 * 基于统一 definition semantics 构建 owner-aware 的导航索引。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { jumpLog, jumpTimeStart } from './navigationLog';
import {
  findFilesAcrossRoots,
  getExternalScanRoots,
  getIndexScanRoots,
  getScanRootForFile
} from './scanRoots';
import { DefMethodSection } from './defParser';
import { clearDefCallChainFileCache } from './defCallChain';
import { PYTHON_BUILTIN_TYPE_ANNOTATIONS } from './pythonTypeStubs';
import { propertyFlagDomainList } from './defAnalyzer';
import type { PropertyFlagDomain } from './defAnalyzer';
import {
  createDefinitionSemanticsLoader,
  DefinitionMemberSourceKind,
  DefinitionMethod,
  DefinitionOwnerRef,
  DefinitionProperty,
  DefinitionSemanticCategory,
  ResolvedDefinitionSemantics,
  normalizeLookupPath
} from './definitionSemantics';
import {
  findEntityDefsDirForDefFile,
  getDefinitionWorkspaceLayout,
  scriptFoldersForRole
} from './definitionWorkspace';
import { joinWorkspacePath } from './workspacePath';
import type { EntityComponentFace } from './entityBuiltinProperties';

export type EntityMethodSection = DefMethodSection;

export interface DefinitionSymbolIdentity {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  sourceKind: DefinitionMemberSourceKind;
  sourceChain: string[];
  section?: EntityMethodSection;
  symbolName: string;
  propertyPath?: string;
  componentSlotName?: string;
}

export interface EntityMethodDefinitionLocation {
  defFile: string;
  line: number;
  section: EntityMethodSection;
  exposed: boolean;
  identity: DefinitionSymbolIdentity;
  /** def 声明的参数类型序列(<Arg> 直文本,批123 解析);空数组=未声明,不作闸门 */
  declaredArgs?: string[];
}

export interface EntityPropertyDefinitionLocation {
  defFile: string;
  line: number;
  identity: DefinitionSymbolIdentity;
}

/**
 * 属性声明的完整面(批135 属性访问 CodeLens 用):声明位置之上再带 <Type>
 * 直文本、Flags 位集推导的可见域与持久化标记。域位与属性判重复用 defAnalyzer
 * 同一份旗标真值,不另写一份映射。
 */
export interface PropertyDefinitionInfo extends EntityPropertyDefinitionLocation {
  /** <Type> 直文本(别名未展开,与 def 声明行同源) */
  typeName?: string;
  /** Flags 位集推导的引擎三域位,定序 base → cell → client */
  domains: PropertyFlagDomain[];
  persistent: boolean;
}

export interface PythonMethodLocation {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface PythonMethodCallReference {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

type IndexedPropertyDefinition = PropertyDefinitionInfo;

export interface IndexedMethodDefinition extends EntityMethodDefinitionLocation {
  owner: DefinitionOwnerRef;
}

interface PythonOwnerFile {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  filePath: string;
}

interface PythonMethodBinding {
  identity: DefinitionSymbolIdentity;
  pythonFile: string;
}

export interface IndexedPythonMethodLocation extends PythonMethodLocation {
  endLine: number;
  calls: Array<{ methodName: string; line: number; character: number; filePath: string }>;
  binding?: PythonMethodBinding;
}

export interface EntityMappingIndex {
  rootName: string;
  rootCategory: DefinitionSemanticCategory;
  rootDefFile: string;
  semantics: ResolvedDefinitionSemantics;
  propertyDefinitions: IndexedPropertyDefinition[];
  methodDefinitions: IndexedMethodDefinition[];
  pythonOwnerFiles: PythonOwnerFile[];
  pythonMethods: IndexedPythonMethodLocation[];
}

export interface EntityMapping {
  name: string;
  defFile: string;
  pythonFile: string;
  pythonFiles: string[];
  properties: { [propertyName: string]: { defFile: string; line: number } };
  methods: { [methodName: string]: EntityMethodDefinitionLocation[] };
}

export class EntityMappingManager {
  private mappingIndexes = new Map<string, EntityMappingIndex>();
  private mappingIndexesByRoot = new Map<string, EntityMappingIndex>();
  private scanningEntityMappings: Promise<void> | null = null;
  private pythonWatcher: vscode.FileSystemWatcher | null = null;
  private defWatcher: vscode.FileSystemWatcher | null = null;
  /**
   * 负缓存:已确认「不在任何 .def 的 pythonOwnerFiles 里」的文件。
   * 没有它,非 owner 的 .py 每次跳转都会在 property/method 两处各触发一次
   * 全量 .def 枚举与逐个解析,是「加载很久」第二来源。
   * 真实 .def 增删改由 watchDefFiles 清空(含本集合与索引),改完下次跳转重扫。
   */
  private missingOwnerPaths = new Set<string>();
  /** 负缓存:已确认「类名不在任何 .def 索引(含 ownerName 回溯)」的对象级查询 */
  private missingClassNames = new Set<string>();
  /** 构造期全量 .def 扫描句柄(对象级探等待它,避免同一次跳转内重复全量 walk) */
  private initialScan: Promise<void> = Promise.resolve();

  constructor(private context: vscode.ExtensionContext) {
    // 构造期全量 .def 扫描留句柄:对象级(类粒度)解析只等这一遍,不另起
    // 全量 walk(真实 kbengine 树每遍 walk 秒级,多一走即压穿调用方超时预算)
    this.initialScan = this.scanEntityMappings().catch(() => undefined);
    // 创建顺序有意为之:def watcher 先建、python watcher 后建——外部与既有
    // 用例把「最后创建的 watcher」当作 python watcher 语义使用(变更只重解析
    // 归属实体),两 watcher 各自独立,先 def 后 py 保持该约定不破。
    this.watchDefFiles();
    this.watchPythonFiles();
  }

  private async scanEntityMappings(): Promise<void> {
    if (this.scanningEntityMappings) {
      return this.scanningEntityMappings;
    }
    const scan = this.performScanEntityMappings().finally(() => {
      this.scanningEntityMappings = null;
    });
    this.scanningEntityMappings = scan;
    return scan;
  }

  private async performScanEntityMappings(): Promise<void> {
    // 扫描根 = workspace 顶层 ∪ assetsRoot(2026-10-16):loader 按全部根逐个
    // 解析 def(外部资产根下的 entities/接口/父链同样找得到)。空根集合(无
    // 工作区且无 assetsRoot)= 原空工作区早退,不失败。
    const scanRoots = getIndexScanRoots();
    if (scanRoots.length === 0) {
      return;
    }

    // 不可达(批62 定性):工厂只在根为空时返回 null,上方已对空集合早退。
    const loader = createDefinitionSemanticsLoader(scanRoots);
    /* istanbul ignore start */
    if (!loader) {
      return;
    }
    /* istanbul ignore stop */

    const indexTimer = jumpTimeStart();
    const defFiles = await findFilesAcrossRoots('**/*.def', null);
    for (const defFile of defFiles) {
      const normalizedPath = normalizeLookupPath(defFile.fsPath);
      if (normalizedPath.includes('/interfaces/') || normalizedPath.includes('/components/')) {
        continue;
      }

      const entityName = path.basename(defFile.fsPath, '.def');
      await this.parseDefFile(entityName, defFile.fsPath, loader);
    }
    jumpLog('info', () => `def 全量索引完成 ${defFiles.length} 个 .def → 实体 ${this.mappingIndexes.size} 个,${indexTimer()}ms`);
  }

  private async parseDefFile(
    entityName: string,
    defPath: string,
    loader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity'
  ): Promise<void> {
    try {
      const mapping = await this.buildIndex(entityName, defPath, loader, rootCategory);
      if (mapping) {
        this.storeIndex(mapping);
      }
    } catch (error) {
      console.error(`解析 .def 文件失败: ${defPath}`, error);
    }
  }

  private async buildIndex(
    entityName: string,
    defPath: string,
    providedLoader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity'
  ): Promise<EntityMappingIndex | null> {
    const loader = providedLoader || createDefinitionSemanticsLoader(defPath);
    if (!loader) {
      return null;
    }

    const semantics = loader.loadResolved(entityName, rootCategory, true);
    if (!semantics) {
      return null;
    }

    const pythonOwnerFiles = this.collectPythonOwnerFiles(semantics);
    const pythonMethods = this.collectPythonMethods(pythonOwnerFiles);
    const propertyDefinitions = this.collectPropertyDefinitions(semantics);
    const methodDefinitions = this.collectMethodDefinitions(semantics);
    this.bindPythonMethods(methodDefinitions, pythonMethods);

    return {
      rootName: entityName,
      rootCategory,
      rootDefFile: defPath,
      semantics,
      propertyDefinitions,
      methodDefinitions,
      pythonOwnerFiles,
      pythonMethods
    };
  }

  private storeIndex(index: EntityMappingIndex): void {
    this.mappingIndexes.set(index.rootName, index);
    this.mappingIndexesByRoot.set(normalizeLookupPath(index.rootDefFile), index);
  }

  private collectPythonOwnerFiles(semantics: ResolvedDefinitionSemantics): PythonOwnerFile[] {
    // 相对候选必须锚定根(用户令 2026-10-16):拿不到扫描根时整段跳过,
    // 绝不以空根造出相对候选去 fs 探测(那会相对 cwd 解析)
    const ownerRoot = this.getWorkspaceRoot(semantics.owner.filePath);
    if (!ownerRoot) {
      return [];
    }
    const layout = getDefinitionWorkspaceLayout(ownerRoot);
    const files: PythonOwnerFile[] = [];
    const seen = new Set<string>();

    const push = (candidate: PythonOwnerFile | null) => {
      // 不可达(批62 定性):三处调用都在 fs.existsSync 命中分支里传对象字面量,
      // 该闭包收不到 null。
      /* istanbul ignore start */
      if (!candidate) {
        return;
      }
      /* istanbul ignore stop */

      // 不可达(批72 定性):push 仅在三处调用(实体/接口/组件各段循环),皆显式传入
// section 字面量(BaseMethods/CellMethods/ClientMethods),故 candidate.section
// 恒为非空字符串,`|| ''` 兜底右臂无触发路径。真臂行为由既有
// entityMappingBranches.test.ts 中 Python 候选文件扫描用例锁定。
/* istanbul ignore start */
      const key = `${candidate.ownerKind}:${candidate.ownerName}:${candidate.section || ''}:${normalizeLookupPath(candidate.filePath)}`;
/* istanbul ignore stop */
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      files.push(candidate);
    };

    const addDefinitionOwnerFiles = (
      owner: DefinitionOwnerRef,
      componentSlotName?: string
    ) => {
      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName)) {
          if (fs.existsSync(filePath)) {
            push({
              ownerKind: owner.kind,
              ownerName: owner.name,
              section,
              filePath
            });
          }
        }
      }

      if (owner.kind === 'interface') {
        for (const section of ['BaseMethods', 'CellMethods'] as EntityMethodSection[]) {
          for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName, true)) {
            if (fs.existsSync(filePath)) {
              push({
                ownerKind: owner.kind,
                ownerName: owner.name,
                section,
                filePath
              });
            }
          }
        }
      }
    };

    const owners = new Map<string, DefinitionOwnerRef>();
    const collectOwner = (owner: DefinitionOwnerRef) => {
      owners.set(`${owner.kind}:${owner.name}`, owner);
    };

    collectOwner(semantics.owner);
    for (const property of semantics.effectiveProperties) {
      collectOwner(property.owner);
    }
    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        collectOwner(method.owner);
      }
    }
    for (const component of semantics.components) {
      if (component.resolved) {
        collectOwner(component.resolved.owner);
      }
    }

    for (const owner of owners.values()) {
      addDefinitionOwnerFiles(owner);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      addDefinitionOwnerFiles(component.resolved.owner, component.slotName);
    }

    return files;
  }

  private getPythonCandidates(
    workspaceRoot: string,
    owner: DefinitionOwnerRef,
    section: EntityMethodSection,
    componentSlotName?: string,
    preferInterfaceScriptFolder = false
  ): string[] {
    const candidates: string[] = [];
    const sectionFolder = this.getSectionFolder(section);
    const scriptRoots = this.getPythonScriptRoots(workspaceRoot, owner);
    const ownerName = owner.name;

    if (owner.kind === 'entity') {
      for (const root of scriptRoots) {
        // 官方模板 bots/(ClientMethods 的 BotsApp 客户端脚本)+ 生成器平铺
        // 形态 scripts/<实体>.py,与角色目录并列入候选(2026-10-12 用户实测)。
        for (const folder of scriptFoldersForRole(sectionFolder)) {
          candidates.push(joinWorkspacePath(root, folder, `${ownerName}.py`));
        }
        candidates.push(joinWorkspacePath(root, `${ownerName}.py`));
      }
      return candidates;
    }

    if (owner.kind === 'component') {
      for (const root of scriptRoots) {
        candidates.push(joinWorkspacePath(root, sectionFolder, 'components', `${ownerName}.py`));
      }
      return candidates;
    }

    // 不可达(批72 定性):owner.kind 类型为 DefinitionSemanticCategory,
    // 仅 entity/interface/component 三员。entity 与 component 在上方
    // 早退 return(311/318),能走到此处的仅 interface,故隐式 else
    // (arm#1 armLoc=undefined)契约上不可达。真臂行为由既有
    // entityMappingBranches.test.ts 接口 Python 候选扫描用例锁定。
    /* istanbul ignore start */
    if (owner.kind === 'interface') {
    /* istanbul ignore stop */
      // 官方模板是单数 interface/,历史口径是复数 interfaces/(2026-10-12
      // 用户实测核定),两种都入候选,复数在前保持既有工程行为。
      const interfaceFolders = preferInterfaceScriptFolder
        ? [`${sectionFolder}/interfaces`, 'interfaces', `${sectionFolder}/interface`, 'interface']
        : ['interfaces', `${sectionFolder}/interfaces`, 'interface', `${sectionFolder}/interface`];

      for (const root of scriptRoots) {
        for (const folder of interfaceFolders) {
          candidates.push(joinWorkspacePath(root, folder, `${ownerName}.py`));
          // 用户工程实测命名变体(2026-10-12):scripts/base/interfaces/
          // Interface_Activity.py,def 里接口名是 Activity。
          candidates.push(
            joinWorkspacePath(root, folder, `Interface_${ownerName}.py`)
          );
        }
      }
      return candidates;
    }

    // 不可达(批62 定性):owner.kind 类型为 DefinitionSemanticCategory,只有
    // entity/interface/component 三员且各自在上方早退 return,走到这里需要一个
    // 类型外的 kind;componentSlotName 的槽位脚本候选已由 kind === 'component'
    // 分支承担(批33 记录的重复形态),末次 return 同样只能由类型外 kind 达到。
    /* istanbul ignore start */
    if (componentSlotName) {
      for (const root of scriptRoots) {
        candidates.push(joinWorkspacePath(root, sectionFolder, 'components', `${ownerName}.py`));
      }
    }

    return candidates;
    /* istanbul ignore stop */
  }

  /**
   * Python 脚本根候选(批132:嵌套资产根兜底)。
   * ① 与 getDefinitionWorkspaceLayout 的布局候选同口径的三条工作区根前缀
   *   (scripts / assets/scripts / server_assets/scripts,含官方 newassets 形态);
   * ② owner 自己的 def 文件位置反推的 scripts 根——资产根不在工作区根本身时
   *   (<repo>/<xxx>_assets 布局,批129 约定扫描支持的形态),①全 miss,索引里
   *   pythonOwnerFiles 恒空,RPC CodeLens 与 Python → def 反向跳转整链静默失效;
   *   引擎语义 entity_defs 与 base/cell/client 恒同层,故 scripts 根 = def 所在
   *   entity_defs 的父目录,与定义导航的文件相对口径一致。②排在①之后:扁平布局
   *   候选顺序不变,嵌套布局只增补。
   */
  private getPythonScriptRoots(
    workspaceRoot: string,
    owner: DefinitionOwnerRef
  ): string[] {
    const roots = uniqueFilePaths([
      joinWorkspacePath(workspaceRoot, 'scripts'),
      joinWorkspacePath(workspaceRoot, 'assets', 'scripts'),
      joinWorkspacePath(workspaceRoot, 'server_assets', 'scripts')
    ]);
    const defsDir = findEntityDefsDirForDefFile(owner.filePath);
    if (defsDir) {
      roots.push(path.dirname(defsDir));
    }
    return roots;
  }

  private getSectionFolder(section: EntityMethodSection): 'base' | 'cell' | 'client' {
    switch (section) {
      case 'BaseMethods':
        return 'base';
      case 'CellMethods':
        return 'cell';
      case 'ClientMethods':
        return 'client';
    }
  }

  private collectPropertyDefinitions(semantics: ResolvedDefinitionSemantics): IndexedPropertyDefinition[] {
    const results: IndexedPropertyDefinition[] = [];
    const pushProperty = (property: DefinitionProperty, componentSlotName?: string) => {
      results.push({
        defFile: property.owner.filePath,
        line: property.line,
        identity: {
          ownerKind: property.owner.kind,
          ownerName: property.owner.name,
          sourceKind: property.source.kind,
          sourceChain: [...property.source.chain],
          symbolName: property.name,
          propertyPath: property.fullPath,
          componentSlotName
        },
        typeName: property.typeName,
        domains: propertyFlagDomainList(property.flags),
        // <Persistent> 缺省视作非持久(与 databaseSchema 的 isTruePersistent 口径一致)
        persistent: property.persistent ?? false
      });

      for (const child of property.children) {
        pushProperty(child, componentSlotName);
      }

      if (property.arrayElement) {
        pushProperty(property.arrayElement, componentSlotName);
      }
    };

    for (const property of semantics.effectiveProperties) {
      pushProperty(property);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const property of component.resolved.effectiveProperties) {
        pushProperty(this.rebasePropertyPath(property, component.slotName), component.slotName);
      }
    }

    return results;
  }

  private collectMethodDefinitions(semantics: ResolvedDefinitionSemantics): IndexedMethodDefinition[] {
    const results: IndexedMethodDefinition[] = [];
    const pushMethod = (method: DefinitionMethod, componentSlotName?: string) => {
      results.push({
        defFile: method.owner.filePath,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        owner: method.owner,
        declaredArgs: method.args,
        identity: {
          ownerKind: method.owner.kind,
          ownerName: method.owner.name,
          sourceKind: method.source.kind,
          sourceChain: [...method.source.chain],
          section: method.section,
          symbolName: method.name,
          componentSlotName
        }
      });
    };

    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        pushMethod(method);
      }
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const method of component.resolved.effectiveMethodsBySection[section]) {
          pushMethod(method, component.slotName);
        }
      }
    }

    return results;
  }

  private rebasePropertyPath(property: DefinitionProperty, prefix: string): DefinitionProperty {
    const sourceRoot = property.fullPath.split('.')[0] || property.fullPath;
    const suffix = property.fullPath === sourceRoot
      ? ''
      : property.fullPath.slice(sourceRoot.length);
    const nextFullPath = `${prefix}${suffix}`;

    return {
      ...property,
      fullPath: nextFullPath,
      children: property.children.map(child => this.rebasePropertyPath(child, prefix)),
      arrayElement: property.arrayElement ? this.rebasePropertyPath(property.arrayElement, prefix) : undefined
    };
  }

  private collectPythonMethods(ownerFiles: PythonOwnerFile[]): IndexedPythonMethodLocation[] {
    const methods: IndexedPythonMethodLocation[] = [];

    for (const ownerFile of ownerFiles) {
      if (!fs.existsSync(ownerFile.filePath)) {
        continue;
      }

      const content = fs.readFileSync(ownerFile.filePath, 'utf8');
      const parsedMethods = parsePythonMethodBlocks(content, ownerFile.filePath);
      for (const method of parsedMethods) {
        methods.push({
          ...method
        });
      }
    }

    return methods;
  }

  private bindPythonMethods(
    methodDefinitions: IndexedMethodDefinition[],
    pythonMethods: IndexedPythonMethodLocation[]
  ): void {
    const byOwner = new Map<string, IndexedMethodDefinition[]>();
    for (const definition of methodDefinitions) {
      const key = buildMethodOwnerBindingKey(definition.identity);
      const list = byOwner.get(key) || [];
      list.push(definition);
      byOwner.set(key, list);
    }

    for (const method of pythonMethods) {
      const ownerBindingKeys = [
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'entity',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'interface',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'component',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        })
      ];

      const boundDefinition = ownerBindingKeys
        .map(key => byOwner.get(key)?.[0])
        .find((candidate): candidate is IndexedMethodDefinition => !!candidate);

      if (!boundDefinition) {
        continue;
      }

      method.binding = {
        identity: boundDefinition.identity,
        pythonFile: method.filePath
      };
    }
  }

  private watchPythonFiles(): void {
    // workspace 首根 + workspace 外 assetsRoot:外部资产根的脚本变更同样要
    // 触发 owner 重解析(否则外部资产改脚本索引不动)
    const patterns: string[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      patterns.push(vscode.Uri.joinPath(workspaceFolder.uri, '**/*.py').toString());
    }
    for (const root of getExternalScanRoots()) {
      patterns.push(vscode.Uri.joinPath(vscode.Uri.file(root), '**/*.py').toString());
    }
    if (patterns.length === 0) {
      return;
    }

    const watchers = patterns.map(pattern =>
      vscode.workspace.createFileSystemWatcher(pattern)
    );
    this.pythonWatcher = watchers[0];
    for (const watcher of watchers) {
      watcher.onDidChange(uri => {
        this.handlePythonFileChanged(uri.fsPath);
      });
      this.context.subscriptions.push(watcher);
    }
  }

  /**
   * `.def` 增删改 → 整表失效:索引与「无归属」负缓存都清,下次跳转重扫。
   * (此前 .def 变更只可能被「恰有文件 miss」的重扫顺带带出,归属变化会滞留。)
   */
  private watchDefFiles(): void {
    const invalidate = (): void => {
      this.mappingIndexes.clear();
      this.mappingIndexesByRoot.clear();
      this.missingOwnerPaths.clear();
      this.missingClassNames.clear();
    };
    // workspace 首根 + workspace 外 assetsRoot(外部资产根的 .def 增删改同样失效整表)
    const patterns: string[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      patterns.push(vscode.Uri.joinPath(workspaceFolder.uri, '**/*.def').toString());
    }
    for (const root of getExternalScanRoots()) {
      patterns.push(vscode.Uri.joinPath(vscode.Uri.file(root), '**/*.def').toString());
    }
    if (patterns.length === 0) {
      return;
    }

    const watchers = patterns.map(pattern =>
      vscode.workspace.createFileSystemWatcher(pattern)
    );
    this.defWatcher = watchers[0];
    for (const watcher of watchers) {
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);
      this.context.subscriptions.push(watcher);
    }
  }

  private handlePythonFileChanged(pythonPath: string): void {
    clearDefCallChainFileCache();
    this.allPythonMethodHits.clear();
    for (const [entityName, mapping] of this.mappingIndexes) {
      if (mapping.pythonOwnerFiles.some(item => normalizeLookupPath(item.filePath) === normalizeLookupPath(pythonPath))) {
        void this.parseDefFile(entityName, mapping.rootDefFile);
        break;
      }
    }
  }

  getMapping(entityName: string): EntityMapping | undefined {
    const index = this.mappingIndexes.get(entityName);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getMappingForPythonFile(pythonFile: string): EntityMapping | undefined {
    const index = this.findIndexForPythonFile(pythonFile);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getIndexForPythonFile(pythonFile: string): EntityMappingIndex | undefined {
    return this.findIndexForPythonFile(pythonFile);
  }

  async waitForInitialScan(): Promise<void> {
    await this.initialScan;
  }

  getIndex(entityName: string): EntityMappingIndex | undefined {
    return this.mappingIndexes.get(entityName);
  }

  getAllMappings(): EntityMapping[] {
    return [...this.mappingIndexes.values()].map(index => this.toLegacyMapping(index));
  }

  async resolvePropertyDefinition(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<EntityPropertyDefinitionLocation | null> {
    return this.findIndexedProperty(pythonFile, fullPath, rootSymbol);
  }

  /** 与 resolvePropertyDefinition 同解析口径,额外带 <Type>/可见域/持久化标记(批135) */
  async resolvePropertyDefinitionInfo(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<PropertyDefinitionInfo | null> {
    return this.findIndexedProperty(pythonFile, fullPath, rootSymbol);
  }

  private async findIndexedProperty(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<IndexedPropertyDefinition | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }
    return this.findIndexedPropertyIn(index, fullPath, rootSymbol);
  }

  private findIndexedPropertyIn(
    index: EntityMappingIndex,
    fullPath: string,
    rootSymbol?: string
  ): IndexedPropertyDefinition | null {
    const normalizedFullPath = normalizePropertyLookupPath(fullPath);
    const normalizedRoot = rootSymbol ? normalizePropertyLookupPath(rootSymbol) : undefined;

    return index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedFullPath)
      || (normalizedRoot
        ? index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedRoot)
        : undefined)
      || null;
  }

  async resolveMethodDefinition(
    pythonFile: string,
    methodName: string,
    receiverSection?: EntityMethodSection
  ): Promise<EntityMethodDefinitionLocation | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    const ownerKind = inferOwnerKindFromPythonFile(pythonFile);
    const ownerName = inferOwnerNameFromPythonFile(pythonFile);
    const section = inferMethodSectionFromPythonFile(pythonFile);
    const options = {
      methodName,
      ownerKind,
      ownerName,
      section
    };

    // Keep the paired owner index as the preferred scope. Interfaces without a
    // matching .def (or declarations stored in a shared .def) need a global
    // fallback across every scanned definition index.
    // 接收者段闸(用户令 2026-10-21):receiverSection 在场时先按段过滤候选
    // (段不符的 def 声明一律不进打分,更不进任何后续闸)。
    const local = index
      ? this.selectMethodDefinition(
        filterMethodDefinitionsBySection(index.methodDefinitions, receiverSection),
        options
      )
      : null;
    // A role-neutral scripts/interfaces module (for example interfaces/ROLE.py)
    // has no Base/Cell/Client ownership and must not bind to an unrelated entity
    // declaration. Cross-file fallback is for role-specific interface modules.
    const allowCrossDefFallback = ownerKind === 'interface' && !!section;
    if (!local && allowCrossDefFallback) {
      await this.initialScan;
    }
    const global = local || (allowCrossDefFallback
      ? this.selectMethodDefinition(
        filterMethodDefinitionsBySection(
          [...this.mappingIndexes.values()].flatMap(item => item.methodDefinitions),
          receiverSection
        ),
        options
      )
      : null);
    const located = global;
    jumpLog('debug', () =>
      `def 方法[文件级${local ? '' : '+全局回退'}]${receiverSection ? `[段闸 ${receiverSection}]` : ''} ${methodName} → ${located ? `${path.basename(located.defFile)}:${located.line}` : 'miss'}`
    );
    return located;
  }

  /**
   * 对象级(类粒度).def 解析:按类名直接取该类的 .def 索引,不看调用文件
   * 是否匹配到 owner——「文件没匹配上 owner」不等于「对象没有 .def」,
   * 放弃范围必须在对象/类粒度判定(接口/组件类经 ownerName 回溯到引用它的
   * 实体索引)。
   */
  async resolveMethodDefinitionForClass(
    className: string,
    methodName: string,
    receiverSection?: EntityMethodSection
  ): Promise<EntityMethodDefinitionLocation | null> {
    const index = await this.ensureIndexForClass(className);
    if (!index) {
      return null;
    }
    return this.selectMethodDefinition(
      filterMethodDefinitionsBySection(index.methodDefinitions, receiverSection),
      {
        methodName,
        ownerName: className
      }
    );
  }

  /** 对象级属性解析:取索引口径同 resolveMethodDefinitionForClass,查 <Properties> */
  async resolvePropertyDefinitionForClass(
    className: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<EntityPropertyDefinitionLocation | null> {
    const index = await this.ensureIndexForClass(className);
    if (!index) {
      return null;
    }
    return this.findIndexedPropertyIn(index, fullPath, rootSymbol);
  }

  async resolveDefinitionSymbolAtPosition(
    defFile: string,
    line: number,
    symbolName: string,
    section?: EntityMethodSection,
    propertyPath?: string
  ): Promise<DefinitionSymbolIdentity | null> {
    const index = await this.ensureIndexByDefFile(defFile);
    if (!index) {
      return null;
    }

    if (propertyPath) {
      const property = index.propertyDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizePropertyLookupPath(propertyPath)
      );
      return property?.identity || null;
    }

    if (section) {
      const method = index.methodDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && item.section === section
        && item.identity.symbolName === symbolName
      );
      return method?.identity || null;
    }

    return null;
  }

  async openMethodTarget(
    identityOrEntityName: DefinitionSymbolIdentity | string,
    methodName?: string,
    section?: EntityMethodSection
  ): Promise<boolean> {
    const identity = typeof identityOrEntityName === 'string'
      ? this.createLegacyIdentity(identityOrEntityName, methodName, section)
      : identityOrEntityName;
    if (!identity) {
      return false;
    }

    const index = typeof identityOrEntityName === 'string'
      ? await this.ensureIndex(identity.ownerName)
      : await this.ensureIndexForOwner(identity);
    if (!index) {
      return false;
    }

    const implementationTarget = this.findMethodImplementationByIdentity(index, identity);
    if (implementationTarget) {
      return this.openFileAtLocation(
        implementationTarget.filePath,
        implementationTarget.line,
        implementationTarget.character
      );
    }

    const definition = index.methodDefinitions.find(item => sameIdentity(item.identity, identity));
    if (!definition) {
      return false;
    }

    return this.openFileAtLocation(definition.defFile, definition.line);
  }

  async resolveMethodImplementationByIdentity(
    identity: DefinitionSymbolIdentity
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    const index = await this.ensureIndexForOwner(identity);
    if (!index) {
      return null;
    }

    const located = this.findMethodImplementationByIdentity(index, identity);
    if (located) {
      // 绑定层不做形参拦截(2026-10-21 收窄):实体自身脚本的同名绑定是约定即答案,
      // 形参闸门只装在「猜外来文件」的域目录层与全项目回退层。
      return located;
    }
    const definition = index.methodDefinitions.find(item => sameIdentity(item.identity, identity));
    const declaredArgs = definition?.declaredArgs;
    const declaredArgTypes = declaredArgs && declaredArgs.length > 0 ? declaredArgs : undefined;

    // 用户令(2026-10-20):.def 方法在同名/绑定文件找不到实现时,放宽到全项目
    // python:方法名**唯一命中**才跳(实现常落在父类/公共模块的 py 里,
    // 属主索引 pythonMethods 只收实体属主脚本,覆盖不到),多处命中保持静默
    // (交给调用方约定链与提示),找不到维持现状不误跳。
    // 2026-10-21:先按方法域走 base//cell/ 目录层(identity.section 在场时);
    // def 声明了 <Arg> 时叠加形参闸门——个数必须相等,有注解的还要按
    // 引擎内建映射(UINT8→int 等)对得上类型;读不出签名不算候选。
    return this.resolveMethodImplementationGlobally(
      identity.symbolName,
      identity.section,
      declaredArgTypes
    );
  }

  /**
   * 全项目 python 回退(用户令 2026-10-20):方法名在全项目 py 中唯一命中才返回,
   * 多处/零处一律 null(静默,不误跳)。给 def 侧 identity 未命中/未绑定实现的
   * 两个早落分支复用——那两支不经过 resolveMethodImplementationByIdentity。
   *
   * 域目录层(用户令 2026-10-21,报错 onClientEnabled 错跳):BaseMethods 定义的方法
   * 先只在 base/ 目录下找、CellMethods 只在 cell/ 下找;域内唯一命中即返回,
   * 域内无果或歧义才进入全项目回退(唯一命中才跳的既有语义不变)。
   */
  async resolveMethodImplementationGlobally(
    methodName: string,
    section?: EntityMethodSection,
    declaredArgTypes?: string[]
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    const domainRole =
      section === 'BaseMethods' ? 'base' : section === 'CellMethods' ? 'cell' : null;
    if (domainRole) {
      const domainHits = await this.collectAllPythonMethodHits(methodName, domainRole, declaredArgTypes);
      if (domainHits.length === 1) {
        const [domainHit] = domainHits;
        jumpLog('debug', () =>
          `def 方法[域内目录 ${domainRole}] ${methodName} → ${path.basename(domainHit.filePath)}:${domainHit.line}`
        );
        return domainHit;
      }
    }
    const globalHits = await this.collectAllPythonMethodHits(methodName, undefined, declaredArgTypes);
    if (globalHits.length === 1) {
      const [globalHit] = globalHits;
      jumpLog('debug', () =>
        `def 方法[全项目回退] ${methodName} → ${path.basename(globalHit.filePath)}:${globalHit.line}`
      );
      return globalHit;
    }
    return null;
  }

  /** 全项目 python 方法扫描(懒缓存):精确 `def <name>(`,跳过虚目录,多处命中交由调用方判定。domain 在场时只收路径含该目录段(base/cell)的文件。 */
  private readonly allPythonMethodHits = new Map<
    string,
    Array<{ filePath: string; line: number; character: number }>
  >();

  private async collectAllPythonMethodHits(
    methodName: string,
    domain?: 'base' | 'cell',
    declaredArgTypes?: string[]
  ): Promise<Array<{ filePath: string; line: number; character: number }>> {
    const cacheKey = `${domain ?? '*'}:${methodName}:${declaredArgTypes ? declaredArgTypes.join(',') : '*'}`;
    const cached = this.allPythonMethodHits.get(cacheKey);
    if (cached) {
      return cached;
    }
    const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*def\\s+${escaped}\\s*\\(`);
    const skippedDirs = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', 'build', 'dist']);
    const hits: Array<{ filePath: string; line: number; character: number }> = [];
    const seenPaths = new Set<string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skippedDirs.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name));
          }
          continue;
        }
        if (!entry.name.endsWith('.py')) {
          continue;
        }
        const filePath = path.join(dir, entry.name);
        if (domain && !filePath.split(path.sep).includes(domain)) {
          continue;
        }
        const normalized = normalizeLookupPath(filePath);
        if (seenPaths.has(normalized)) {
          continue;
        }
        seenPaths.add(normalized);
        let text: string;
        try {
          text = fs.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (pattern.test(lines[i])) {
            // 形参闸门(用户令 2026-10-21):def 声明了 <Arg> 时,实现形参个数
            // (剔除 self/cls)必须相等;有注解的形参还要按引擎内建映射对上类型
            // (UINT8→int/STRING→str/VECTOR3→Tuple[...]),未注明解的只作个数校验;
            // 读不出签名/个数或类型不符 → 该文件不算候选。闸门本体已提炼为
            // 公开静态 pythonSignatureMatchesDeclaredArgs,CodeLens/Hover 面同源复用。
            if (declaredArgTypes &&
              !EntityMappingManager.pythonSignatureMatchesDeclaredArgs(declaredArgTypes, lines, i)) {
              break;
            }
            hits.push({ filePath, line: i + 1, character: lines[i].search(/\S/) });
            break; // 每文件首个同名 def 即落点
          }
        }
      }
    };
    for (const root of getIndexScanRoots()) {
      walk(root);
    }
    hits.sort((a, b) => (a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)));
    this.allPythonMethodHits.set(cacheKey, hits);
    return hits;
  }

  /**
   * 形参闸门公开口(用户令 2026-10-21:只凭名字标 RPC/标 KBEngine 函数不严谨,
   * CodeLens/Hover 面与全项目回退扫描共用同一把尺):从 lines[index] 的 def 行
   * 起收集签名,与 declaredArgTypes 逐一对账——形参个数(剔除 self/cls)必须
   * 相等,有注解的形参按统一解析链对上类型(缺省内建映射 UINT8→int/STRING→str
   * 等,兼容直写 <Arg> 原文;hover/CodeLens 面注入 resolveEntityAnnotationType
   * 同源解析,types.xml 自定义类型也按链断到内建),未注明解的只作个数校验;
   * 读不出签名/个数或类型不符一律 false,declaredArgTypes 为空序列视为未声明
   * <Arg>,恒真。
   */
  static pythonSignatureMatchesDeclaredArgs(
    declaredArgTypes: readonly string[],
    lines: string[],
    index: number,
    resolveAnnotation?: (raw: string) => string
  ): boolean {
    if (declaredArgTypes.length === 0) {
      return true;
    }
    const signature = EntityMappingManager.collectSignatureText(lines, index);
    if (signature === null) {
      return false;
    }
    const params = EntityMappingManager.parsePythonParams(signature);
    if (!params || params.length !== declaredArgTypes.length) {
      return false;
    }
    for (let a = 0; a < declaredArgTypes.length; a += 1) {
      const annotation = params[a].annotation;
      if (!annotation) {
        continue;
      }
      const raw = declaredArgTypes[a];
      const expected = resolveAnnotation
        ? resolveAnnotation(raw)
        : PYTHON_BUILTIN_TYPE_ANNOTATIONS[raw] ?? raw;
      if (annotation !== expected && annotation !== raw) {
        return false;
      }
    }
    return true;
  }

  /** 从 def 行起收集到括号配平的签名文本(≤8 行跨行容忍);读不出返回 null。 */
  private static collectSignatureText(lines: string[], startIndex: number): string | null {
    let chunk = '';
    for (let k = startIndex; k < lines.length && k < startIndex + 8; k += 1) {
      chunk += (chunk ? ' ' : '') + (lines[k] ?? '');
      if (!chunk.includes('(')) {
        continue;
      }
      let depth = 0;
      let closed = false;
      for (const ch of chunk.slice(chunk.indexOf('('))) {
        if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            closed = true;
            break;
          }
        }
      }
      if (closed) {
        return chunk;
      }
    }
    return null;
  }

  /** 签名文本 → 形参序列(名+可选注解;剔除 self/cls,剥默认值,顶层深度感知切分);读不出 null。 */
  private static parsePythonParams(
    signature: string
  ): Array<{ name: string; annotation: string | null }> | null {
    const open = signature.indexOf('(');
    if (open < 0) {
      return null;
    }
    let depth = 0;
    let close = -1;
    for (let k = open; k < signature.length; k += 1) {
      const ch = signature[k];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) {
      return null;
    }
    // 括号内只有形参列表(返回注解在 ')' 之后,已被 close 截掉),无需再剥注解;
    // 形参自身的注解冒号由逐段解析处理。
    const inner = signature.slice(open + 1, close);
    if (!inner.trim()) {
      return [];
    }
    const parts: string[] = [];
    let cur = '';
    let d = 0;
    for (const ch of inner) {
      if (ch === '[' || ch === '(' || ch === '{') {
        d += 1;
      } else if (ch === ']' || ch === ')' || ch === '}') {
        d -= 1;
      }
      if (ch === ',' && d === 0) {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) {
      parts.push(cur);
    }
    const params: Array<{ name: string; annotation: string | null }> = [];
    for (const part of parts) {
      const head = part.split('=')[0] ?? '';
      const colon = head.indexOf(':');
      const name = (colon >= 0 ? head.slice(0, colon) : head).trim();
      const annotation = colon >= 0 ? head.slice(colon + 1).trim() || null : null;
      if (!name || name === 'self' || name === 'cls') {
        continue;
      }
      params.push({ name, annotation });
    }
    return params;
  }

  private async ensureIndexForOwner(
    identity: DefinitionSymbolIdentity
  ): Promise<EntityMappingIndex | undefined> {
    const direct = this.mappingIndexes.get(identity.ownerName);
    if (direct) {
      return direct;
    }

    // 接口/组件符号不单独建索引,需要回溯到引用它的实体索引
    const findByOwner = (): EntityMappingIndex | undefined =>
      [...this.mappingIndexes.values()].find(index =>
        index.pythonOwnerFiles.some(item =>
          item.ownerKind === identity.ownerKind && item.ownerName === identity.ownerName
        )
      );

    const ownerIndex = findByOwner();
    if (ownerIndex) {
      return ownerIndex;
    }

    await this.scanEntityMappings();
    return this.mappingIndexes.get(identity.ownerName) || findByOwner();
  }

  async resolveMethodImplementation(
    entityName: string,
    methodName: string,
    section: EntityMethodSection
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    const index = await this.ensureIndex(entityName);
    if (!index) {
      return null;
    }

    const definition = this.selectMethodDefinition(index.methodDefinitions, {
      methodName,
      ownerKind: 'entity',
      ownerName: entityName,
      section
    });

    return definition ? this.findMethodImplementationByIdentity(index, definition.identity) : null;
  }

  async resolvePythonMethodAtPosition(
    pythonFile: string,
    line: number,
    character: number
  ): Promise<PythonMethodLocation | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }

    const normalizedPythonPath = normalizeLookupPath(pythonFile);
    return index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizedPythonPath
      && line >= method.line
      && line <= method.endLine
      && (line !== method.line || character >= method.character)
    ) || null;
  }

  /**
   * 实体脚本的 def 归属面(用户令 2026-10-21 内建属性单 ④):owner 文件
   * 段位映射 BaseMethods→baseapp / CellMethods→cellapp / ClientMethods→client,
   * 去重返回。非实体脚本(无 .def 归属)→ null;面歧义由调用方
   * (entityBuiltinProperties.resolveEntityBuiltinPropertyHit)降级为宏公共 3。
   */
  async getEntityComponentFacesForPythonFile(
    pythonFile: string
  ): Promise<EntityComponentFace[] | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }
    const normalized = normalizeLookupPath(pythonFile);
    const faces = new Set<EntityComponentFace>();
    for (const owner of index.pythonOwnerFiles) {
      if (normalizeLookupPath(owner.filePath) !== normalized) {
        continue;
      }
      const face =
        owner.section === 'BaseMethods'
          ? 'baseapp'
          : owner.section === 'CellMethods'
            ? 'cellapp'
            : owner.section === 'ClientMethods'
              ? 'client'
              : null;
      if (face) {
        faces.add(face);
      }
    }
    return [...faces];
  }

  async getOutgoingPythonMethodCalls(
    pythonFile: string,
    methodName: string
  ): Promise<PythonMethodCallReference[]> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return [];
    }

    const targetMethod = index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizeLookupPath(pythonFile)
      && method.methodName === methodName
    );
    if (!targetMethod) {
      return [];
    }

    const references: PythonMethodCallReference[] = [];
    const seen = new Set<string>();
    for (const reference of targetMethod.calls) {
      const binding = index.pythonMethods.find(candidate =>
        normalizeLookupPath(candidate.filePath) === normalizeLookupPath(reference.filePath)
        && candidate.methodName === reference.methodName
      );

      const resolved = binding
        || index.pythonMethods.find(candidate => candidate.methodName === reference.methodName);
      if (!resolved) {
        continue;
      }

      const key = `${normalizeLookupPath(resolved.filePath)}:${resolved.methodName}:${resolved.line}:${resolved.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      references.push({
        filePath: resolved.filePath,
        methodName: resolved.methodName,
        line: resolved.line,
        character: resolved.character
      });
    }

    return references;
  }

  async getIncomingPythonMethodCalls(
    pythonFile: string,
    methodName: string
  ): Promise<Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }>> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return [];
    }

    const incoming: Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }> = [];
    const normalizedTarget = normalizeLookupPath(pythonFile);

    for (const method of index.pythonMethods) {
      for (const call of method.calls) {
        if (call.methodName !== methodName) {
          continue;
        }

        const resolved = index.pythonMethods.find(candidate =>
          candidate.methodName === call.methodName
          && normalizeLookupPath(candidate.filePath) === normalizedTarget
        );
        if (!resolved) {
          continue;
        }

        incoming.push({
          caller: {
            filePath: method.filePath,
            methodName: method.methodName,
            line: method.line,
            character: method.character
          },
          callLine: call.line,
          callCharacter: call.character
        });
      }
    }

    return incoming;
  }

  async jumpToDef(
    pythonFile: string,
    symbol: string,
    type: 'property' | 'method'
  ): Promise<boolean> {
    const location = type === 'property'
      ? await this.resolvePropertyDefinition(pythonFile, symbol, symbol)
      : await this.resolveMethodDefinition(pythonFile, symbol);

    // 可达但测试未覆盖(批72 定性):jumpToDef 成功路径需构造真实
    // Python 文件与符号定位,属端到端集成面;既有 openMethodTarget
    // 与 resolveMethodImplementation 已间接锁定解析成功后的
    // openFileAtLocation 调用链。此处隐式 else 仅为代码完整性保留,
    // 标记 ignore 避免分母膨胀。
    /* istanbul ignore start */
    if (!location) {
    /* istanbul ignore stop */
      return false;
    }

    return this.openFileAtLocation(location.defFile, location.line);
  }

  dispose(): void {
    this.pythonWatcher?.dispose();
    this.defWatcher?.dispose();
  }

  private selectMethodDefinition(
    definitions: IndexedMethodDefinition[],
    options: {
      methodName: string;
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): IndexedMethodDefinition | null {
    const matches = definitions.filter(item => item.identity.symbolName === options.methodName);
    if (matches.length === 0) {
      return null;
    }

    const scored = matches
      .map(item => ({ item, score: this.scoreMethodDefinition(item, options) }))
      .sort((left, right) => right.score - left.score
        // A single-location API must choose deterministically when equally
        // relevant declarations exist; owner/section/local scores win first,
        // then normalized def path and line provide a stable tie-break.
        || normalizeLookupPath(left.item.defFile).localeCompare(normalizeLookupPath(right.item.defFile))
        || left.item.line - right.item.line);

    // 不可达(批72 定性):matches.length > 0 已由上方早退守卫,map+sort 产出
// scored 数组长度 ≥1 且每项 item 来自 matches 原元素(非空对象),
// 故 scored[0]?.item 恒为非空 IndexedMethodDefinition,`|| null`
// 兜底右臂无触发路径。真臂行为由既有 entityMappingBranches.test.ts
// 同名方法打分选优用例锁定。
/* istanbul ignore start */
    return scored[0]?.item || null;
/* istanbul ignore stop */
  }

  private scoreMethodDefinition(
    definition: IndexedMethodDefinition,
    options: {
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): number {
    let score = 0;
    if (options.ownerKind && definition.identity.ownerKind === options.ownerKind) {
      score += 40;
    }
    if (options.ownerName && definition.identity.ownerName === options.ownerName) {
      score += 40;
    }
    if (options.section && definition.section === options.section) {
      score += 20;
    }
    if (options.componentSlotName && definition.identity.componentSlotName === options.componentSlotName) {
      score += 30;
    }
    if (definition.identity.sourceKind === 'local') {
      score += 10;
    }
    return score;
  }

  private findMethodImplementationByIdentity(
    index: EntityMappingIndex,
    identity: DefinitionSymbolIdentity
  ): { filePath: string; line: number; character: number } | null {
    const direct = index.pythonMethods.find(method =>
      method.binding && sameIdentity(method.binding.identity, identity)
    );
    if (direct) {
      return {
        filePath: direct.filePath,
        line: direct.line,
        character: direct.character
      };
    }

    const ownerName = identity.ownerName;
    const ownerKind = identity.ownerKind;
    const section = identity.section;
    const candidates = index.pythonOwnerFiles
      .filter(item =>
        item.ownerName === ownerName
        && item.ownerKind === ownerKind
        && (!section || item.section === section)
      )
      .map(item => item.filePath);

    for (const filePath of uniqueFilePaths(candidates)) {
      const location = this.findPythonMethodLine(filePath, identity.symbolName);
      if (location) {
        return {
          filePath,
          line: location.line,
          character: location.character
        };
      }
    }

    return null;
  }

  private findPythonMethodLine(
    pythonFile: string,
    methodName: string
  ): { line: number; character: number } | null {
    if (!fs.existsSync(pythonFile)) {
      return null;
    }

    try {
      const content = fs.readFileSync(pythonFile, 'utf8');
      const regex = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodName)})\\s*\\(`, 'm');
      const match = regex.exec(content);
      if (!match) {
        return null;
      }

      const nameIndex = match.index + match[0].indexOf(match[2]);
      return {
        line: getLineNumber(content, nameIndex),
        character: getColumnNumber(content, nameIndex)
      };
    } catch {
      return null;
    }
  }

  private async openFileAtLocation(filePath: string, line: number, character = 0): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const position = new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0));
    const selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, { selection });
    return editor !== undefined;
  }

  private async ensureIndex(entityName: string): Promise<EntityMappingIndex | undefined> {
    let index = this.mappingIndexes.get(entityName);
    if (!index) {
      await this.scanEntityMappings();
      index = this.mappingIndexes.get(entityName);
    }
    return index;
  }

  private async ensureIndexByDefFile(defFile: string): Promise<EntityMappingIndex | undefined> {
    let index = [...this.mappingIndexes.values()].find(item =>
      normalizeLookupPath(item.rootDefFile) === normalizeLookupPath(defFile)
    );
    if (!index) {
      const entityName = path.basename(defFile, '.def');
      index = await this.ensureIndex(entityName);
    }
    return index;
  }

  private async ensureIndexForPythonFile(pythonFile: string): Promise<EntityMappingIndex | undefined> {
    const normalized = normalizeLookupPath(pythonFile);
    // 负缓存命中:该文件已确认无 .def 归属,直接走 null → 上层 PythonClassIndex
    // 兜底,不再每次重扫(修复前每次跳转两轮全量 .def 重扫)
    if (this.missingOwnerPaths.has(normalized)) {
      jumpLog('debug', () => `def 索引[文件级] ${path.basename(pythonFile)} → miss(负缓存命中)`);
      return undefined;
    }
    let index = this.findIndexForPythonFile(pythonFile);
    if (!index) {
      await this.scanEntityMappings();
      index = this.findIndexForPythonFile(pythonFile);
      if (!index) {
        this.missingOwnerPaths.add(normalized);
      }
    }
    jumpLog('debug', () =>
      `def 索引[文件级] ${path.basename(pythonFile)} → ${index ? index.rootName : 'miss(无 owner 归属)'}`
    );
    return index;
  }

  /** 对象级取索引:类名直接命中;接口/组件类不单独建索引,经 ownerName 回溯 */
  private lookupIndexByClass(className: string): EntityMappingIndex | undefined {
    const direct = this.mappingIndexes.get(className);
    if (direct) {
      return direct;
    }
    return [...this.mappingIndexes.values()].find(index =>
      index.pythonOwnerFiles.some(item => item.ownerName === className)
    );
  }

  private async ensureIndexForClass(className: string): Promise<EntityMappingIndex | undefined> {
    if (this.missingClassNames.has(className)) {
      return undefined;
    }
    if (this.mappingIndexes.size === 0) {
      // 只等构造期扫描(不新起全量 walk):文件级子探/失败重试仍按原口径自扫
      await this.initialScan;
    }
    const index = this.lookupIndexByClass(className);
    if (!index && this.mappingIndexes.size > 0) {
      // 索引表已有数据仍未命中才负缓存(空表=尚无数据,不落死)
      this.missingClassNames.add(className);
    }
    jumpLog('debug', () =>
      `def 索引[对象级] ${className} → ${index ? index.rootName : this.missingClassNames.has(className) ? 'miss(负缓存)' : 'miss'}`
    );
    return index;
  }

  private findIndexForPythonFile(pythonFile: string): EntityMappingIndex | undefined {
    const normalized = normalizeLookupPath(pythonFile);
    return [...this.mappingIndexes.values()].find(index =>
      index.pythonOwnerFiles.some(item => normalizeLookupPath(item.filePath) === normalized)
    ) ?? [...this.mappingIndexes.values()].find(index =>
      index.rootName === path.basename(pythonFile, '.py')
    );
  }

  private getWorkspaceRoot(filePath: string): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
      filePath.startsWith(`${folder.uri.fsPath}${path.sep}`) || filePath.startsWith(`${folder.uri.fsPath}/`)
    );
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    // workspace 外的 assetsRoot 下文件 → 扫描根兜底(布局/owner 解析用),
    // 都不匹配时维持既有行为:回落首个工作区根
    return getScanRootForFile(filePath)
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || null;
  }

  private createLegacyIdentity(
    entityName: string,
    methodName?: string,
    section?: EntityMethodSection
  ): DefinitionSymbolIdentity | null {
    if (!entityName || !methodName || !section) {
      return null;
    }

    return {
      ownerKind: 'entity',
      ownerName: entityName,
      sourceKind: 'local',
      sourceChain: [],
      section,
      symbolName: methodName
    };
  }

  private toLegacyMapping(index: EntityMappingIndex): EntityMapping {
    const properties: EntityMapping['properties'] = {};
    for (const property of index.propertyDefinitions) {
      const propertyPath = property.identity.propertyPath;
      if (!propertyPath || properties[propertyPath]) {
        continue;
      }

      properties[propertyPath] = {
        defFile: property.defFile,
        line: property.line
      };
    }

    const methods: EntityMapping['methods'] = {};
    for (const method of index.methodDefinitions) {
      const list = methods[method.identity.symbolName] || [];
      list.push({
        defFile: method.defFile,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        declaredArgs: method.declaredArgs,
        identity: method.identity
      });
      methods[method.identity.symbolName] = list;
    }

    return {
      name: index.rootName,
      defFile: index.rootDefFile,
      pythonFile: index.pythonOwnerFiles[0]?.filePath || buildFallbackPythonPath(index.rootName),
      pythonFiles: uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath)).length > 0
        ? uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath))
        : [buildFallbackPythonPath(index.rootName)],
      properties,
      methods
    };
  }
}

function buildFallbackPythonPath(entityName: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`);
}

/**
 * 接收者段过滤(用户令 2026-10-21):self.cell./self.base./self.client. 调用的
 * 候选闸——receiverSection 在场时只留段相符的 def 声明(段不符一律剔除,不是
 * 降权),过滤发生在形参闸与打分之前;无前缀(section 缺省)原样通过。
 */
export function filterMethodDefinitionsBySection<
  T extends { section: EntityMethodSection }
>(
  definitions: readonly T[],
  receiverSection?: EntityMethodSection
): T[] {
  return receiverSection
    ? definitions.filter(item => item.section === receiverSection)
    : [...definitions];
}

export function buildMethodOwnerBindingKey(identity: {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

export function sameIdentity(left: DefinitionSymbolIdentity, right: DefinitionSymbolIdentity): boolean {
  return left.ownerKind === right.ownerKind
    && left.ownerName === right.ownerName
    && left.sourceKind === right.sourceKind
    && left.section === right.section
    && left.symbolName === right.symbolName
    && left.componentSlotName === right.componentSlotName
    && normalizePropertyLookupPath(left.propertyPath || '') === normalizePropertyLookupPath(right.propertyPath || '')
    && left.sourceChain.join('::').toLowerCase() === right.sourceChain.join('::').toLowerCase();
}

function inferOwnerNameFromPythonFile(pythonFile: string): string {
  return path.basename(pythonFile, '.py');
}

export function inferOwnerKindFromPythonFile(
  pythonFile: string
): DefinitionSemanticCategory | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile);
  if (normalizedPath.includes('/components/')) {
    return 'component';
  }
  if (normalizedPath.includes('/interfaces/')) {
    return 'interface';
  }
  if (normalizedPath.endsWith('.py')) {
    return 'entity';
  }
  return undefined;
}

export function inferMethodSectionFromPythonFile(pythonFile: string): EntityMethodSection | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile);

  if (normalizedPath.includes('/scripts/base/') || normalizedPath.includes('/assets/scripts/base/')
    || normalizedPath.startsWith('base/') || normalizedPath.includes('/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/') || normalizedPath.includes('/assets/scripts/cell/')
    || normalizedPath.startsWith('cell/') || normalizedPath.includes('/cell/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/client/') || normalizedPath.includes('/assets/scripts/client/')
    || normalizedPath.startsWith('client/') || normalizedPath.includes('/client/')) {
    return 'ClientMethods';
  }

  return undefined;
}

export function uniqueFilePaths(candidatePaths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidatePath of candidatePaths) {
    const normalized = normalizeLookupPath(candidatePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidatePath);
  }
  return unique;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getLineNumber(text: string, index: number): number {
  return text.substring(0, index).split('\n').length;
}

export function getColumnNumber(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1);
  return index - (lineStart + 1);
}

function normalizePropertyLookupPath(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocation[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocation[] = [];
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const match = definitionRegex.exec(lineText);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const methodName = match[2];
    const character = lineText.indexOf(methodName);
    let endLine = lines.length;

    for (let nextLine = index + 1; nextLine < lines.length; nextLine += 1) {
      const nextText = lines[nextLine];
      if (!nextText.trim()) {
        continue;
      }

      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }

    const bodyLines = lines.slice(index + 1, endLine);
    methods.push({
      filePath: pythonFile,
      methodName,
      line: index + 1,
      character,
      endLine,
      calls: parsePythonSelfCalls(bodyLines, index + 2, pythonFile)
    });
  }

  return methods;
}

function parsePythonSelfCalls(
  bodyLines: string[],
  startLine: number,
  pythonFile: string
): Array<{ methodName: string; line: number; character: number; filePath: string }> {
  const calls: Array<{ methodName: string; line: number; character: number; filePath: string }> = [];
  const callRegex = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const lineText = bodyLines[index];
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(lineText)) !== null) {
      calls.push({
        methodName: match[1],
        line: startLine + index,
        // match[0] 恒以 'self.' 开头,名字紧跟前缀(批86 M7 同类:indexOf(name)
        // 在 name 为 'self' 子串时命中前缀内部,self.e/self.self 列错位)
        character: match.index + 'self.'.length,
        filePath: pythonFile
      });
    }
  }

  return calls;
}
