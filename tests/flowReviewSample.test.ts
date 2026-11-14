import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildFlowReviewSample,
  type FlowReviewSampleInput
} from '../src/backend/flowReviewSample';

// FLOW-014(旧 KFLOW-UI-01)评审样图钉。
// 验收:以真实调用夹具画泳道、消息和本地函数帧,标出分支/异步/未知;
// 样图中每条边可追溯证据。词汇/展示红线:docs/design/kflow-three-graph-contract.md §2 R1/R3。
//
// golden 工件(docs/review/2026-11-14-kflow-014-review-sample.html)重生成:
//   FLOW_REVIEW_UPDATE=1 npx vitest run tests/flowReviewSample.test.ts

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';

// 真实调用夹具:选角入场场景(Client→Base→Cell→Client 回调)+ 广播 +
// else 分支未连接发送 + 动态 getattr 未知边——KBEngine 真实 API 形态。
const CLIENT_TEXT = [
  'class Avatar:',
  '    def chooseRole(self, roleId):',
  '        self.base.chooseRole(roleId)',
  '',
  '    def onEnterGame(self, roleId):',
  '        pass'
].join('\n');

const BASE_TEXT = [
  'class Avatar:',
  '    def chooseRole(self, roleId):',
  '        if self.ready:',
  '            self.cell.enterGame(roleId)',
  '        else:',
  '            self.client.onChooseRoleFailed(roleId)'
].join('\n');

const CELL_TEXT = [
  'class Avatar:',
  '    def enterGame(self, roleId):',
  "        self.allClients.showScene('scene_1')",
  '        self.client.onEnterGame(roleId)',
  '        self.playSkill()',
  '',
  '    def playSkill(self):',
  "        getattr(self, 'skillName')()"
].join('\n');

const FILES: Record<string, string> = {
  [CLIENT_AVATAR]: CLIENT_TEXT,
  [BASE_AVATAR]: BASE_TEXT,
  [CELL_AVATAR]: CELL_TEXT
};

const DEF_REGISTRY: Record<string, { defFile: string; line: number }> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': { defFile: '/ws/entity_defs/Avatar.def', line: 10 },
  'Avatar\u001fCellMethods\u001fenterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonEnterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 34 }
  // onChooseRoleFailed 故意缺席:未连接发送面(def 缺口如实)
};

const IMPL_REGISTRY: Record<
  string,
  { filePath: string; line: number; signature: string; className: string }
> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': {
    filePath: BASE_AVATAR,
    line: 1,
    signature: 'def chooseRole(self, roleId)',
    className: 'Avatar'
  },
  'Avatar\u001fCellMethods\u001fenterGame': {
    filePath: CELL_AVATAR,
    line: 1,
    signature: 'def enterGame(self, roleId)',
    className: 'Avatar'
  },
  'Avatar\u001fClientMethods\u001fonEnterGame': {
    filePath: CLIENT_AVATAR,
    line: 4,
    signature: 'def onEnterGame(self, roleId)',
    className: 'Avatar'
  }
};

const input = (overrides: Partial<FlowReviewSampleInput> = {}): FlowReviewSampleInput => ({
  rootKey: '/ws',
  entry: { filePath: CLIENT_AVATAR, functionName: 'chooseRole' },
  files: new Map(Object.entries(FILES)),
  resolveDefMethod: (entity, section, methodName) =>
    DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  resolveImplementation: (entity, section, methodName) =>
    IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  ...overrides
});

const GOLDEN = path.join(__dirname, '..', 'docs', 'review', '2026-11-14-kflow-014-review-sample.html');
const UPDATE = process.env.FLOW_REVIEW_UPDATE === '1';

describe('FLOW-014 泳道与本地函数帧', () => {
  it('泳道按角色分列(client/base/cell),帧带候选帧标签与文件路径', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.swimlanes.map(lane => lane.role)).toEqual(['client', 'base', 'cell']);
    const client = sample.swimlanes[0];
    expect(client.frames.map(f => f.label)).toContain('候选帧 Avatar.chooseRole');
    const cell = sample.swimlanes[2];
    expect(cell.frames.map(f => f.label)).toContain('候选帧 Avatar.playSkill');
    // 每帧带文件路径(remote-exec 帧经 rpc 合成节点也有)
    for (const lane of sample.swimlanes) {
      for (const frame of lane.frames) {
        expect(frame.file).not.toBeNull();
      }
    }
    const enterGame = cell.frames.find(f => f.label.includes('enterGame'));
    expect(enterGame!.file).toBe(CELL_AVATAR);
    expect(enterGame!.kind).toBe('remote-exec');
    expect(sample.truncated).toBe(false);
  });

  it('R1 词汇:全部帧是候选帧/远端执行帧,模型与 html 无栈帧/调用栈/堆栈', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.html).not.toMatch(/栈帧|调用栈|堆栈/);
    for (const lane of sample.swimlanes) {
      for (const frame of lane.frames) {
        expect(['local-frame', 'remote-exec']).toContain(frame.kind);
        expect(frame.label.startsWith('候选帧')).toBe(true);
      }
    }
  });
});

describe('FLOW-014 跨进程消息呈现', () => {
  it('走查轨迹:发送与远端执行两段锁步,广播只记发送步,未连接发送如实', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.walkLinks.map(link => link.kind)).toEqual([
      'send',
      'remote-exec',
      'send',
      'remote-exec',
      'broadcast-send',
      'send',
      'remote-exec',
      'send'
    ]);
    // 两段锁步:remote-exec 与前一发送边配对
    const execLinks = sample.walkLinks.filter(link => link.kind === 'remote-exec');
    const sendIds = sample.walkLinks
      .filter(link => link.kind === 'send')
      .map(link => link.edgeId);
    for (const exec of execLinks) {
      expect(exec.pairedSendEdgeId).not.toBeNull();
      expect(sendIds).toContain(exec.pairedSendEdgeId!);
      expect(exec.evidenceType).toBe('declaration-contract');
    }
    // 广播:受众动态集合,不连接执行帧
    const broadcast = sample.walkLinks.find(link => link.kind === 'broadcast-send')!;
    expect(broadcast.connectedToExec).toBe(false);
    expect(broadcast.toLabel).toContain('广播声明');
    expect(broadcast.syncAsync).toBe('async-send');
    // 未连接发送:onChooseRoleFailed def 缺席 → 只记发送步
    const unconnected = sample.walkLinks[sample.walkLinks.length - 1];
    expect(unconnected.kind).toBe('send');
    expect(unconnected.connectedToExec).toBe(false);
    expect(unconnected.toLabel).toContain('onChooseRoleFailed');
    // 发起帧取边 fromNodeId 真实标签:DFS 回溯后不得指错帧(指到 playSkill)
    expect(unconnected.fromLabel).toContain('chooseRole');
    expect(unconnected.callSite).toBe(`${BASE_AVATAR}:6`);
    // 广播发起帧同样是 fromNodeId 解析(cell enterGame),不是游标帧
    expect(broadcast.fromLabel).toContain('enterGame');
  });

  it('异步与同步可辨识:async-send 与 sync 不混同', () => {
    const sample = buildFlowReviewSample(input());
    for (const link of sample.walkLinks.filter(l => l.kind === 'send' || l.kind === 'broadcast-send')) {
      expect(link.syncAsync).toBe('async-send');
    }
    for (const link of sample.walkLinks.filter(l => l.kind === 'remote-exec')) {
      expect(link.syncAsync).toBe('sync');
    }
    expect(sample.html).toContain('async-send');
  });
});

describe('FLOW-014 分支与未知标出', () => {
  it('分支为候选:enterGame 发送边带 if 条件候选标注', () => {
    const sample = buildFlowReviewSample(input());
    const link = sample.walkLinks.find(l => l.toLabel.includes('enterGame') && l.kind === 'send')!;
    expect(link.branchCandidate).not.toBeNull();
    expect(link.branchCandidate!.text).toContain('self.ready');
    expect(link.branchCandidate!.note).toContain('候选');
    expect(link.branchCandidate!.note).toContain('不是固定执行顺序');
  });

  it('未知边标原因码保留:动态 getattr 不静默消失', () => {
    const sample = buildFlowReviewSample(input());
    const locals = sample.frameLocals.find(group => group.frameLabel.includes('playSkill'));
    expect(locals).toBeDefined();
    const unresolved = locals!.links.find(
      link => link.kind === 'unresolved' && link.unresolvedCode === 'dynamic-getattr'
    );
    expect(unresolved).toBeDefined();
    expect(unresolved!.unresolvedCode).toBe('dynamic-getattr');
    expect(unresolved!.unresolvedDetail).toContain('不可静态证明');
    expect(unresolved!.callSite).toBe(`${CELL_AVATAR}:8`);
  });

  it('帧内本地调用成组:enterGame → playSkill 本地调用帧', () => {
    const sample = buildFlowReviewSample(input());
    const locals = sample.frameLocals.find(group => group.frameLabel.includes('enterGame'));
    expect(locals).toBeDefined();
    const localCall = locals!.links.find(link => link.kind === 'local-call');
    expect(localCall).toBeDefined();
    expect(localCall!.toLabel).toContain('playSkill');
    expect(localCall!.syncAsync).toBe('sync');
  });
});

describe('FLOW-014 证据可追溯', () => {
  it('每条边带 EV 编号且证据索引可回查', () => {
    const sample = buildFlowReviewSample(input());
    const allLinks = [
      ...sample.walkLinks,
      ...sample.frameLocals.flatMap(group => group.links)
    ];
    const evidenceIds = new Set(sample.evidenceIndex.map(evidence => evidence.id));
    expect(evidenceIds.size).toBe(sample.evidenceIndex.length);
    for (const link of allLinks) {
      expect(link.evidenceId).toMatch(/^EV-\d{2}$/);
      expect(evidenceIds.has(link.evidenceId)).toBe(true);
      expect(link.evidenceType.length).toBeGreaterThan(0);
      expect(link.evidenceDetail.length).toBeGreaterThan(0);
    }
    // 每条边在 html 中可按 EV 编号溯源到证据表
    for (const link of allLinks) {
      expect(sample.html).toContain(`[${link.evidenceId}]`);
    }
    for (const evidence of sample.evidenceIndex) {
      expect(sample.html).toContain(evidence.id);
    }
  });

  it('调用点行号人读 1 基:client 发送边指向 chooseRole 调用行', () => {
    const sample = buildFlowReviewSample(input());
    const send = sample.walkLinks.find(link => link.kind === 'send')!;
    expect(send.callSite).toBe(`${CLIENT_AVATAR}:3`);
    expect(send.evidenceType).toBe('syntax-anchor');
  });
});

describe('FLOW-014 R3 展示红线与 golden', () => {
  it('来源标签恒挂静态可能路径;步序声明为走查轨迹非执行顺序', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.sourceLabel).toBe('静态可能路径(G2)');
    expect(sample.walkNote).toContain('走查轨迹');
    expect(sample.walkNote).toContain('不是执行顺序');
    expect(sample.walkNote).toContain('不是时间轴');
    expect(sample.html).toContain('静态可能路径');
    expect(sample.html).toContain('走查轨迹');
  });

  it('静态角色不冒充运行实例:泳道头带静态角色标注', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.html).toContain('泳道:client(静态角色,非运行实例)');
    expect(sample.html).toContain('泳道:base(静态角色,非运行实例)');
    expect(sample.html).toContain('泳道:cell(静态角色,非运行实例)');
  });

  it('golden 字节锁:docs/review 评审工件与生成器同步', () => {
    const sample = buildFlowReviewSample(input());
    if (UPDATE) {
      writeFileSync(GOLDEN, sample.html, 'utf8');
    }
    const committed = readFileSync(GOLDEN, 'utf8');
    expect(sample.html).toBe(committed);
  });
});
