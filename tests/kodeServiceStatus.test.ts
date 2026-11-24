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
  engineVersionLine,
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
  it('shows built / not-built / off across enabled x binary (en default)', () => {
    // 2026-11-13 内建 MCP 三可见态:enabled × binary
    expect(mcpStatusBarText(true, true)).toContain('built');
    expect(mcpStatusBarText(false, true)).toContain('not built');
    expect(mcpStatusBarText(true, false)).toContain('off');
    expect(mcpStatusBarText(false, false)).toContain('off');
  });

  it('renders zh-cn translations when bundle injected', () => {
    setL10nBundle(zhCnBundle);
    expect(mcpStatusBarText(true, true)).toContain('已构建');
    expect(mcpStatusBarText(false, true)).toContain('未构建');
    expect(mcpStatusBarText(true, false)).toContain('已关闭');
  });

  it('tooltip states built-in hosting with click-to-toggle (集成 fact)', () => {
    // 内建托管新口径:注册事实 + 点击启停(2026-11-13 用户令)
    expect(mcpStatusBarTooltip(true, true)).toContain('built-in MCP server definition registered');
    expect(mcpStatusBarTooltip(true, true)).toContain('click to disable');
    expect(mcpStatusBarTooltip(false, true)).toContain('build the binary');
    expect(mcpStatusBarTooltip(true, false)).toContain('click to enable');
  });
});

describe('mcp liveness face (2026-11-24 MCP 活性灯批)', () => {
  it('probing/未探时保持 built 文案;探针有账才翻 ok / no reply (en default)', () => {
    expect(mcpStatusBarText(true, true, { probing: false, last: null })).toContain('built');
    expect(mcpStatusBarText(true, true, { probing: true, last: null })).toContain('built');
    expect(
      mcpStatusBarText(true, true, { probing: false, last: { ok: true, latencyMs: 12 } })
    ).toContain('Kode MCP: ok');
    expect(
      mcpStatusBarText(true, true, { probing: false, last: { ok: false, latencyMs: 3000 } })
    ).toContain('no reply');
    expect(
      mcpStatusBarText(true, true, {
        probing: false,
        last: { ok: false, latencyMs: 30, reason: 'spawn failed: ENOENT' }
      })
    ).toContain('no reply');
  });

  it('off / not built 臂不吃探针账(关态/缺二进制时探活无意义)', () => {
    expect(
      mcpStatusBarText(false, true, { probing: false, last: { ok: true, latencyMs: 1 } })
    ).toContain('not built');
    expect(
      mcpStatusBarText(true, false, { probing: false, last: { ok: false, latencyMs: 1 } })
    ).toContain('off');
  });

  it('tooltip 探针行四口吻如实:通过带延迟/快速失败带原词/预算未决疑似挂死/在途', () => {
    expect(
      mcpStatusBarTooltip(true, true, { probing: false, last: { ok: true, latencyMs: 12 } })
    ).toContain('Liveness probe passed (12ms)');
    expect(
      mcpStatusBarTooltip(true, true, {
        probing: false,
        last: {
          ok: false,
          latencyMs: 40,
          reason: 'kode-mcp probe process exited before answering (code 1)'
        }
      })
    ).toContain('Liveness probe failed: kode-mcp probe process exited');
    expect(
      mcpStatusBarTooltip(true, true, { probing: false, last: { ok: false, latencyMs: 3000 } })
    ).toContain('no answer within budget (suspected hang)');
    expect(
      mcpStatusBarTooltip(true, true, { probing: true, last: null })
    ).toContain('running (first probe after activation)');
    // 未探(probe 缺省或全空账)= 既有托管事实,不带探针行(两参旧签名同口径)
    expect(mcpStatusBarTooltip(true, true)).not.toContain('Liveness probe');
    expect(mcpStatusBarTooltip(true, true, { probing: false, last: null })).toContain(
      'built-in MCP server definition registered'
    );
  });

  it('renders zh-cn translations when bundle injected', () => {
    setL10nBundle(zhCnBundle);
    expect(
      mcpStatusBarText(true, true, { probing: false, last: { ok: true, latencyMs: 9 } })
    ).toContain('正常');
    expect(
      mcpStatusBarText(true, true, { probing: false, last: { ok: false, latencyMs: 9 } })
    ).toContain('无应答');
    expect(
      mcpStatusBarTooltip(true, true, { probing: false, last: { ok: true, latencyMs: 9 } })
    ).toContain('探活通过(9ms)');
    expect(
      mcpStatusBarTooltip(true, true, { probing: false, last: { ok: false, latencyMs: 9 } })
    ).toContain('探活失败:预算内未决(疑似挂死)');
    expect(
      mcpStatusBarTooltip(true, true, {
        probing: false,
        last: { ok: false, latencyMs: 9, reason: 'spawn failed: ENOENT' }
      })
    ).toContain('探活失败:spawn failed: ENOENT');
  });
});

describe('engine version line (RUST-136 增量⑤)', () => {
  it('shows detected version verbatim, never guesses a value (en default)', () => {
    // 探测命中:如实显示标记值
    expect(
      coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' }, '2.5.10')
    ).toContain('KBEngine engine version: 2.5.10');
    // 未检出(null)= 显式「未检测到」,绝不回落 kbengine.engineVersion 设置值
    expect(
      coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' }, null)
    ).toContain('not detected');
    // 单参调用(测试旧签名/未接线)= 同口径「未检测到」
    expect(coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' })).toContain(
      'not detected'
    );
  });

  it('empty probe result (defensive) also renders not-detected', () => {
    expect(engineVersionLine('')).toContain('not detected');
  });

  it('renders zh-cn translations when bundle injected', () => {
    setL10nBundle(zhCnBundle);
    expect(
      coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' }, '2.5.10')
    ).toContain('KBEngine 引擎版本:2.5.10');
    expect(
      coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' }, null)
    ).toContain('未检测到');
  });
});

describe('index format schema line (ENGINE-WORDING-006)', () => {
  it('every core tooltip carries the schema line, word-separated from KBEngine', () => {
    expect(coreStatusBarTooltip({ mode: 'rust', serverPath: '/x/kode-server' })).toContain(
      'Index format schema=index-cache/1'
    );
    expect(coreStatusBarTooltip({ mode: 'ts', serverPath: '' })).toContain(
      'unrelated to the KBEngine engine version'
    );
    expect(coreStatusBarTooltip(null)).toContain('Index format schema=index-cache/1');
  });
});
