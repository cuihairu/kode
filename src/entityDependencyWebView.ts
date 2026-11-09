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
import { EntityDependencyAnalyzer } from './entityDependency';
import { buildDependencyGraphInRust } from './backend/dependencyGraphRust';
import { buildPythonCallGraphInRust } from './backend/pythonCallGraphRust';
import { randomNonce, webviewAssetUri } from './webviewSecurity';
import {
  renderEntityDependencyWebview,
  type DependencyPanelMode
} from './entityDependencyWebViewHtml';
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
  type CallGraphGraph,
  type CollectedPythonFiles
} from './entityCallGraphView';


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
    // SRC-012:HTML 模板半边已迁 entityDependencyWebViewHtml.ts;
    // 此处只补面板态入参(标题/模式/mermaidUri/cspSource/nonce)并委托,
    // 产出与迁移前逐字节一致(thin wrapper,测试经私有 cast 调用不变)。
    return renderEntityDependencyWebview({
      mode: this.mode,
      title: this.panelTitle(),
      mermaidGraph,
      graph,
      callGraph,
      rustUnavailable,
      mermaidUri: webviewAssetUri(
        this.panel?.webview,
        this.context.extensionUri,
        'media',
        'mermaid.tiny.js'
      ),
      cspSource: this.panel?.webview.cspSource ?? 'vscode-webview:',
      nonce: randomNonce()
    });
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

