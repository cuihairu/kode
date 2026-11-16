import { describe, expect, it } from 'vitest';
import {
  renderTraceReplayHtml,
  TRACE_REPLAY_MAX_LANES,
  TRACE_REPLAY_MAX_LANE_FRAMES,
  TRACE_REPLAY_MAX_LANE_FLOWS,
  TRACE_REPLAY_MAX_LANE_MARKERS
} from '../src/backend/traceReplayHtml';
import type { TraceReplayModel, ReplayLane, ReplayStackSegment } from '../src/backend/traceReplayModel';

const frame = (seq: number) => ({ seq, file: 'a.py', line: seq + 1, function: `fn${seq}`, className: null, depth: 0 });
const flow = (seq: number) => ({
  kind: 'causal' as const,
  methodName: `m${seq}`,
  correlationId: null,
  sendSeq: seq,
  receiveSeq: null,
  fromProcessId: null,
  toProcessId: null,
  broadcast: false,
  reason: null
});
const marker = (seq: number) => ({
  kind: 'send-without-receive' as const,
  seq,
  methodName: `m${seq}`,
  detail: 'd'
});

const makeModel = (lanes: ReplayLane[]): TraceReplayModel => ({
  sessionId: 's',
  collectorKind: 'sys-monitoring',
  sampleFaceNote: 'note',
  lanes,
  flows: [],
  completenessNote: 'note'
});

const makeLane = (segments: ReplayStackSegment[], flowsCount = 0, markersCount = 0): ReplayLane => ({
  processId: 'p1',
  role: 'base',
  name: null,
  entityInstances: [],
  segments,
  flows: Array.from({ length: flowsCount }, (_, i) => flow(i)),
  missingMarkers: Array.from({ length: markersCount }, (_, i) => marker(i)),
  firstSeq: 1
});

const seg = (framesCount: number, kind: 'callback' | 'entry-chain' = 'entry-chain'): ReplayStackSegment => ({
  kind,
  receiveSeq: kind === 'callback' ? 1 : null,
  rootCallSeq: kind === 'entry-chain' ? 0 : null,
  frames: Array.from({ length: framesCount }, (_, i) => frame(i)),
  note: null
});

const countFrameDivs = (html: string): number => (html.match(/class="frame"/g) ?? []).length;

describe('traceReplayHtml 渲染上限(RUST-150:零脚本面板渲染面截断+如实提示)', () => {
  it('未超限小模型零截断提示', () => {
    const html = renderTraceReplayHtml(makeModel([makeLane([seg(10)], 3, 1)]), { title: 't' });
    expect(html).not.toContain('已截断');
    expect(countFrameDivs(html)).toBe(10);
  });

  it('单段帧超预算:只渲染前缀帧+泳道级截断尾注含计数', () => {
    const total = TRACE_REPLAY_MAX_LANE_FRAMES + 500;
    const html = renderTraceReplayHtml(makeModel([makeLane([seg(total)])]), { title: 't' });
    expect(countFrameDivs(html)).toBe(TRACE_REPLAY_MAX_LANE_FRAMES);
    expect(html).toContain('已截断:本地栈帧仅渲染前');
    expect(html).toContain(`(共 ${total})`);
  });

  it('帧预算跨 segment 消耗:前段尽取后段余量,总量钉在预算', () => {
    const half = TRACE_REPLAY_MAX_LANE_FRAMES / 2 + 300;
    const html = renderTraceReplayHtml(makeModel([makeLane([seg(half), seg(half)])]), { title: 't' });
    expect(countFrameDivs(html)).toBe(TRACE_REPLAY_MAX_LANE_FRAMES);
    expect(html).toContain('已截断:本地栈帧仅渲染前');
  });

  it('消息流/缺失标记各自预算截断+尾注', () => {
    const html = renderTraceReplayHtml(
      makeModel([
        makeLane(
          [seg(1)],
          TRACE_REPLAY_MAX_LANE_FLOWS + 100,
          TRACE_REPLAY_MAX_LANE_MARKERS + 50
        )
      ]),
      { title: 't' }
    );
    expect(html).toContain('已截断:消息流仅渲染前');
    expect(html).toContain('已截断:缺失标记仅渲染前');
    expect((html.match(/class="flow /g) ?? []).length).toBe(TRACE_REPLAY_MAX_LANE_FLOWS);
    expect((html.match(/class="missing"/g) ?? []).length).toBe(TRACE_REPLAY_MAX_LANE_MARKERS);
  });

  it('泳道数超上限:只渲染前缀泳道+全局 notes 截断行', () => {
    const total = TRACE_REPLAY_MAX_LANES + 6;
    const html = renderTraceReplayHtml(
      makeModel(Array.from({ length: total }, (_, i) => makeLane([], 0, 0))),
      { title: 't' }
    );
    expect(html).toContain(`泳道已截断:仅渲染前 ${TRACE_REPLAY_MAX_LANES} 条(共 ${total})`);
    expect((html.match(/class="lane"/g) ?? []).length).toBe(TRACE_REPLAY_MAX_LANES);
  });
});
