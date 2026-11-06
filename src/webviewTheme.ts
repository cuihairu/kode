/**
 * KODE webview 统一设计系统(KODE MONITOR DESIGN SYSTEM v1)。
 *
 * 用户已批准的重设计原型(kode-webviews-redesign.html)把 8 个面板的视觉
 * 收敛为单一 token 来源:VS Code Dark+ 原生语境、唯一四档状态色板
 * (替代旧 Material/Bootstrap 两族混用)、工作台蓝唯一强调色、5 档字阶、
 * 4 基准间距。所有 webview 面板的 <style> 必须以 WEBVIEW_THEME_CSS 为底,
 * 非.CSS 场景(Chart.js/mermaid/内联 style)用 statusColor/statusVar 取色。
 */

/** 四档语义状态 + neutral(诊断 §四:唯一状态色板,全 8 面板共用) */
export type KodeStatusLevel = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export const KODE_STATUS_COLORS: Record<KodeStatusLevel, string> = {
  ok: '#89d185',
  warn: '#cca700',
  err: '#f14c4c',
  info: '#75beff',
  neutral: '#808080'
};

/** CSS 自定义属性引用(面板样式表内使用) */
export function statusVar(level: KodeStatusLevel): string {
  return `var(--kode-${level})`;
}

/** 原始色值(Chart.js 边框色、mermaid classDef 等非 CSS-var 场景) */
export function statusColor(level: KodeStatusLevel): string {
  return KODE_STATUS_COLORS[level];
}

/**
 * 共享主题:token 块(:root)+ 面板壳/组件类。token 名统一 --kode-* 前缀,
 * 值钉死为原型批准的 VS Code Dark+ 色值(单点真相;面板局部样式只引用
 * var(--kode-*) 与 .kode-* 组件类,不再自带色值)。
 */
export const WEBVIEW_THEME_CSS = `
:root {
  /* 面层(VS Code Dark+) */
  --kode-bg:#1e1e1e;
  --kode-surface:#252526;
  --kode-surface-2:#2d2d30;
  --kode-border:#3c3c3c;
  --kode-border-soft:rgba(255,255,255,.08);
  /* 文本四档 */
  --kode-fg:#d4d4d4;
  --kode-fg-2:#b8b8b8;
  --kode-fg-3:#8a8a8a;
  --kode-fg-4:#6a6a6a;
  /* 唯一四档状态色板(+neutral) */
  --kode-ok:#89d185;  --kode-ok-dim:rgba(137,209,133,.14);
  --kode-warn:#cca700;--kode-warn-dim:rgba(204,167,0,.14);
  --kode-err:#f14c4c; --kode-err-dim:rgba(241,76,76,.14);
  --kode-info:#75beff;--kode-info-dim:rgba(117,190,255,.12);
  --kode-neutral:#808080;
  /* 唯一强调色(工作台蓝) */
  --kode-accent:#3794ff;
  --kode-btn:#0e639c;
  --kode-btn-hover:#1177bb;
  /* 字体 */
  --kode-ui:"Segoe WPC","Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
  --kode-mono:"Cascadia Code",Consolas,"Courier New",monospace;
  /* 字阶 5 档 */
  --kode-t-kpi:22px;
  --kode-t-h1:15px;
  --kode-t-body:13px;
  --kode-t-meta:12px;
  --kode-t-tag:11px;
  /* 间距 4 基准 + 圆角 */
  --kode-s1:4px; --kode-s2:8px; --kode-s3:12px; --kode-s4:16px; --kode-s5:24px;
  --kode-r:4px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background-color: var(--kode-bg);
  color: var(--kode-fg);
  font-family: var(--kode-ui);
  font-size: var(--kode-t-body);
}
.kode-mono { font-family: var(--kode-mono); }
.kode-num { font-variant-numeric: tabular-nums; }
/* 面板头 */
.kode-head {
  display:flex; align-items:center; gap:var(--kode-s3);
  padding:10px var(--kode-s4);
  border-bottom:1px solid var(--kode-border);
  background:var(--kode-surface); flex:none;
}
.kode-head h1 { font-size:var(--kode-t-h1); font-weight:600; color:#fff; }
.kode-head .kode-sub { font-size:var(--kode-t-meta); color:var(--kode-fg-3); }
.kode-head .kode-spacer { flex:1; }
/* 状态 pill(唯一状态语义载体) */
.kode-pill {
  display:inline-flex; align-items:center; gap:6px;
  font-size:var(--kode-t-tag); border-radius:10px;
  padding:2px 10px; font-weight:500;
}
.kode-pill i { width:7px; height:7px; border-radius:50%; display:inline-block; }
.kode-pill.ok { background:var(--kode-ok-dim); color:var(--kode-ok); }
.kode-pill.ok i { background:var(--kode-ok); }
.kode-pill.warn { background:var(--kode-warn-dim); color:var(--kode-warn); }
.kode-pill.warn i { background:var(--kode-warn); }
.kode-pill.err { background:var(--kode-err-dim); color:var(--kode-err); }
.kode-pill.err i { background:var(--kode-err); }
.kode-pill.info { background:var(--kode-info-dim); color:var(--kode-info); }
.kode-pill.info i { background:var(--kode-info); }
.kode-pill.neutral { background:rgba(128,128,128,.15); color:var(--kode-fg-2); }
.kode-pill.neutral i { background:var(--kode-neutral); }
/* 按钮 */
.kode-btn {
  font-family:var(--kode-ui); font-size:var(--kode-t-meta);
  border:none; border-radius:3px; padding:4px 12px; cursor:pointer;
  background:transparent; color:var(--kode-fg-2); border:1px solid var(--kode-border);
}
.kode-btn:hover { background:rgba(255,255,255,.06); }
.kode-btn.primary { background:var(--kode-btn); color:#fff; border-color:transparent; }
.kode-btn.primary:hover { background:var(--kode-btn-hover); }
.kode-btn.danger { color:var(--kode-err); border-color:rgba(241,76,76,.4); }
/* 输入/下拉 */
.kode-sel, .kode-inp {
  font-family:var(--kode-ui); font-size:var(--kode-t-meta);
  background:var(--kode-surface-2); color:var(--kode-fg);
  border:1px solid var(--kode-border); border-radius:3px;
  padding:4px 8px; outline:none;
}
.kode-inp:focus { border-color:var(--kode-accent); }
/* 小节标题 */
.kode-sect-t {
  font-size:var(--kode-t-meta); font-weight:600; color:var(--kode-fg-3);
  text-transform:uppercase; letter-spacing:.05em;
}
/* 数据表基线 */
.kode-table { width:100%; border-collapse:collapse; font-size:var(--kode-t-meta); }
.kode-table th {
  font-weight:500; color:var(--kode-fg-3); text-align:left;
  padding:6px 10px; border-bottom:1px solid var(--kode-border);
  white-space:nowrap;
}
.kode-table td {
  padding:7px 10px; border-bottom:1px solid var(--kode-border-soft);
  vertical-align:middle; white-space:nowrap;
}
/* 空态 */
.kode-empty {
  color:var(--kode-fg-4); font-size:var(--kode-t-meta);
  text-align:center; padding:var(--kode-s2);
}
/* 通知条(语义由调用方选 ok/warn/err/info) */
.kode-notice {
  padding:6px 12px; border-radius:var(--kode-r);
  font-size:var(--kode-t-meta); line-height:1.5;
}
.kode-notice.warn { background:var(--kode-warn-dim); color:var(--kode-warn); }
.kode-notice.err { background:var(--kode-err-dim); color:var(--kode-err); }
.kode-notice.info { background:var(--kode-info-dim); color:var(--kode-info); }
.kode-notice.ok { background:var(--kode-ok-dim); color:var(--kode-ok); }
`;
