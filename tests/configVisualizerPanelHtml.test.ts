// configVisualizerPanelHtml:壳安全面(docs/design/config-visualization.md
// §11 可测断言)。壳内零键名/零键值;CSP 串 = webviewScriptCsp(nonce)
// (2026-11-11 修正:零媒体资源,无 cspSource);文案经 toJsonForScript
// 一次注入(函数形键反推 {n} 占位模板);无 vscode import(SRC-012 纯字符串);
// 静态插值全转义。
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as stub from './helpers/vscodeStub';
import { renderConfigVisualizerWebview } from '../src/configVisualizerPanelHtml';
import { webviewScriptCsp } from '../src/webviewSecurity';

const render = (title = 'Config Merge Visualization', nonce = 'NONCE123'): string =>
  renderConfigVisualizerWebview({ title, nonce });

describe('壳安全面(§11)', () => {
  beforeEach(() => {
    stub.configurationOverrides.delete('kbengine');
    stub.envState.language = 'en';
  });

  it('CSP 串精确等于 webviewScriptCsp(nonce):default-src none,无 img-src/外联', () => {
    const html = render('Config Merge Visualization', 'N1');
    expect(html).toContain(`content="${webviewScriptCsp('N1')}"`);
    expect(html).toContain(`<script nonce="N1">`);
    expect(html).not.toContain('cspSource');
  });

  it('SRC-012:模块不 import vscode(纯字符串生产,可静态断言)', () => {
    const source = readFileSync(new URL('../src/configVisualizerPanelHtml.ts', import.meta.url), 'utf8');
    expect(source.includes("from 'vscode'")).toBe(false);
  });

  it('壳内不含任何键名/键值——数据只经 postMessage 达前端', () => {
    const html = render();
    // 哨兵探针:壳静态串里不存在任何配置键值占位;真实键值只会在运行期经
    // resolveState 消息进入 DOM(createElement/textContent 路径)
    expect(html).not.toContain('SENTINEL_KEY_NAME');
    expect(html).not.toContain('SENTINEL_KEY_VALUE');
    expect(html).not.toContain('kbengine_defaults.xml:');
  });

  it('文案一次注入:函数形键反推 {n} 占位模板,JSON 通道不带函数', () => {
    const html = render();
    expect(html).toContain('"sectionMeta":"{0} keys · {1} overridden · {2} custom"');
    expect(html).toContain('"statusSummary":"{0} sections · {1} keys · {2} overridden · {3} custom"');
    expect(html).toContain('"copyFailed":"Copy failed: {0}"');
    // 模型侧烘焙尾注,客户端不需要 valueTruncated 模板
    expect(html).toContain('"valueTruncated":""');
    expect(html).toContain('var T = ');
  });

  it('标题等静态插值全转义:<script> 落 HTML 按文本出现', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('语言跟随 locale:en/en、zh/zh-CN,双语文案随之切换', () => {
    expect(render()).toContain('lang="en"');
    expect(render()).toContain('Resolving config…');
    stub.configurationOverrides.set('kbengine', { webviewLocale: 'zh' });
    const zh = render();
    expect(zh).toContain('lang="zh-CN"');
    expect(zh).toContain('正在解析配置…');
    expect(zh).toContain('"sectionMeta":"{0} 键 · 覆盖 {1} · 新增 {2}"');
  });
});

describe('版式与可访问性骨架(§5.2/§5.3)', () => {
  beforeEach(() => {
    stub.configurationOverrides.delete('kbengine');
    stub.envState.language = 'en';
  });

  it('三栏 + 状态区元素 id 齐:树/列表/详情/徽标/路径/警示/错误/加载/状态', () => {
    const html = render();
    for (const id of [
      'cfg-search',
      'cfg-filter-all',
      'cfg-filter-overridden',
      'cfg-filter-custom',
      'cfg-filter-defaults',
      'cfg-refresh',
      'cfg-badge',
      'cfg-paths',
      'cfg-warning',
      'cfg-error',
      'cfg-loading',
      'cfg-tree',
      'cfg-list-head',
      'cfg-list',
      'cfg-detail-body',
      'cfg-status',
      'cfg-live'
    ]) {
      expect(html, `id ${id}`).toContain(`id="${id}"`);
    }
  });

  it('ARIA 骨架:tree/listbox/complementary/status 徽标默认隐藏', () => {
    const html = render();
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/role="status"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('id="cfg-badge" class="source-badge" hidden');
  });
});
