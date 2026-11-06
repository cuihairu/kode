// webviewTheme:UI 重设计统一设计系统(KODE MONITOR DESIGN SYSTEM v1,
// 用户已批准的原型 ~/kode-ui-redesign/prototype/kode-webviews-redesign.html)。
// 单一 token 来源:VS Code Dark+ 四档状态色板 + 工作台蓝强调色 + 5 档字阶 +
// 4 基准间距。8 个 webview 面板全部从这里取色,替代 Material/Bootstrap
// 两族旧色系(DIAGNOSIS.md 三、第 36 行)。
import { describe, expect, it } from 'vitest';
import {
  KODE_STATUS_COLORS,
  WEBVIEW_THEME_CSS,
  statusColor,
  statusVar
} from '../src/webviewTheme';

describe('webviewTheme 状态色板(唯一四档+neutral)', () => {
  it('四档状态色与原型逐一对应', () => {
    expect(KODE_STATUS_COLORS.ok).toBe('#89d185');
    expect(KODE_STATUS_COLORS.warn).toBe('#cca700');
    expect(KODE_STATUS_COLORS.err).toBe('#f14c4c');
    expect(KODE_STATUS_COLORS.info).toBe('#75beff');
    expect(KODE_STATUS_COLORS.neutral).toBe('#808080');
  });

  it('statusVar 输出 CSS 自定义属性引用', () => {
    expect(statusVar('ok')).toBe('var(--kode-ok)');
    expect(statusVar('warn')).toBe('var(--kode-warn)');
    expect(statusVar('err')).toBe('var(--kode-err)');
    expect(statusVar('info')).toBe('var(--kode-info)');
    expect(statusVar('neutral')).toBe('var(--kode-neutral)');
  });

  it('statusColor 输出原始色值(Chart.js/mermaid 等非 CSS 场景用)', () => {
    expect(statusColor('err')).toBe('#f14c4c');
    expect(statusColor('ok')).toBe('#89d185');
  });
});

describe('webviewTheme 主题样式块', () => {
  const css = WEBVIEW_THEME_CSS;

  it('包含全部设计 token:面层/文本/状态/强调/字阶/间距/圆角', () => {
    // 面层(VS Code Dark+)
    expect(css).toContain('--kode-bg:#1e1e1e');
    expect(css).toContain('--kode-surface:#252526');
    expect(css).toContain('--kode-surface-2:#2d2d30');
    expect(css).toContain('--kode-border:#3c3c3c');
    // 文本四档
    expect(css).toContain('--kode-fg:#d4d4d4');
    // 唯一强调色(工作台蓝)
    expect(css).toContain('--kode-accent:#3794ff');
    expect(css).toContain('--kode-btn:#0e639c');
    expect(css).toContain('--kode-btn-hover:#1177bb');
    // 字阶 5 档
    expect(css).toContain('--kode-t-kpi:22px');
    expect(css).toContain('--kode-t-h1:15px');
    expect(css).toContain('--kode-t-body:13px');
    expect(css).toContain('--kode-t-meta:12px');
    expect(css).toContain('--kode-t-tag:11px');
    // 间距 4 基准 + 圆角 4
    expect(css).toContain('--kode-s1:4px');
    expect(css).toContain('--kode-s2:8px');
    expect(css).toContain('--kode-s3:12px');
    expect(css).toContain('--kode-s4:16px');
    expect(css).toContain('--kode-s5:24px');
    expect(css).toContain('--kode-r:4px');
  });

  it('不再携带 Material/Bootstrap 两族旧色系', () => {
    for (const legacy of [
      '#4CAF50', '#FF9800', '#F44336', // Material
      '#5cb85c', '#d9534f', '#f0ad4e', // Bootstrap
      '#2196F3', '#D32F2F' // 日志面板旧蓝图/深红
    ]) {
      expect(css.toLowerCase()).not.toContain(legacy.toLowerCase());
    }
  });

  it('共享组件类齐备:pill/btn/sel/inp/sect-t', () => {
    expect(css).toContain('.kode-pill.ok');
    expect(css).toContain('.kode-pill.warn');
    expect(css).toContain('.kode-pill.err');
    expect(css).toContain('.kode-pill.info');
    expect(css).toContain('.kode-pill.neutral');
    expect(css).toContain('.kode-btn.primary');
    expect(css).toContain('.kode-btn.danger');
    expect(css).toContain('.kode-sel');
    expect(css).toContain('.kode-inp');
    expect(css).toContain('.kode-sect-t');
  });
});
