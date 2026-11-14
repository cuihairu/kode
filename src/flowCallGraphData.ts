/**
 * KFLOW 调用图数据装配(FLOW-015,G2 泳道面板的数据适配核)。
 *
 * 验收:Client/Base/Cell 和已涉及其他进程按角色分泳道;静态角色不冒充
 * 运行中实例,运行实例带组件 ID。
 *
 * 口径:
 *   - 装配两段:先解析收集真正需要的跨进程三元组(实体×段×方法,只解析
 *     实际发送的方法,不为全 def 方法表预解析);宿主解析 def 声明与实现
 *     (entityMappingManager,异步)后按同步注册表喂 FLOW-012/007 装配核;
 *   - 泳道分组是 flowReviewSample 的角色首现序(client/base/cell/桥接等
 *     已涉及角色各一条泳道);泳道标注「静态角色」——静态分析没有运行中
 *     实例,不冒充(运行实例属 G3/TRACE 泳道,届时带组件 ID);
 *   - def 未声明/实现缺失按 FLOW-007 口径:发送边保留、不连线,如实;
 *   - 本核零 vscode 依赖:宿主面(文件收集/读取/实体归属/def/实现解析)
 *     全部注入,测试用替身。
 */

import { resolveFlowCallSites } from './backend/flowCallResolver';
import type { FlowCallResolverResult } from './backend/flowCallResolver';
import { buildFlowReviewSample, type FlowReviewSample } from './backend/flowReviewSample';

export type FlowRpcSection = 'BaseMethods' | 'CellMethods' | 'ClientMethods';

const ROLE_TO_SECTION: Partial<Record<string, FlowRpcSection>> = {
  base: 'BaseMethods',
  cell: 'CellMethods',
  client: 'ClientMethods'
};

export interface FlowCallGraphSource {
  rootKey: string;
  /** 有界脚本文件清单(宿主按多根收集;截断策略由宿主声明) */
  listScriptFiles(): Promise<string[]>;
  readFile(filePath: string): Promise<string | null>;
  /** 文件静态归属实体;null=无实体(不属于任何实体脚本) */
  entityForFile(filePath: string): Promise<string | null>;
  resolveDefMethod(
    entity: string,
    section: FlowRpcSection,
    methodName: string
  ): Promise<{ defFile: string; line: number } | null>;
  resolveImplementation(
    entity: string,
    section: FlowRpcSection,
    methodName: string
  ): Promise<{
    filePath: string;
    line: number;
    signature: string;
    className: string;
    inheritedFrom?: string | null;
  } | null>;
}

export interface NeededRpcTriple {
  entity: string;
  section: FlowRpcSection;
  methodName: string;
  callerFile: string;
}

const tripleKey = (entity: string, section: string, methodName: string): string =>
  `${entity}\u001f${section}\u001f${methodName}`;

/**
 * pass-1:逐文件解析,收集实际发生的跨进程发送三元组(去重)。
 * 发起实体取发送边 fromNodeId 节点文件归属(DFS 前真实发起文件);
 * 段取 rpc 声明节点角色(base/cell/client→三段;其他角色无段不收)。
 */
export async function collectNeededRpcTriples(
  texts: ReadonlyMap<string, string>,
  rootKey: string,
  entityForFile: (filePath: string) => Promise<string | null>
): Promise<NeededRpcTriple[]> {
  const needed = new Map<string, NeededRpcTriple>();
  for (const [filePath, text] of texts) {
    let result: FlowCallResolverResult;
    try {
      result = resolveFlowCallSites({ text, filePath, rootKey });
    } catch {
      continue; // 单文件解析失败不拖垮装配(该文件边缺失如实)
    }
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));
    for (const edge of result.edges) {
      if (edge.messageKind !== 'rpc') {
        continue;
      }
      const target = nodesById.get(edge.toNodeId);
      if (!target || target.kind !== 'rpc-declaration' || !target.fn) {
        continue;
      }
      const section = ROLE_TO_SECTION[target.role];
      if (!section) {
        continue;
      }
      const caller = nodesById.get(edge.fromNodeId);
      const callerFile = caller?.fn?.filePath ?? filePath;
      const entity = await entityForFile(callerFile);
      if (!entity) {
        continue;
      }
      const key = tripleKey(entity, section, target.fn.name);
      if (!needed.has(key)) {
        needed.set(key, { entity, section, methodName: target.fn.name, callerFile });
      }
    }
  }
  return [...needed.values()];
}

export interface AssembleOptions {
  maxDepth?: number;
}

/**
 * 装配:pass-1 三元组 → 宿主解析 def/实现 → pass-2 buildFlowReviewSample。
 * 解析失败的文件跳过(该文件面缺失如实);def/实现 null=未连接发送(FLOW-007)。
 */
export async function assembleFlowCallGraph(
  source: FlowCallGraphSource,
  entry: { filePath: string; functionName: string },
  options: AssembleOptions = {}
): Promise<FlowReviewSample> {
  const files = await source.listScriptFiles();
  const texts = new Map<string, string>();
  for (const filePath of files) {
    const text = await source.readFile(filePath);
    if (text !== null) {
      texts.set(filePath, text);
    }
  }
  const needed = await collectNeededRpcTriples(texts, source.rootKey, filePath =>
    source.entityForFile(filePath)
  );
  const defRegistry = new Map<string, { defFile: string; line: number }>();
  const implRegistry = new Map<
    string,
    {
      filePath: string;
      line: number;
      signature: string;
      className: string;
      inheritedFrom?: string | null;
    }
  >();
  for (const triple of needed) {
    const key = tripleKey(triple.entity, triple.section, triple.methodName);
    const def = await source.resolveDefMethod(triple.entity, triple.section, triple.methodName);
    if (def) {
      defRegistry.set(key, def);
    }
    const impl = await source.resolveImplementation(
      triple.entity,
      triple.section,
      triple.methodName
    );
    if (impl) {
      implRegistry.set(key, impl);
    }
  }
  return buildFlowReviewSample({
    rootKey: source.rootKey,
    entry,
    files: texts,
    resolveDefMethod: (entity, section, methodName) =>
      defRegistry.get(tripleKey(entity, section, methodName)) ?? null,
    resolveImplementation: (entity, section, methodName) =>
      implRegistry.get(tripleKey(entity, section, methodName)) ?? null,
    maxDepth: options.maxDepth
  });
}
