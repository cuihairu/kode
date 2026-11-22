import { describe, expect, it } from 'vitest';
import {
  VIRTUAL_SCROLL_THRESHOLD,
  renderHistoryPanelHtml,
  type HotReloadHistoryPanelState
} from '../src/hotReloadHistoryView';
import type { HotReloadHistoryEntry } from '../src/backend/hotReloadHistoryCore';
import { htmlLang, strings } from '../src/webviewStrings';

// RUST-384 批C 钉:历史面板无障碍完整性+主题硬化+键盘可达+locale 文案残差。
// 批A 落了快捷键/行级键盘/live 区基础,批B 落了面板文案国际化(webviewStrings
// 注入 t/lang)+主题令牌化;本钉覆盖批B 诚实留下的残差——
// ①主题硬化:editor-background 底+:focus-visible 焦点环,不引固定 Dark+ 调色板;
// ②screen reader:实时队列稳定 live 区(只换内层行,屏幕阅读器可听到队列变化)
//   +过滤表单 role=search+五控件 sr-only 关联标签+双表 aria-label;
// ③键盘:apply 钮即 submit 钮,任一过滤控件回车走 form submit 处理器即应用;
// ④zh 文案残差修复:defaultTarget 落中文(不再英文占位)。
// 纯渲染钉:renderHistoryPanelHtml 是纯字符串函数,不经 vscode,直接两态注入。

const baseState = (): HotReloadHistoryPanelState => ({
  feedStatus: { watchMode: '保存时', target: 'dev-1' },
  filter: { fullModuleContains: '', targetId: '', status: '', trigger: '', errorCategory: '' },
  page: 0
});

const rowOf = (overrides: Partial<HotReloadHistoryEntry> = {}): HotReloadHistoryEntry => ({
  requestId: 'dev-1/FightAI.py#1',
  fullModule: 'entities.fight.FightAI',
  requestModule: 'fight.FightAI',
  fileUri: '/ws/scripts/entities/fight/FightAI.py',
  targetId: '',
  time: 1700000000000,
  status: 'sent-unverified',
  ...overrides
});

const render = (
  locale: 'zh' | 'en' = 'zh',
  opts: {
    rows?: readonly HotReloadHistoryEntry[];
    hasMore?: boolean;
    virtualize?: { rowHeightPx: number; viewportHeightPx: number; overscanRows: number };
  } = {}
): string =>
  renderHistoryPanelHtml({
    state: baseState(),
    rows: opts.rows ?? [rowOf()],
    total: opts.rows?.length ?? 1,
    hasMore: opts.hasMore ?? false,
    pageSize: 200,
    t: strings(locale).hotReloadHistory,
    lang: htmlLang(locale),
    ...(opts.virtualize ? { virtualize: opts.virtualize } : {})
  });

describe('RUST-384 批C 主题硬化', () => {
  it('面板底色走 --vscode-editor-background,焦点环走 --vscode-focusBorder', () => {
    const html = render();
    expect(html).toContain('background: var(--vscode-editor-background)');
    expect(html).toContain(':focus-visible { outline: 2px solid var(--vscode-focusBorder');
  });

  it('不引固定 Dark+ 调色板(暗色常量/自造色板变量一律不出现)', () => {
    const html = render();
    expect(html).not.toContain('#1e1e1e');
    expect(html).not.toContain('--kode-bg');
  });
});

describe('RUST-384 批C screen reader 文本', () => {
  it('实时队列包稳定 live 区:role=status aria-live=polite,aria-label 按 locale', () => {
    expect(render()).toContain(
      'id="queue-region" role="status" aria-live="polite" aria-label="实时队列"'
    );
    expect(render('en')).toContain('aria-label="Live queue"');
  });

  it('页头计数 live 区(role=status aria-live=polite)保留', () => {
    expect(render()).toContain('<div class="header" role="status" aria-live="polite">');
  });

  it('过滤表单 role=search+aria-label;五控件各配 sr-only 关联标签(label for=id)', () => {
    const html = render();
    expect(html).toContain('id="filter-form" role="search" aria-label="历史筛选"');
    expect(html).toContain('<label class="sr-only" for="f-module">');
    expect(html).toContain('<label class="sr-only" for="f-target">');
    expect(html).toContain('<label class="sr-only" for="f-status">');
    expect(html).toContain('<label class="sr-only" for="f-trigger">');
    expect(html).toContain('<label class="sr-only" for="f-category">');
    expect(html).toContain('.sr-only { position: absolute');
  });

  it('双表 aria-label:非虚拟表与虚拟滚动表两分支同钉(按 locale)', () => {
    expect(render()).toContain('<table aria-label="热更历史表">');
    expect(render('en')).toContain('<table aria-label="Hot reload history table">');

    const rows = Array.from({ length: VIRTUAL_SCROLL_THRESHOLD + 40 }, (_, i) =>
      rowOf({ requestId: `dev-1/FightAI.py#${i + 1}`, fullModule: `entities.fight.FightAI${i}` })
    );
    expect(
      render('zh', {
        rows,
        virtualize: { rowHeightPx: 28, viewportHeightPx: 200, overscanRows: 5 }
      })
    ).toContain('<table aria-label="热更历史表">');
  });
});

describe('RUST-384 批C 键盘可达', () => {
  it('apply 钮即 submit 钮:回车走 form submit 处理器(preventDefault 后应用筛选)', () => {
    const html = render();
    expect(html).toContain('<button type="submit" id="apply">');
    expect(html).toContain("addEventListener('submit', event => {");
    expect(html).toContain('event.preventDefault();');
  });

  it('清除/加载更多钮仍 type=button(点一下不误触提交)', () => {
    expect(render()).toContain('<button type="button" id="clear">');
    expect(render('zh', { hasMore: true })).toContain('<button type="button" id="more">');
  });
});

describe('RUST-384 批C locale 文案残差', () => {
  it('defaultTarget 按 locale:zh=(默认) en=(default)(修复 zh 英文占位)', () => {
    const zh = render();
    expect(zh).toContain('<td>(默认)</td>');
    expect(zh).not.toContain('<td>(default)</td>');
    expect(render('en')).toContain('<td>(default)</td>');
  });

  it('三个 a11y 标签键 zh/en 同形且皆非空(面板标签不进宿主 NLS 面)', () => {
    const zh = strings('zh').hotReloadHistory;
    const en = strings('en').hotReloadHistory;
    expect(new Set(Object.keys(zh))).toEqual(new Set(Object.keys(en)));
    for (const key of ['queueRegionLabel', 'filterGroupLabel', 'tableLabel'] as const) {
      expect(zh[key].length).toBeGreaterThan(0);
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  it('<html lang> 按 locale(zh-CN / en)', () => {
    expect(render()).toContain('<html lang="zh-CN">');
    expect(render('en')).toContain('<html lang="en">');
  });
});