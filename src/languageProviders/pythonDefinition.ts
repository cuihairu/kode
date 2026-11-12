// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { eventDefinitionAt } from '../eventApi';
import { getScanRootForFile } from '../scanRoots';
import { parsePythonFile, linearizeC3, isPythonCodePosition, getPythonBaseExpressionAtPosition, PythonClassIndex, PythonClassDef, PythonMethodLocation } from '../backend/pythonClassIndex';
import { EntityMappingManager } from '../entityMapping';
import { findTypesXmlImplementedByReference, findEntityDefinitionFile, getEntityRuntimeProfile, getWorkspaceRootForDocument, findDefinitionFileByCategory, findDefinitionTextByCategory, getEntityCustomTypesSnapshot } from '../definitionWorkspace';
import { cellScriptRoleAndEntity, collectCellDataDefUniverseWithCategory, fetchCellDataKeys } from '../backend/cellDataCompletion';
import { cellDataKeyAccessAtPosition, isCellDataKeyInsideLineComment } from '../backend/cellDataKeyAccess';
import { fixedDictChainRootType, fixedDictSubscriptContextAt, resolveFixedDictSubscriptKey } from '../backend/fixedDictSubscript';
import { jumpLog, jumpTimeStart } from '../navigationLog';
import { startLanguageServiceOperation } from '../languageServiceMetrics';
import { getPythonReceiverCallAtPosition, type PythonReceiverCall, getPythonSelfAccessAtPosition, getPythonMemberAccessAtPosition, type PythonMemberAccess } from '../backend/pythonLanguageUtils';
import { buildKbeStubDocument, buildKbeStubUriString, getKbeAliases, getKbeFromImportedSymbols, getKbeSymbol, getPythonClassBaseAtPosition, resolveKbeAccessAtPosition } from '../kbeModuleIndex';
import { pythonProcessFromPath } from '../backend/pythonProcess';
import { GlobalDataDictIndex, getDataDictAccessInCodeContext, getKbeDataDictAccessAtPosition, isKeyInsideLineComment, queryDataDictSitesForAccess, resolveScopeRoot, type KbeDataDictSite } from '../globalDataIndex';
import { withInitialScanTimeout } from '../hoverBudget';
import { getLanguageFeatureConfig } from './shared';
import { getPythonMethodDeclarationAtPosition } from './callHierarchy';
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
   * kbe-stub / class-base / types-reverse / globaldata-key / cellData-key /
   * fixeddict-key = 前置契约分支(命中即终点);globaldata-key = 数据字典键
   * 跨进程互链(GLOBDATA-001);cellData-key = cellData 字符串键来源 def 跳转
   * (KSEM-CELL-05);fixeddict-key = FIXED_DICT 下标链键 → types.xml 字段声明
   * 跳转(KSEM-STRUCT-02);
   * member-access = 非 self 接收者成员调用(avatar.SendErrorInfo,批158);
   * context = 入参形态判定(既非 self 访问/成员调用也非方法声明)。
   */
  layer:
    | 'kbe-stub'
    | 'class-base'
    | 'types-reverse'
    | 'globaldata-key'
    | 'cellData-key'
    | 'fixeddict-key'
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

    // KSEM-CELL-05:cellData 字符串键 F12 → 键来源 def 声明(def 字段/组件
    // 槽)。与 GLOBDATA-001 同理置于 isPythonCodePosition 守卫之前(键是
    // 字符串字面量,该守卫会把其内位置判 skip)。诚实边界:内建键(引擎
    // 文件,不在 workspace)不跳转、不伪造声明;未知键/非实体脚本面/键
    // 宇宙不可用 → 交回常规链。
    const cellKeyHit = cellDataKeyAccessAtPosition(line.text, position.character);
    if (cellKeyHit && !isCellDataKeyInsideLineComment(line.text, cellKeyHit.keyStart)) {
      const cellRole = cellScriptRoleAndEntity(document.fileName);
      if (cellRole) {
        // KSEM-CELL-15:def 文本走脏 overlay 读取——未保存的 def 编辑立即进键
        // 宇宙(跳转落点行取自脏缓冲解析结果,打开的 def 编辑器即真位)。
        const cellDefs = collectCellDataDefUniverseWithCategory(cellRole.entity, (name, category) =>
          findDefinitionTextByCategory(name, category, document));
        const cellKeys = await fetchCellDataKeys(cellRole.entity, cellDefs);
        if (token?.isCancellationRequested) {
          return cancelledDefinitionResult();
        }
        if (cellKeys) {
          const keyEntry = cellKeys.find(entry => entry.key === cellKeyHit.key);
          if (keyEntry && keyEntry.kind !== 'builtin' && keyEntry.sourceFile) {
            const fromName = keyEntry.sourceFile.replace(/\.def$/, '');
            const sourceDef = cellDefs.find(def => def.name === fromName);
            if (sourceDef) {
              const targetPath = findDefinitionFileByCategory(fromName, sourceDef.category, document);
              if (targetPath) {
                const targetLine = Math.max(0, (keyEntry.sourceLine ?? 1) - 1);
                jumpLog('info', () =>
                  `前置命中 cellData-key:${cellKeyHit.key} → ${path.basename(targetPath)}:${targetLine + 1}`
                );
                return {
                  location: new vscode.Location(
                    vscode.Uri.file(targetPath),
                    new vscode.Position(targetLine, 0)
                  ),
                  layers: [{
                    layer: 'cellData-key',
                    query: cellKeyHit.key,
                    status: 'hit',
                    detail: `${path.basename(targetPath)}:${targetLine + 1}`
                  }]
                };
              }
            }
          }
        }
      }
    }

    // KSEM-STRUCT-02:FIXED_DICT 子字段下标链键 F12 → types.xml 字段声明行
    // (Properties 子元素标签=字段名)。与 cellData-key 同理置于
    // isPythonCodePosition 守卫之前(键是字符串字面量,该守卫判 skip);
    // 行内注释位在探测内排除。cellData 首层键位已被上方 RPC 宇宙跳转面接管
    // (def 声明/内建/组件槽);本面接嵌套层与其他 FIXED_DICT 型 def 属性。
    // 解析不出(非 FD 根/链断/键不在 types.xml 字段)→ 交回常规链,不造跳转。
    const fdKeyHit = fixedDictSubscriptContextAt(line.text, position.character);
    if (fdKeyHit?.cursor === 'key') {
      const lastSegment = fdKeyHit.segments[fdKeyHit.segments.length - 1];
      if (lastSegment && lastSegment.kind === 'key' && lastSegment.keyEnd !== null) {
        const documentLines = document.getText().split(/\r?\n/);
        const rootTypeName = await fixedDictChainRootType(
          fdKeyHit.receiver,
          documentLines,
          position.line,
          async propertyName => {
            if (token?.isCancellationRequested) {
              return null;
            }
            const location = await this.entityMappingManager.resolvePropertyDefinitionInfo(
              document.fileName,
              propertyName,
              propertyName
            );
            return location?.typeName ?? null;
          }
        );
        if (!token?.isCancellationRequested && rootTypeName) {
          const workspaceRoot = getWorkspaceRootForDocument(document);
          const resolution = resolveFixedDictSubscriptKey(
            rootTypeName,
            fdKeyHit.segments.slice(0, -1),
            lastSegment.key,
            getEntityCustomTypesSnapshot(workspaceRoot ?? '')
          );
          if (resolution?.field) {
            const targetLine = Math.max(0, resolution.field.line - 1);
            jumpLog('info', () =>
              `前置命中 fixeddict-key:${resolution.container.name}.${lastSegment.key} → ` +
              `${path.basename(resolution.container.filePath)}:${targetLine + 1}`
            );
            return {
              location: new vscode.Location(
                vscode.Uri.file(resolution.container.filePath),
                new vscode.Position(targetLine, 0)
              ),
              layers: [{
                layer: 'fixeddict-key',
                query: `${resolution.container.name}.${lastSegment.key}`,
                status: 'hit',
                detail: `${path.basename(resolution.container.filePath)}:${targetLine + 1}`
              }]
            };
          }
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
    const process = pythonProcessFromPath(document.fileName);
    if (kbeAccess && getKbeSymbol(kbeAccess.symbol, process)) {
      const stub = buildKbeStubDocument(process);
      jumpLog('info', () => `前置命中 kbe-stub:${kbeAccess.symbol} → 内置桩`);
      return {
        location: new vscode.Location(
          vscode.Uri.parse(buildKbeStubUriString(process)),
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
      if (fromImports.has(classBase) && getKbeSymbol(classBase, process)) {
        const stub = buildKbeStubDocument(process);
        jumpLog('info', () => `前置命中 class-base:${classBase} → kbe from-import 桩`);
        return {
          location: new vscode.Location(
            vscode.Uri.parse(buildKbeStubUriString(process)),
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
