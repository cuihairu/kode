// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { documentEventCacheKey, findEventCallsCached } from '../eventApi';
import { DefElementNode, findDeepestElementAtOffset, findTextNodeAtOffset, getScalarChildValue, getScalarChildValues, hasTruthyChildTag } from '../defParser';
import { EntityMappingManager } from '../entityMapping';
import { getDocumentLines } from '../documentStore';
import { buildDefChain } from '../defChain';
import { describePropertyDatabaseStoragePublished, getTypeStorageShape, TypeStorageShape } from '../databaseSchema';
import { buildPropertyDatabaseStorageHover, describeBuiltinTypeCapacity } from '../databaseSimulator';
import { findCustomTypeInfo, findTypesXmlImplementedByReference, findDefinitionFileByCategory, findEntityDefinitionFile, findEntityScriptFile, getEntityRuntimeProfile, getRegisteredEntities, getWorkspaceRootForDocument, resolveEntityAnnotationType, resolveEntityAnnotationTypeWithReason } from '../definitionWorkspace';
import { describeMethodCallDirection, describePropertySyncDirection } from '../entityFlowGraph';
import { renderUserTypeContractHoverSection, userTypeContractStatusForName } from '../userTypeContractSource';
import { HOOK_CATEGORY_NAMES, getHookByName } from '../hooks';
import { getEntryHookByName, isComponentEntryScriptFile } from '../entryHooks';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_RELOAD_FUNCTIONS, KBENGINE_TYPES } from '../kbengineMetadata';
import { resolveEntityBuiltinPropertyHit, resolveEntityComponentFaceFromPath, type EntityComponentFace } from '../entityBuiltinProperties';
import { formatBuiltinPropertyHover, formatEntityDefMethodHover, formatEventStatsHover, formatInferredReturnHover, formatSelfPropertyTypeHover } from '../hoverMarkdown';
import { apiDocDomainsForFace, formatApiDocHover, formatApiDocSupplement, getKbengineApiAccessAtPosition, getPythonCallbackDefinitionAtPosition, lookupApiDoc } from '../pythonApiHoverDocs';
import { currentHoverLanguageEnv, readHoverLanguageSetting, resolveHoverLanguage } from '../hoverLocale';
import { resolveLocalVariableReturnTypeFromSnapshot } from '../pythonReturnTypeInference';
import { resolveAnnotationTypeWithReason } from '../pythonTypeStubs';
import { resolveSelfPropertyAnnotation, type DefPropertyLocator } from '../selfPropertyTypeInference';
import { behaviorEntriesForSymbol, behaviorNotesMarkdown, fixedDictBehaviorNoteMarkdown } from '../behaviorKnowledge';
import { isFixedDictTypeName } from '../behaviorLints';
import { getPythonReceiverCallAtPosition, type PythonReceiverCall, getPythonSelfAccessAtPosition, getPythonCallAtPosition, type PythonCallAtPosition } from '../pythonLanguageUtils';
import { engineApiVersionAnnotation, getKbeAliases, getKbeSymbol, resolveKbeAccessAtPosition, summaryForLanguage } from '../kbeModuleIndex';
import { GlobalDataDictIndex, getDataDictAccessInCodeContext, getKbeDataDictAccessAtPosition, inferDataDictValueType, isKeyInsideLineComment, queryDataDictSitesForAccess, resolveScopeRoot } from '../globalDataIndex';
import { getEngineVersion } from '../engineVersion';
import { createHoverRequestDeadline, createWaiterUnionToken, raceWithBudget } from '../hoverBudget';
import { KBEngineSectionName, METHOD_SECTIONS, PROPERTY_SECTIONS, TAG_HOVER_DOCS, getLanguageFeatureConfig, getSectionLabel, parseDefAst } from './shared';
import { getKodeCoreShadowGate, serveHoverFromRust } from '../kodeCoreShadowFaces';
import { formatDefMethodParameter, formatDefMethodSignature } from './completion';
import { describeExpectedScriptPaths, findCustomTypeAtPosition, findEnclosingSymbol, formatWorkspaceRelativePath, isPositionInsideTagValue } from './navigation';
import { awaitDataDictIndexReady, getPythonDataDictIndexGeneration, isPythonDataDictIndexEnabled } from './pythonDefinition';
import { getPythonMethodDeclarationAtPosition } from './callHierarchy';
/**
 * 批159(用户令「hover 还是需要 loading 很久」):同点位并发 hover 各自重跑
 * 整条异步解析链。按(文件+版本+行+列)做在途去重:第二个并发 hover 直接
 * 共享第一个的在途 Promise。只在途、不缓存落定结果 —— 暖路径加速由
 * manager 自身的 mtime/解析缓存承担(hoverBudget 契约:重复 hover 必须仍
 * 走 def 解析缓存、可数命中);若缓存完结结果,会在 TTL 窗口内冻结标注
 * 错过索引更新,且让缓存命中计数失明。文档编辑(版本变)天然失效;存
 * provider 实例上:生产单实例语义不变,测试逐用例新建 provider 天然隔离。
 */
export const HOVER_MEMO_LIMIT = 256;

export interface HoverMemoEntry {
  documentVersion: number;
  promise: Promise<vscode.Hover | null>;
  /** IDE-BUD-008:合并请求登记在册等待者(人人取消才取消共享计算) */
  addWaiter(waiterToken: vscode.CancellationToken | undefined): () => void;
}

export function hoverMemoKey(document: vscode.TextDocument, position: vscode.Position): string {
  return `${document.fileName}#${document.version}#${position.line}#${position.character}`;
}

/** IDE-MET-003:hover 分支级计时面——start(label) 返回段结束 stop */
export interface HoverPhaseTimer {
  start(label: string): () => void;
}

/** IDE-REV-032:测试面在途闸——provider 已过入口守卫(请求确实开始)、任何
 * 结果尚未产出(未完成)之间一段可确定命中的在途窗口。生产恒 null,零
 * 行为差异;测试方负责释放(惯用法=释放时顺手 setHoverInFlightGateForTests(null),
 * 递归重入即走原路径)。 */
export let hoverInFlightGateForTests: (() => Promise<void>) | null = null;

export function setHoverInFlightGateForTests(gate: (() => Promise<void>) | null): void {
  hoverInFlightGateForTests = gate;
}

/**
 * C-23(交付③)出口注记挂靠:悬停词命中 KB-001 结构化条目的 symbols 时,
 * 把「现象+正确姿势+依据」双语段拼到既有 hover 尾部;无既有 hover 时构建
 * 注记专属 hover(知识呈现通道)。既有 contents 是单个 MarkdownString 时
 * **重建新实例**再拼(memo 缓存跨请求共享同一 Hover 实例,原地 append 会
 * 随请求次数重复叠加);数组/未知形态原样返回不动。非 python 文档/开关
 * 关闭/无命中时行为与挂靠前逐位一致。
 */
function attachBehaviorNotesToHoverResult(
  result: vscode.ProviderResult<vscode.Hover>,
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.ProviderResult<vscode.Hover> {
  // 同步结果保持同步返回(既有用例口径:provideHover 直接给 Hover;只有
  // 异步面(自管属性预算腿)才走 Promise 链)
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as Promise<vscode.Hover | null | undefined>)
      .then(hover => applyBehaviorNotes(hover, document, position));
  }
  return applyBehaviorNotes(result as vscode.Hover | null, document, position);
}

function applyBehaviorNotes(
  hover: Awaited<vscode.ProviderResult<vscode.Hover>>,
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | null {
  if (document.languageId !== 'python') {
    return hover ?? null;
  }
  if (!getLanguageFeatureConfig().hoverBehaviorNotes) {
    return hover ?? null;
  }
  const wordRange = document.getWordRangeAtPosition(position, /\w+/);
  if (!wordRange) {
    return hover ?? null;
  }
  const entries = behaviorEntriesForSymbol(document.getText(wordRange));
  if (entries.length === 0) {
    return hover ?? null;
  }
  const notes = behaviorNotesMarkdown(entries);
  const contents = hover?.contents as unknown;
  if (contents && typeof contents === 'object' && 'value' in contents
    && typeof (contents as vscode.MarkdownString).value === 'string') {
    const markdown = new vscode.MarkdownString(
      `${(contents as vscode.MarkdownString).value}${notes}`
    );
    return new vscode.Hover(markdown);
  }
  if (hover) {
    return hover; // 未知 contents 形态:不猜,原样返回
  }
  // 无既有 hover:注记单独成 hover(去掉段首分隔线)
  return new vscode.Hover(new vscode.MarkdownString(notes.replace(/^\n\n---\n\n/, '')));
}

export class KBEngineHoverProvider implements vscode.HoverProvider {
  // 实体 def 方法标注面(用户令:只凭名字标 KBEngine 函数不严谨)需要 def
  // 索引,按 RpcCodeLensProvider 同款注入;可选参数保持既有无参用例口径。
  // GLOBDATA-002:数据字典键索引注入(可选),键类型悬停用;未注入跳过。
  constructor(
    private readonly entityMappingManager?: EntityMappingManager,
    private readonly dataDictIndex?: GlobalDataDictIndex
  ) {}

  // 批159:同点位在途 hover 去重(provider 实例级,生产单实例语义不变,
  // 测试逐用例新建 provider 天然隔离)。
  private readonly hoverMemo = new Map<string, HoverMemoEntry>();

  /**
   * 在途共享:同 key 同版本的并发 hover 复用同一 Promise;落定条目即刻出册。
   * IDE-BUD-008:共享计算的 token = 全部在册等待者的并集(人人取消才取消),
   * 单个等待者取消只影响自己的 respond,不斩断别人还在等的计算;等待者的
   * 注销函数在各自 respond 落定时调用。
   */
  private memoizedHover(
    key: string,
    documentVersion: number,
    run: (sharedToken: vscode.CancellationToken) => Promise<vscode.Hover | null>,
    waiterToken?: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const inflight = this.hoverMemo.get(key);
    if (inflight && inflight.documentVersion === documentVersion) {
      inflight.addWaiter(waiterToken); // 注销随共享 promise 落定统一清理
      return inflight.promise;
    }
    const union = createWaiterUnionToken();
    const unregister = union.addWaiter(waiterToken);
    const promise = run(union.token);
    const entry: HoverMemoEntry = {
      documentVersion,
      promise,
      addWaiter: nextToken => union.addWaiter(nextToken)
    };
    this.hoverMemo.set(key, entry);
    if (this.hoverMemo.size > HOVER_MEMO_LIMIT) {
      const oldest = this.hoverMemo.keys().next().value;
      if (oldest !== undefined) {
        this.hoverMemo.delete(oldest);
      }
    }
    // 落定即出册(成败同):完结结果不复用,后续 hover 重走 manager 暖缓存
    const drop = () => {
      const memoEntry = this.hoverMemo.get(key);
      if (memoEntry && memoEntry.promise === promise) {
        this.hoverMemo.delete(key);
      }
      unregister();
      union.dispose();
    };
    promise.then(drop, drop);
    return promise;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    // C-23(交付③):出口统一挂行为注记——KB-001 结构化条目按悬停词挂靠,
    // 覆盖所有 hover 分支出口(注记纯静态知识,零索引查询,不进预算闸)
    return attachBehaviorNotesToHoverResult(
      this.provideHoverTimed(document, position, token),
      document,
      position
    );
  }

  /**
   * IDE-MET-003:hover 分支级耗时记录——timer 由适配层注入(per-request
   * operation.startSubPhase),并发请求各自归因;不传计时面零开销,行为与
   * provideHover 完全一致。分支标签四类:annotation-query(注解查询)、
   * def-mapping(def 映射/def 归属)、schema(签名/形参闸/属性表)、render;
   * 总耗时由 operation.elapsedMs 承担。
   */
  provideHoverTimed(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer,
    // 直接切重入标记:true = Rust 腿已试过(miss),本轮直接走 TS 既有链
    rustHoverAttempted?: boolean
  ): vscode.ProviderResult<vscode.Hover> {
    if (token?.isCancellationRequested) { return null; }
    if (hoverInFlightGateForTests) {
      // IDE-REV-032:门住一段确定性在途窗口;释放方负责清闸,重入走原路径
      const gate = hoverInFlightGateForTests;
      return gate().then(() => this.provideHoverTimed(document, position, token, timer, rustHoverAttempted));
    }
    // 2026-11-08 用户令「直接切到 rust」:服务轨道下语料文档(.def + 三类
    // XML)hover 先走 Rust(kode-server textDocument/hover);Rust 命中即用,
    // 未命中(null:词未知/非语料/任何失败)重入下方 TS 既有链(rustHover-
    // Attempted 防重入)。Python 文档零请求直通 TS。本分支在 deadline 建立
    // 之前:Rust 腿由 client 自带超时,miss 后重入再走预算闸,不占 TS 预算。
    if (
      !rustHoverAttempted &&
      document.languageId !== 'python' &&
      getKodeCoreShadowGate()?.serveFromRust()
    ) {
      return serveHoverFromRust(document, position).then(value =>
        value !== null
          ? new vscode.Hover(new vscode.MarkdownString(value))
          : this.provideHoverTimed(document, position, token, timer, true)
      );
    }
    const featureConfig = getLanguageFeatureConfig();
    // IDE-BUD-001:一次请求一个截止时间上下文——绝对 deadline + 链接 token
    // 全分支共享:各层 raceWithBudget 用 remainingMs() 而非各起满额预算窗;
    // 父取消或预算到期即取消链接 token,异步层与取消闸同刻观测。
    const deadline = createHoverRequestDeadline(token, featureConfig.hoverAsyncBudgetMs);
    const respond = (work: Promise<vscode.Hover | null>): Promise<vscode.Hover | null> =>
      raceWithBudget('hover:cancel', work, 0, deadline.token)
        .finally(() => deadline.dispose());
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      deadline.dispose();
      return null;
    }

    const word = document.getText(range);

    // 实体 def 方法声明标注(用户令:Python 实现里看不出哪些函数是 def 声明
    // 的方法):光标落在 python def 声明行方法名上时,先问 def 索引是否命中;
    // 命中后过与 RPC CodeLens/全项目回退同一把形参闸门(def 声明了 <Arg> 时
    // 个数/注解类型必须对上),不符不给该标注。未命中或未注入 manager 时落
    // 回普通 hover 链,既有同步行为不变(未注入即不进异步面)。
    const manager = this.entityMappingManager;
    if (manager && document.languageId === 'python') {
      // 批159:同点位并发 hover 在途去重(共享同一 Promise);命中任一异步面
      // 才进 memo,未命中落回下方同步链(局部变量返回类型推导等),与批159
      // 前贯穿语义一致。
      const memoKey = hoverMemoKey(document, position);
      const methodName = getPythonMethodDeclarationAtPosition(
        document.lineAt(position.line).text,
        position.character
      );
      if (methodName) {
        // 异步链总预算闸(用户令 2026-10-22):底层索引慢(首扫秒级+)时不再
        // 永转 loading,超预算返回空悬停并记 LogHub(层名+耗时)。
        // IDE-BUD-001:预算 = 共享 deadline 的剩余量,不再各起满额窗。
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:def-method',
            this.resolveDefMethodAnnotation(manager, document, position.line, methodName, sharedToken, timer, featureConfig.hoverApiDocs)
              .then(annotation => {
                if (annotation) { return annotation; }
                const stop = timer?.start('annotation-query');
                try {
                  return this.provideKnownHover(document, position, featureConfig, range, word);
                } finally { stop?.(); }
              }),
            deadline.remainingMs(),
            sharedToken,
            // R2-F18:预算到期传播取消——取消本请求的链接 token;若是等待者
            // 并集的唯一剩余,共享计算随之取消(停止新增读取/排队);他人
            // 仍在等则不取消(共享计算继续)。
            () => deadline.cancel()
          )
        , deadline.token));
      }
      // 接收者感知(用户令 2026-10-21):光标落在 self.cell./self.base./self.client.
      // 的方法名上时,先按段闸解析(仅对应区块的 def 候选通过,段不符不给标注,
      // 落回普通 hover 链);段过滤先行于形参闸(命中后沿用同一把签名对账)。
      // kbengine.entity.receiverSections=false 时回归不感知段的旧解析
      // (直接落 provideKnownHover),形参/类型闸门不受此开关影响。
      const receiverCall = featureConfig.entityReceiverSections
        ? getPythonReceiverCallAtPosition(
            document.lineAt(position.line).text,
            position.character
          )
        : null;
      if (receiverCall) {
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:receiver-call',
            this.resolveReceiverCallAnnotation(manager, document, position.line, receiverCall, sharedToken, timer)
              .then(annotation => {
                if (annotation) { return annotation; }
                const stop = timer?.start('annotation-query');
                try {
                  return this.provideKnownHover(document, position, featureConfig, range, word);
                } finally { stop?.(); }
              }),
            deadline.remainingMs(),
            sharedToken,
            // R2-F18:预算到期传播取消(见 def-method 分支)
            () => deadline.cancel()
          )
        , deadline.token));
      }
      // 内建属性(用户令 2026-10-21 内建属性单 ②):self.<属性> 单段访问
      // (fullPath 无第二段,不与 self.cell.X 接收者调用重叠)命中分面表
      // → 内建属性标注;未命中/非实体脚本落回普通 hover 链。
      // kbengine.entity.builtinProperties=false 时整体让位,不进异步面。
      const selfAccess = getPythonSelfAccessAtPosition(
        document.lineAt(position.line).text,
        position.character
      );
      if (
        featureConfig.entityBuiltinProperties &&
        selfAccess &&
        !selfAccess.fullPath.includes('.')
      ) {
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:builtin-property',
            this.resolveBuiltinPropertyAnnotation(manager, document, selfAccess.currentSymbol, sharedToken, timer, featureConfig.hoverApiDocs)
              .then(annotation => {
                if (annotation) { return annotation; }
                // TYP-ARRAY:内建属性未命中 → 同点位试 def 属性容器注解
                // (self.<def 属性> 声明类型,别名断到内建;与 inlay/存根同链);
                // 仍不命中才落普通 hover 链。复用 entityBuiltinProperties 总闸
                // (本分支已在总闸内)。
                return this.resolveSelfPropertyAnnotationHover(
                  manager, document, position, word, selfAccess, sharedToken, timer
                ).then(selfHover => selfHover ?? this.provideKnownHover(document, position, featureConfig, range, word));
              }),
            deadline.remainingMs(),
            sharedToken,
            // R2-F18:预算到期传播取消(见 def-method 分支)
            () => deadline.cancel()
          )
        , deadline.token));
      }
      // 三个异步面都未命中:落回下方同步链(批159 前语义,不进 memo)
      // IDE-BUD-001:同步段不可抢占——只在段口协作检查 deadline(父已取消/
      // 预算已耗尽就不进同步链),不得宣称同步路径因此可被抢占。
      if (deadline.token.isCancellationRequested || deadline.isExpired()) {
        deadline.dispose();
        return null;
      }
    }

    // 局部变量返回类型推导(用户令 2026-10-21:「data = activity_data.get_data()
    // → data: JSONDATA」):光标落在变量名上时,按右侧单层调用的被调函数返回
    // 注解推导(python `def get_data(...) -> X:` 注解先行;.def 方法无返回声明
    // 语法故该层结构性缺位)。解出才提示并标注来源;解不出不显示任何类型
    // (不显 Any、不显空类型,落回普通 hover 链)。
    if (document.languageId === 'python' && vscode.workspace.getConfiguration('kbengine').get<boolean>('hover.returnTypeInference', true)) {
      // PR2 快照接入:局部变量推导复用快照行数据(同版本不重拆);
      // IDE-HOV-011:按文档版本喂当前文件注解桶(未保存变化立即生效)
      // IDE-MET-003:推导整段属注解查询面(annotation-query)
      const stopInfer = timer?.start('annotation-query');
      let inferred: ReturnType<typeof resolveLocalVariableReturnTypeFromSnapshot>;
      try {
        inferred = resolveLocalVariableReturnTypeFromSnapshot(
          getDocumentLines(document),
          position.line,
          word,
          getWorkspaceRootForDocument(document),
          {
            fileKey: document.uri.toString(),
            version: document.version,
            source: () => document.getText()
          }
        );
      } finally { stopInfer?.(); }
      if (inferred) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(formatInferredReturnHover(inferred.target, inferred.annotation, inferred.methodName));
        deadline.dispose();
        return new vscode.Hover(markdown);
      }
    }

    // TYP-ARRAY:def 属性访问的类型推导与数组元素类型(hover 面,2026-10-30
    // 用户反馈 self.<def 属性> 仍 Any)。self.<def 属性> → 声明类型(别名断到
    // 内建);for x in self.<attr> / x = self.<attr>[i] → <of> 元素类型;赋值局部
    // 变量延续推导;空 <of>/环/缺失 → Any + reason(诚实,不伪造)。形状不匹配
    // (非 def 属性/元素位)快速返回 null,落回下方普通 hover 链(能推才显)。
    // GLOBDATA-002 数据字典键悬停由下方该面专管:本面若不排除 dict 访问位,
    // 会在解析不出时落回 provideKnownHover 短路掉下方数据字典面(丢同键写点
    // 类型)。仅当数据字典索引装配且命中 dict 访问位时不接管(与下方同闸)。
    // KR-AUD-65(UI-16)口径统一:数据字典落点判定与 definition/references 同源
    // ——行级快筛(便宜,绝大多数落点在此落空)→ getDataDictAccessInCodeContext
    // 全文词法上下文复核(贵,只在真命中时才建掩码)。行级口径单独判会把跨行
    // 三引号/外层字符串里的伪访问当真:同一位置 hover 接管而 F12 不跳。
    // 一次解析,下方自属性面闸门与数据字典面共用。
    const dictDocumentText = document.getText();
    const dictLineText = document.lineAt(position.line).text;
    const dictAliases = getKbeAliases(dictDocumentText);
    const dictAccess =
      this.dataDictIndex &&
      isPythonDataDictIndexEnabled() &&
      getKbeDataDictAccessAtPosition(dictLineText, position.character, dictAliases)
        ? getDataDictAccessInCodeContext(
          dictDocumentText,
          position.line,
          position.character,
          dictAliases
        )
        : null;
    const isDataDictPosition = dictAccess !== null;
    if (
      manager &&
      document.languageId === 'python' &&
      // 自属性类型 hover 复用实体脚本属性 hover 总闸(见 getLanguageFeatureConfig)
      featureConfig.entityBuiltinProperties &&
      !isDataDictPosition
    ) {
      const selfAccess = getPythonSelfAccessAtPosition(
        document.lineAt(position.line).text,
        position.character
      );
      // 本面位于 manager 块外,memoKey 不在作用域:同口径按 (位置,版本) 现算
      const selfPropertyMemoKey = hoverMemoKey(document, position);
      return respond(this.memoizedHover(selfPropertyMemoKey, document.version, sharedToken =>
        raceWithBudget(
          'hover:self-property-type',
          this.resolveSelfPropertyAnnotationHover(
            manager, document, position, word, selfAccess, sharedToken, timer
          ).then(hover => hover ?? this.provideKnownHover(document, position, featureConfig, range, word)),
          deadline.remainingMs(),
          sharedToken,
          // R2-F18:预算到期传播取消(见 def-method 分支)
          () => deadline.cancel()
        )
      , deadline.token));
    }

    // GLOBDATA-002:数据字典键类型悬停 —— 落点在键表达式上时:写点显示 RHS
    // 类型;读点显示同键写点值类型(union)+ 首个写点位置;推不出且无写点
    // 交回普通 hover 链(能推才显)。索引首次查询即触发懒建(与 definition
    // 同源),后续查询零成本。
    if (document.languageId === 'python' && this.dataDictIndex && isPythonDataDictIndexEnabled()) {
      const dataDictIndex = this.dataDictIndex;
      // dictAccess 已在上方按 definition 同源口径算好(此处不再行级重判);
      // 行内注释由 isKeyInsideLineComment 继续排除(与词法掩码双保险)
      if (dictAccess && !isKeyInsideLineComment(dictLineText, dictAccess.keyStart)) {
        // AUD-073:发布前复核启用代际——等待期间开关被改过则不发布旧结果
        const enabledGeneration = getPythonDataDictIndexGeneration();
        // AUD-075(R4-F10):源文档身份/版本复核(与 definition/references 同口径)
        const sourceUri = document.uri.toString();
        const sourceVersion = document.version;
        return respond(
          // AUD-072:冷索引等待可取消——取消即放行 null,共享初扫继续
          awaitDataDictIndexReady(dataDictIndex, token).then(ready => {
            if (!ready || getPythonDataDictIndexGeneration() !== enabledGeneration) {
              return null;
            }
            if (
              document.uri.toString() !== sourceUri ||
              document.version !== sourceVersion ||
              document.isClosed
            ) {
              return null;
            }
            const hover = this.buildDataDictHover(dictAccess, dataDictIndex, resolveScopeRoot(document.uri.fsPath));
            if (hover) {
              return hover;
            }
            // 推不出(无同键写点/未知类型)→ 交回普通 hover 链(同一 deadline)
            return this.provideKnownHover(document, position, featureConfig, range, word);
          })
        );
      }
    }

    const stopKnown = timer?.start('annotation-query');
    let known: vscode.Hover | null;
    try {
      known = this.provideKnownHover(document, position, featureConfig, range, word);
    } finally { stopKnown?.(); }
    deadline.dispose();
    return known;
  }

  /**
   * GLOBDATA-002 数据字典键类型悬停(格式与局部变量推导同风格):写点显示
   * RHS 推导类型;读点显示同键写点值类型(union)与首个写点位置。写点类型
   * 推不出→null(交回普通链);读点无同键写点→null;读点有写点但类型推
   * 不出→只给写点位置。
   */
  private buildDataDictHover(
    access: NonNullable<ReturnType<typeof getKbeDataDictAccessAtPosition>>,
    index: GlobalDataDictIndex,
    scopeRoot: string
  ): vscode.Hover | null {
    // AUD-068 同款(与 definition/references 同口径):查询带根身份——
    // 索引按 workspace 根身份键提交,查询不带根会落在 '' 空根键上永远查空
    const writeSites = queryDataDictSitesForAccess(index, access, scopeRoot)
      .filter(site => site.kind === 'write');
    const types: string[] = [];
    for (const write of writeSites) {
      const type = inferDataDictValueType(write.valueText);
      if (type && !types.includes(type)) {
        types.push(type);
      }
    }
    if (access.kind === 'write' && types.length === 0) {
      return null;
    }
    if (access.kind === 'read' && writeSites.length === 0) {
      return null;
    }
    const keyLabel = access.callFn ? `${access.callFn}(...)` : access.keySignature;
    const markdown = new vscode.MarkdownString();
    const headline =
      `**KBEngine.${access.dict}\`${keyLabel}\`${types.length > 0 ? `: ${types.join(' | ')}` : ''}**`;
    if (access.kind === 'write') {
      markdown.appendMarkdown(`${headline}\n\n推导自本写点右侧表达式`);
    } else {
      markdown.appendMarkdown(`${headline}\n\n读点 · 同键写点 ${writeSites.length} 处`);
      const first = writeSites[0];
      markdown.appendMarkdown(`\n\n首个写点 ${path.basename(first.file)}:${first.line + 1}`);
    }
    return new vscode.Hover(markdown);
  }

  /**
   * 「此函数是实体 def 声明的 X 方法」标注(形参闸门同源):resolveMethodDefinition
   * 命中才标;def 声明了 <Arg> 时本行签名须过 pythonSignatureMatchesDeclaredArgs,
   * 不符返回 null(调用方落回普通 hover)。
   */
  private async resolveDefMethodAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    line: number,
    methodName: string,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer,
    apiDocsEnabled = false
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:def-mapping(def 索引映射)→ schema(形参闸+签名)→
    // render(markdown 构造);timer 缺省零开销。
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    const stopMapping = timer?.start('def-mapping');
    try {
      location = await manager.resolveMethodDefinition(document.fileName, methodName, undefined, token);
    } catch {
      return null;
    } finally { stopMapping?.(); }
    if (!location) {
      return null;
    }
    const declaredArgTypes =
      location.declaredArgs && location.declaredArgs.length > 0 ? location.declaredArgs : undefined;
    // 形参闸与签名同链(用户令 2026-10-21):注解按统一解析链对账,types.xml
    // 自定义类型断到内建(如 TIMESTAMP→int),与 formatter 输出同源。
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(workspaceRoot ?? '', raw);
    const stopSchema = timer?.start('schema');
    let signatureMatched = true;
    let signature: string;
    try {
      if (
        declaredArgTypes &&
        !EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
          declaredArgTypes,
          [...getDocumentLines(document)],
          line,
          resolveAnnotation
        )
      ) {
        signatureMatched = false;
      }
      signature = formatDefMethodSignature(workspaceRoot ?? undefined, methodName, location.declaredArgs);
    } finally { stopSchema?.(); }
    if (!signatureMatched) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(formatEntityDefMethodHover({
        methodName,
        section: location.section,
        signature,
        defFile: location.defFile,
        defLine: location.line,
        exposed: location.exposed
      }));
      // C-21 交付②第四类触发点:def 声明的方法在 API 文档库(entity 方法/
      // 回调语义)另有记载时追加文档段(命中才非空,不覆盖 def 注解)
      if (apiDocsEnabled) {
        const locale = resolveHoverLanguage(readHoverLanguageSetting(), currentHoverLanguageEnv());
        markdown.appendMarkdown(formatApiDocSupplement(
          methodName,
          apiDocDomainsForFace(resolveEntityComponentFaceFromPath(document.fileName)),
          locale
        ));
      }
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  /**
   * 接收者调用标注(用户令 2026-10-21):self.cell./self.base./self.client. 调用
   * 的方法名上,按段闸解析(resolveMethodDefinition 第三参,段不符即 null);
   * 命中后与声明面共用形参闸(def 声明了 <Arg> 时对账,不符不标注)。
   */
  private async resolveReceiverCallAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    line: number,
    receiverCall: PythonReceiverCall,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:与声明面同构 def-mapping → schema → render。
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    const stopMapping = timer?.start('def-mapping');
    try {
      location = await manager.resolveMethodDefinition(
        document.fileName,
        receiverCall.methodName,
        receiverCall.section,
        token
      );
    } catch {
      return null;
    } finally { stopMapping?.(); }
    if (!location) {
      return null;
    }
    const declaredArgTypes =
      location.declaredArgs && location.declaredArgs.length > 0 ? location.declaredArgs : undefined;
    // 形参闸与签名同链(用户令 2026-10-21):与声明面共用 resolveEntityAnnotationType
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(workspaceRoot ?? '', raw);
    const stopSchema = timer?.start('schema');
    let signatureMatched = true;
    let signature: string;
    try {
      if (
        declaredArgTypes &&
        !EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
          declaredArgTypes,
          [...getDocumentLines(document)],
          line,
          resolveAnnotation
        )
      ) {
        signatureMatched = false;
      }
      signature = formatDefMethodSignature(
        workspaceRoot ?? undefined,
        receiverCall.methodName,
        location.declaredArgs
      );
    } finally { stopSchema?.(); }
    if (!signatureMatched) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(formatEntityDefMethodHover({
        methodName: receiverCall.methodName,
        section: location.section,
        signature,
        defFile: location.defFile,
        defLine: location.line,
        exposed: location.exposed,
        receiver: receiverCall.receiver
      }));
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  /**
   * 内建属性标注(用户令 2026-10-21 内建属性单 ②④):self.<属性> 单段访问
   * 命中分面属性表 → 「KBEngine 内建属性（<组件>面）·只读/可写 · 类型」。
   * 组件面判定:目录域(与 collectAllPythonMethodHits 的 base/cell/client
   * 目录闸同源)先行,判不出再问 def 归属(owner 文件段位);都判不出 =
   * 非实体脚本 → 不接管;判为实体但 def 面歧义 → 只查宏公共 3。
   * 面内未命中 → null(不遮蔽 def 属性/普通符号,落回普通 hover 链)。
   */
  private async resolveBuiltinPropertyAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    attributeName: string,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer,
    apiDocsEnabled = false
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:def-mapping(面归属判定+属性命中)→ render;此面无
    // schema 段(不读 def 声明签名)。
    const stopMapping = timer?.start('def-mapping');
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    let defFaces: readonly EntityComponentFace[] | null = null;
    if (!pathFace) {
      try {
        defFaces = await manager.getEntityComponentFacesForPythonFile(document.fileName, token);
      } catch {
        defFaces = null;
      }
    }
    let hit: ReturnType<typeof resolveEntityBuiltinPropertyHit>;
    try {
      hit = resolveEntityBuiltinPropertyHit(attributeName, pathFace, defFaces);
    } finally { stopMapping?.(); }
    if (!hit) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      // 首行紧凑形态(用户令 2026-10-21 形态升级单 ①):类型紧跟属性名冒号后
      // (**self.databaseID: int** — baseapp面 · 只读),详情段走单一 formatter
      markdown.appendMarkdown(formatBuiltinPropertyHover(hit));
      // C-21 B 触发点:内建属性在 API 文档库另有语义段时追加(命中才非空,
      // 不重复签名,不覆盖既有标注)
      if (apiDocsEnabled) {
        const locale = resolveHoverLanguage(readHoverLanguageSetting(), currentHoverLanguageEnv());
        markdown.appendMarkdown(formatApiDocSupplement(
          hit.property.name,
          apiDocDomainsForFace(hit.face),
          locale
        ));
      }
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  /**
   * TYP-ARRAY:def 属性/元素类型悬停(与 inlay/存根同一条 resolvePropertyDefinitionInfo
   * + resolveEntityAnnotationTypeWithReason 解析链)。def-mapping 段管 def 属性定位,
   * render 段管标注拼装;形状不匹配(非 def 属性/元素位)返回 null(调用方落回
   * provideKnownHover,能推才显)。
   */
  private async resolveSelfPropertyAnnotationHover(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string,
    selfAccess: ReturnType<typeof getPythonSelfAccessAtPosition>,
    sharedToken: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): Promise<vscode.Hover | null> {
    const stopMapping = timer?.start('def-mapping');
    let resolved: Awaited<ReturnType<typeof resolveSelfPropertyAnnotation>>;
    try {
      const workspaceRoot = getWorkspaceRootForDocument(document);
      const locator: DefPropertyLocator = (fullPath, rootSymbol) =>
        // 无目录域路径(无 workspace root)/manager 面判定注入缺失(测试替身
        // 无该方法)→ 视为无 def 属性位置,落回普通 hover 链(能推才显,不炸)
        !manager || typeof manager.resolvePropertyDefinitionInfo !== 'function'
          ? Promise.resolve(null)
          : sharedToken.isCancellationRequested
            ? Promise.resolve(null)
            : manager.resolvePropertyDefinitionInfo(document.fileName, fullPath, rootSymbol);
      const annotate = (raw: string) =>
        workspaceRoot
          ? resolveEntityAnnotationTypeWithReason(workspaceRoot, raw)
          : resolveAnnotationTypeWithReason(raw, []);
      resolved = await resolveSelfPropertyAnnotation(
        getDocumentLines(document),
        position.line,
        word,
        selfAccess,
        locator,
        annotate
      );
    } finally { stopMapping?.(); }
    if (!resolved) {
      return null;
    }
    const stopRender = timer?.start('render');
    try {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(formatSelfPropertyTypeHover(resolved));
      // C-23 交付③ hover 行为注记:FIXED_DICT 形态的 def 属性附 KB-001 双语
      // 行为警告段。形态判定两线并存(C-23 曾有两路实现,合并口径):优先
      // getTypeStorageShape 类型图(与存根/悬停同源),内建名直判兜底——测试
      // 夹具/无 types.xml 环境下类型图解析不到字面 FIXED_DICT 时不漏挂;
      // 文案=behaviorNoteMarkdown 单一事实源(现象/正确姿势/依据双语段)。
      if (resolved.kind === 'def-property' && resolved.typeName) {
        const shape = getTypeStorageShape(document.fileName, resolved.typeName);
        if (shape.kind === 'fixedDict' || isFixedDictTypeName(resolved.typeName, [])) {
          markdown.appendMarkdown(fixedDictBehaviorNoteMarkdown());
        }
      }
      return new vscode.Hover(markdown);
    } finally { stopRender?.(); }
  }

  private provideKnownHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
    range: vscode.Range,
    word: string
  ): vscode.Hover | null {
    if (document.languageId === 'python' && featureConfig.hoverEventStats) {
      // KR-AUD-65(UI-16):同文档同版本共享一次全文扫描(此前每次悬停都全扫),
      // 版本前进/换文档自然换键
      const calls = findEventCallsCached(
        document.getText(),
        documentEventCacheKey(document)
      );
      const current = calls.find(call => position && document.offsetAt(position) >= call.eventOffset && document.offsetAt(position) <= call.eventOffset + call.event.length);
      if (current) {
        const registrations = calls.filter(call => (call.api === 'addEvent' || call.api === 'registerEvent') && call.event === current.event).length;
        const emits = calls.filter(call => call.api === 'emitEvent' && call.event === current.event).length;
        return new vscode.Hover(formatEventStatsHover(current.event, registrations, emits));
      }
    }
    if (featureConfig.hoverTypeStorage) {
      const typeValueHover = getTypeValueHover(document, position, word);
      if (typeValueHover) {
        return typeValueHover;
      }

      const customTypeHover = getCustomTypeHover(document, position, word);
      if (customTypeHover) {
        return customTypeHover;
      }
    }

    if (featureConfig.hoverImplementedBy) {
      const implementedByReverseHover = getImplementedByReverseHover(document, position, word);
      if (implementedByReverseHover) {
        return implementedByReverseHover;
      }
    }

    if (featureConfig.hoverEntityRegistration) {
      const entityRegistrationHover = getEntityRegistrationHover(document, position, word);
      if (entityRegistrationHover) {
        return entityRegistrationHover;
      }
    }

    if (featureConfig.hoverDefChain) {
      const defChainHover = getDefChainHover(document, position);
      if (defChainHover) {
        return defChainHover;
      }
    }

    if (featureConfig.hoverShowValueDocs) {
      // SP-5: cellappIndex / createCellEntityInNewSpace 语义悬停
      const cellappIdxHover = createCellappIndexHover(word);
      if (cellappIdxHover) {
        return cellappIdxHover;
      }
      // SP-2: kbe/KBEngine 模块符号悬停(alias.Symbol 访问位)——
      // 空间/导航等模块函数挂 knowledge 摘要;未引入别名时不接管。
      if (document.languageId === 'python') {
        const kbeAccess = resolveKbeAccessAtPosition(
          document.lineAt(position.line).text,
          position.character,
          getKbeAliases(document.getText())
        );
        if (kbeAccess) {
          const kbeEntry = getKbeSymbol(kbeAccess.symbol);
          if (kbeEntry) {
            return createKbeSymbolHover(kbeEntry);
          }
        }
      }
      // SP-1: 入口脚本 SPI 悬停——仅 kbemain.py 路径,避免污染实体脚本。
      // 实体 hooks(getHookByName)与入口 SPI 名称不重叠,顺序无冲突。
      if (
        document.languageId === 'python' &&
        isComponentEntryScriptFile(document.fileName, 'cellapp')
      ) {
        const entryHook = getEntryHookByName(word);
        if (entryHook) {
          return createEntryHookHover(entryHook);
        }
      }
      const earlyHook = getHookByName(word);
      if (earlyHook) {
        return createHookHover(earlyHook);
      }
    }

    // C-21:KBEngine Python API 文档 hover(知识页抽取库;A. KBEngine.<api>
    // 成员访问、C. 生命周期回调 def 声明行)。排在 kbe 模块符号(SP-2)与
    // 实体 hooks 面之后:已有更详实 hover 的符号不被覆盖,本面补其余成员。
    if (document.languageId === 'python' && featureConfig.hoverApiDocs) {
      const lineText = document.lineAt(position.line).text;
      const apiAccess = getKbengineApiAccessAtPosition(lineText, position.character);
      const callbackDef = apiAccess ? null : getPythonCallbackDefinitionAtPosition(lineText, position.character);
      const name = apiAccess?.member ?? callbackDef?.name;
      if (name) {
        const face = resolveEntityComponentFaceFromPath(document.fileName);
        const locale = resolveHoverLanguage(readHoverLanguageSetting(), currentHoverLanguageEnv());
        const lookup = lookupApiDoc(name, callbackDef ? [] : apiDocDomainsForFace(face), locale);
        if (lookup.kind !== 'miss') {
          return new vscode.Hover(formatApiDocHover(lookup));
        }
      }
    }

    if (featureConfig.hoverShowSymbolDocs) {
      const knownHook = getHookByName(word);
      if (!knownHook) {
        const symbolHover = getSymbolHover(document, position, word);
        if (symbolHover) {
          return symbolHover;
        }
      }
    }

    if (featureConfig.hoverShowTagDocs) {
      const tagDoc = TAG_HOVER_DOCS[word];
      if (tagDoc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown(`${tagDoc.detail}\n\n`);
        markdown.appendMarkdown(tagDoc.documentation);
        // 根修令③:实现位置给真实解析路径,不给花括号模板。
        const implementationNote = describeImplementationForHover(document, word);
        if (implementationNote) {
          markdown.appendMarkdown(`\n\n${implementationNote}`);
        }
        return new vscode.Hover(markdown);
      }
    }

    if (featureConfig.hoverShowValueDocs) {
      const type = KBENGINE_TYPES.find(t => t.name === word);
      if (type) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${type.name}**\n\n`);
        markdown.appendMarkdown(`${type.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(type.documentation);
        return new vscode.Hover(markdown);
      }

      if (DETAIL_LEVELS.includes(word)) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown('KBEngine 属性细节级别。\n\n');
        markdown.appendMarkdown('可用于 `<DetailLevel>` 标签，表示属性同步的重要程度。');
        return new vscode.Hover(markdown);
      }

      const flag = KBENGINE_FLAGS.find(f => f.name === word);
      if (flag) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${flag.name}**\n\n`);
        markdown.appendMarkdown(`${flag.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(flag.documentation);
        return new vscode.Hover(markdown);
      }

      // 不可达(批62 定性):同一个 hoverShowValueDocs 开关下,前面的 earlyHook
      // 命中即已返回,走到这里时 getHookByName(word) 必为假。
      const hook = getHookByName(word);
      /* istanbul ignore start */
      if (hook) {
        return createHookHover(hook);
      }
      /* istanbul ignore stop */

      const reloadFunc = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name.endsWith(word) || word === f.name);
      if (reloadFunc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${reloadFunc.name}**\n\n`);
        markdown.appendMarkdown(`${reloadFunc.detail}\n\n`);
        markdown.appendMarkdown(reloadFunc.documentation);
        return new vscode.Hover(markdown);
      }
    }

    return null;
  }
}

/**
 * 签名帮助(批159):光标落在 self.base/cell/client.X(...) 或对象 avatar.X(...)
 * 的方法名/实参表内时,按与 hover 同一条解析链(resolveMethodDefinition + 形参
 * 闸)出 def 签名;活动形参按调用点顶层逗号序号标亮(括号/逗号触发)。解析
 * 走预算闸(复用 hoverAsyncBudgetMs),超时不阻塞输入;形参名 argN 与存根
 * 生成器同口径,类型注解与声明面 hover 同源(formatDefMethodParameter)。
 */
export class KBEngineSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.SignatureHelp | null> {
    if (document.languageId !== 'python' || !this.entityMappingManager) {
      return null;
    }
    const call = getPythonCallAtPosition(
      document.lineAt(position.line).text,
      position.character
    );
    if (!call) {
      return null;
    }
    const featureConfig = getLanguageFeatureConfig();
    const version = document.version;
    const result = await raceWithBudget(
      'signatureHelp:def-method',
      this.resolveSignatureHelp(this.entityMappingManager, document, call),
      featureConfig.hoverAsyncBudgetMs,
      token
    );
    return document.version === version ? result : null;
  }

  private async resolveSignatureHelp(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    call: PythonCallAtPosition
  ): Promise<vscode.SignatureHelp | null> {
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    try {
      location = await manager.resolveMethodDefinition(
        document.fileName,
        call.methodName,
        call.section
      );
    } catch {
      return null;
    }
    if (!location) {
      return null;
    }
    // 形参闸不适用调用行(仓内 CodeLens 调用行先例):闸门对账的是 def 声明行
    // 签名;签名帮助恰是「调用写错时照着修」的提示面,闸掉本末倒置。
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const parameterLabels = (location.declaredArgs ?? []).map((arg, index) =>
      formatDefMethodParameter(workspaceRoot ?? undefined, arg, index)
    );
    const signature = new vscode.SignatureInformation(
      formatDefMethodSignature(workspaceRoot ?? undefined, call.methodName, location.declaredArgs)
    );
    signature.parameters = parameterLabels.map(
      parameterLabel => new vscode.ParameterInformation(parameterLabel)
    );
    const documentation = new vscode.MarkdownString();
    documentation.appendMarkdown(`此调用是实体 def 声明的 ${location.section} 方法`);
    if (call.section) {
      documentation.appendMarkdown(`(接收者 self.${call.section})`);
    }
    if (location.exposed) {
      documentation.appendMarkdown(' · **Exposed**: 可被客户端远程调用');
    }
    signature.documentation = documentation;
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter =
      parameterLabels.length > 0
        ? Math.min(call.activeArgument, parameterLabels.length - 1)
        : 0;
    return help;
  }
}

export interface SymbolHoverInfo {
  name: string;
  section: KBEngineSectionName;
  type?: string;
  flags?: string;
  defaultValue?: string;
  detailLevel?: string;
  database?: string;
  identifier?: string;
  persistent: boolean;
  args: string[];
  exposed?: boolean;
}

export function getSymbolHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  const symbolInfo = findEnclosingSymbol(document, position, word);
  if (!symbolInfo) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${symbolInfo.name}**\n\n`);
  markdown.appendMarkdown(`${getSectionLabel(symbolInfo.section)}中的自定义定义。\n\n`);

  if (PROPERTY_SECTIONS.has(symbolInfo.section)) {
    if (symbolInfo.type) {
      markdown.appendMarkdown(`**Type**: \`${symbolInfo.type}\`\n\n`);
    }
    if (symbolInfo.flags) {
      markdown.appendMarkdown(`**Flags**: \`${symbolInfo.flags}\`\n\n`);
    }
    // GEN-DEF-1e ③:属性数据流方向(同步源→受众),与 entityFlowGraph 主图
    // 同源旗标语义;无旗标给出「不注册任何域」,不发明方向。
    const syncDirection = describePropertySyncDirection(symbolInfo.flags);
    if (syncDirection) {
      markdown.appendMarkdown(`**同步方向**: ${syncDirection}\n\n`);
    }
    if (symbolInfo.defaultValue) {
      markdown.appendMarkdown(`**Default**: \`${symbolInfo.defaultValue}\`\n\n`);
    }
    if (symbolInfo.detailLevel) {
      markdown.appendMarkdown(`**DetailLevel**: \`${symbolInfo.detailLevel}\`\n\n`);
    }
    if (symbolInfo.database) {
      markdown.appendMarkdown(`**DatabaseLength**: \`${symbolInfo.database}\`\n\n`);
    }
    if (symbolInfo.identifier) {
      markdown.appendMarkdown(`**Identifier**: \`${symbolInfo.identifier}\`\n\n`);
    }
    // Persistent 字段的数据库落点(2026-10-13 用户令):悬停展示库表与列名;
    // types.xml 别名类型沿快照别名链展开,完整建表结构走 kbengine.database.open。
    if (symbolInfo.persistent) {
      const storageLine = describePropertyDatabaseStorageHover(document, symbolInfo.name);
      if (storageLine) {
        markdown.appendMarkdown(`\n\n**数据库存储**: ${storageLine}`);
      }
    }
  }

  if (METHOD_SECTIONS.has(symbolInfo.section)) {
    // GEN-DEF-1e ③:方法段调用方向(baseapp/cellapp 方法 / 客户端回调)。
    const methodDirection = describeMethodCallDirection(symbolInfo.section);
    if (methodDirection) {
      markdown.appendMarkdown(`**调用方向**: ${methodDirection}\n\n`);
    }
    markdown.appendMarkdown(`**参数个数**: ${symbolInfo.args.length}\n\n`);
    if (symbolInfo.args.length > 0) {
      markdown.appendMarkdown(`**Args**: \`${symbolInfo.args.join(', ')}\``);
    }
    if (symbolInfo.exposed) {
      markdown.appendMarkdown(`\n\n**Exposed**: \`true\`\n\n`);
      markdown.appendMarkdown('该方法可被客户端远程调用。');
    }
  }

  return new vscode.Hover(markdown);
}

/**
 * 属性悬停的数据库存储描述行(批131 用户令升级:完整 db.table.column +
 * 引擎 DDL 片段 + 具体大小限制;库表名转义,粘贴进外部 MySQL 客户端即用)。
 * 非持久属性无目标返回 null,悬停不显示该行。
 */
export function describePropertyDatabaseStorageHover(
  document: vscode.TextDocument,
  propertyName: string
): string | null {
  const entityName = path.basename(document.fileName, '.def');
  // IDE-REV-012:悬停只读已发布快照——冷/失效 miss 不整段同步构建,调度
  // 后台构建(阶段间让出宿主,可取消)后本悬停不出存储行,发布后下一悬停出
  return buildPropertyDatabaseStorageHover(
    describePropertyDatabaseStoragePublished(entityName, propertyName, document)
  );
}

export function createHookHover(hook: import('../hooks').KBEngineHook): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hook.name}** - ${vscode.l10n.t(HOOK_CATEGORY_NAMES[hook.category])}\n\n`);
  markdown.appendMarkdown(`${hook.description}\n\n`);
  markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
  markdown.appendMarkdown('**函数签名**:\n');
  markdown.appendCodeblock(hook.signature, 'python');
  markdown.appendMarkdown('\n**详细说明**:\n');
  markdown.appendMarkdown(hook.documentation);
  // 不可达(批64 定性):KBENGINE_HOOKS 全部 36 个 hook 均带 sourceLocation
  // 与 example(src/hooks.ts 数据不变式,引擎侧用例亦锁定 sourceLocation),
  // 两个 if 的假臂不可达。精确单行区间只摘除分支条目,悬停文案保持被覆盖计入分母。
  /* istanbul ignore start */
  if (hook.sourceLocation) {
  /* istanbul ignore stop */
    markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
  }
  /* istanbul ignore start */
  if (hook.example) {
  /* istanbul ignore stop */
    markdown.appendMarkdown('\n\n**使用示例**:\n');
    markdown.appendCodeblock(hook.example, 'python');
  }
  return new vscode.Hover(markdown);
}

// GEN-DEF-1e ②+口径①:user_type 带 impl 时,悬停补三契约方法状态与双向
// 序列化契约。workspace root 不可得 / 无 implementedBy / 未注册 → null
// (不打扰无契约的类型悬停)。
/**
 * SP-5: cellappIndex semantics for createCellEntityInNewSpace.
 * Sources: baseapp/Entity.md:144; cellappmgr.cpp:348-351 ((index-1)%size);
 * baseapp.cpp:2473-2479 (0 => load balancer).
 */
export function createCellappIndexHover(word: string): vscode.Hover | null {
  if (word !== 'cellappIndex' && word !== 'createCellEntityInNewSpace') {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  if (word === 'cellappIndex') {
    markdown.appendMarkdown('**cellappIndex** - createCellEntityInNewSpace 的目标 cellapp 序号\n\n');
  } else {
    markdown.appendMarkdown('**createCellEntityInNewSpace**(cellappIndex) - 新建 Space 并把本实体 cell 放入\n\n');
  }
  markdown.appendMarkdown('**语义**:\n');
  markdown.appendMarkdown('- `0`/`None`:由引擎负载均衡动态选择 cellapp(推荐,副本 space 默认用法)\n');
  markdown.appendMarkdown('- `N > 0`:固定选第 N 个 cellapp;索引溢出取模轮转——预期 4 个实际只有 3 个时,`4→1`、`5→2`(cellappmgr.cpp:348-351 `(N-1) % cellappSize`)\n\n');
  markdown.appendMarkdown('**搭配**:`KBEngine.setAppFlags(KBEngine.APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING)` 把大地图钉在固定 cellapp,副本用 `cellappIndex=0` 走机动进程,互不抢负载。\n\n');
  markdown.appendMarkdown('**示例**:\n');
  markdown.appendCodeblock(['# 大地图:固定到第 2 个 cellapp(需先对该 cellapp 设 NOT_PARTCIPATING_LOAD_BALANCING)', 'self.createCellEntityInNewSpace(2)', '', '# 副本:自动均衡', 'self.createCellEntityInNewSpace(0)'].join('\n'), 'python');
  markdown.appendMarkdown('\n**源码**: `baseapp.cpp:2462` → `cellappmgr.cpp:310`\n');
  return new vscode.Hover(markdown);
}

/** SP-1: entrance script (kbemain) module-level SPI hover - no self, scoped by component entry path */
export function createEntryHookHover(hook: import('../entryHooks').KBEngineEntryHook): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hook.name}** - Entry Script (${hook.component})\n\n`);
  markdown.appendMarkdown(`${hook.description}\n\n`);
  markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
  markdown.appendMarkdown('**函数签名**:\n');
  markdown.appendCodeblock(hook.signature, 'python');
  markdown.appendMarkdown('\n**详细说明**:\n');
  markdown.appendMarkdown(hook.documentation);
  markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
  if (hook.example) {
    markdown.appendMarkdown('\n\n**使用示例**:\n');
    markdown.appendCodeblock(hook.example, 'python');
  }
  return new vscode.Hover(markdown);
}

/** SP-2: kbe/KBEngine module symbol hover - knowledge summary + typings anchor */
export function createKbeSymbolHover(entry: import('../kbeModuleIndex').KbeSymbolEntry): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  const language = vscode.env.language;
  markdown.appendMarkdown(`**${entry.name}** - ${entry.signature}\n\n`);
  markdown.appendMarkdown(summaryForLanguage(entry, language) + '\n\n');
  markdown.appendMarkdown('原始声明: `' + entry.sourceFile + ':' + entry.sourceLine + '`');
  const note = engineApiVersionAnnotation(entry, getEngineVersion(), language);
  if (note) {
    markdown.appendMarkdown('\n\n' + note);
  }
  return new vscode.Hover(markdown);
}

export function resolveUserTypeContractSection(
  document: vscode.TextDocument,
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>
): string | null {
  if (!customTypeInfo.implementedBy) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }
  const status = userTypeContractStatusForName(workspaceRoot, customTypeInfo.name);
  if (!status) {
    return null;
  }
  return renderUserTypeContractHoverSection(status);
}

export function getCustomTypeHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeTarget = findCustomTypeAtPosition(document, position, word);
  if (!customTypeTarget) {
    return null;
  }

  return createCustomTypeHover(
    customTypeTarget.info,
    'Custom type from `types.xml`',
    // 批134:声明行悬停追加落库形态;implementedBy 值上的悬停只谈引用,不谈存储
    customTypeTarget.isImplementedByValue ? null : getTypeStorageShapeMarkdown(document, word),
    resolveUserTypeContractSection(document, customTypeTarget.info)
  );
}

// 批134:types.xml 类型声明行悬停的落库形态段。形态判定走 schema 构建
// 器的别名/列展开语义(getTypeStorageShape 与引擎装载同源),这里把形态
// 翻成说明文字;悬停的就是 types.xml 本体,直接按文档路径解析
export function getTypeStorageShapeMarkdown(document: vscode.TextDocument, word: string): string | null {
  const shapeLines = describeTypeStorageShape(getTypeStorageShape(document.fileName, word));
  return `**落库形态**:\n${shapeLines.map(line => `- ${line}`).join('\n')}\n\n`;
}

export function describeTypeStorageShape(shape: TypeStorageShape): string[] {
  if (shape.kind === 'builtin') {
    // IDE-DB-001:内建形态附容量说明(可指定与否/引擎默认 255/上限与校验方)
    const capacity = describeBuiltinTypeCapacity(shape.typeName);
    return [
      `主表单列${shape.columnType ? `（\`${shape.columnType}\`）` : ''}`,
      ...(capacity ? [`容量：${capacity}`] : [])
    ];
  }
  if (shape.kind === 'fixedDict') {
    const keys = shape.topLevelKeys.length > 0
      ? `；顶层键各占一列：${shape.topLevelKeys.join('、')}`
      : '';
    return [
      `平铺成列，不成表${keys}`,
      '容量：逐键按其键类型——STRING 键可配长度（未配置引擎默认 255），整型/浮点键为显示宽度，blob 族键不可配'
    ];
  }
  if (shape.kind === 'array') {
    const element = shape.element
      ? `元素落列：${describeTypeStorageElement(shape.element)}`
      : '缺 <of>，元素类型未知';
    return [
      `成子表 \`tbl_<实体>_<属性>\`，元素各占一行；${element}`,
      '容量：逐元素按其元素类型，规则同主表单列'
    ];
  }
  return ['未知类型，引擎装载 types.xml 会失败'];
}

export function describeTypeStorageElement(element: TypeStorageShape): string {
  if (element.kind === 'builtin') {
    return `\`sm_value\`${element.columnType ? `（\`${element.columnType}\`）` : ''}`;
  }
  if (element.kind === 'fixedDict') {
    return element.topLevelKeys.length > 0
      ? `键平铺：${element.topLevelKeys.join('、')}`
      : '键平铺';
  }
  if (element.kind === 'array') {
    return element.element ? '`sm_value`（套更深层子表）' : '`sm_value`';
  }
  return '未知元素类型';
}

// types.xml implementedBy 反向跳转提示(python 侧):光标在被引用符号上时
// 给出引用方与落点,点击跳转(F12/Ctrl+点击)走 PythonDefinitionProvider
// 的反向链,提示与跳转同一套解析,不另起一套
export function getImplementedByReverseHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!document.fileName.toLowerCase().endsWith('.py')) {
    return null;
  }

  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  const reference = findTypesXmlImplementedByReference(workspaceRoot, document.fileName, word);
  if (!reference) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${word}**\n\n`);
  markdown.appendMarkdown(
    `types.xml 自定义类型 \`${reference.typeName}\` 以 \`implementedBy\` 引用此符号。\n\n`
  );
  markdown.appendMarkdown(
    `F12 / Ctrl+点击 跳回 \`${path.basename(reference.filePath)}\` 第 ${reference.line} 行。`
  );
  return new vscode.Hover(markdown);
}

export function getTypeValueHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(word, document);
  if (customTypeInfo) {
    return createCustomTypeHover(
      customTypeInfo,
      'Referenced custom type from `types.xml`',
      null,
      resolveUserTypeContractSection(document, customTypeInfo)
    );
  }

  const componentPath = findDefinitionFileByCategory(word, 'component', document);
  if (componentPath) {
    return createDefinitionReferenceHover(word, 'Component type', componentPath);
  }

  const entityPath = findEntityDefinitionFile(word, document);
  if (entityPath) {
    const extraLines = getEntityRuntimeHoverLines(document, word);
    return createDefinitionReferenceHover(word, 'Entity type', entityPath, extraLines);
  }

  return null;
}

export function createCustomTypeHover(
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>,
  summary: string,
  shapeMarkdown: string | null = null,
  contractSection: string | null = null
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${customTypeInfo.name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**AliasType**: \`${customTypeInfo.aliasType}\`\n\n`);

  if (customTypeInfo.rawValue && customTypeInfo.rawValue !== customTypeInfo.aliasType) {
    markdown.appendMarkdown(`**Raw**: \`${customTypeInfo.rawValue}\`\n\n`);
  }

  if (customTypeInfo.implementedBy) {
    markdown.appendMarkdown(`**implementedBy**: \`${customTypeInfo.implementedBy}\`\n\n`);
  }

  if (customTypeInfo.pythonFilePath) {
    markdown.appendMarkdown(`**Python**: \`${path.basename(customTypeInfo.pythonFilePath)}\`\n\n`);
  }

  if (customTypeInfo.properties.length > 0) {
    markdown.appendMarkdown('**Properties**:\n');
    for (const property of customTypeInfo.properties) {
      markdown.appendMarkdown(`- \`${property.name}\`: \`${property.typeName || 'UNKNOWN'}\`\n`);
    }
  }

  // GEN-DEF-1e ②+口径①:user_type 带 impl 时补三契约方法状态与双向序列化契约
  if (contractSection) {
    markdown.appendMarkdown(contractSection);
  }

  if (shapeMarkdown) {
    markdown.appendMarkdown(shapeMarkdown);
  }

  return new vscode.Hover(markdown);
}

export function createDefinitionReferenceHover(
  name: string,
  summary: string,
  filePath: string,
  extraLines: string[] = []
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**Definition**: \`${path.basename(filePath)}\`\n\n`);

  for (const line of extraLines) {
    markdown.appendMarkdown(`${line}\n\n`);
  }

  return new vscode.Hover(markdown);
}

export function getEntityRegistrationHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!document.fileName.endsWith('entities.xml')) {
    return null;
  }

  const ast = parseDefAst(document);
  const root = ast?.root;
  if (!root) {
    return null;
  }

  const offset = document.offsetAt(position);
  const textNode = findTextNodeAtOffset(root, offset);
  const elementNode = textNode?.parent || findDeepestElementAtOffset(root, offset);
  if (!elementNode || elementNode.parent !== root || elementNode.name !== word) {
    return null;
  }

  const defPath = findEntityDefinitionFile(word, document);
  const extraLines = getEntityRuntimeHoverLines(document, word);
  const utypeLine = getEntityUtypeLine(document, word);
  if (utypeLine) {
    extraLines.unshift(utypeLine);
  }
  return createDefinitionReferenceHover(
    word,
    'Entity registration from `entities.xml`',
    defPath || `${word}.def`,
    extraLines
  );
}

// 清单序号行(source-analysis 设计 D3):引擎按 entities.xml 子节点顺序
// 分配 utype(entitydef.cpp:253-265、2382-2396),注册快照保持清单序,
// 首次出现位置即序号(同名重复引擎按首条合并,重复条目另有诊断提示)。
export function getEntityUtypeLine(
  document: vscode.TextDocument,
  entityName: string
): string | null {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  const entities = getRegisteredEntities(workspaceRoot);
  const index = entities.findIndex(entity => entity.name === entityName);
  if (index < 0) {
    return null;
  }

  return `**Utype**: \`${index + 1}\`(entities.xml 清单顺序,共 \`${entities.length}\` 个实体)`;
}

// def 链合并呈现(source-analysis 设计 D5 剩余段):def 文档内悬停根级
// <Parent> 元素(含其取值文本)时,呈现该 def 的继承闭包三面——Parent 链
// 递归 + interfaces/ 平铺 + components/ 挂接,与引擎归并口径一致
// (entitydef.cpp:890-924、551-639、642-771)。引擎 loadParentClass 未见
// 防环,buildDefChain 带 visited 截断并如实标注。
export function getDefChainHover(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | null {
  const fileName = document.fileName.toLowerCase();
  if (document.languageId !== 'kbengine-def' && !fileName.endsWith('.def')) {
    return null;
  }

  const ast = parseDefAst(document);
  const root = ast?.root;
  if (!root) {
    return null;
  }

  const offset = document.offsetAt(position);
  const node = findTextNodeAtOffset(root, offset)?.parent
    || findDeepestElementAtOffset(root, offset);
  if (!node || node.parent !== root || node.name !== 'Parent') {
    return null;
  }

  const entityName = path.basename(document.fileName, '.def');
  const info = buildDefChain(document.fileName);
  const describe = (item: { name: string; defPath: string | null }): string =>
    `\`${item.name}\`${item.defPath ? '' : '(def 缺失)'}`;

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${entityName} 的 def 链**(引擎归并口径)\n\n`);
  if (info.parentChain.length > 0) {
    const chainText = info.parentChain.map(describe).join(' → ');
    const cycleNote = info.cycleTruncated ? ';检测到环,已截断' : '';
    markdown.appendMarkdown(`- **Parent 链**: ${chainText}(共 ${info.parentChain.length} 层${cycleNote})\n\n`);
  }
  if (info.interfaces.length > 0) {
    const list = info.interfaces.map(describe).join('、');
    markdown.appendMarkdown(`- **Interfaces 平铺**: ${list}(接口 def 不跟随 Parent)\n\n`);
  }
  if (info.components.length > 0) {
    const list = info.components.map(describe).join('、');
    markdown.appendMarkdown(`- **Components 挂接**: ${list}\n\n`);
  }
  if (info.parentChain.length === 0 && info.interfaces.length === 0 && info.components.length === 0) {
    markdown.appendMarkdown('无 Parent、接口与组件声明。');
  }

  return new vscode.Hover(markdown);
}

export function getRegisteredEntityInfo(
  document: vscode.TextDocument,
  entityName: string
) {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  return getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName) || null;
}

export function getEntityRuntimeHoverLines(
  document: vscode.TextDocument,
  entityName: string
): string[] {
  const entityInfo = getRegisteredEntityInfo(document, entityName);
  const runtimeProfile = getEntityRuntimeProfile(entityName, document);
  if (!entityInfo) {
    return [];
  }

  const renderFacet = (
    label: 'Base' | 'Cell' | 'Client',
    facet: ReturnType<typeof getEntityRuntimeProfile> extends infer T
      ? T extends { base: infer F } ? F : never
      : never,
    declaredValue: boolean
  ): string => {
    const state = facet.enabled ? 'enabled' : 'disabled';
    if (facet.declared) {
      return `**${label}**: \`${declaredValue}\` (declared, ${state})`;
    }

    if (facet.scriptExists) {
      return `**${label}**: \`${facet.enabled}\` (inferred from script)`;
    }

    return `**${label}**: \`false\` (not declared, no script)`;
  };

  // 不可达(批62 定性):entityInfo 与 runtimeProfile 同源于同一 workspaceRoot 的
  // getRegisteredEntities 快照,上面 !entityInfo 已早退,此处 profile 必非 null。
  /* istanbul ignore start */
  if (!runtimeProfile) {
    return [
      `**Base**: \`${entityInfo.hasBase}\``,
      `**Cell**: \`${entityInfo.hasCell}\``,
      `**Client**: \`${entityInfo.hasClient}\``
    ];
  }
  /* istanbul ignore stop */

  const extraLines = [
    renderFacet('Base', runtimeProfile.base, entityInfo.hasBase),
    renderFacet('Cell', runtimeProfile.cell, entityInfo.hasCell),
    renderFacet('Client', runtimeProfile.client, entityInfo.hasClient),
    `**Runtime**: \`${runtimeProfile.runtimeRoles.join(' / ') || 'None'}\``,
    `**Visibility**: ${runtimeProfile.visibilitySummary}`,
    `**Registration**: ${runtimeProfile.registrationSummary}`
  ];

  if (!runtimeProfile.client.enabled) {
    extraLines.push('**Meaning**: client SDK will not create this entity type on the client side.');
  } else {
    extraLines.push('**Meaning**: client SDK may generate and instantiate this entity type on the client side.');
  }

  return extraLines;
}

// 根修令③:段标签悬停附带本工程的真实实现解析——命中给实际脚本路径,
// 未命中列全部期望位置,不给花括号模板。
export function describeImplementationForHover(
  document: vscode.TextDocument,
  sectionWord: string
): string | null {
  const sectionRoles: Partial<Record<string, Array<'base' | 'cell' | 'client'>>> = {
    Properties: ['base', 'cell', 'client'],
    BaseMethods: ['base'],
    CellMethods: ['cell'],
    ClientMethods: ['client']
  };
  const roles = sectionRoles[sectionWord];
  if (!roles) {
    return null;
  }

  const entityName = path.basename(document.fileName, '.def');
  for (const role of roles) {
    const scriptPath = findEntityScriptFile(entityName, role, document);
    if (scriptPath) {
      return `当前实现:${formatWorkspaceRelativePath(scriptPath, getWorkspaceRootForDocument(document))}`;
    }
  }
  return `未找到实体脚本,期望位置:${describeExpectedScriptPaths(document, entityName, roles).join('、')}`;
}

export function buildSymbolHoverInfo(
  section: KBEngineSectionName,
  symbolNode: DefElementNode
): SymbolHoverInfo {
  return {
    name: symbolNode.name,
    section,
    type: getScalarChildValue(symbolNode, 'Type'),
    flags: getScalarChildValue(symbolNode, 'Flags'),
    defaultValue: getScalarChildValue(symbolNode, 'Default'),
    detailLevel: getScalarChildValue(symbolNode, 'DetailLevel'),
    database: getScalarChildValue(symbolNode, 'DatabaseLength'),
    identifier: getScalarChildValue(symbolNode, 'Identifier'),
    // 引擎装载语义:Properties 字段文本恰为 "true"(忽略大小写)才持久,
    // 与 databaseSchema 的 isTruePersistent 同口径(loadDefPropertys)。
    persistent: getScalarChildValue(symbolNode, 'Persistent')?.trim().toLowerCase() === 'true',
    args: getScalarChildValues(symbolNode, 'Arg'),
    exposed: hasTruthyChildTag(symbolNode, 'Exposed')
  };
}
