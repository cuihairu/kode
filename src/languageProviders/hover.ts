// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { documentEventCacheKey, findEventCallsCached } from '../eventApi';
import { EntityMappingManager } from '../entityMapping';
import { getDocumentLines } from '../backend/documentStore';
import { getTypeStorageShape } from '../databaseSchema';
import { getWorkspaceRootForDocument, resolveEntityAnnotationType, resolveEntityAnnotationTypeWithReason } from '../definitionWorkspace';
import { getHookByName } from '../hooks';
import { getEntryHookByName, isComponentEntryScriptFile } from '../backend/entryHooks';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_RELOAD_FUNCTIONS, KBENGINE_TYPES } from '../backend/kbengineMetadata';
import { resolveEntityBuiltinPropertyHit, resolveEntityComponentFaceFromPath, type EntityComponentFace } from '../backend/entityBuiltinProperties';
import { formatBuiltinPropertyHover, formatEntityDefMethodHover, formatEventStatsHover, formatInferredReturnHover, formatSelfPropertyTypeHover } from '../backend/hoverMarkdown';
import { apiDocDomainsForFace, formatApiDocHover, formatApiDocSupplement, getKbengineApiAccessAtPosition, getPythonCallbackDefinitionAtPosition, lookupApiDoc } from '../backend/pythonApiHoverDocs';
import { currentHoverLanguageEnv, readHoverLanguageSetting, resolveHoverLanguage } from '../hoverLocale';
import { hasLocalReturnCandidate, resolveLocalVariableReturnTypeFromSnapshot } from '../backend/pythonReturnTypeInference';
import { inferLocalReturnTypeFromRust } from '../backend/localReturnTypeRust';
import { flowVersionKeyForDocument } from '../flowVersionKey';
import { resolveAnnotationTypeWithReason } from '../pythonTypeStubs';
import { resolveSelfPropertyAnnotation, type DefPropertyLocator } from '../backend/selfPropertyTypeInference';
import { behaviorEntriesForSymbol, behaviorNotesMarkdown, fixedDictBehaviorNoteMarkdown } from '../backend/behaviorKnowledge';
import { isFixedDictTypeName } from '../backend/behaviorLints';
import { getPythonReceiverCallAtPosition, type PythonReceiverCall, getPythonSelfAccessAtPosition, getPythonCallAtPosition, type PythonCallAtPosition } from '../backend/pythonLanguageUtils';
import { getKbeAliases, getKbeSymbol, resolveKbeAccessAtPosition } from '../kbeModuleIndex';
import { GlobalDataDictIndex, getDataDictAccessInCodeContext, getKbeDataDictAccessAtPosition, inferDataDictValueType, isKeyInsideLineComment, queryDataDictSitesForAccess, resolveScopeRoot } from '../globalDataIndex';
import { createHoverRequestDeadline, createWaiterUnionToken, raceWithBudget } from '../hoverBudget';
import { TAG_HOVER_DOCS, getLanguageFeatureConfig } from './shared';
import { getKodeCoreShadowGate, serveHoverFromRust } from '../backend/kodeCoreShadowFaces';
import { formatDefMethodParameter, formatDefMethodSignature } from './completion';
import { awaitDataDictIndexReady, getPythonDataDictIndexGeneration, isPythonDataDictIndexEnabled } from './pythonDefinition';
import { getPythonMethodDeclarationAtPosition } from './callHierarchy';
import { createInferredMirrorHover } from '../inferredMirrorLookup';
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
    rustHoverAttempted?: boolean,
    // 批 D 重入标记:true = 局部返回注解面(Rust 接收者定型)已试过(miss),
    // 本轮直接走下游既有链(TYP-ARRAY/数据字典/自属性等)
    localReturnAttempted?: boolean
  ): vscode.ProviderResult<vscode.Hover> {
    if (token?.isCancellationRequested) { return null; }
    if (hoverInFlightGateForTests) {
      // IDE-REV-032:门住一段确定性在途窗口;释放方负责清闸,重入走原路径
      const gate = hoverInFlightGateForTests;
      return gate().then(() => this.provideHoverTimed(document, position, token, timer, rustHoverAttempted, localReturnAttempted));
    }
    // 2026-11-08 用户令「直接切到 rust」:服务轨道下语料文档(.def + 三类
    // XML)hover 先走 Rust(kode-server textDocument/hover);Rust 命中即用,
    // 未命中(null:词未知/非语料/任何失败)重入下方 TS 既有链(rustHover-
    // Attempted 防重入)。Python 文档零请求直通 TS。本分支在 deadline 建立
    // 之前:Rust 腿自带端到端交互预算(INTERACTIVE_SERVE_BUDGET_MS;
    // KBUG-TIME),miss 后重入再走 TS 预算闸,不占 TS 预算。
    if (
      !rustHoverAttempted &&
      document.languageId !== 'python' &&
      getKodeCoreShadowGate()?.serveFromRust()
    ) {
      return serveHoverFromRust(document, position).then(value =>
        value !== null
          ? new vscode.Hover(new vscode.MarkdownString(value))
          : this.provideHoverTimed(document, position, token, timer, true, localReturnAttempted)
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
    // → data: JSONDATA」):光标落在变量名上时,按右侧调用的被调函数返回注解
    // 推导。解出才提示并标注来源;解不出不显示任何类型(不显 Any、不显空类型,
    // 落回普通 hover 链)。
    // 批 D(精确性主车道,2026-11-08 用户令「直接切 rust」同车):Rust-first
    // 接收者定型(localReturnType 面:同文件 def 调用/self 方法/类限定/链式/
    // 别名链,hasLocalReturnCandidate 同域存在性预检)——TS 级联兜底(全局方法名猜测,
    // 跨类误绑)已删除,TS 链只留 import 绑定路径。Rust 腿自带端到端交互预算
    // (LOCAL_RETURN_RUST_BUDGET_MS,覆盖 start/排队/响应;KBUG-TIME),
    // 不占 TS 预算;provider 取消即提前结束。miss/失败/超时/杀开关
    // (kbengine.core.backend=ts)回落 TS 既有链,返回承诺(面内 await,语义不变)。
    if (document.languageId === 'python' && vscode.workspace.getConfiguration('kbengine').get<boolean>('hover.returnTypeInference', true)) {
      // PR2 快照接入:局部变量推导复用快照行数据(同版本不重拆)
      // IDE-MET-003:推导整段属注解查询面(annotation-query;Rust 腿同段计量)
      // KBUG-GATE 预检(存在性口径,形态无关):作用域内无同名写点 = Rust/TS
      // 双链必空,零成本跳过本段,下游既有面(TYP-ARRAY/数据字典/自属性)照走
      // 同步原路(不进异步不重入);伪赋值(字符串/注释,掩码)与非法查询快跳。
      // 不在 TS 侧用「单层调用」正则克隆 Rust 的 RHS 形态判定——修前别名链
      // (x = alias)与链式调用(x = build().load())在生产入口被吞,Rust
      // 根本收不到查询;形态可推导性与答案诚实性由 Rust 面裁定。
      const docLines = getDocumentLines(document);
      if (!localReturnAttempted && hasLocalReturnCandidate(docLines, position.line, word)) {
        const stopQuery = timer?.start('annotation-query');
        const resolveInferred = async (): Promise<ReturnType<typeof resolveLocalVariableReturnTypeFromSnapshot>> => {
          try {
            const fromRust = await inferLocalReturnTypeFromRust(
              docLines,
              position.line,
              word,
              flowVersionKeyForDocument(document),
              // KBUG-TIME-04:provider 取消(光标移开/文档更新/token 取消)
              // 即时结束 Rust 等待,迟到响应不发布旧 hover
              () => token?.isCancellationRequested ?? false,
              // KBUG-ORDER-04:同行光标列透传(0 基 UTF-16 同 VSCode 口径;
              // 同行读/写按列裁定,缺列 Rust 侧保守回退行首非空白列)
              position.character
            );
            if (fromRust) {
              return fromRust;
            }
          } finally {
            stopQuery?.();
          }
          // miss/失败/杀开关 → TS 既有链(import 绑定路径;级联猜测已删)
          const stopInfer = timer?.start('annotation-query');
          try {
            return resolveLocalVariableReturnTypeFromSnapshot(
              docLines,
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
        };
        return resolveInferred().then(inferred => {
          deadline.dispose();
          if (!inferred) {
            // 双链都推不出(接收者不可知)→ 诚实无类型段,重入下游既有链
            // (语料分支同款重入口径;localReturnAttempted 防再入)
            return this.provideHoverTimed(document, position, token, timer, rustHoverAttempted, true);
          }
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown(formatInferredReturnHover(inferred.target, inferred.annotation, inferred.methodName));
          return new vscode.Hover(markdown);
        });
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

    // KODE-CFG-017-R:镜像兜底富化——整条 KBEngine 域解析链未命中时,普通
    // Python 符号读 .kbengine/inferred 副本出推断类型(返回/形参/变量注解)。
    // 副本缺失/无注解静默回退 null(不抛错不刷通知);更强面已提前 return,
    // 本面只补缺不覆盖,且副本绝不进 extraPaths/导入解析(T-04 禁遮蔽)。
    if (document.languageId === 'python' && featureConfig.hoverShowSymbolDocs) {
      const mirrorHover = createInferredMirrorHover(document, word);
      if (mirrorHover) {
        return mirrorHover;
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

// SRC-012: module-level hover builder/value-docs faces live in hoverBuilders.ts
// (moved verbatim). Re-exports keep every existing './hover' import path intact.
import {
  createCellappIndexHover,
  createEntryHookHover,
  createHookHover,
  createKbeSymbolHover,
  describeImplementationForHover,
  getCustomTypeHover,
  getDefChainHover,
  getEntityRegistrationHover,
  getImplementedByReverseHover,
  getSymbolHover,
  getTypeValueHover,
} from './hoverBuilders';

export type { SymbolHoverInfo } from './hoverBuilders';
export {
  buildSymbolHoverInfo,
  createCellappIndexHover,
  createCustomTypeHover,
  createDefinitionReferenceHover,
  createEntryHookHover,
  createHookHover,
  createKbeSymbolHover,
  describeImplementationForHover,
  describePropertyDatabaseStorageHover,
  describeTypeStorageElement,
  describeTypeStorageShape,
  getCustomTypeHover,
  getDefChainHover,
  getEntityRegistrationHover,
  getEntityRuntimeHoverLines,
  getEntityUtypeLine,
  getImplementedByReverseHover,
  getRegisteredEntityInfo,
  getSymbolHover,
  getTypeStorageShapeMarkdown,
  getTypeValueHover,
  resolveUserTypeContractSection,
} from './hoverBuilders';
