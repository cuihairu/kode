/**
 * KFLOW replay instance-level flow HTML presentation (the pure-string half of
 * FLOW-028): renders traceReplayModel into a zero-script static page — real component
 * instance lanes in columns, with each lane's local stack segments (callback segments
 * / entry chains, frames indented by segment-root depth) + message flows
 * (causal/candidate badges, broadcast markers, seq anchors) + missing markers.
 *
 * Security discipline (same family as configVisualizerPanelHtml):
 * - Zero script: the CSP `default-src 'none'` only allows inline style; all data is
 *   escaped server-side (at render time), so there is no front-end HTML-assembly face;
 * - Text always goes through escapeHtml (attribute values included, title tooltips
 *   likewise);
 * - Line numbers keep the capture semantics (1-based) and are shown as-is, with no
 *   conversion or guessing.
 *
 * Honest boundaries come straight from the model: an empty instance identity =
 * "source not observed"; candidate flows carry a reason (the FLOW-026 provenance);
 * missing markers are their own face. Pure functions, zero vscode dependency.
 */

import { describeTraceReplayModel, type TraceReplayModel, type ReplayLane, type ReplayFlow } from './traceReplayModel';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// RUST-150: the replay page is zero-script (the enableScripts=false hard rule) and
// cannot do scroll loading or virtual lists, so a render-face cap + an honest
// truncation note is the correct shape under that constraint — the model (the data
// face) does not truncate; it only guards against rendering a ten-thousand-scale DOM
// in one shot (the capture budget is 20000 events; frames/flows can reach that scale).
export const TRACE_REPLAY_MAX_LANES = 24;
export const TRACE_REPLAY_MAX_LANE_FRAMES = 2000;
export const TRACE_REPLAY_MAX_LANE_FLOWS = 2000;
export const TRACE_REPLAY_MAX_LANE_MARKERS = 500;

function truncatedNote(shown: number, total: number, noun: string): string {
  return (
    `<div class="truncated-note">已截断:${noun}仅渲染前 ${shown} 项(共 ${total});` +
    `数据完整,仅渲染面截断</div>`
  );
}

function flowBadge(flow: ReplayFlow): string {
  if (flow.kind === 'causal') {
    const broadcast = flow.broadcast ? ' <span class="badge broadcast">broadcast</span>' : '';
    return `<span class="badge causal">causal</span>${broadcast}`;
  }
  return '<span class="badge candidate">candidate</span>';
}

function flowLine(flow: ReplayFlow, index: number): string {
  const anchors: string[] = [];
  if (flow.sendSeq !== null) anchors.push(`send#${flow.sendSeq}`);
  if (flow.receiveSeq !== null) anchors.push(`receive#${flow.receiveSeq}`);
  const id = flow.correlationId !== null ? ` <code>${escapeHtml(flow.correlationId)}</code>` : '';
  const reason =
    flow.reason !== null ? `<div class="reason" title="${escapeHtml(flow.reason)}">${escapeHtml(flow.reason)}</div>` : '';
  return (
    `<div class="flow ${flow.kind}${flow.broadcast ? ' broadcast' : ''}">` +
    `${flowBadge(flow)} <span class="method">${escapeHtml(flow.methodName)}</span>${id} ` +
    `<span class="anchors">[${escapeHtml(anchors.join(' → '))}]</span>` +
    `<span class="order">#${index + 1}</span>${reason}</div>`
  );
}

function laneHtml(lane: ReplayLane): string {
  const header =
    `<div class="lane-head"><span class="lane-role">${escapeHtml(lane.role)}</span>` +
    (lane.name !== null ? ` <span class="lane-name">${escapeHtml(lane.name)}</span>` : '') +
    ` <span class="lane-pid">${escapeHtml(lane.processId)}</span></div>`;
  const instances =
    lane.entityInstances.length > 0
      ? `<div class="instances">${lane.entityInstances
          .map(instance => `<span class="instance">${escapeHtml(instance)}</span>`)
          .join('')}</div>`
      : '<div class="instances none">实例身份:来源未观察(事件无 entityId)</div>';

  // RUST-150: the frame budget is consumed across segments (taking prefixes in order);
  // once the budget is exhausted the remaining segments are honestly empty + a
  // lane-level truncation footnote; frames are never dropped silently.
  let framesRemaining = TRACE_REPLAY_MAX_LANE_FRAMES;
  let framesTotal = 0;
  const segments =
    lane.segments.length > 0
      ? lane.segments
          .map(segment => {
            framesTotal += segment.frames.length;
            const label =
              segment.kind === 'callback'
                ? `回调段(receive#${segment.receiveSeq ?? '?'}`
                : `入口链(root#${segment.rootCallSeq ?? '?'}`;
            const note = segment.note !== null ? `<div class="seg-note">${escapeHtml(segment.note)}</div>` : '';
            const take = Math.min(segment.frames.length, Math.max(framesRemaining, 0));
            framesRemaining -= take;
            const frames = segment.frames
              .slice(0, take)
              .map(
                frame =>
                  `<div class="frame" style="margin-left:${frame.depth * 18}px">` +
                  `<span class="fn">${escapeHtml(frame.function)}</span>` +
                  `<span class="loc">${escapeHtml(frame.file)}:${frame.line}</span>` +
                  `<span class="seq">#${frame.seq}</span></div>`
              )
              .join('');
            return `<div class="segment ${segment.kind}"><div class="seg-head">${label})</div>${frames}${note}</div>`;
          })
          .join('')
      : '<div class="seg-empty">无本地栈段</div>';
  const segmentsHtml =
    lane.segments.length > 0 && framesTotal > TRACE_REPLAY_MAX_LANE_FRAMES
      ? segments + truncatedNote(TRACE_REPLAY_MAX_LANE_FRAMES, framesTotal, '本地栈帧')
      : segments;

  const flowsShown = lane.flows.slice(0, TRACE_REPLAY_MAX_LANE_FLOWS);
  const flows =
    flowsShown.length > 0
      ? flowsShown.map(flowLine).join('') +
        (lane.flows.length > flowsShown.length
          ? truncatedNote(flowsShown.length, lane.flows.length, '消息流')
          : '')
      : '<div class="flow-empty">无消息流</div>';
  const markersShown = lane.missingMarkers.slice(0, TRACE_REPLAY_MAX_LANE_MARKERS);
  const markers =
    markersShown.length > 0
      ? markersShown
          .map(
            marker =>
              `<div class="missing" title="${escapeHtml(marker.detail)}">` +
              `<span class="badge missing">缺失</span> ${escapeHtml(marker.kind)} ` +
              `<span class="method">${escapeHtml(marker.methodName)}</span> <span class="seq">#${marker.seq}</span></div>`
          )
          .join('') +
        (lane.missingMarkers.length > markersShown.length
          ? truncatedNote(markersShown.length, lane.missingMarkers.length, '缺失标记')
          : '')
      : '';

  return `<div class="lane">${header}${instances}${segmentsHtml}${flows}${markers}</div>`;
}

const STYLE = `
body{font-family:monospace,monospace;margin:12px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}
h1{font-size:14px} .summary{color:var(--vscode-descriptionForeground);margin:4px 0 12px}
.notes{margin:0 0 12px;padding:8px;border:1px solid var(--vscode-panel-border);font-size:12px}
.lanes{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.lane{border:1px solid var(--vscode-panel-border);padding:8px;min-width:280px;flex:1}
.lane-head{font-weight:bold} .lane-role{color:var(--vscode-symbolicFunction-color,inherit)}
.lane-pid{color:var(--vscode-descriptionForeground);font-size:11px}
.instances{margin:4px 0}.instance{border:1px solid var(--vscode-panel-border);padding:1px 4px;margin-right:4px;font-size:11px}
.instances.none{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic}
.segment{margin:6px 0;border-left:2px solid var(--vscode-panel-border);padding-left:6px}
.segment.callback{border-left-color:var(--vscode-charts-blue,#3794ff)}
.segment.entry-chain{border-left-color:var(--vscode-charts-purple,#b180d7)}
.seg-head{font-size:11px;color:var(--vscode-descriptionForeground)}
.frame{font-size:12px;white-space:nowrap} .fn{font-weight:bold} .loc{color:var(--vscode-descriptionForeground);margin-left:6px}
.seq{color:var(--vscode-descriptionForeground);margin-left:6px;font-size:10px}
.seg-note{font-size:11px;color:var(--vscode-editorWarning-foreground,#cca700);margin-top:2px}
.seg-empty,.flow-empty{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic}
.truncated-note{margin:4px 0;font-size:11px;color:var(--vscode-editorWarning-foreground,#cca700);border:1px dashed var(--vscode-editorWarning-foreground,#cca700);padding:2px 4px}
.flow{margin:4px 0;font-size:12px} .flow .method{font-weight:bold} .flow .anchors{color:var(--vscode-descriptionForeground)}
.flow .order{color:var(--vscode-descriptionForeground);margin-left:6px;font-size:10px}
.flow.candidate{opacity:.9} .reason{font-size:11px;color:var(--vscode-editorWarning-foreground,#cca700)}
.badge{display:inline-block;padding:0 4px;font-size:10px;border:1px solid var(--vscode-panel-border)}
.badge.causal{color:var(--vscode-charts-green,#89d185)} .badge.candidate{color:var(--vscode-charts-orange,#d7ba7d)}
.badge.broadcast{color:var(--vscode-charts-red,#f48771)} .badge.missing{color:var(--vscode-errorForeground,#f14c4c)}
.missing{margin:4px 0;font-size:12px;border:1px dashed var(--vscode-errorForeground,#f14c4c);padding:2px 4px}
code{color:var(--vscode-charts-blue,#3794ff)}
`;

export interface TraceReplayHtmlOptions {
  /** Page title (given by the panel) */
  title: string;
}

/** Render the replay page (pure string; the caller puts it into the webview html itself). */
export function renderTraceReplayHtml(model: TraceReplayModel, options: TraceReplayHtmlOptions): string {
  const title = escapeHtml(options.title);
  const summary = escapeHtml(describeTraceReplayModel(model));
  const notes = [
    `来源:${escapeHtml(model.collectorKind)};${escapeHtml(model.sampleFaceNote)}`,
    model.completenessNote !== model.sampleFaceNote ? escapeHtml(model.completenessNote) : null,
    model.lanes.length > TRACE_REPLAY_MAX_LANES
      ? `泳道已截断:仅渲染前 ${TRACE_REPLAY_MAX_LANES} 条(共 ${model.lanes.length})`
      : null
  ]
    .filter(note => note !== null)
    .map(note => `<div>${note}</div>`)
    .join('');
  const lanesHtml = model.lanes
    .slice(0, TRACE_REPLAY_MAX_LANES)
    .map(laneHtml)
    .join('');
  return `<!DOCTYPE html>
<html>
<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${STYLE}</style></head>
<body>
<h1>${title}</h1>
<div class="summary">${summary}</div>
<div class="notes">${notes}</div>
<div class="lanes">${lanesHtml}</div>
</body></html>`;
}
