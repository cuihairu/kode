/**
 * Kode 核心/MCP 状态栏标签纯面单测(2026-11-10 用户令「如何提示 lsp 和 mcp
 * 的状态是否开启」)。标签是纯函数(事实由装配采集),此处锁文案与状态映射;
 * 装配面(状态栏项/订阅)在 src/activate/kodeServiceStatus.ts,经
 * infrastructure.ts 接线,由 electron 集成面兜底。
 * 两态:默认(无 bundle)= 英文源串;注入 zh-cn bundle = 中文(与真实 locale 同口径)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import {
  coreStatusBarText,
  coreStatusBarTooltip,
  mcpStatusBarText,
  mcpStatusBarTooltip
} from '../src/backend/kodeServiceStatus';

afterEach(() => {
  setL10nBundle(null);
});

describe('core status bar (pure)', () => {
  it('maps each backend mode to its honest label (en default)', () => {
    // Rust 服务轨道:backend=rust + serverPath 命中
    expect(coreStatusBarText({ mode: 'rust', serverPath: '/x/kode-server' })).toContain('Rust');
    // UX-REVIEW-011 追加:核心状态文案点明 LSP(用户反馈「看不出哪条是 LSP」)
    expect(coreStatusBarText({ mode: 'rust', serverPath: '/x/kode-server' })).toContain('Kode LSP');
    expect(coreStatusBarText({ mode: 'ts', serverPath: '' })).toContain('Kode LSP');
    // Rust 配置但二进制未找到(自动发现落空)→ 降级 TS
    expect(coreStatusBarText({ mode: 'rust', serverPath: '' })).toContain('fallback');
    // 纯 TS
    expect(coreStatusBarText({ mode: 'ts', serverPath: '' })).toContain('TS');
    // Shadow 影子对拍
    expect(coreStatusBarText({ mode: 'shadow', serverPath: '/x/kode-server' })).toContain('Shadow');
    // 未初始化
    expect(coreStatusBarText(null)).toContain('not initialized');
  });

  it('renders zh-cn translations when bundle injected', () => {
    setL10nBundle(zhCnBundle);
    expect(coreStatusBarText({ mode: 'rust', serverPath: '/x/kode-server' })).toContain('Rust');
    expect(coreStatusBarText({ mode: 'rust', serverPath: '' })).toContain('降级');
    expect(coreStatusBarText({ mode: 'shadow', serverPath: '/x/kode-server' })).toContain('对拍');
    expect(coreStatusBarText(null)).toContain('未初始化');
  });

  it('tooltip carries the fallback reason / path (no overclaim)', () => {
    // 降级时明确说明原因(不虚构 applied)
    expect(coreStatusBarTooltip({ mode: 'rust', serverPath: '' })).toContain('not found');
    // Rust 在位给真实路径
    expect(coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' })).toContain('/x/kode-server');
  });
});

describe('mcp status bar (pure)', () => {
  it('shows built / not-built from binary presence (en default)', () => {
    expect(mcpStatusBarText(true)).toContain('built');
    expect(mcpStatusBarText(false)).toContain('not built');
  });

  it('renders zh-cn translations when bundle injected', () => {
    setL10nBundle(zhCnBundle);
    expect(mcpStatusBarText(true)).toContain('已构建');
    expect(mcpStatusBarText(false)).toContain('未构建');
  });

  it('tooltip states the extension does not host mcp (未集成 fact)', () => {
    expect(mcpStatusBarTooltip(true)).toContain('does not host');
    expect(mcpStatusBarTooltip(false)).toContain('does not host');
  });
});
