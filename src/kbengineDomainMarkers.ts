// KODE-SYN-005:KBEngine 符号可选领域标记(轻量装饰试点)。
//
// 给**已解析**的 KBEngine 符号出编辑器装饰(下划线类,零颜色),与 Pylance
// 的语义高亮分层共存(装饰层叠在其上,不占用 semantic token 命名空间——
// RUST-148 的通用 Semantic Tokens 默认关闭决策保持不动)。四个试点面:
// ① self.<DEF 属性> —— def 声明命中的属性访问(resolvePropertyDefinitionInfo
//    同一索引口径,继承链由索引侧裁定);
// ② self.base/cell/client.<RPC> —— 接收者段闸命中的 def 方法
//    (resolveMethodDefinition 同段过滤;同名方法跨 Base/Cell/Client 段由
//    接收者段分辨,绝不按名字猜);
// ③ 引擎生命周期钩子 —— entity 脚本树内、类体上声明且名字命中
//    KBENGINE_HOOKS(36 条表)的方法声明;表外/非 entity 树一律不出;
// ④ 有确定身份的数据字典键 —— globalData/baseAppData/cellAppData 访问点
//    键签名在索引里有真实写点(queryMarked;首扫未就绪 ready=false 直接
//    略过,绝不把「索引未建」读成「无此键」)。
//
// 诚实边界:解析器未命中/索引未就绪/未知接收者(self.other.x)一律零装饰,
// 不猜;所有面只消费现有符号面与索引快照,不新增解析、不阻塞宿主。
import * as vscode from 'vscode';
import { parsePythonFile } from './backend/pythonParser';
import { findPythonSelfPropertyAccesses } from './backend/propertyCodeLens';
import { findPythonReceiverCalls } from './backend/pythonLanguageUtils';
import { maskPythonNonCode } from './pythonSourceMask';
import { inferMethodSectionFromPythonFile } from './backend/pythonMethodCallQueries';
import { KBENGINE_HOOKS, getHookByName } from './hooks';
import {
  extractModuleConstantBindings,
  findKbeDataDictAccesses
} from './backend/globalDataIndexCore';
import { getKbeAliases } from './kbeModuleIndex';
import { queryDataDictSitesForAccessMarked, resolveScopeRoot } from './globalDataIndex';
import type { KbeDataDictAccess } from './backend/globalDataIndexCore';
import type { GlobalDataDictIndex } from './globalDataIndex';
import type { EntityMappingManager } from './entityMapping';

/** 开关(可选试点,默认关;与 RUST-148 默认关闭决策同向) */
export const DOMAIN_MARKERS_ENABLED_DEFAULT = false;
export const DOMAIN_MARKERS_CONFIG_KEY = 'kbengine.domainMarkers.enabled';

/** 领域面(装饰类型一面对应一类型) */
export type DomainMarkerFace = 'property' | 'rpc' | 'hook' | 'dataKey';

/** 一个标记位(0 起行/列 + UTF-16 长度;应用层转 Range) */
export interface DomainMarkerSpan {
  line: number;
  character: number;
  length: number;
  face: DomainMarkerFace;
  /** 悬停说明(域身份与出处,绝不发明) */
  tooltip: string;
}

/** 解析注入面(结构窄型;生产装配传 EntityMappingManager 的两个解析口) */
export interface DomainMarkerResolvers {
  resolveProperty(
    pythonFile: string,
    fullPath: string
  ): Promise<{
    identity: { symbolName: string };
    domains: readonly string[];
    typeName?: string;
    defFile: string;
    line: number;
  } | null>;
  resolveMethod(
    pythonFile: string,
    methodName: string,
    section: 'BaseMethods' | 'CellMethods' | 'ClientMethods'
  ): Promise<{ defFile: string; line: number; section: string } | null>;
  /** 数据字典键查询(ready=false=首扫未就绪,调用方直接略过) */
  queryDataKey(
    dict: string,
    keySignature: string,
    root: string
  ): { sites: ReadonlyArray<{ kind?: string }>; ready: boolean };
}

/** 生产装配的解析口(EntityMappingManager + GlobalDataDictIndex 直连) */
export function defaultDomainMarkerResolvers(
  entityMappingManager: EntityMappingManager,
  dataDictIndex: GlobalDataDictIndex
): DomainMarkerResolvers {
  return {
    resolveProperty: (pythonFile, fullPath) =>
      entityMappingManager.resolvePropertyDefinitionInfo(pythonFile, fullPath),
    resolveMethod: (pythonFile, methodName, section) =>
      entityMappingManager.resolveMethodDefinition(pythonFile, methodName, section),
    queryDataKey: (dict, keySignature, root) =>
      queryDataDictSitesForAccessMarked(dataDictIndex, {
        dict,
        keySignature,
        line: 0,
        keyStart: 0,
        keyEnd: 0,
        kind: 'read',
        valueText: null,
        exprEnd: 0
      } as KbeDataDictAccess, root)
  };
}

/** 计算一文档的全部领域标记位(纯函数核;解析注入,方便真索引/桩双测) */
export async function computeDomainMarkerSpans(
  text: string,
  pythonFile: string,
  resolvers: DomainMarkerResolvers
): Promise<DomainMarkerSpan[]> {
  const spans: DomainMarkerSpan[] = [];
  // 掩码行域(列不位移):字符串/注释里的伪访问不进发现面
  const masked = maskPythonNonCode(text);

  // ① def 属性面
  const accesses = findPythonSelfPropertyAccesses(masked);
  const propertyHits = await Promise.all(
    accesses.map(access => resolvers.resolveProperty(pythonFile, access.fullPath))
  );
  accesses.forEach((access, index) => {
    const hit = propertyHits[index];
    if (!hit) {
      return;
    }
    spans.push({
      line: access.line,
      character: access.character,
      length: access.fullPath.length,
      face: 'property',
      tooltip: `def 属性 · ${hit.identity.symbolName} · 域位 ${hit.domains.join('/')}` +
        `${hit.typeName ? ` · ${hit.typeName}` : ''} · ${hit.defFile}:${hit.line}`
    });
  });

  // ② RPC 面(接收者段闸;同名跨段由段分辨)
  const calls = findPythonReceiverCalls(masked);
  const methodHits = await Promise.all(
    calls.map(call => resolvers.resolveMethod(pythonFile, call.methodName, call.section))
  );
  calls.forEach((call, index) => {
    const hit = methodHits[index];
    if (!hit) {
      return;
    }
    spans.push({
      line: call.line,
      character: call.character,
      length: call.methodName.length,
      face: 'rpc',
      tooltip: `def RPC(${call.receiver}) · ${hit.section} · ${hit.defFile}:${hit.line}`
    });
  });

  // ③ 生命周期钩子面:entity 脚本树内、类体方法声明、名字命中 36 条表
  if (inferMethodSectionFromPythonFile(pythonFile)) {
    for (const cls of parsePythonFile(text, pythonFile).classes) {
      for (const [name, position] of cls.methods) {
        const hook = getHookByName(name);
        if (!hook) {
          continue;
        }
        spans.push({
          line: position.line,
          character: position.character,
          length: name.length,
          face: 'hook',
          tooltip: `引擎生命周期钩子 · ${hook.name} · ${hook.category}`
        });
      }
    }
  }

  // ④ 数据字典键面:键签名在索引里有真实写点才有身份;未就绪直接略过
  const aliases = getKbeAliases(text);
  if (aliases.size > 0) {
    const bindings = extractModuleConstantBindings(text);
    const root = resolveScopeRoot(pythonFile);
    for (const access of findKbeDataDictAccesses(text, aliases, undefined, undefined, bindings)) {
      if (access.keySignature === null) {
        continue;
      }
      const marked = resolvers.queryDataKey(access.dict, access.keySignature, root);
      if (!marked.ready) {
        continue;
      }
      const writes = marked.sites.filter(site => site.kind === 'write').length;
      if (writes === 0) {
        continue;
      }
      spans.push({
        line: access.line,
        character: access.keyStart,
        length: access.keyEnd - access.keyStart,
        face: 'dataKey',
        tooltip: `数据字典键 · ${access.dict} · ${access.kind} · 写点 ${writes}`
      });
    }
  }

  return spans;
}

/** 各面的装饰样式(零颜色,纯下划线形态;tooltip 带域身份) */
function decorationStyleFor(face: DomainMarkerFace): vscode.DecorationRenderOptions {
  switch (face) {
    case 'property':
      return { textDecoration: 'underdotted' };
    case 'rpc':
      return { textDecoration: 'underline' };
    case 'hook':
      return { textDecoration: 'underdouble' };
    case 'dataKey':
      return { textDecoration: 'underdotted' };
  }
}

/** 装配面:注册装饰类型 + 编辑器事件接线,返回Disposable(随 context 释放) */
export function setupKbengineDomainMarkers(
  context: vscode.ExtensionContext,
  deps: {
    entityMappingManager: EntityMappingManager;
    dataDictIndex: GlobalDataDictIndex;
  }
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const resolvers = defaultDomainMarkerResolvers(deps.entityMappingManager, deps.dataDictIndex);
  const decorationTypes: Record<DomainMarkerFace, vscode.TextEditorDecorationType> = {
    property: vscode.window.createTextEditorDecorationType(decorationStyleFor('property')),
    rpc: vscode.window.createTextEditorDecorationType(decorationStyleFor('rpc')),
    hook: vscode.window.createTextEditorDecorationType(decorationStyleFor('hook')),
    dataKey: vscode.window.createTextEditorDecorationType(decorationStyleFor('dataKey'))
  };
  const cache = new Map<string, { version: number; spans: DomainMarkerSpan[] }>();
  const pending = new Map<string, NodeJS.Timeout>();

  const isEnabled = (): boolean =>
    vscode.workspace.getConfiguration('kbengine').get<boolean>(
      'domainMarkers.enabled',
      DOMAIN_MARKERS_ENABLED_DEFAULT
    );

  const applyToEditors = (uri: vscode.Uri): void => {
    const entry = cache.get(uri.fsPath);
    // 真宿主恒给数组;`?? []` 只为 fake-vscode 替身(不建编辑器对象)兜底
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      if (editor.document.uri.fsPath !== uri.fsPath) {
        continue;
      }
      const grouped: Record<DomainMarkerFace, vscode.DecorationOptions[]> = {
        property: [], rpc: [], hook: [], dataKey: []
      };
      for (const span of entry?.spans ?? []) {
        grouped[span.face].push({
          range: new vscode.Range(
            new vscode.Position(span.line, span.character),
            new vscode.Position(span.line, span.character + span.length)
          ),
          hoverMessage: span.tooltip
        });
      }
      for (const face of Object.keys(grouped) as DomainMarkerFace[]) {
        editor.setDecorations(decorationTypes[face], grouped[face]);
      }
    }
  };

  const compute = async (document: vscode.TextDocument): Promise<void> => {
    const capturedVersion = document.version;
    if (!isEnabled() || document.languageId !== 'python') {
      cache.delete(document.uri.fsPath);
      applyToEditors(document.uri);
      return;
    }
    let spans: DomainMarkerSpan[];
    try {
      spans = await computeDomainMarkerSpans(document.getText(), document.uri.fsPath, resolvers);
    } catch {
      spans = [];
    }
    // 版本守卫:计算期间文档又改 → 本轮结果作废(下轮变更事件重算)
    if (document.version !== capturedVersion) {
      return;
    }
    cache.set(document.uri.fsPath, { version: capturedVersion, spans });
    applyToEditors(document.uri);
  };

  const schedule = (document: vscode.TextDocument, delay = 250): void => {
    if (document.languageId !== 'python') {
      return;
    }
    const existing = pending.get(document.uri.fsPath);
    if (existing) {
      clearTimeout(existing);
    }
    pending.set(
      document.uri.fsPath,
      setTimeout(() => {
        pending.delete(document.uri.fsPath);
        void compute(document);
      }, delay)
    );
  };

  disposables.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isEnabled() && event.document.languageId === 'python') {
        schedule(event.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      cache.delete(document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('kbengine.domainMarkers')) {
        return;
      }
      if (!isEnabled()) {
        // 关闸:清缓存 + 清可见编辑器装饰
        cache.clear();
        for (const editor of vscode.window.visibleTextEditors ?? []) {
          for (const face of Object.keys(decorationTypes) as DomainMarkerFace[]) {
            editor.setDecorations(decorationTypes[face], []);
          }
        }
        return;
      }
      for (const editor of vscode.window.visibleTextEditors ?? []) {
        if (editor.document.languageId === 'python') {
          schedule(editor.document, 0);
        }
      }
    }),
    { dispose: () => { for (const t of pending.values()) { clearTimeout(t); } pending.clear(); } },
    { dispose: () => { for (const face of Object.keys(decorationTypes) as DomainMarkerFace[]) { decorationTypes[face].dispose(); } } }
  );
  context.subscriptions.push(...disposables);
  // 活动编辑器切换 → 对刚激活的 python 文档出一次(真宿主恒有该事件;fake-vscode
  // 替身无,按 hotReload 同一 feature-detect 判据让位)
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && isEnabled() && editor.document.languageId === 'python') {
          schedule(editor.document, 0);
        }
      })
    );
  }
  // 激活即对在编辑的 python 文档出一次(开闸时)
  const activeEditor = vscode.window.activeTextEditor;
  if (isEnabled() && activeEditor?.document.languageId === 'python') {
    schedule(activeEditor.document, 0);
  }
  return {
    dispose: () => {
      for (const item of disposables) { item.dispose(); }
    }
  };
}

/** 试点面表规模自检用(KODE-SYN-005 验收:36 条全表可得) */
export const DOMAIN_MARKER_HOOK_ROSTER_SIZE = KBENGINE_HOOKS.length;
