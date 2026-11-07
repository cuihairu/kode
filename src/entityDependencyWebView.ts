/**
 * KBEngine 实体依赖关系 WebView
 * 使用 Mermaid.js 可视化实体依赖图
 *
 * IDE-RUST-007:图拓扑推导走 Rust 核心(`$/kode/dependency/graph`,从
 * entities.xml 登记实体出发 → 实体 def → 继承/接口/组件/属性类型 →
 * types.xml 对象类 → python 实现,全部边反向可索引)。Rust 不可用回落
 * TS EntityDependencyAnalyzer(降级 entity→entity 图,徽章「TS 兜底」)。
 * 两源图先归一为 RenderGraph 再渲染:TS 兜底源输出与迁移前逐字节一致,
 * Rust 源按节点 kind 分 emoji/classDef、按边 kind 分箭头,带三关键路径
 * 与节点点击跳转。
 *
 * C-20:同一面板双模式「dependency(实体依赖)| callgraph(Python 方法级
 * 调用图)」。callgraph 模式走 `$/kode/python/callgraph`(Rust ruff AST),
 * 收集 workspace 全部根 *.py 原文直传;归一为 CallGraphGraph 再渲染
 * (8 类边分箭头/样式,未解析被调方补 stub 节点,绝不丢调用点)。Rust
 * 不可用 = 面板徽标「Rust 不可用」+ 空图注记(无 TS 兜底,不虚构)。
 */

import * as vscode from 'vscode';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import { EntityDependencyAnalyzer } from './entityDependency';
import { buildDependencyGraphInRust } from './dependencyGraphRust';
import { buildPythonCallGraphInRust } from './pythonCallGraphRust';
import { randomNonce, webviewAssetUri, webviewScriptCsp } from './webviewSecurity';
import type { DependencyGraphSource } from './warmupStages';
import type { PanelWarmupSource } from './backgroundWarmup';

/**
 * 渲染层节点 kind(六员;TS 兜底源归一后全部是 entity)。
 */
import {
  normalizeDependencyGraph,
  normalizeGraphSource,
  normalizeRustGraph,
  renderLegacyMermaid,
  renderRustMermaid,
  type RenderGraph
} from './entityDependencyGraphView';
import {
  CALLGRAPH_EXCLUDE_GLOB,
  CALLGRAPH_MAX_FILES,
  CALLGRAPH_READ_CONCURRENCY,
  normalizeCallGraph,
  renderCallGraphMermaid,
  callGraphLegendHtml,
  type CallGraphGraph,
  type CollectedPythonFiles
} from './entityCallGraphView';

export {
  normalizeDependencyGraph,
  normalizeGraphSource,
  normalizeRustGraph,
  renderLegacyMermaid,
  renderRustMermaid,
  type RenderGraph
} from './entityDependencyGraphView';
export {
  CALLGRAPH_EXCLUDE_GLOB,
  CALLGRAPH_MAX_FILES,
  CALLGRAPH_READ_CONCURRENCY,
  normalizeCallGraph,
  renderCallGraphMermaid,
  callGraphLegendHtml,
  type CallGraphGraph,
  type CollectedPythonFiles
} from './entityCallGraphView';


/** 面板双模式。 */
export type DependencyPanelMode = 'dependency' | 'callgraph';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 实体依赖关系 WebView 面板
 */
export class EntityDependencyWebView {
  private panel: vscode.WebviewPanel | null = null;
  private analyzer: EntityDependencyAnalyzer;
  private currentRender: RenderGraph | null = null;
  private currentCallGraph: CallGraphGraph | null = null;
  private pendingExport: { format: 'png' | 'svg'; uri: vscode.Uri } | null = null;
  private mode: DependencyPanelMode = 'dependency';
  // KODE-PERF-005:刷新代际守卫——并发刷新/关面板/切模式后旧 RPC 结果不写入。
  // 每代刷新自增 refreshGeneration 并持 CancellationTokenSource;新一代开始
  // 或面板关闭取消旧代(收集循环提前终止),旧代结果在写入面按代际弃置。
  private refreshGeneration = 0;
  private refreshCancellation: vscode.CancellationTokenSource | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel,
    // BG-WARM:后台预热产物源(面板只读缓存)。未注入(既有测试/装配)时
    // 行为与迁移前逐字节一致——现算路径原样保留。
    private readonly warmup?: PanelWarmupSource
  ) {
    this.analyzer = new EntityDependencyAnalyzer(context);
  }

  /**
   * KODE-PERF-005:写入面守卫——代际最新 + 面板在 + 模式未换代,三面齐才可写。
   * 旧代(并发刷新被取代/关面板/切模式)任一不满足即整体弃置,不覆盖新代。
   */
  private canWriteRefresh(generation: number, expectedMode: DependencyPanelMode): boolean {
    return (
      generation === this.refreshGeneration &&
      this.panel !== null &&
      this.mode === expectedMode
    );
  }

  /** 面板标题(双模式)。 */
  private panelTitle(): string {
    return this.mode === 'callgraph' ? 'KBEngine Python 调用图' : 'KBEngine 实体依赖关系';
  }

  /**
   * BG-WARM:预热中进度页(部分结果位)。后台管线完成后 refreshGraph 复用
   * 在跑产物渲染真图;标记类名 kbengine-warmup 供测试与样式锚定。
   */
  private getWarmupProgressHtml(): string {
    const snapshot = this.warmup?.snapshot();
    const detail = snapshot
      ? `${snapshot.completedStages}/${snapshot.totalStages}${snapshot.currentLabel ? ` · ${snapshot.currentLabel}` : ''}`
      : '';
    return `<!DOCTYPE html>
<html>
<body class="kbengine-warmup">
  <h1>KBEngine 索引预热中</h1>
  <p>${detail}</p>
  <p>后台索引完成后,本面板将自动展示依赖图。</p>
</body>
</html>`;
  }

  /**
   * BG-WARM:预热阶段体的依赖图计算(Rust 优先 TS 兜底)——与 refreshGraph
   * 现算同一出口(同一 analyzer 实例、同一 buildDependencyGraphInRust),
   * 只是把计算挪到激活后台;产物经 warmup 产物面发布给面板只读复用。
   */
  async buildWarmupGraphSource(): Promise<DependencyGraphSource> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      try {
        const rust = await buildDependencyGraphInRust(root);
        if (rust) {
          return { kind: 'rust', graph: rust };
        }
      } catch (rustError) {
        // 与现算路径同口径:Rust 面异常按不可用处理,回落 TS 兜底
        this.outputChannel.appendLine(`Rust 依赖图推导失败,回落 TS: ${rustError}`);
      }
    }
    return { kind: 'ts', graph: await this.analyzer.analyze() };
  }

  /**
   * 显示依赖图(mode:'dependency'|'callgraph';已开面板时仅切换模式并刷新)。
   */
  async show(mode: DependencyPanelMode = 'dependency'): Promise<void> {
    const modeChanged = this.mode !== mode;
    this.mode = mode;
    if (this.panel) {
      this.panel.title = this.panelTitle();
      this.panel.reveal();
      if (modeChanged) {
        await this.refreshGraph();
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.entityDependency',
      this.panelTitle(),
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // 处理面板关闭
    this.panel.onDidDispose(() => {
      // KODE-PERF-005:关面板即取消在途收集/RPC 代,旧代结果在写入面被弃。
      this.refreshCancellation?.cancel();
      this.refreshCancellation?.dispose();
      this.refreshCancellation = null;
      this.panel = null;
    });

    // 处理来自 WebView 的消息
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            await this.refreshGraph();
            break;
          case 'openEntity':
            await this.openEntityFile(message.entityName);
            break;
          case 'openNode':
            await this.openNode(message.filePath);
            break;
          case 'export':
            await this.exportGraph(message.format);
            break;
          case 'exportData':
            await this.saveExportedGraph(message.format, message.data);
            break;
          case 'setMode':
            if (
              (message.mode === 'dependency' || message.mode === 'callgraph') &&
              this.panel
            ) {
              this.mode = message.mode;
              this.panel.title = this.panelTitle();
              await this.refreshGraph();
            }
            break;
        }
      },
      null,
      this.context.subscriptions
    );

    // 初始加载图数据
    await this.refreshGraph();
  }

  /**
   * 刷新依赖图:按模式分流。
   * - dependency:Rust 核心优先(实体→def→接口/组件/types.xml/python 全图),
   *   不可用(无 gate/调用失败/形状不符)回落 TS 分析器(降级实体图)。
   * - callgraph:收集 workspace 全部根 *.py 原文直传 Rust `$/kode/python/callgraph`;
   *   Rust 不可用 → 面板徽标「Rust 不可用」+ 空图注记(无 TS 兜底,不虚构)。
   */
  private async refreshGraph(): Promise<void> {
    if (!this.panel) {
      return;
    }
    // KODE-PERF-005:新一代刷新开始——取消旧代收集 + 代际自增,旧代结果在
    // 写入面被弃(同模式并发刷新的旧代不再覆盖新代;关面板/切模式同守卫)。
    const previous = this.refreshCancellation;
    const cancellation = new vscode.CancellationTokenSource();
    this.refreshCancellation = cancellation;
    previous?.cancel();
    previous?.dispose();
    const generation = ++this.refreshGeneration;

    try {
      if (this.mode === 'callgraph') {
        await this.refreshCallGraph(generation, cancellation.token);
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let render: RenderGraph | null = null;
      // BG-WARM 只读缓存:预热产物 done → 直接归一渲染,零 findFiles/零 analyze;
      // running → 先出进度页,复用在跑任务(同一 Promise,阶段只算一次),完成后
      // 渲染;missing/failed/cancelled → 回落既有现算路径(不拿失败当结果)。
      // 失效口径:缓存只服务「面板还空着」这一次打开——已出图后再刷新(源文件
      // 改动、手动刷新、切模式回切)一律现算,否则激活期快照会永久盖住用户之后
      // 的修改。
      const cached =
        this.currentRender === null
          ? this.warmup?.peekArtifact<DependencyGraphSource>('dependencyGraph')
          : undefined;
      let reuseInFlight: Promise<DependencyGraphSource | undefined> | null = null;
      if (cached && cached.state === 'done' && cached.value) {
        render = normalizeGraphSource(cached.value);
      } else if (cached && cached.state === 'running' && this.warmup) {
        this.panel.webview.html = this.getWarmupProgressHtml();
        reuseInFlight = this.warmup.artifact<DependencyGraphSource>('dependencyGraph');
      }
      if (!render && reuseInFlight && !cancellation.token.isCancellationRequested) {
        const reused = await reuseInFlight;
        if (this.canWriteRefresh(generation, 'dependency') && reused) {
          render = normalizeGraphSource(reused);
        }
      }
      if (root && !render && !cancellation.token.isCancellationRequested) {
        try {
          const rust = await buildDependencyGraphInRust(root);
          if (rust) {
            render = normalizeRustGraph(rust);
          }
        } catch (rustError) {
          // Rust 面异常按不可用处理(与返回 null 同),回落 TS 兜底
          this.outputChannel.appendLine(`Rust 依赖图推导失败,回落 TS: ${rustError}`);
        }
      }
      if (!render && !cancellation.token.isCancellationRequested) {
        render = normalizeDependencyGraph(await this.analyzer.analyze());
      }

      // RPC 在途面复检(KODE 审核发现)+ KODE-PERF-005 代际守卫:面板在途
      // 关闭(panel=null)或代际已换代(并发刷新/切模式)时旧结果不得渲染进
      // 当前视图——本轮旧代渲染整体丢弃(新一代刷新自会写入最新数据)。
      if (!this.canWriteRefresh(generation, 'dependency')) {
        return;
      }
      // KODE-PERF-005:取消代不满足 canWriteRefresh(已 return);此处 render 为
      // null 仅剩「本代未取消但推导得空」的异常态,按空图处理不写 null。
      if (!render) {
        return;
      }

      this.currentRender = render;

      // 生成 Mermaid 图
      const mermaidGraph = this.generateMermaidGraph(render);

      // 获取 Webview 内容
      this.panel.webview.html = this.getWebviewContent(mermaidGraph, render, null, false);
    } catch (error) {
      // KODE-PERF-005:旧代被取代/取消时错误不再冒泡成「刷新依赖图失败」。
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.outputChannel.appendLine(`刷新依赖图失败: ${error}`);
      vscode.window.showErrorMessage(`刷新依赖图失败: ${error}`);
    }
  }

  /**
   * KODE-PERF-004:收集 workspace 全部根 *.py。
   * - 多根:遍历全部 workspaceFolders(旧码只取根[0])并按 fsPath 去重;
   * - 超 10,000 文件明确策略:发现全量→按路径排序→取前上限→truncated
   *   标记(面板出「已截断」警告条并如实显示发现总数,绝不静默装完整);
   * - 宿主不阻塞:有界并发异步读(旧码同步 readWorkspaceTextFile 逐文件阻塞)。
   */
  private async collectPythonFiles(
    token?: vscode.CancellationToken
  ): Promise<CollectedPythonFiles> {
    const merged = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // KODE-PERF-005:取消代不再发起新根收集(旧代结果在写入面被弃)。
      if (token?.isCancellationRequested) {
        break;
      }
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder.uri, '**/*.py'),
        CALLGRAPH_EXCLUDE_GLOB,
        undefined,
        token
      );
      for (const uri of uris) {
        merged.set(uri.fsPath, uri);
      }
    }
    // 确定序:截断保留稳定前缀,不因 findFiles 序抖动而漂移。
    const all = [...merged.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    const totalDiscovered = all.length;
    const selected =
      totalDiscovered > CALLGRAPH_MAX_FILES ? all.slice(0, CALLGRAPH_MAX_FILES) : all;
    return {
      files: await this.readPythonFilesAsync(selected, token),
      truncated: totalDiscovered > CALLGRAPH_MAX_FILES,
      totalDiscovered
    };
  }

  /** 有界并发异步读(默认 8 路);单文件读失败回落空串(与旧同步口径一致)。 */
  private async readPythonFilesAsync(
    uris: vscode.Uri[],
    token?: vscode.CancellationToken
  ): Promise<Array<{ path: string; text: string }>> {
    const files: Array<{ path: string; text: string }> = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(CALLGRAPH_READ_CONCURRENCY, uris.length) },
      async () => {
        while (nextIndex < uris.length) {
          // KODE-PERF-005:取消代不再拉取新文件(在读面尽早停,不空耗 IO)。
          if (token?.isCancellationRequested) {
            break;
          }
          const index = nextIndex;
          nextIndex += 1;
          const uri = uris[index];
          let text = '';
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = Buffer.from(bytes).toString('utf8');
          } catch {
            // 读失败(文件消失/IO):回落空串,与旧 readWorkspaceTextFile 一致,
            // 保持「选中文件数 = Rust 输入数」口径,不静默丢文件。
          }
          files.push({ path: uri.fsPath, text });
        }
      }
    );
    await Promise.all(workers);
    return files;
  }

  /** callgraph 模式刷新:收集全部根 *.py → Rust RPC → 归一 → 渲染。 */
  private async refreshCallGraph(
    generation: number,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    let callGraph: CallGraphGraph | null = null;
    let rustUnavailable = false;
    try {
      // KODE-PERF-004:多根收集(旧码 root[0] 单根);process_topology.xml
      // 是项目级清单,仍取主根(根[0]),无根时空清单。
      const collected = await this.collectPythonFiles(token);
      // KODE-PERF-005:收集在途被取消(关面板/切模式/并发刷新)→ 不再发 RPC、
      // 不读清单,旧代整体丢弃。
      if (token.isCancellationRequested) {
        return;
      }
      const primaryRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const manifestText = primaryRoot
        ? await this.readProcessTopologyText(primaryRoot)
        : null;
      const rust = await buildPythonCallGraphInRust({
        files: collected.files,
        ...(manifestText !== null ? { manifestXmlText: manifestText } : {})
      });
      if (rust) {
        const normalized = normalizeCallGraph(rust);
        // KODE-PERF-004:截断信息并入渲染图(面板出警告条,不静默装完整)。
        callGraph = collected.truncated
          ? {
            ...normalized,
            stats: {
              ...normalized.stats,
              truncated: true,
              totalDiscovered: collected.totalDiscovered
            }
          }
          : normalized;
      } else {
        rustUnavailable = true;
      }
    } catch (rustError) {
      // KODE-PERF-005:旧代(被取代/取消)的错误不冒泡成「Rust 调用图失败」。
      if (token.isCancellationRequested || generation !== this.refreshGeneration) {
        return;
      }
      rustUnavailable = true;
      this.outputChannel.appendLine(`Rust 调用图失败: ${rustError}`);
    }

    // KODE-PERF-005 代际守卫(取代在途面复检):collect/RPC 在途时面板关闭
    // (panel=null)的写入会 TypeError 冒泡;在途 setMode 切回 dependency 或
    // 并发同模式刷新时,旧代调用图不得渲染——本轮旧代结果整体丢弃。
    if (!this.canWriteRefresh(generation, 'callgraph')) {
      return;
    }

    this.currentCallGraph = callGraph;
    const mermaidGraph = callGraph ? renderCallGraphMermaid(callGraph) : '';
    this.panel.webview.html = this.getWebviewContent(
      mermaidGraph,
      null,
      callGraph,
      rustUnavailable
    );
  }

  /** `<root>/process_topology.xml` 原文(缺省 null → RPC 侧空清单)。 */
  private async readProcessTopologyText(root: string): Promise<string | null> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), 'process_topology.xml');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * 生成 Mermaid 图(按图来源分流:Rust 核心/TS 兜底)
   */
  private generateMermaidGraph(graph: RenderGraph): string {
    return graph.source === 'rust' ? renderRustMermaid(graph) : renderLegacyMermaid(graph);
  }

  /** UI-05:统计卡按业务域分组,组头 <details> 可折叠并带条目计数 */
  private statGroup(domain: string, label: string, cards: string[]): string {
    return `      <details class="stat-group" data-domain="${domain}" open>
        <summary><span>${label}</span><span class="gcount" data-count="${cards.length}">${cards.length}</span></summary>
        <div class="stat-cards">
${cards.join('\n')}
        </div>
      </details>`;
  }

  private statCard(label: string, value: string | number): string {
    // KR-AUD-53:value 面会落到进程角色串/最常引用实体名等来自扫描结果的
    // 字符串面,与 label 一并转义(标签注入)
    return `      <div class="stat-card">
        <div class="stat-label">${escapeHtml(String(label))}</div>
        <div class="stat-value">${escapeHtml(String(value))}</div>
      </div>`;
  }

  /**
   * 获取 Webview 内容(双模式:dependency 渲染 RenderGraph;callgraph 渲染
   * CallGraphGraph,Rust 不可用时出空图注记)
   */
  private getWebviewContent(
    mermaidGraph: string,
    graph: RenderGraph | null,
    callGraph: CallGraphGraph | null,
    rustUnavailable: boolean
  ): string {
    const t = strings(resolvePanelLocale()).entityDependency;
    const title = this.panelTitle();
    // KR-AUD-50/53:整页 nonce CSP + mermaid 离线打包(media/mermaid.tiny.js,
    // 经 asWebviewUri 取与 cspSource 同源的 URI),脚本不再依赖 CDN;
    // 图片源只给导出用的 data:/blob: 开洞。
    const nonce = randomNonce();
    const cspSource = this.panel?.webview.cspSource ?? 'vscode-webview:';
    const mermaidUri = webviewAssetUri(
      this.panel?.webview,
      this.context.extensionUri,
      'media',
      'mermaid.tiny.js'
    );
    const isCallGraph = this.mode === 'callgraph';
    const sourceBadge = isCallGraph
      ? rustUnavailable
        ? 'Rust 不可用'
        : 'Rust 核心'
      : graph && graph.source === 'rust'
        ? 'Rust 核心'
        : 'TS 兜底';

    const statsHtml = isCallGraph
      ? [
        // KODE-PERF-004:截断时如实显示「已收集 / 实际发现(截断)」,不装完整。
        this.statCard('文件', callGraph?.stats.truncated
          ? `${callGraph.stats.fileCount} / ${callGraph.stats.totalDiscovered ?? callGraph.stats.fileCount}（截断）`
          : (callGraph?.stats.fileCount ?? 0)),
        this.statCard('节点', callGraph?.stats.nodeCount ?? 0),
        this.statCard('调用边', callGraph?.stats.edgeCount ?? 0),
        this.statCard('语法错误', callGraph?.stats.errorCount ?? 0),
        this.statCard(
          '进程角色',
          callGraph && callGraph.processRoles.length > 0
            ? callGraph.processRoles.join(', ')
            : '-'
        )
      ].join('\n')
      : graph && graph.source === 'rust'
        ? [
          this.statGroup('graph', t.groupGraph, [
            this.statCard(t.nodes, graph.stats.nodeCount),
            this.statCard(t.edges, graph.stats.edgeCount)
          ]),
          this.statGroup('defs', t.groupDefs, [
            this.statCard(t.entities, graph.stats.entityCount),
            this.statCard(t.defs, graph.stats.defCount),
            this.statCard(t.interfaces, graph.stats.interfaceCount),
            this.statCard(t.components, graph.stats.componentCount),
            this.statCard(t.types, graph.stats.typeCount),
            this.statCard(t.python, graph.stats.pythonCount)
          ])
        ].join('\n')
        : [
          this.statGroup('inheritance', t.groupInheritance, [
            this.statCard(t.totalEntities, graph?.legacyStats?.totalEntities ?? 0),
            this.statCard(t.baseEntities, graph?.legacyStats?.baseEntities ?? 0),
            this.statCard(t.cellEntities, graph?.legacyStats?.cellEntities ?? 0),
            this.statCard(t.clientEntities, graph?.legacyStats?.clientEntities ?? 0),
            this.statCard(t.maxDepth, graph?.legacyStats?.maxDepth ?? 0)
          ]),
          this.statGroup('hotspot', t.groupHotspot, [
            this.statCard(t.mostReferenced, graph?.legacyStats?.mostReferenced || '-')
          ])
        ].join('\n');

    const pathsHtml =
      !isCallGraph && graph && graph.paths
        ? `
  <div class="paths">
    <div class="path-item"><span class="path-label">entities.xml</span><code>${escapeHtml(graph.paths.entitiesXml)}</code></div>
    <div class="path-item"><span class="path-label">defsRoot</span><code>${escapeHtml(graph.paths.defsRoot)}</code></div>
    <div class="path-item"><span class="path-label">types.xml</span><code>${escapeHtml(graph.paths.typesXml)}</code></div>
  </div>`
        : '';

    // KODE-PERF-004:超 10,000 文件截断的明确策略——出可见警告条,绝不静默
    // 装完整(发现数/已收集数/上限都如实显示)。
    const callgraphWarningHtml =
      isCallGraph && callGraph?.stats.truncated
        ? `
  <div class="callgraph-warning">⚠ 超出 ${CALLGRAPH_MAX_FILES} 个 Python 文件上限,仅收集前 ${callGraph.stats.fileCount} 个(实际发现 ${callGraph.stats.totalDiscovered ?? callGraph.stats.fileCount} 个),调用图可能不完整。</div>`
        : '';

    const graphHtml = isCallGraph
      ? rustUnavailable
        ? `    <div class="loading">Rust 核心不可用(未配置 serverPath 或调用失败),调用图无法生成。</div>`
        : `
    <div class="mermaid">
${mermaidGraph}
    </div>`
      : `
    <div class="mermaid">
${mermaidGraph}
    </div>`;

    const legendHtml = isCallGraph
      ? callGraphLegendHtml()
      : `
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #173a5e; border: 2px solid #3794ff;"></div>
      <span>Base 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #1d3a2a; border: 2px solid #89d185;"></div>
      <span>Cell 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #3a2d10; border: 2px solid #cca700;"></div>
      <span>Client 实体</span>
    </div>
    <div class="legend-item">
      <span>→ 继承关系</span>
    </div>`;

    return `<!DOCTYPE html>
<html lang="${htmlLang(resolvePanelLocale())}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP(KR-AUD-50/53):default-src 'none' 断掉一切外联/外帧/连接,
       脚本只认本次渲染 nonce + 扩展自带 media/mermaid.tiny.js(离线打包,
       与 cspSource 同源);mermaid securityLevel=strict 下其自带 click 回调被
       丢弃,打开文件改由面板脚本按 click 指令自绑(见下方事件委托)。 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce, [cspSource], ['data:', 'blob:', cspSource])}">
  <title>${title}</title>
  <style>
    ${WEBVIEW_THEME_CSS}
    body {
      margin: 0;
      padding: 20px;
    }

    /* UI-05:统计卡按业务域分组(与 monitoring 同一分类管理范式) */
    .stat-group {
      border: 1px solid var(--kode-border);
      border-radius: var(--kode-r);
      background: var(--kode-surface);
      margin-bottom: 8px;
    }
    .stat-group > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      cursor: pointer;
      list-style: none;
      color: var(--kode-fg-3);
      font-size: var(--kode-t-meta);
      font-weight: 600;
    }
    .stat-group > summary::-webkit-details-marker { display: none; }
    .stat-group > summary::before { content: '▸'; color: var(--kode-fg-4); font-size: 10px; }
    .stat-group[open] > summary::before { content: '▾'; }
    .stat-group .gcount {
      background: var(--kode-surface-2);
      border: 1px solid var(--kode-border);
      border-radius: 8px;
      color: var(--kode-fg-3);
      font-family: var(--kode-mono);
      font-size: var(--kode-t-tag);
      font-weight: 400;
      padding: 0 7px;
    }
    .stat-group .stat-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      padding: 0 14px 12px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .title {
      font-size: 24px;
      font-weight: bold;
    }

    .source-badge {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 10px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .toolbar {
      display: flex;
      gap: 10px;
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 2px;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-card {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
    }

    .stat-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 5px;
    }

    .stat-value {
      font-size: 24px;
      font-weight: bold;
    }

    .paths {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
      margin-bottom: 20px;
      font-size: 12px;
    }

    .path-item {
      display: flex;
      gap: 10px;
      margin-bottom: 6px;
    }

    .path-item:last-child {
      margin-bottom: 0;
    }

    .path-label {
      color: var(--vscode-descriptionForeground);
      min-width: 90px;
    }

    .path-item code {
      word-break: break-all;
    }

    #graph-container {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 20px;
      min-height: 400px;
    }

    .legend {
      display: flex;
      gap: 20px;
      margin-top: 20px;
      font-size: 12px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .loading {
      text-align: center;
      padding: 50px;
      color: var(--vscode-descriptionForeground);
    }

    .callgraph-warning {
      background-color: var(--vscode-inputValidation-warningBackground, #5a3d00);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #bd8b00);
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
      border-radius: 4px;
      padding: 10px 15px;
      margin-bottom: 20px;
      font-size: 13px;
    }
  </style>
  <script src="${mermaidUri}"></script>
</head>
<body>
  <div class="header">
    <div class="title">${title}</div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <span class="source-badge">${sourceBadge}</span>
      <div class="toolbar">
        <select id="mode-select" style="padding: 8px; background-color: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);">
          <option value="dependency" ${isCallGraph ? '' : 'selected'}>实体依赖</option>
          <option value="callgraph" ${isCallGraph ? 'selected' : ''}>调用图</option>
        </select>
        <button id="refresh-graph-btn">刷新</button>
        <button id="export-png-btn">导出 PNG</button>
        <button id="export-svg-btn">导出 SVG</button>
      </div>
    </div>
  </div>

  <div class="stats">
${statsHtml}
  </div>
${pathsHtml}
${callgraphWarningHtml}

  <div id="graph-container">
${graphHtml}
  </div>

  <div class="legend">
${legendHtml}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // 初始化 Mermaid(KR-AUD-53:securityLevel=strict——标签经 DOMPurify 清洗,
    // 自带 click 回调在此级别被 mermaid 丢弃,故下方改为面板自绑)
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'strict',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });

    // click 指令回调名保留(strict 下 mermaid 不再调用,图文本口径不变);
    // 真正的点击打开走下方事件委托,映射同样来自这些 click 指令。
    window.openFilePath = function(filePath) {
      vscode.postMessage({
        command: 'openNode',
        filePath: filePath
      });
    };

    // 节点 → 文件路径映射:渲染前从 .mermaid 源文本读 click 指令
    // (mermaid 渲染会替换该元素内容,必须在 DOMContentLoaded 前抓取)
    const openPaths = new Map();
    const openLabels = new Map();
    const mermaidSource = document.querySelector('#graph-container .mermaid');
    if (mermaidSource) {
      const text = mermaidSource.textContent || '';
      const nodeLabelRe = /^\\s*([A-Za-z0-9_]+)\\["((?:[^"\\\\]|\\\\.)*)"\\]/gm;
      const clickRe = /^\\s*click\\s+([A-Za-z0-9_]+)\\s+openFilePath\\s+"((?:[^"\\\\]|\\\\.)*)"/gm;
      const labels = new Map();
      let nodeMatch;
      while ((nodeMatch = nodeLabelRe.exec(text)) !== null) {
        labels.set(nodeMatch[1], nodeMatch[2]);
      }
      let clickMatch;
      while ((clickMatch = clickRe.exec(text)) !== null) {
        const filePath = clickMatch[2].replace(/\\\\"/g, '"');
        openPaths.set(clickMatch[1], filePath);
        const label = labels.get(clickMatch[1]);
        if (label !== undefined && !openLabels.has(label)) {
          openLabels.set(label, filePath);
        }
      }
    }

    // 事件委托:mermaid 渲染出的 g.node id 形如 <前缀><节点 id>-<序号>
    // (可带 diagramId 前缀),解析不出时回落节点标签文本
    function resolveOpenPath(node) {
      const domId = node.id || '';
      const idMatch = /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]+)-\\d+$/.exec(domId);
      if (idMatch && openPaths.has(idMatch[1])) {
        return openPaths.get(idMatch[1]);
      }
      if (openPaths.has(domId)) {
        return openPaths.get(domId);
      }
      const labelEl = node.querySelector('.label');
      const label = labelEl ? (labelEl.textContent || '').trim() : '';
      return openLabels.get(label) || null;
    }

    const graphContainer = document.getElementById('graph-container');
    if (graphContainer) {
      graphContainer.addEventListener('click', event => {
        const target = event.target;
        const node = target && typeof target.closest === 'function'
          ? target.closest('g.node')
          : null;
        if (!node) {
          return;
        }
        const filePath = resolveOpenPath(node);
        if (filePath) {
          vscode.postMessage({ command: 'openNode', filePath: filePath });
        }
      });
    }

    // 工具栏:nonce CSP 下内联事件处理器不执行,一律脚本绑定
    document.getElementById('mode-select')?.addEventListener('change', event => {
      setMode(event.target.value);
    });
    document.getElementById('refresh-graph-btn')?.addEventListener('click', refreshGraph);
    document.getElementById('export-png-btn')?.addEventListener('click', () => exportGraph('png'));
    document.getElementById('export-svg-btn')?.addEventListener('click', () => exportGraph('svg'));

    // 模式切换 → 扩展侧重绘
    function setMode(mode) {
      vscode.postMessage({
        command: 'setMode',
        mode: mode
      });
    }

    // 刷新图表
    function refreshGraph() {
      vscode.postMessage({
        command: 'refresh'
      });
    }

    // 导出图表
    function exportGraph(format) {
      vscode.postMessage({
        command: 'export',
        format: format
      });
    }

    async function buildExportData(format) {
      const svg = document.querySelector('#graph-container svg');
      if (!svg) {
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: null
        });
        return;
      }

      if (format === 'svg') {
        const serialized = new XMLSerializer().serializeToString(svg);
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: serialized
        });
        return;
      }

      const svgRect = svg.getBoundingClientRect();
      const width = Math.ceil(svgRect.width || Number(svg.getAttribute('width')) || 1200);
      const height = Math.ceil(svgRect.height || Number(svg.getAttribute('height')) || 800);
      const serialized = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const blobUrl = URL.createObjectURL(svgBlob);
      const image = new Image();

      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          vscode.postMessage({
            command: 'exportData',
            format: format,
            data: null
          });
          URL.revokeObjectURL(blobUrl);
          return;
        }

        context.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\\/png;base64,/, '');
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: base64
        });
        URL.revokeObjectURL(blobUrl);
      };

      image.onerror = () => {
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: null
        });
        URL.revokeObjectURL(blobUrl);
      };

      image.src = blobUrl;
    }

    // 处理 VSCode 消息
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'beginExport') {
        buildExportData(message.format);
      }
    });
  </script>
</body>
</html>`;
  }

  /**
   * 打开图中节点对应的文件
   */
  private async openNode(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`打开文件失败: ${error}`);
    }
  }

  /**
   * 打开实体文件
   */
  private async openEntityFile(entityName: string): Promise<void> {
    const node = this.analyzer.getEntityNode(entityName);
    if (!node) {
      vscode.window.showWarningMessage(`未找到实体节点: ${entityName}`);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.defFile));
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`打开实体定义失败: ${error}`);
    }
  }

  /**
   * 导出图表
   */
  private async exportGraph(format: 'png' | 'svg'): Promise<void> {
    const hasGraph = this.mode === 'callgraph' ? !!this.currentCallGraph : !!this.currentRender;
    if (!hasGraph || !this.panel) {
      vscode.window.showWarningMessage('没有可导出的图表');
      return;
    }

    const filename =
      this.mode === 'callgraph' ? `python-call-graph.${format}` : `entity-dependency.${format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(filename),
      filters: {
        'PNG Image': ['png'],
        'SVG Image': ['svg']
      }
    });

    if (!uri) {
      return;
    }

    this.pendingExport = { format, uri };
    await this.panel.webview.postMessage({
      command: 'beginExport',
      format
    });
  }

  private async saveExportedGraph(format: 'png' | 'svg', data: string | null): Promise<void> {
    if (!this.pendingExport) {
      return;
    }

    const pendingExport = this.pendingExport;
    this.pendingExport = null;

    if (!data || pendingExport.format !== format) {
      vscode.window.showErrorMessage(`导出 ${format.toUpperCase()} 失败`);
      return;
    }

    const content = format === 'svg'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data, 'base64');

    try {
      await vscode.workspace.fs.writeFile(pendingExport.uri, content);
      vscode.window.showInformationMessage(`依赖图已导出到 ${pendingExport.uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`写入导出文件失败: ${error}`);
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}

