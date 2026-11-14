/**
 * KFLOW 文本路径(FLOW-020,G2 泳道的文本消费面纯核)。
 *
 * 验收:图和文本消费同一模型——本核只读 FlowReviewSample(FLOW-014 生成
 * 核产物,HTML 面消费的同一对象),不重新解析、不新造证据;渲染(HTML 面)
 * 失败时文本面仍在:路径、未解析/未连接原因、分支候选全保留,可重试装配。
 *
 * 口径:
 *   - 输出零脚本自包含文本(<pre> 文档),词汇红线 R1 同源:候选帧/走查
 *     轨迹/静态可能路径,无栈词汇;
 *   - 段落:走查序列(rows 帧行/链接行交错)→ 帧内本地调用(frameLocals)
 *     → 分支候选 → 未解析/未连接(walkLinks+frameLocals 全量)→ 证据
 *     索引(EV 编号可回查)→ 截断注记(truncated 如实);
 *   - 链接行携带 kind/方向/调用点/未解析码/未连接标记(与 HTML 面同一
 *     字段面,同一样本);
 *   - 零 vscode 依赖;面板层负责包 <pre> 后走同一 CSP/工具条渲染管线。
 */

import type { FlowReviewLink, FlowReviewSample } from './flowReviewSample';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 链接行文本(与 HTML 面同一字段面:kind/方向/调用点/未解析/未连接) */
const linkLine = (link: FlowReviewLink): string => {
  const parts: string[] = [];
  parts.push(`${link.id} ${link.kind} ${link.fromLabel} → ${link.toLabel}`);
  parts.push(`方向 ${link.direction.from}→${link.direction.to}`);
  if (link.callSite) {
    parts.push(`调用点 ${link.callSite}`);
  }
  if (link.argNote) {
    parts.push(link.argNote);
  }
  if (link.unresolvedCode) {
    parts.push(`未解析 ${link.unresolvedCode}(${link.unresolvedDetail ?? ''})`);
  }
  if (!link.connectedToExec) {
    parts.push('未连接(def/实现缺口或广播,如实)');
  }
  parts.push(`证据 ${link.evidenceId}(${link.evidenceType})`);
  return `  - ${parts.join(' · ')}`;
};

export interface FlowTextPath {
  /** 纯文本(走查轨迹全文;零脚本) */
  text: string;
  /** <pre> 自包含文档(面板层经同一 CSP/工具条管线渲染) */
  html: string;
}

export function buildFlowTextPath(sample: FlowReviewSample): FlowTextPath {
  const localLinks = sample.frameLocals.flatMap(local => local.links);
  const allLinks = [...sample.walkLinks, ...localLinks];
  const lines: string[] = [];
  lines.push(sample.sourceLabel);
  lines.push(sample.walkNote);
  lines.push(`走查序列 ${sample.rows.length} 行:`);
  for (const row of sample.rows) {
    if (row.type === 'frame') {
      const boundary = row.frame.truncationBoundary ? ' [截断边界]' : '';
      lines.push(`  [${row.frame.role}] ${row.frame.label} (深度 ${row.frame.depth})${boundary}`);
    } else {
      lines.push(linkLine(row.link));
    }
  }
  if (sample.frameLocals.length > 0) {
    lines.push(`帧内本地调用 ${sample.frameLocals.length} 帧:`);
    for (const local of sample.frameLocals) {
      lines.push(`  [${local.role}] ${local.frameLabel}`);
      for (const link of local.links) {
        lines.push(linkLine(link));
      }
    }
  }
  const candidates = allLinks
    .map(link => link.branchCandidate)
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  lines.push(sample.branchNote);
  for (const candidate of candidates) {
    lines.push(`  - ${candidate.text}(${candidate.note})`);
  }
  lines.push(sample.unresolvedNote);
  const unresolvedLinks = allLinks.filter(link => link.unresolvedCode !== null);
  for (const link of unresolvedLinks) {
    lines.push(`  - ${link.id} ${link.unresolvedCode}: ${link.unresolvedDetail ?? ''}`);
  }
  lines.push(`证据索引 ${sample.evidenceIndex.length} 条:`);
  for (const evidence of sample.evidenceIndex) {
    const callsite = evidence.callSite ? ` · 调用点 ${evidence.callSite}` : '';
    lines.push(`  - ${evidence.id} ${evidence.evidenceType}${callsite} · ${evidence.evidenceDetail}`);
  }
  if (sample.truncated) {
    lines.push('走查深度截断(如实;截断边界帧可继续展开)');
  }
  const text = lines.join('\n');
  const html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body { font-family: monospace, sans-serif; margin: 16px; color: #1e1e1e; background: #fafafa; }',
    'pre { white-space: pre-wrap; font-size: 12px; line-height: 1.6; }',
    '</style></head><body>',
    `<pre>${esc(text)}</pre>`,
    '</body></html>'
  ].join('\n');
  return { text, html };
}
