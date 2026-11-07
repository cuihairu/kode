// KODE-ARCH-001 pure-move split from the original languageProviders.ts (zero behavior change).
// KODE-ARCH-001 (in progress): providers are being moved to ./languageProviders/*
// in pure-move steps; this file keeps remaining code + re-exports the moved surface.

import * as path from 'path';
import * as vscode from 'vscode';
import { eventDefinitionAt } from './eventApi';
import { getScanRootForFile } from './scanRoots';
import { parsePythonFile, linearizeC3, isPythonCodePosition, getPythonBaseExpressionAtPosition, PythonClassIndex, PythonClassDef, PythonMethodLocation } from './pythonClassIndex';
import { DefElementNode, getDirectChildElements, getElementText, getLineNumberAt, parseDefDocument } from './defParser';
import { DEF_METHOD_MISSING_DIAGNOSTIC_CODE, KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND, buildMethodStubCode, type MethodStubBody } from './defMethodConsistency';
import { EntityMappingManager, EntityMethodSection } from './entityMapping';
import { buildPythonMethodSkeletonWithTypes, entityNameOfDefFile } from './defPythonParity';
import { METHOD_DECLARATION_PATTERN, buildRpcCodeLenses, defaultRpcCodeLensTitle, findPythonMethodDeclarations, RpcMethodHit } from './rpcCodeLens';
import { buildPropertyCodeLenses, findPythonSelfPropertyAccesses, propertyAccessKey, PropertyCodeLensHit } from './propertyCodeLens';
import { buildPropertyInitOrderLensSpecs } from './propertyInitOrderLens';
import { getTypeStorageUsageIndexReadOnly, indexTypeStorageUsageEntries, onTypeStorageUsageIndexPublished, TypeStorageUsage } from './databaseSchema';
import { findTypesXmlImplementedByReference, findEntityDefinitionFile, getDefinitionWorkspaceLayout, getEntityRuntimeProfile, getWorkspaceRootForDocument, resolveEntityAnnotationType } from './definitionWorkspace';
import { computeDefRenameEdits, findDefRenameConflict, findDefRenameConflictInClosure, getLineCharacterAtOffset, renameInputsDrifted, resolveRenameSymbolAtOffset, DefRenameFileEdits, RenameInputVersionRef } from './defRenamer';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { jumpLog, jumpTimeStart } from './navigationLog';
import { provideTypesXmlReferences } from './typesXmlReferences';
import { provideDefSymbolReferences } from './defSymbolReferences';
import { startLanguageServiceOperation } from './languageServiceMetrics';
import { findPythonReceiverCalls, getPythonReceiverCallAtPosition, PYTHON_RECEIVER_BY_SECTION, type PythonReceiverCall, getPythonSelfAccessAtPosition, getPythonMemberAccessAtPosition, type PythonMemberAccess } from './pythonLanguageUtils';
import { buildKbeStubDocument, buildKbeStubUriString, getKbeAliases, getKbeFromImportedSymbols, getKbeSymbol, getPythonClassBaseAtPosition, resolveKbeAccessAtPosition } from './kbeModuleIndex';
import { GlobalDataDictIndex, getDataDictAccessInCodeContext, getKbeDataDictAccessAtPosition, isKeyInsideLineComment, queryDataDictSitesForAccess, resolveScopeRoot, type KbeDataDictSite } from './globalDataIndex';
import { withInitialScanTimeout } from './hoverBudget';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from './sourceRevealCommand';
import { RECEIVER_NONE_DIAGNOSTIC_CODE, buildReceiverNoneGuardEdit, buildReceiverNoneWrapEdit } from './receiverNoneDiagnostics';
import { DEF_SYMBOL_SECTIONS, KBEngineSectionName, METHOD_SECTIONS, elementFullRange, elementTagRange, getLanguageFeatureConfig, getNodeValue, parseDefAst, toSectionName } from './languageProviders/shared';
import { UNKNOWN_TYPE_DIAGNOSTIC_CODE } from './languageProviders/validation';
import { findDefSymbolInfo, resolveDefMethodPythonTarget } from './languageProviders/navigation';
import { findRegisteredTypeSuggestions, getKnownTypeContext } from './languageProviders/completion';

/**
 * 层2 python-mro 开关(kbengine.python.enableMroJump,默认开;用户 2026-10-17:
 * mixin 函数导航要可关——上一轮实测行为异常时,先关掉隔离该层再排查)。
 * extension 激活时读取、配置变更时刷新(与 kbengine.jumpLog 同款接线);
 * 关闭时层2 只记 skip,不触发全仓扫描。
 */
export let pythonMroJumpEnabled = true;

export function setPythonMroJumpEnabled(enabled: boolean): void {
  pythonMroJumpEnabled = enabled;
}

export function isPythonMroJumpEnabled(): boolean {
  return pythonMroJumpEnabled;
}

/**
 * GLOBDATA-001 数据字典键索引开关(kbengine.python.enableDataDictIndex,
 * 默认开;2026-10-30 用户令的 globalData/baseAppData/cellAppData 键引用/
 * 跳转面)。extension 激活时读取、配置变更时刷新(与 enableMroJump 同款
 * 接线);关闭时 definition 前置层与 python 引用分支不查索引。
 */
export let pythonDataDictIndexEnabled = true;
// AUD-073(R4-F08):启用代际——开关每次实际翻转前进;在飞冷查询据此判断
// 等待期间开关是否被改过,改了则不发布旧结果(关闭/关→开代际都拦截)。
export let pythonDataDictIndexGeneration = 0;

export function setPythonDataDictIndexEnabled(enabled: boolean): void {
  if (pythonDataDictIndexEnabled !== enabled) {
    pythonDataDictIndexEnabled = enabled;
    pythonDataDictIndexGeneration += 1;
  }
}

export function isPythonDataDictIndexEnabled(): boolean {
  return pythonDataDictIndexEnabled;
}

export function getPythonDataDictIndexGeneration(): number {
  return pythonDataDictIndexGeneration;
}

// AUD-072(R4-F07):冷索引等待可取消——旧实现先 await 全量 ensureStarted
// 再查 token,初扫在飞时取消要等整轮扫描结束才返回。改为竞速:取消信号先
// 到即放行当前调用(返回 false,不再查索引),共享初扫原样继续服务其他请求
// (单次取消不中止、不破坏索引);初扫先到仍复检取消。返回 false = 已取消,
// 调用方应停止后续查找工作。
export async function awaitDataDictIndexReady(
  index: GlobalDataDictIndex,
  token?: vscode.CancellationToken
): Promise<boolean> {
  if (token?.isCancellationRequested) {
    return false;
  }
  const starting = index.ensureStarted();
  if (!token) {
    await starting;
    return true;
  }
  let onDone: (() => void) | undefined;
  // 取消订阅面缺失(手写桩 token 只有旗标)→ 退化为先检后检,不竞速
  if (typeof token.onCancellationRequested !== 'function') {
    await starting;
    return !token.isCancellationRequested;
  }
  const cancelWins = new Promise<null>(resolve => {
    const d = token.onCancellationRequested(() => resolve(null));
    onDone = () => d.dispose();
  });
  try {
    const winner = await Promise.race([
      starting.then(() => 'ready' as const),
      cancelWins
    ]);
    if (winner === null) {
      return false;
    }
    return !token.isCancellationRequested;
  } finally {
    onDone?.();
  }
}

/**
 * 数据字典键定位的共享实现:落点命中字典键访问时,经签名归一索引取同键
 * 族全部写+读点。definition(跳首个异类点)与 references(全量)同源,
 * 索引未装配或未启用返回 null。
 */
export async function resolveDataDictSitesAtPosition(
  dataDictIndex: GlobalDataDictIndex | undefined,
  document: vscode.TextDocument,
  position: vscode.Position,
  token?: vscode.CancellationToken
): Promise<{ access: NonNullable<ReturnType<typeof getKbeDataDictAccessAtPosition>>; sites: KbeDataDictSite[] } | null> {
  if (!dataDictIndex || !isPythonDataDictIndexEnabled()) {
    return null;
  }
  // AUD-073:发布前复核启用代际——等待期间开关被改过(关闭或关→开)则
  // 结果是过期的,不放行(在飞查询不发布旧结果)。
  const enabledGeneration = getPythonDataDictIndexGeneration();
  // AUD-075(R4-F10):捕获查询时源文档身份/版本——冷索引等待后复核,源被
  // 编辑(版本前进)、关闭(isClosed)或换文档(URI 变)则当前上下文过期,
  // 不按旧光标上下文发布跳转。
  const sourceUri = document.uri.toString();
  const sourceVersion = document.version;
  // AUD-066:冷查前验证源访问的词法上下文——alias.dict 段须在全文代码域,
  // 跨行三引号/外层字符串/注释里的伪访问不启动全量索引、不返回定义/引用。
  const access = getDataDictAccessInCodeContext(
    document.getText(),
    position.line,
    position.character,
    getKbeAliases(document.getText())
  );
  if (!access) {
    return null;
  }
  // AUD-072:冷索引等待可取消——取消即放行,不查索引(共享初扫继续)。
  if (!(await awaitDataDictIndexReady(dataDictIndex, token))) {
    return null;
  }
  if (getPythonDataDictIndexGeneration() !== enabledGeneration) {
    return null;
  }
  if (
    document.uri.toString() !== sourceUri ||
    document.version !== sourceVersion ||
    document.isClosed
  ) {
    return null;
  }
  // AUD-068:查询带根身份——跨进程字典不跨工程共享命名空间,同根内互链。
  // 函数调用键(callFn)→ 现解签名取并集;普通键走单键查询。
  return {
    access,
    sites: queryDataDictSitesForAccess(
      dataDictIndex,
      access,
      resolveScopeRoot(document.uri.fsPath)
    )
  };
}

/**
 * 跳转分层追踪(用户 2026-10-16「放弃范围必须逐层收窄,对象级不是文件级」):
 * 记录本次跳转查过的每一层与命中/落空原因,全部落空时可据此说明「查过哪些层」。
 */
export interface JumpLayerTrace {
  /**
   * entity-def = .def 派生索引(对象级类粒度 → 文件级 owner 归属两个子探);
   * python-mro = PythonClassIndex 跨文件 C3-MRO + 组合根;
   * file-scope = 当前文件类作用域 / 本文件 MRO;
   * kbe-stub / class-base / types-reverse / globaldata-key = 前置契约分支
   * (命中即终点);globaldata-key = 数据字典键跨进程互链(GLOBDATA-001);
   * member-access = 非 self 接收者成员调用(avatar.SendErrorInfo,批158);
   * context = 入参形态判定(既非 self 访问/成员调用也非方法声明)。
   */
  layer:
    | 'kbe-stub'
    | 'class-base'
    | 'types-reverse'
    | 'globaldata-key'
    | 'entity-def'
    | 'python-mro'
    | 'file-scope'
    | 'member-access'
    | 'context';
  /** 本层查询的符号(方法层为光标所在段/声明名,非根符号) */
  query: string;
  /** partial = 预算到期枚举不完整(IDE-IDX-018,python-mro 层),非权威 miss */
  status: 'hit' | 'miss' | 'skip' | 'partial';
  /** 命中落点或落空原因(object=<类名>/file=<文件名> 子探结果、异常等) */
  detail?: string;
}

export interface TracedDefinitionResult {
  location: vscode.Location | vscode.Location[] | null;
  layers: JumpLayerTrace[];
}

export const cancelledDefinitionResult = (): TracedDefinitionResult => ({
  location: null,
  layers: [{ layer: 'context', query: '', status: 'skip', detail: 'cancelled' }]
});

export const layerErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const describeMethodLocation = (candidate: PythonMethodLocation): string =>
  `${path.basename(candidate.filePath)}:${candidate.line + 1}` +
  (candidate.compositionRoot ? ` (root=${candidate.compositionRoot})` : '');

export const toDefinitionLocation = (candidate: PythonMethodLocation): vscode.Location =>
  new vscode.Location(
    vscode.Uri.file(candidate.filePath),
    new vscode.Position(candidate.line, candidate.character)
  );

/** IDE-REV-033:测试面在途闸——定义跳转 provider 过入口守卫后、任何结果
 * 产出前的确定性在途窗口(语义与 REV-032 hover 闸同款:生产恒 null,零行为
 * 差异;释放方顺手清闸)。provider 为 async 方法,门内直接 await,放行后
 * 重查取消——晚到的取消不再触发任何查找工作(无晚到结果发布)。 */
export let definitionInFlightGateForTests: (() => Promise<void>) | null = null;

export function setDefinitionInFlightGateForTests(gate: (() => Promise<void>) | null): void {
  definitionInFlightGateForTests = gate;
}

/** IDE-AUD-016(F14/IDE-REV-033 深审):测试面派发后闸——层1 entity-def 方法
 * 探针 `await probe.run()` 返回后、取消复查前的确定性窗口。此刻真实 def 依赖
 * 链已派发(定向 glob/解析/索引解析在探针内执行并返回),门住=「真实工作已
 * 启动」的在途证明面;放行后由既有取消复查收口(取消即不再进后续层/晚到
 * 结果)。与入口闸(definitionInFlightGateForTests)互补:入口闸证明「进
 * provider 后取消零工作」,本闸证明「真实链已派发后取消,链在下一观测点停」。
 * 生产恒 null,零行为差异。 */
export let definitionDispatchGateForTests: (() => Promise<void>) | null = null;

export function setDefinitionDispatchGateForTests(gate: (() => Promise<void>) | null): void {
  definitionDispatchGateForTests = gate;
}

export class PythonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    // mixin/跨类跳转根因修复:.def 派生索引解析不到时(非实体文件或方法不在
    // 任何 .def),回退 Python 类层级 C3-MRO 解析 —— entityMapping.ts:573
    // 对非 .def 映射文件直接 return null 即丢定位处。
    private pythonClassIndex?: PythonClassIndex,
    // GLOBDATA-001:数据字典键索引(单例,extension 装配);未注入则前置层跳过
    private dataDictIndex?: GlobalDataDictIndex
  ) {}

  /**
   * VS Code 定义跳转入口:落点即分层解析的首个命中(层序见 provideDefinitionTraced)。
   */
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location | vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    if (definitionInFlightGateForTests) {
      // IDE-REV-033:门住确定性在途窗口;放行后重查取消,取消即零工作返回
      await definitionInFlightGateForTests();
      if (token?.isCancellationRequested) { return null; }
    }
    const eventLocation = await eventDefinitionAt(document, position, this.entityMappingManager);
    if (token?.isCancellationRequested) { return null; }
    if (eventLocation) return eventLocation;
    return (await this.provideDefinitionTraced(document, position, token)).location;
  }

  /**
   * 分层追踪入口。放弃范围逐层收窄(用户 2026-10-16):
   * 前置契约分支(kbe 桩 / 类基类 / types implementedBy 反查,命中即终点)后,
   * 层1 entity-def:.def 派生索引,先对象级(类粒度)再文件级(owner 归属);
   * 层2 python-mro:PythonClassIndex 跨文件 C3-MRO + 组合根(异常降级落空,不断链);
   * 层3 file-scope:当前文件类作用域 / 本文件 MRO;
   * 属性访问和方法声明优先 .def；方法使用优先 Python 实现，找不到再回 .def；
   * 每层命中/落空/未执行与原因记入 layers,供测试与排障说明「查过哪些层」。
   */
  async provideDefinitionTraced(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    // PR1 打点:semantic-query = 分层语义解析全链路耗时(层序实现见
    // provideDefinitionTracedImpl),location 命中 → ok,落空 → miss;
    // 打点不改任何查找顺序与返回值。
    const metrics = startLanguageServiceOperation('semantic-query', {
      fileKind: 'python',
      documentVersion: document.version
    });
    try {
      const traced = await this.provideDefinitionTracedImpl(document, position, token);
      if (token?.isCancellationRequested) {
        metrics.end('cancelled');
        return cancelledDefinitionResult();
      }
      metrics.end(traced.location ? 'ok' : 'miss');
      return traced;
    } catch (error) {
      metrics.end('error');
      throw error;
    }
  }

  private async provideDefinitionTracedImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    if (token?.isCancellationRequested) {
      return cancelledDefinitionResult();
    }
    const line = document.lineAt(position.line);

    // GLOBDATA-001:KBEngine.globalData/baseAppData/cellAppData 字典键跨进程
    // 互链。置于 isPythonCodePosition 守卫之前:键表达式可能是字符串字面量
    // (get("cfg") 的 cfg),该守卫会把字符串内位置判为 skip,字典键因此
    // 到不了层链;注释里的假访问由行内注释检查排除。落点命中键表达式时,
    // 经签名归一索引把键族内的写/读点互链:读点 F12 → 首个写点;写点 F12
    // → 首个异类同键点;无同键异类点则同键同类首点;键族无任何点(仅自身)
    // 交回常规链。
    if (isPythonDataDictIndexEnabled() && this.dataDictIndex) {
      const dataDictHit = await resolveDataDictSitesAtPosition(
        this.dataDictIndex,
        document,
        position,
        token
      );
      if (dataDictHit && !isKeyInsideLineComment(line.text, dataDictHit.access.keyStart)) {
        const { access, sites } = dataDictHit;
        const keyLabel = access.callFn ? `${access.callFn}(...)` : access.keySignature;
        const otherKind = access.kind === 'write' ? 'read' : 'write';
        const target =
          sites.find(site => site.kind === otherKind) ??
          sites.find(site => site.kind === access.kind);
        if (target) {
          jumpLog('info', () =>
            `前置命中 globaldata-key:${access.dict}[${keyLabel}] ${access.kind} → ` +
            `${path.basename(target.file)}:${target.line + 1}`
          );
          return {
            location: new vscode.Location(
              vscode.Uri.file(target.file),
              new vscode.Position(target.line, target.keyStart)
            ),
            layers: [{
              layer: 'globaldata-key',
              query: `${access.dict}[${keyLabel}]`,
              status: 'hit',
              detail: `${access.kind} → ${path.basename(target.file)}:${target.line + 1}`
            }]
          };
        }
      }
    }

    // AUD-072(R4-F07):冷查取消即停——初扫等待取消返回 null 后不再沿
    // entity-def/python-mro 等重层继续查找(放闸前返回,零继续工作)。
    if (token?.isCancellationRequested) {
      return cancelledDefinitionResult();
    }

    if (!isPythonCodePosition(document.getText(), position.line, position.character)) {
      return { location: null, layers: [{ layer: 'context', query: '', status: 'skip', detail: 'comment or string literal' }] };
    }
    jumpLog('info', () =>
      `F12 ${document.fileName}:${position.line + 1}:${position.character + 1} ` +
        `行="${line.text.trim().slice(0, 160)}"`
    );

    // kbe/KBEngine 模块符号(批108):别名已在文档引入且 position 落在
    // 模块符号上时,跳到内置桩文档的对应声明行。未引入或非模块面访问
    // (self.kbe 之类)时交回下方实体属性/方法链路。
    const kbeAccess = resolveKbeAccessAtPosition(
      line.text,
      position.character,
      getKbeAliases(document.getText())
    );
    if (kbeAccess && getKbeSymbol(kbeAccess.symbol)) {
      const stub = buildKbeStubDocument();
      jumpLog('info', () => `前置命中 kbe-stub:${kbeAccess.symbol} → 内置桩`);
      return {
        location: new vscode.Location(
          vscode.Uri.parse(buildKbeStubUriString()),
          new vscode.Position(stub.symbolLines[kbeAccess.symbol], 0)
        ),
        layers: [{ layer: 'kbe-stub', query: kbeAccess.symbol, status: 'hit', detail: 'kbe module stub' }]
      };
    }

    // 类继承头基类(批109):class X(Base) 行,光标落在基类标识符上时沿
    // 注册链解析——①from-import 引入的 kbe 符号走内置桩文档;②登记实体走
    // entities.xml 链(def 文件优先,纯脚本实体回落 scripts/{base,cell,
    // client}/<Name>.py,与引擎同名类注册口径一致,见 docs/source-analysis.md
    // 第五节 D5/D7)。都未命中则交回下方 self 属性/方法链路与 python 扩展。
    const classBase = getPythonClassBaseAtPosition(line.text, position.character);
    const pythonBase = getPythonBaseExpressionAtPosition(document.getText(), position.line, position.character);
    const baseImports = pythonBase ? parsePythonFile(document.getText(), document.fileName).imports : undefined;
    const explicitlyImportedBase = !!pythonBase && baseImports?.has(pythonBase.split('.')[0]) === true;
    if (classBase) {
      const fromImports = getKbeFromImportedSymbols(document.getText());
      if (fromImports.has(classBase) && getKbeSymbol(classBase)) {
        const stub = buildKbeStubDocument();
        jumpLog('info', () => `前置命中 class-base:${classBase} → kbe from-import 桩`);
        return {
          location: new vscode.Location(
            vscode.Uri.parse(buildKbeStubUriString()),
            new vscode.Position(stub.symbolLines[classBase], 0)
          ),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: 'kbe from-import stub' }]
        };
      }

    }

    // An explicit Python import binds the class name to that module. Resolve it
    // before KBEngine's basename-based .def/entity fallback, which can otherwise
    // send an aliased mixin to an unrelated entity with the same name.
    if (pythonBase && explicitlyImportedBase && this.pythonClassIndex && isPythonMroJumpEnabled()) {
      try {
        const base = await this.pythonClassIndex.resolveClassBase(document, pythonBase, position.line, token);
        if (base) {
          return {
            location: new vscode.Location(vscode.Uri.file(base.filePath), new vscode.Position(base.startLine, 0)),
            layers: [{ layer: 'class-base', query: pythonBase, status: 'hit', detail: `Python class ${base.qualifiedName ?? base.name}` }]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `Python base lookup failed: ${layerErrorMessage(error)}`);
      }
    }

    if (classBase && !explicitlyImportedBase) {
      const baseDefPath = findEntityDefinitionFile(classBase, document);
      if (baseDefPath) {
        jumpLog('info', () => `前置命中 class-base:${classBase} → 实体 def ${path.basename(baseDefPath)}`);
        return {
          location: new vscode.Location(vscode.Uri.file(baseDefPath), new vscode.Position(0, 0)),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: `entity def ${path.basename(baseDefPath)}` }]
        };
      }

      const baseProfile = getEntityRuntimeProfile(classBase, document);
      const baseScriptPath =
        baseProfile?.base.scriptPath || baseProfile?.cell.scriptPath || baseProfile?.client.scriptPath;
      if (baseScriptPath) {
        jumpLog('info', () => `前置命中 class-base:${classBase} → 实体脚本 ${path.basename(baseScriptPath)}`);
        return {
          location: new vscode.Location(vscode.Uri.file(baseScriptPath), new vscode.Position(0, 0)),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: `entity script ${path.basename(baseScriptPath)}` }]
        };
      }
    }

    if (pythonBase && !explicitlyImportedBase && this.pythonClassIndex && isPythonMroJumpEnabled()) {
      try {
        const base = await this.pythonClassIndex.resolveClassBase(document, pythonBase, position.line, token);
        if (base) {
          return {
            location: new vscode.Location(vscode.Uri.file(base.filePath), new vscode.Position(base.startLine, 0)),
            layers: [{ layer: 'class-base', query: pythonBase, status: 'hit', detail: `Python class ${base.qualifiedName ?? base.name}` }]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `Python base lookup failed: ${layerErrorMessage(error)}`);
      }
    }

    // types.xml implementedBy 反向跳转:光标落在被 types.xml 引用的符号上
    // (class/def/赋值或任意使用处)时跳回 implementedBy 行——正向跳得到
    // 去,反向跳得回来。模块按快照 pythonFilePath 比对定,不猜文件名。
    const reverseWorkspaceRoot =
      getWorkspaceRootForDocument(document) || getScanRootForFile(document.fileName);
    if (reverseWorkspaceRoot) {
      const reverseWordRange = document.getWordRangeAtPosition(position, /\w+/);
      if (reverseWordRange) {
        const reference = findTypesXmlImplementedByReference(
          reverseWorkspaceRoot,
          document.fileName,
          document.getText(reverseWordRange)
        );
        if (reference) {
          jumpLog('info', () => `前置命中 types-reverse:${document.getText(reverseWordRange)} → ${reference.filePath}:${reference.line}`);
          return {
            location: new vscode.Location(
              vscode.Uri.file(reference.filePath),
              new vscode.Position(reference.line - 1, 0)
            ),
            layers: [{
              layer: 'types-reverse',
              query: document.getText(reverseWordRange),
              status: 'hit',
              detail: `${path.basename(reference.filePath)}:${reference.line}`
            }]
          };
        }
      }
    }

    const access = getPythonSelfAccessAtPosition(line.text, position.character);
    const declaredMethodName = getPythonMethodDeclarationAtPosition(line.text, position.character);
    // 接收者感知(用户令 2026-10-21):光标落在 self.cell./self.base./self.client.
    // 的方法名上时,候选先按段过滤(CellMethods/BaseMethods/ClientMethods),
    // 段不符不跳;链前缀只认 self. 形态,解析自调用行文本。
    // kbengine.entity.receiverSections=false → 回归不感知段的旧解析(不传
    // receiver);形参/类型闸门是纠错不是增强,不随此开关关闭。
    const receiverCall =
      access && getLanguageFeatureConfig().entityReceiverSections
        ? getPythonReceiverCallAtPosition(line.text, position.character)
        : null;
    if (access) {
      const accessResult = await this.runDefinitionLayers(document, position, access, null, receiverCall ?? undefined, token);
      if (accessResult.location) {
        return accessResult;
      }
      // 光标行同时是方法声明的交叠形态:再走声明层序,层记录合并
      // (两判定取位互斥,交叠臂无触发输入:声明面 getPythonMethodDeclarationAtPosition
      // 要求光标落在 def 名 token 上(rpcCodeLens.ts:49 模式锚定 `def\s+name`),
      // self 访问面 getPythonSelfAccessAtPosition 要求光标落在 self.成员段内,
      // 同一光标不可同时满足;tests/pythonLanguageUtils.test.ts 锁死 self 访问取位界)
      /* istanbul ignore start */
      if (declaredMethodName) {
        const declaredResult = await this.runDefinitionLayers(document, position, null, declaredMethodName, undefined, token);
        return {
          location: declaredResult.location,
          layers: [...accessResult.layers, ...declaredResult.layers]
        };
      }
      /* istanbul ignore stop */
      return accessResult;
    }
    if (declaredMethodName) {
      return this.runDefinitionLayers(document, position, null, declaredMethodName, undefined, token);
    }
    // 批158(用户令 2026-10-26):非 self 接收者的成员调用 avatar.SendErrorInfo(...)
    // 不再直接放弃。旧口径在 context 层返回 null(用户实测「精确跳转不行」的根因);
    // 新增 member-access 层:接收者名 → 全项目唯一同名 .def 实体 → 方法声明行;
    // 无同名实体时不误跳,维持 null(仅层记录不同)。
    const memberAccess = getPythonMemberAccessAtPosition(line.text, position.character);
    if (memberAccess) {
      return this.resolveMemberAccess(document, memberAccess);
    }
    jumpLog('info', () => '跳转放弃: 光标既非 self 访问/成员调用也非方法声明(context)');
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    return {
      location: null,
      layers: [
        {
          layer: 'context',
          query: wordRange ? document.getText(wordRange) : '',
          status: 'miss',
          detail: 'position is neither self access nor method declaration'
        }
      ]
    };
  }

  /**
   * 批158 member-access 层:非 self 接收者成员调用的定义解析
   * (avatar.SendErrorInfo)。接收者名在 KBEngine 语义里即实体名(实体变量命名
   * 惯例与实体同名,如 avatar: Avatar);解析链:
   * ①全项目唯一同名 .def 实体(Avatar.def)→ 该 def 内方法声明行(段不过滤,
   *   方法在 Base/Cell/Client 任一段都算命中);
   * ②接收者名同时是当前文件内可见的 Python 类名(同文件/import)且该类有同名
   *   方法 → 类声明处。
   * 找不到同名实体/类时不误跳(返回 null + 层记录),绝不静默落别的实体。
   */
  private async resolveMemberAccess(
    document: vscode.TextDocument,
    access: PythonMemberAccess
  ): Promise<TracedDefinitionResult> {
    const query = access.memberName;
    jumpLog('info', () => `member-access 层: ${access.fullPath}(接收者=${access.receiverName})`);

    // ① 接收者名 → 同名实体 def 的方法声明(对象级,复用类粒度 API)。
    // KBEngine 变量命名惯例:实体变量小驼峰(avatar)与实体名帕斯卡(Avatar)
    // 同形,精确名未命中时按首字母大写变体再试一次;两者都不中不误跳。
    const entityCandidates = [access.receiverName];
    const capitalized = access.receiverName.charAt(0).toUpperCase() + access.receiverName.slice(1);
    if (capitalized !== access.receiverName) {
      entityCandidates.push(capitalized);
    }
    let defHit: { defFile: string; line: number } | null = null;
    let matchedEntity = access.receiverName;
    for (const candidate of entityCandidates) {
      const hit = await this.entityMappingManager.resolveMethodDefinitionForClass(
        candidate,
        query,
        undefined,
        document.fileName
      );
      if (hit) {
        defHit = hit;
        matchedEntity = candidate;
        break;
      }
    }
    if (defHit) {
      const hitFile = defHit.defFile;
      const hitLine = defHit.line;
      jumpLog('info', () =>
        `member-access 命中 def: ${path.basename(hitFile)}:${hitLine}`
      );
      return {
        location: new vscode.Location(
          vscode.Uri.file(hitFile),
          new vscode.Position(Math.max(hitLine - 1, 0), 0)
        ),
        layers: [
          {
            layer: 'member-access',
            query,
            status: 'hit',
            detail: `entity=${matchedEntity} def=${path.basename(hitFile)}:${hitLine}`
          }
        ]
      };
    }

    // ② 接收者名 = 当前文件内可见类名 → 同名方法声明(本文件作用域)。
    // IDE-IDX-017:答案本就只来自当前文档(旧路径取索引同文件类后仍重解析
    // 现文档复核),改为直查当前文件快照——不经 findClassesByName 的
    // ensureScanned,全仓扫描挂起时同文件 Class.method 跳转不受拖累。
    if (this.pythonClassIndex) {
      try {
        const parsed = parsePythonFile(document.getText(), document.fileName);
        const cls = parsed.classes.find(item => item.name === access.receiverName);
        const method = cls?.methods.get(query);
        if (method) {
          jumpLog('info', () =>
            `member-access 命中类: ${access.receiverName}.${query} @ ${path.basename(document.fileName)}:${method.line + 1}`
          );
          return {
            location: new vscode.Location(
              vscode.Uri.file(document.fileName),
              new vscode.Position(method.line, method.character)
            ),
            layers: [
              {
                layer: 'member-access',
                query,
                status: 'hit',
                detail: `class=${access.receiverName}.${query}`
              }
            ]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `member-access 类回退失败: ${layerErrorMessage(error)}`);
      }
    }

    jumpLog('info', () => `member-access 落空: ${access.fullPath}(无同名实体/类方法)`);
    return {
      location: null,
      layers: [
        {
          layer: 'member-access',
          query,
          status: 'miss',
          detail: `receiver=${access.receiverName} has no matching entity def or class method`
        }
      ]
    };
  }

  /**
   * 属性声明优先；方法使用先尝试 Python 实现，再回退 .def 声明。
   * 多段访问必须有 receiver 类型证据，不能把 obj.method 当成 self.method。
   */
  private async runDefinitionLayers(
    document: vscode.TextDocument,
    position: vscode.Position,
    access: { rootSymbol: string; currentSymbol: string; fullPath: string } | null,
    declaredMethodName: string | null,
    receiver?: PythonReceiverCall,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
    const manager = this.entityMappingManager;
    // 查询符号 = 光标所在段(方法层不再查根符号——根对象不在 .def 时不连带断链);
    // 属性子探的完整访问路径(可能多段)记入 detail。
    const symbol = access ? access.currentSymbol : (declaredMethodName as string);
    const query = symbol;
    const basename = path.basename(document.fileName);
    const layers: JumpLayerTrace[] = [];
    const totalTimer = jumpTimeStart();

    // 对象上下文:光标所在类 —— 对象级 .def 判定的输入。直接解析当前文档
    // 文本(单文件,不触发 PythonClassIndex 的全仓扫描:.def 命中路径因此
    // 保持与旧实现同量级,不因对象级探而变慢);取不到不中断(退化文件级)。
    let enclosingName: string | undefined;
    let enclosingNote = '';
    try {
      const parsed = parsePythonFile(document.getText(), document.fileName);
      const enclosing = parsed.classes
        .filter(cls => position.line >= cls.startLine && position.line < cls.endLine)
        .sort((left, right) => right.startLine - left.startLine)[0];
      if (enclosing) {
        enclosingName = enclosing.name;
      } else {
        enclosingNote = 'no enclosing class';
      }
    } catch (error) {
      enclosingNote = `enclosing class error: ${layerErrorMessage(error)}`;
    }
    jumpLog('info', () =>
      `解析开始 query=${symbol} 文件=${basename}:${position.line + 1} ` +
        `对象类=${enclosingName ?? `(无:${enclosingNote})`}`
    );
    const defTimer = jumpTimeStart();

    // ── 层0 接收者段闸(用户令 2026-10-21):self.cell./self.base./self.client.
    // 调用的候选只认对应区块(CellMethods/BaseMethods/ClientMethods)的 def 声明,
    // 段不符不跳;属性子探不做(接收者段不是属性),段过滤先行于一切后续闸。
    // 实现层(python-mro/file-scope)不感知段,命中段内声明后直接落 def 声明行。
    if (receiver) {
      const receiverParts: string[] = [`receiver=self.${receiver.receiver} → ${receiver.section}`];
      const receiverProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        receiverProbes.push({
          via: `object=${enclosingName}`,
          run: () =>
            manager.resolveMethodDefinitionForClass(
              enclosingName as string,
              symbol,
              receiver.section,
              document.fileName
            )
        });
      }
      receiverProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolveMethodDefinition(document.fileName, symbol, receiver.section)
      });
      for (const probe of receiverProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          receiverParts.push(`method ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          const hitLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          receiverParts.push(`method ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          jumpLog('info', () =>
            `层0 接收者段闸命中(${receiver.section}) → ${hitLocation.uri.fsPath}:${hitLocation.range.start.line + 1} ${defTimer()}ms`
          );
          return {
            location: hitLocation,
            layers: [{ layer: 'entity-def', query, status: 'hit', detail: receiverParts.join('; ') }]
          };
        }
        receiverParts.push(`method ${probe.via} miss`);
      }
      jumpLog('info', () =>
        `层0 接收者段闸落空(${receiver.section} 无候选) ${defTimer()}ms`
      );
      return {
        location: null,
        layers: [{ layer: 'entity-def', query, status: 'miss', detail: receiverParts.join('; ') }]
      };
    }

    // ── 层1 entity-def:对象级(类粒度)→ 文件级(owner 归属);属性子探在前(契约) ──
    const defParts: string[] = [];
    let defLocation: vscode.Location | null = null;
    let propertyHit = false;

    if (access) {
      const propertyProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        propertyProbes.push({
          via: `object=${enclosingName}`,
          run: () =>
            manager.resolvePropertyDefinitionForClass(
              enclosingName as string,
              access.fullPath,
              access.rootSymbol,
              document.fileName
            )
        });
      }
      propertyProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolvePropertyDefinition(document.fileName, access.fullPath, access.rootSymbol)
      });
      for (const probe of propertyProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          defParts.push(`property(${access.fullPath}) ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          defLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          // 属性访问的定义 = def 的属性声明行(defLocation);类型的声明
          // (types.xml)不是属性访问的定义——按 def 里的类型名才该去那里,
          // 故不再优先类型声明(2026-11-04 用户反馈纠正)。
          const managerWithScan = manager as EntityMappingManager & { waitForInitialScan?: () => Promise<void> };
          if (managerWithScan.waitForInitialScan) {
            // 首扫超时闸(用户令 2026-10-22):大树首扫可秒级+,不拖死跳转层
            await withInitialScanTimeout(managerWithScan.waitForInitialScan(), undefined, token);
            if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
          }
          propertyHit = true;
          defParts.push(`property(${access.fullPath}) ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          break;
        }
        defParts.push(`property(${access.fullPath}) ${probe.via} miss`);
      }
    }

    // A member of self.component is not a method on self. Until its receiver
    // type is known, leave it to the Python language server rather than guessing.
    if (!defLocation && access && access.currentSymbol !== access.rootSymbol) {
      return { location: null, layers: [{ layer: 'entity-def', query, status: 'miss',
        detail: 'nested receiver type is unknown; ' + defParts.join('; ') }] };
    }

    if (!defLocation) {
      const methodProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        methodProbes.push({
          via: `object=${enclosingName}`,
          run: () => manager.resolveMethodDefinitionForClass(enclosingName as string, symbol, undefined, document.fileName)
        });
      }
      methodProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolveMethodDefinition(document.fileName, symbol)
      });
      for (const probe of methodProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          defParts.push(`method ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (definitionDispatchGateForTests) {
          // IDE-AUD-016:真实 def 依赖链已派发(探针 await 返回)后门住,放行由
          // 下方既有取消复查收口——取消落在此窗口=「真实工作已启动后的中止」
          await definitionDispatchGateForTests();
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          defLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          defParts.push(`method ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          break;
        }
        defParts.push(`method ${probe.via} miss`);
      }
    }

    const implementationFirst = !!access && !propertyHit;
    if (defLocation && !implementationFirst) {
      const detail = defParts.join('; ');
      // 闭包内 TS 不收窄 let:命中位置先固化为 const 再进日志闭包
      const hitLocation = defLocation;
      layers.push({ layer: 'entity-def', query, status: 'hit', detail });
      jumpLog('info', () =>
        `层1 entity-def 命中 → ${hitLocation.uri.fsPath}:${hitLocation.range.start.line + 1}` +
          `(${detail.slice(0, 200)}) ${defTimer()}ms`
      );
      return { location: defLocation, layers };
    }
    const defDetail = defParts.join('; ') || enclosingNote || 'no .def index';
    layers.push({
      layer: 'entity-def',
      query,
      status: defLocation ? 'skip' : 'miss',
      detail: defLocation ? `deferred method declaration; ${defDetail}` : defDetail
    });
    jumpLog('info', () => `层1 entity-def ${defLocation ? '暂存方法声明，先查实现' : '落空'}(${defDetail.slice(0, 200)}) ${defTimer()}ms`);
    const pyTimer = jumpTimeStart();

    // ── 层2 python-mro:跨文件 MRO + 组合根;异常降级为落空,绝不在本层断链 ──
    if (!isPythonMroJumpEnabled()) {
      layers.push({ layer: 'python-mro', query: symbol, status: 'skip', detail: 'disabled by kbengine.python.enableMroJump' });
      jumpLog('info', () => '层2 python-mro 跳过(设置关闭)');
    } else if (!this.pythonClassIndex) {
      layers.push({ layer: 'python-mro', query: symbol, status: 'skip', detail: 'python class index unavailable' });
      jumpLog('info', () => '层2 python-mro 跳过(索引未注入)');
    } else {
      try {
        // IDE-IDX-018:取带 partial 标记的完整结果——预算到期只拿到静态目标时
        // 不得把这枚(可能是空的)候选集发布成完整枚举的权威负结论。
        const resolution = await this.pythonClassIndex.resolveSelfMethodResolution(
          document.fileName,
          position.line,
          symbol,
          document,
          token
        );
        const resolved = resolution.candidates;
        const partialNote = resolution.partial ? ' (partial: budget expired)' : '';
        const candidates = declaredMethodName ? resolved.filter(candidate =>
          candidate.filePath !== document.fileName || candidate.line !== position.line) : resolved;
        if (candidates.length === 1) {
          const detail = describeMethodLocation(candidates[0]) + partialNote;
          layers.push({ layer: 'python-mro', query: symbol, status: 'hit', detail });
          jumpLog('info', () =>
            `层2 python-mro 命中 → ${candidates[0].filePath}:${candidates[0].line + 1}` +
              `(${detail.slice(0, 160)}) ${pyTimer()}ms`
          );
          return { location: toDefinitionLocation(candidates[0]), layers };
        }
        if (candidates.length > 1) {
          layers.push({
            layer: 'python-mro',
            query: symbol,
            status: 'hit',
            detail: `${candidates.length} candidates: ${candidates.map(describeMethodLocation).join(', ')}${partialNote}`
          });
          jumpLog('info', () =>
            `层2 python-mro 命中 ${candidates.length} 候选 → [${candidates
              .map(describeMethodLocation)
              .join(' | ')
              .slice(0, 300)}] ${pyTimer()}ms`
          );
          return { location: candidates.map(toDefinitionLocation), layers };
        }
        if (resolution.partial) {
          // IDE-IDX-018:预算到期枚举不完整——落空不是权威负结论,记 partial,
          // 继续走后续层兜底;下次查询预算/索引就绪后自然补齐。
          layers.push({
            layer: 'python-mro',
            query: symbol,
            status: 'partial',
            detail: 'budget expired before full enumeration'
          });
          jumpLog('info', () => `层2 python-mro 预算到期,记 partial 不作权威落空 ${pyTimer()}ms`);
        } else {
          const missDetail = enclosingName
            ? 'no provider in mro/composition-roots/descendants'
            : enclosingNote || 'no enclosing class';
          layers.push({ layer: 'python-mro', query: symbol, status: 'miss', detail: missDetail });
          jumpLog('info', () => `层2 python-mro 落空(${missDetail}) ${pyTimer()}ms`);
        }
      } catch (error) {
        const missDetail = `error: ${layerErrorMessage(error)}`;
        layers.push({ layer: 'python-mro', query: symbol, status: 'miss', detail: missDetail });
        jumpLog('info', () => `层2 python-mro 异常降级为落空(${missDetail.slice(0, 160)})`);
      }
    }
    const fileScopeTimer = jumpTimeStart();

    // ── 层3 file-scope:当前文件类作用域 / 本文件 MRO(索引缺此文件时的兜底) ──
    try {
      const fileScope = this.resolveFileScope(document, position.line, symbol, declaredMethodName !== null);
      layers.push({
        layer: 'file-scope',
        query: symbol,
        status: fileScope.location ? 'hit' : 'miss',
        detail: fileScope.detail
      });
      if (fileScope.location) {
        // 闭包内 TS 不收窄:命中行先固化为 const 再进日志闭包
        const hitLine = (Array.isArray(fileScope.location) ? fileScope.location[0] : fileScope.location).range.start.line;
        jumpLog('info', () =>
          `层3 file-scope 命中 → ${document.fileName}:${hitLine + 1}` +
            `(${fileScope.detail.slice(0, 160)}) ${fileScopeTimer()}ms`
        );
        return { location: fileScope.location, layers };
      }
      jumpLog('info', () => `层3 file-scope 落空(${fileScope.detail.slice(0, 200)}) ${fileScopeTimer()}ms`);
    } catch (error) {
      layers.push({
        layer: 'file-scope',
        query: symbol,
        status: 'miss',
        detail: `parse error: ${layerErrorMessage(error)}`
      });
    }

    if (defLocation) {
      layers.push({ layer: 'entity-def', query, status: 'hit', detail: 'Python implementation unavailable; use declaration' });
      jumpLog('info', () => `Python 实现未找到，回退 .def 声明(query=${symbol})`);
      return { location: defLocation, layers };
    }
    jumpLog('info', () => `跳转放弃: 三层全落空(query=${symbol}) 总耗时 ${totalTimer()}ms`);
    return { location: null, layers };
  }

  /**
   * 层3:直接解析当前文档文本(不依赖索引扫描)。顺序:光标所在类自身 →
   * 同文件内的基类(本文件 MRO)→ 真实后代的全部候选；排除无关类和声明自身行。
   */
  private resolveFileScope(
    document: vscode.TextDocument,
    line: number,
    symbol: string,
    excludeSelfLine: boolean
  ): { location: vscode.Location | vscode.Location[] | null; detail: string } {
    const parsed = parsePythonFile(document.getText(), document.fileName);
    const enclosing = parsed.classes
      .filter(cls => line >= cls.startLine && line < cls.endLine)
      .sort((left, right) => right.startLine - left.startLine)[0];
    const chain: Array<{ cls: PythonClassDef; how: string }> = [];
    if (enclosing) {
      const mro = linearizeC3(enclosing.qualifiedName ?? enclosing.name, name =>
        parsed.classes.filter(cls => (cls.qualifiedName ?? cls.name) === name));
      for (const name of mro) {
        const cls = parsed.classes.find(item => (item.qualifiedName ?? item.name) === name);
        if (cls) { chain.push({ cls, how: cls === enclosing ? 'same class' : `file-local base ${name}` }); }
      }
    }
    for (const item of chain) {
      const loc = item.cls.methods.get(symbol);
      if (!loc) {
        continue;
      }
      if (excludeSelfLine && loc.line === line) {
        continue;
      }
      return {
        location: new vscode.Location(
          vscode.Uri.file(document.fileName),
          new vscode.Position(loc.line, loc.character)
        ),
        detail: `${item.how}: ${item.cls.name}`
      };
    }
    if (enclosing) {
      const locations = new Map<string, vscode.Location>();
      for (const cls of parsed.classes) {
        if (cls === enclosing) { continue; }
        const mro = linearizeC3(cls.qualifiedName ?? cls.name, name =>
          parsed.classes.filter(item => (item.qualifiedName ?? item.name) === name));
        if (!mro.includes(enclosing.qualifiedName ?? enclosing.name)) { continue; }
        for (const name of mro) {
          const provider = parsed.classes.find(item => (item.qualifiedName ?? item.name) === name);
          const loc = provider?.methods.get(symbol);
          if (!loc || (excludeSelfLine && loc.line === line)) { continue; }
          locations.set(`${loc.line}:${loc.character}`, new vscode.Location(vscode.Uri.file(document.fileName), new vscode.Position(loc.line, loc.character)));
          break;
        }
      }
      if (locations.size) {
        const candidates = [...locations.values()];
        return { location: candidates.length === 1 ? candidates[0] : candidates,
          detail: `file-local descendants: ${candidates.length} implementation(s)` };
      }
    }
    return {
      location: null,
      detail: enclosing
        ? `class ${enclosing.name} (of ${parsed.classes.length} classes in file) does not define ${symbol}`
        : `no enclosing class; no class in file defines ${symbol}`
    };
  }
}

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

export class KBEngineCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async prepareCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CallHierarchyItem | vscode.CallHierarchyItem[] | null> {
    if (document.languageId === 'python') {
      const pythonMethod = await this.entityMappingManager.resolvePythonMethodAtPosition(
        document.fileName,
        position.line + 1,
        position.character
      );
      return pythonMethod ? createPythonCallHierarchyItem(pythonMethod) : null;
    }

    if (document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def')) {
      const range = document.getWordRangeAtPosition(position, /\w+/);
      if (!range) {
        return null;
      }

      const word = document.getText(range);
      const symbolInfo = findDefSymbolInfo(document, position, word);
      if (!symbolInfo || !METHOD_SECTIONS.has(symbolInfo.section)) {
        return null;
      }

      // 不可达(批62 定性):symbolInfo 非空说明上一次 parseDefAst 已取到 AST
      // (getDefNodeAtWord→getDefNodeAtPosition 在 ast 为空时必然返回 null),
      // 且本分支的 languageId/文件名条件已满足 parseDefAst 的白名单;同一 document
      // 的同步重复解析不可能改判为空。
      const ast = parseDefAst(document);
      /* istanbul ignore start */
      if (!ast) {
        return null;
      }
      /* istanbul ignore stop */

      const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
        document.fileName,
        getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
        symbolInfo.symbolNode.name,
        symbolInfo.section as EntityMethodSection
      );

      // IDE-NAV-015:与 F12 同链(resolveDefMethodPythonTarget:identity
      // 绑定/属主+全局唯一 → 约定链),相同 RPC/mixin 方法两入口同目标;
      // 空臂如实 null(F12 的提示+注册回落不是 python 目标,层次不借)。
      const target = await resolveDefMethodPythonTarget(
        document,
        symbolInfo.symbolNode.name,
        symbolInfo.section as EntityMethodSection,
        this.entityMappingManager,
        identity
      );
      if (!target) {
        return null;
      }

      return createPythonCallHierarchyItem({
        filePath: target.filePath,
        methodName: symbolInfo.symbolNode.name,
        line: target.line,
        character: target.character
      });
    }

    return null;
  }

  async provideCallHierarchyIncomingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyIncomingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getIncomingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyIncomingCall(
      createPythonCallHierarchyItem(call.caller),
      [createSelectionRange(call.callLine, call.callCharacter, item.name)]
    ));
  }

  async provideCallHierarchyOutgoingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyOutgoingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getOutgoingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyOutgoingCall(
      createPythonCallHierarchyItem(call),
      [createSelectionRange(call.line, call.character, call.methodName)]
    ));
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

export function getPythonMethodDeclarationAtPosition(lineText: string, character: number): string | null {
  const match = METHOD_DECLARATION_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }

  const methodName = match[1];
  const nameStart = lineText.indexOf(methodName);
  const nameEnd = nameStart + methodName.length;
  if (character < nameStart || character > nameEnd) {
    return null;
  }

  return methodName;
}

export function createPythonCallHierarchyItem(
  method: { filePath: string; methodName: string; line: number; character: number }
): vscode.CallHierarchyItem {
  const selectionRange = createSelectionRange(method.line, method.character, method.methodName);
  return new vscode.CallHierarchyItem(
    vscode.SymbolKind.Method,
    method.methodName,
    path.basename(method.filePath),
    vscode.Uri.file(method.filePath),
    selectionRange,
    selectionRange
  );
}

export function createSelectionRange(line: number, character: number, text: string): vscode.Range {
  return new vscode.Range(
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0)),
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0) + text.length)
  );
}

export { EventCodeLensProvider } from './eventApi';
export { RECEIVER_NONE_DIAGNOSTIC_CODE } from './receiverNoneDiagnostics';
export { KbengineSourceRevealArgs, revealSourceCommand, prewarmKbengineIndex } from './languageProviders/reveal';
export { validateDocument, validateEntitiesXmlDocument, UNKNOWN_TYPE_DIAGNOSTIC_CODE } from './languageProviders/validation';
export { KBEngineCompletionProvider, findRegisteredTypeSuggestions, PythonCompletionProvider } from './languageProviders/completion';
export { KBEngineBuiltinTypeInlayHintsProvider } from './languageProviders/inlay';
export { HoverPhaseTimer, setHoverInFlightGateForTests, KBEngineHoverProvider, KBEngineSignatureHelpProvider, describeTypeStorageShape } from './languageProviders/hover';
export { KBEngineDefinitionProvider, resolvePropertyLandingLine } from './languageProviders/navigation';
