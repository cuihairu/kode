/**
 * 后台预热阶段管线(BG-WARM 批)。
 *
 * 阶段构成(全部复用既有链,不另起第二套口径):
 * 1. discovery      —— 发现链首扫(entityMappingManager.waitForInitialScan,
 *                      activate 已 ensureStartup,这里只等同一轮,不重起);
 * 2. eventIndex     —— WorkspaceIndex 全量 .py 事件/方法首扫(ensureStarted
 *                      幂等,复用在跑任务);
 * 3. dependencyGraph —— 依赖图 Rust 优先 + TS 兜底(与面板现算同源,产物
 *                      'dependencyGraph' 供面板只读缓存);
 * 4. definitionLayout —— 定义工作区布局预热(KR-AUD-36 热路径:面板/悬停
 *                      首查不再付冷布局解析,只挪时机不改语义);
 * 5. flowGraphs     —— 逐实体架构流程图(mapWithConcurrency 有界并发,
 *                      KR-AUD-35 口径;产物 'flowGraph:<entity>')。
 *
 * deps 全注入:单元测试以替身驱动;extension.ts 装配真实实现。
 */

import { mapWithConcurrency, WARMUP_SCAN_CONCURRENCY } from './backgroundWarmup';
import type { WarmupStageDef } from './backgroundWarmup';

/** 阶段内逐条目的宏任务让出(与控制器阶段间让出同一节拍:setImmediate 边界) */
const yieldToHost = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** 依赖图产物:Rust 源或 TS 兜底源(面板按 kind 归一,渲染口径不变) */
export interface DependencyGraphSource {
  readonly kind: 'rust' | 'ts';
  readonly graph: unknown;
}

export interface WarmupStageDeps {
  /** 发现链首扫完成句柄(复用 activate 已起的一轮) */
  waitForDiscovery(): Promise<void>;
  /** 事件索引全量首扫(ensureStarted 幂等) */
  ensureEventIndex(): Promise<void>;
  /** 依赖图计算(Rust 优先 TS 兜底,与面板现算同源) */
  buildDependencyGraph(): Promise<DependencyGraphSource>;
  /** 已注册实体清单(流程图阶段输入) */
  listFlowEntities(): readonly string[];
  /** 单实体架构流程图(与 EntityFlowWebView.buildGraph 同源;未注册返回 null) */
  buildFlowGraph(entityName: string): unknown;
  /** 定义工作区布局预热(KR-AUD-36 热路径首查) */
  preheatDefinitionLayout(): void;
  /** 阶段内逐条目进度(状态栏 message 明细) */
  report?(detail: string): void;
}

export function createWarmupStages(deps: WarmupStageDeps): WarmupStageDef[] {
  return [
    {
      key: 'discovery',
      label: '实体发现链',
      run: async () => {
        await deps.waitForDiscovery();
      }
    },
    {
      key: 'eventIndex',
      label: '事件/方法索引',
      run: async () => {
        await deps.ensureEventIndex();
      }
    },
    {
      key: 'dependencyGraph',
      label: '实体依赖图',
      run: async ctx => {
        const source = await deps.buildDependencyGraph();
        ctx.publish('dependencyGraph', source);
      },
      expectedArtifacts: ['dependencyGraph']
    },
    {
      key: 'definitionLayout',
      label: '定义布局预热',
      run: async () => {
        deps.preheatDefinitionLayout();
      }
    },
    {
      key: 'flowGraphs',
      label: '实体架构流程图',
      run: async ctx => {
        const entities = deps.listFlowEntities();
        // 动态清单先登记:实体键在逐个计算前全部落 running——本阶段中途打开的
        // 面板读到 running(进度页 + 复用在跑 Promise),不是 missing(另起现算)。
        for (const entityName of entities) {
          ctx.declare(`flowGraph:${entityName}`);
        }
        let built = 0;
        await mapWithConcurrency(
          entities,
          ctx.concurrency,
          async entityName => {
            // 宏任务让出:建图是同步 CPU 活,逐条让宿主事件循环走一拍,长清单
            // 不按住交互;让出后取消旗标可见,取消即不再建新图。
            await yieldToHost();
            if (ctx.token.isCancellationRequested) {
              return;
            }
            const graph = await deps.buildFlowGraph(entityName);
            // 未注册实体(null)也如实结算 done:null——键不悬挂,面板按「无值」
            // 回落自己的现算/提示路径,不会永远等一条不会来的产物。
            ctx.publish(`flowGraph:${entityName}`, graph ?? null);
            built += 1;
            deps.report?.(`流程图 ${built}/${entities.length}`);
          },
          { stop: () => ctx.token.isCancellationRequested }
        );
      }
    }
  ];
}

/** 流程图逐实体并发缺省(生产装配若不显式配 concurrency 则用 WARMUP_SCAN_CONCURRENCY) */
export const WARMUP_FLOW_CONCURRENCY = WARMUP_SCAN_CONCURRENCY;
