// RUST-414(旧 HR-QA-002)真 UI 线程墙钟(webview 实渲染)装配面基准:
// S8 纯核面(9698b66d)量的是 renderHistoryPanelHtml 字符串生成(Node,无
// DOM/layout/paint);本套件补其缺失段=真 Chromium webview 里渲染同一面板
// HTML 的墙钟(导航起点→parse+强制 reflow 布局 或 导航起点→parse+layout+
// paint 的 double-rAF,两者同源同一次导航,先到者用谁并如实标记)。零生产
// 代码改动:套件自建 webview 面板注入真面板 HTML+探针脚本,测的是真渲染管线。
//
// 诚实边界:数据为合成记录(与 S8 同构造),面板 HTML 为真 renderHistoryPanelHtml
// 产物,渲染引擎为真 VS Code webview(Chromium)——本测量目标即「webview 实
// 渲染」成本,与数据来源无关;装配面其余段(命令打开/消息链路)不在此列。
//
// 环境判例(2026-11-23):webview 内容装载在高载 xvfb 宿主里进程级哑——实测
// 14 跑 3 通,全败跑里 5+ 个全新面板均 visible=true/active=true 却零脚本执行
// (连面板自身 queueReady 都不发,即内容没装载,非消息桥被吞)。固定 webview
// service worker profile、豁免 --disable-gpu、元素挂载沉淀窗三招均不改判;
// 主嫌疑=vscode-webview SW 注册/内容装载在高载宿主上的首发竞态,属真机装配面
// 而非扩展代码。3 通跑证明测量设计成立(信号确实经真 Chromium 管线到达);
// 故跑红时套件如实失败(不假绿),20+20 样本待宿主协同时采集。
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { HotReloadHistoryCore } from '../../../backend/hotReloadHistoryCore';
import {
  renderHistoryPanelHtml,
  translateDeliveryRecord,
  type HotReloadNamesResolver
} from '../../../hotReloadHistoryView';
import { htmlLang, strings } from '../../../webviewStrings';

/** 探针:把测量代码注入面板脚本自身 queueReady 行之后(复用面板已 acquire 的
 * vscode 变量,同作用域,零二次 acquire,不另起 script 块)。
 *
 * 双信号:
 *  ① layout——强制同步 reflow(document.body.offsetHeight),量导航→parse+
 *     layout 墙钟。这是本测量主信号:不依赖可见合成器,xvfb 下 rAF 会被
 *     暂停(实测双 rAF 永不触发)而 setTimeout/reflow 照常。
 *  ② paint——double-rAF(过 layout+paint)。webview 标签未激活/未合成时
 *     rAF 停摆则如实缺省,报告里区分记录,不冒充有 paint 数据。 */
const INJECT_ANCHOR = `vscode.postMessage({ type: 'queueReady' });`;
const INJECT_CODE = `vscode.postMessage({ type: 'queueReady' });
    (function () {
      var layoutMs = 0;
      try {
        void document.body.offsetHeight;
        layoutMs = performance.now();
      } catch (e) {}
      // 导航起始段的同步 post 有丢帧(实测 hrProbeLayout 被吞而 hrProbePainted
      // 到达,反之亦然),故同一 layout 值在三条独立时序路径各投一次:同步/
      // setTimeout 0/双 rAF。先到者即定,值来自同一次强制 reflow,可比较。
      var postLayout = function () {
        vscode.postMessage({ type: 'hrProbeLayout', ms: layoutMs });
      };
      postLayout();
      try { setTimeout(postLayout, 0); } catch (e) {}
      try {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            postLayout();
            vscode.postMessage({ type: 'hrProbePainted', ms: performance.now() });
          });
        });
      } catch (e) {}
    })();`;

const injectProbe = (html: string, nonce: string): string => {
  const anchor = html.indexOf(INJECT_ANCHOR);
  const probed = anchor >= 0
    ? `${html.slice(0, anchor)}${INJECT_CODE}${html.slice(anchor + INJECT_ANCHOR.length)}`
    : html;
  // 每次尝试的 html 必须不同:VS Code 对相同 html 的重设是 no-op(比对相等
  // 即跳过),重试不换 nonce 就永远不会真的重新导航(实测 4 连败即此因)。
  return probed.includes('</body>')
    ? probed.replace('</body>', `<!--hr-probe-${nonce}--></body>`)
    : `${probed}<!--hr-probe-${nonce}-->`;
};

/** 等面板真可见(懒加载只在可见后才装载)。reveal 在 1.82 类型里是 void 非
 * Thenable,激活与装载是纯竞态;轮询 visible+补 reveal 压成有界等待。 */
const waitPanelVisible = async (panel: vscode.WebviewPanel, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !panel.visible) {
    panel.reveal(vscode.ViewColumn.One, false);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return panel.visible;
};

/** 全新面板(reveal+等可见+小沉淀)。沉淀窗给 webview 元素在 workbench 里完成
 * 挂载,免得首个 html 落在挂载中途被吞(实测可见即投 html 在高载宿主易整跑哑)。 */
const createLivePanel = async (): Promise<vscode.WebviewPanel> => {
  const panel = vscode.window.createWebviewPanel(
    'kbengineHotReloadHistoryRenderProbe',
    'history render probe',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  panel.reveal(vscode.ViewColumn.One, false);
  await waitPanelVisible(panel, 3000);
  await new Promise(resolve => setTimeout(resolve, 800));
  return panel;
};

const percentile = (samples: readonly number[], p: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[index]!;
};

/** 合成记录(与 S8 bench 同构造):500 条,状态三态混布,含错误详情子集。 */
const makeEntries = (): {
  entries: ReturnType<typeof translateDeliveryRecord>[];
  scriptPath: (index: number) => string;
} => {
  const scriptPath = (index: number): string =>
    path.join('/ws/scripts', `entity${Math.floor(index / 20)}`, `File${index}.py`);
  const records = Array.from({ length: 500 }, (_unused, index) => {
    const file = scriptPath(index);
    return {
      rootId: 'r1',
      targetId: '',
      file,
      outcome: index % 5 === 0 ? 'failed' : index % 3 === 0 ? 'accepted' : 'applied',
      recordedAt: 1700000000000 + index * 1000,
      attempt: 1,
      ...(index % 7 === 0 ? { detail: 'HTTP 状态 500:非 2xx 不算送达' } : {})
    } as Parameters<typeof translateDeliveryRecord>[0];
  });
  const resolver: HotReloadNamesResolver = file => ({
    fullModule: `entities.${path.basename(file, '.py')}`,
    requestModule: path.basename(file, '.py')
  });
  return { entries: records.map(record => translateDeliveryRecord(record, resolver)), scriptPath };
};

/** 单次尝试:注入探针→设置 html→等回执。
 * 双信号择一即可成样:hrProbeLayout(导航→parse+强制 reflow)或
 * hrProbePainted(导航→parse+layout+paint,double-rAF)。两者同一次导航同源
 * (performance.now() 原点=导航起点),都合法;先到哪个用哪个并如实标记,
 * 不冒充另一信号在场。
 *
 * 收敛规则:首个信号到开 graceMs 窗等第二信号,双到或窗尽即回;窗尽只带
 * 单信号照样成样(实测启动窗 post 丢帧常见只到其一)。两信号都不来才超时拒绝。 */
const attemptOnce = (
  panel: vscode.WebviewPanel,
  html: string,
  nonce: string,
  timeoutMs: number,
  graceMs: number
): Promise<{ layout: number | null; painted: number | null }> => {
  return new Promise<{ layout: number | null; painted: number | null }>((resolve, reject) => {
    let layout: number | null = null;
    let painted: number | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const seen: string[] = [];
    const finish = (): void => {
      if (grace !== null) {
        clearTimeout(grace);
        grace = null;
      }
      clearTimeout(timer);
      disposable.dispose();
      resolve({ layout, painted });
    };
    const timer = setTimeout(() => {
      disposable.dispose();
      if (layout === null && painted === null) {
        reject(new Error(
          `渲染探针超时 ${timeoutMs}ms(已到通道:${seen.join(',') || '无'},visible=${panel.visible},active=${panel.active})`
        ));
        return;
      }
      resolve({ layout, painted });
    }, timeoutMs);
    const disposable = panel.webview.onDidReceiveMessage(message => {
      const type = message?.type;
      if (typeof type === 'string') {
        seen.push(type);
      }
      if (message?.type === 'hrProbeLayout' && typeof message.ms === 'number') {
        layout = message.ms as number;
        if (grace === null) {
          grace = setTimeout(finish, graceMs);
        }
        if (painted !== null) {
          finish();
        }
      }
      if (message?.type === 'hrProbePainted' && typeof message.ms === 'number') {
        painted = message.ms as number;
        if (grace === null) {
          grace = setTimeout(finish, graceMs);
        }
        if (layout !== null) {
          finish();
        }
      }
    });
    panel.webview.html = injectProbe(html, nonce);
  });
};

/** 一轮测量。面板复用(健康面板=生产「回执到达→面板重渲」的刷新路径,每轮
 * set html 即重新导航);重试时换全新面板——acquireVsCodeApi 的引导注入是
 * 每 webview 对象一次,导航重载不重跑,同一坏桥面板重设 html 几百次也救不活
 * (实测同面板 4 连败、跨进程新面板却能通,即此因)。 */
const measureOnce = async (
  holder: { panel: vscode.WebviewPanel | null },
  html: string,
  label: string,
  tries = 5,
  timeoutMs = 4000
): Promise<{ sample: number; layout: number | null; painted: number | null; signal: string }> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (holder.panel === null) {
      holder.panel = await createLivePanel();
    }
    const panel = holder.panel;
    try {
      const r = await attemptOnce(panel, html, `${label}-${attempt}`, timeoutMs, 250);
      const signal = r.layout !== null ? 'layout' : 'paint';
      return {
        sample: (r.layout ?? r.painted) as number,
        layout: r.layout,
        painted: r.painted,
        signal
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      holder.panel = null;
      panel.dispose();
    }
  }
  throw lastError ?? new Error('渲染探针未知失败');
};

describe('history render real-webview wall clock (RUST-414 真 UI 线程墙钟)', () => {
  it('真 Chromium webview 渲染面板:50 行页 + 500 行虚拟滚动,p50/p95/p99 有界', async function () {
    this.timeout(300_000);
    const { entries, scriptPath } = makeEntries();
    const core = new HotReloadHistoryCore();
    for (const entry of entries) {
      core.record(entry);
    }
    assert.strictEqual(core.size(), 200, '缺省容量 200 环形淘汰');
    const deepCore = new HotReloadHistoryCore({ capacity: 500 });
    for (const entry of entries) {
      deepCore.record(entry);
    }
    assert.strictEqual(deepCore.size(), 500, 'capacity=500 全量保留');
    const t = strings('zh').hotReloadHistory;
    const lang = htmlLang('zh');
    const state = { feedStatus: { watchMode: 'auto', target: 'local' }, filter: {}, page: 0 };

    // 探针面板:健康面板复用(生产刷新路径),坏桥面板换新(measureOnce 内处置)
    const holder: { panel: vscode.WebviewPanel | null } = { panel: null };

    const page50: number[] = [];
    const virtual500: number[] = [];
    const paint50: number[] = [];
    const paint500: number[] = [];
    let sigLayout50 = 0;
    let sigPaint50 = 0;
    let sigLayout500 = 0;
    let sigPaint500 = 0;
    try {
      for (let round = 0; round < 20; round += 1) {
        const m = await measureOnce(holder, renderHistoryPanelHtml({
          state,
          rows: core.entries().slice(0, 50),
          total: core.size(),
          hasMore: true,
          pageSize: 50,
          t,
          lang
        }), `p${round}`);
        page50.push(m.sample);
        if (m.signal === 'layout') {
          sigLayout50 += 1;
        } else {
          sigPaint50 += 1;
        }
        if (m.painted !== null) {
          paint50.push(m.painted);
        }
      }
      for (let round = 0; round < 20; round += 1) {
        const m = await measureOnce(holder, renderHistoryPanelHtml({
          state,
          rows: deepCore.entries(),
          total: deepCore.size(),
          hasMore: false,
          pageSize: 50,
          virtualize: { rowHeightPx: 26, viewportHeightPx: 480, overscanRows: 5 },
          t,
          lang
        }), `v${round}`);
        virtual500.push(m.sample);
        if (m.signal === 'layout') {
          sigLayout500 += 1;
        } else {
          sigPaint500 += 1;
        }
        if (m.painted !== null) {
          paint500.push(m.painted);
        }
      }
    } finally {
      if (holder.panel !== null) {
        holder.panel.dispose();
      }
    }

    const summary = {
      page50: {
        renderP50: percentile(page50, 0.5),
        renderP95: percentile(page50, 0.95),
        renderP99: percentile(page50, 0.99),
        renderMax: Math.max(...page50),
        samples: page50.length,
        signalLayout: sigLayout50,
        signalPaint: sigPaint50,
        paintSamples: paint50.length,
        paintP99: paint50.length > 0 ? percentile(paint50, 0.99) : null
      },
      virtual500: {
        renderP50: percentile(virtual500, 0.5),
        renderP95: percentile(virtual500, 0.95),
        renderP99: percentile(virtual500, 0.99),
        renderMax: Math.max(...virtual500),
        samples: virtual500.length,
        signalLayout: sigLayout500,
        signalPaint: sigPaint500,
        paintSamples: paint500.length,
        paintP99: paint500.length > 0 ? percentile(paint500, 0.99) : null
      },
      fixture: path.basename(scriptPath(0))
    };
    // 证据落盘(与 hotReloadSegment bench run.txt 同目录同格式追加制)
    const fs = await import('fs');
    const pct = (arm: { samples: number; renderP50: number; renderP95: number; renderP99: number; renderMax: number; signalLayout: number; signalPaint: number }): string =>
      `n=${arm.samples} p50=${arm.renderP50}ms p95=${arm.renderP95}ms p99=${arm.renderP99}ms max=${arm.renderMax}ms signalLayout=${arm.signalLayout} signalPaint=${arm.signalPaint}`;
    fs.appendFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'docs', 'perf', 'hot-reload-segment-run.txt'),
      [
        `HRS-METRIC RUST414.page50 ${pct(summary.page50)}`,
        `HRS-METRIC RUST414.virtual500 ${pct(summary.virtual500)}`,
        `HRS-METRIC RUST414.paint50 n=${summary.page50.paintSamples} p99=${summary.page50.paintP99}ms`,
        `HRS-METRIC RUST414.paint500 n=${summary.virtual500.paintSamples} p99=${summary.virtual500.paintP99}ms`,
        'HRS-NOTE RUST414 真 UI 线程墙钟(webview 实渲染):真 Chromium webview 渲染真 renderHistoryPanelHtml 产物,双信号同源同导航(导航→parse+强制 reflow / 导航→parse+layout+paint),先到者成样并如实标记(signalLayout/signalPaint);数据为合成记录与 S8 同构造,渲染引擎与面板 HTML 均为真'
      ].join('\n') + '\n'
    );

    // 断言:真 UI 线程渲染真实完成且时间健全(亚秒级有界;webview 装载+渲染
    // 可到几十 ms,但渲染墙钟 p99 必须在 500ms 内——S8 纯核字符串生成 p99
    // 3.81ms,真实 webview 含 DOM 解析+layout,允许一个量级以上的管线开销,
    // 但不允许秒级冻结)
    assert.ok(summary.page50.samples === 20, `page50 应有 20 轮样本,实 ${summary.page50.samples}`);
    assert.ok(summary.virtual500.samples === 20, `virtual500 应有 20 轮样本,实 ${summary.virtual500.samples}`);
    assert.ok(summary.page50.renderP99 > 0, 'page50 有样本');
    assert.ok(summary.virtual500.renderP99 > 0, 'virtual500 有样本');
    assert.ok(
      summary.page50.renderP99 < 500,
      `page50 渲染 p99 应 <500ms,实 ${summary.page50.renderP99}`
    );
    assert.ok(
      summary.virtual500.renderP99 < 500,
      `virtual500 渲染 p99 应 <500ms,实 ${summary.virtual500.renderP99}`
    );
    // 虚拟 500 行应不慢于 50 行页一个数量级之上(虚拟只渲染视口窗,不应 10 倍级劣化)
    assert.ok(
      summary.virtual500.renderP99 < summary.page50.renderP99 * 10 + 50,
      `virtual500 渲染 p99 ${summary.virtual500.renderP99} 不应远超 page50 p99 ${summary.page50.renderP99}`
    );
  });
});
