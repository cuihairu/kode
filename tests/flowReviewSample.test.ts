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

const DEF_REGISTRY: Record<
  string,
  { defFile: string; line: number; declaredArgs?: string[]; declaredReturnType?: string | null }
> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': {
    defFile: '/ws/entity_defs/Avatar.def',
    line: 10,
    declaredArgs: ['UINT32']
  },
  'Avatar\u001fCellMethods\u001fenterGame': {
    defFile: '/ws/entity_defs/Avatar.def',
    line: 21,
    declaredArgs: ['UINT32'],
    declaredReturnType: 'None'
  },
  'Avatar\u001fClientMethods\u001fonEnterGame': {
    defFile: '/ws/entity_defs/Avatar.def',
    line: 34,
    declaredArgs: ['UINT32']
  }
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

describe('FLOW-016 调用点与声明分别跳转', () => {
  it('每条链接带声明位置:行基随节点形态归一(python 0基+1 / def 文件 1基原样)', () => {
    const sample = buildFlowReviewSample(input());
    // 发送步声明=def 文件(1 基原样,回填 rpc 声明节点)
    const send = sample.walkLinks.find(link => link.kind === 'send')!;
    expect(send.declaration).toEqual({
      file: '/ws/entity_defs/Avatar.def',
      displayLine: 10,
      line0: 9
    });
    // 远端执行段声明=python 实现(0 基 +1;impl line 1 → 人读 2)
    const exec = sample.walkLinks.find(link => link.kind === 'remote-exec')!;
    expect(exec.declaration).toEqual({ file: BASE_AVATAR, displayLine: 2, line0: 1 });
    // 广播无声明点(不虚构);getattr 未解析无声明;def 缺口发送无声明
    const broadcast = sample.walkLinks.find(link => link.kind === 'broadcast-send')!;
    expect(broadcast.declaration).toBeNull();
    const locals = sample.frameLocals.find(group => group.frameLabel.includes('playSkill'))!;
    const unresolved = locals.links.find(link => link.kind === 'unresolved')!;
    expect(unresolved.declaration).toBeNull();
    const unconnected = sample.walkLinks[sample.walkLinks.length - 1];
    expect(unconnected.declaration).toBeNull();
    // 本地调用声明=helper def 行(python 0 基 6 → 人读 7)
    const enterGameLocals = sample.frameLocals.find(group =>
      group.frameLabel.includes('enterGame')
    )!;
    const localCall = enterGameLocals.links.find(link => link.kind === 'local-call')!;
    expect(localCall.declaration).toEqual({ file: CELL_AVATAR, displayLine: 7, line0: 6 });
  });

  it('调用点与声明在 html 中分别标注且各带跳转面(0 基打开行)', () => {
    const sample = buildFlowReviewSample(input());
    const send = sample.walkLinks.find(link => link.kind === 'send')!;
    expect(send.callSite).toBe(`${CLIENT_AVATAR}:3`);
    // 调用点跳转面=0 基行(显示 3 → 打开行 2)
    expect(sample.html).toContain(`data-flow-jump="${CLIENT_AVATAR}:2"`);
    // 声明跳转面:def 文件 1 基显示 → 打开行 9;python 实现 → 打开行 1
    expect(sample.html).toContain('声明 /ws/entity_defs/Avatar.def:10');
    expect(sample.html).toContain('data-flow-jump="/ws/entity_defs/Avatar.def:9"');
    expect(sample.html).toContain(`声明 ${BASE_AVATAR}:2`);
    expect(sample.html).toContain(`data-flow-jump="${BASE_AVATAR}:1"`);
    // 本地调用树内:调用点与声明分别标注
    expect(sample.html).toContain(`声明 ${CELL_AVATAR}:7`);
    expect(sample.html).toContain(`data-flow-jump="${CELL_AVATAR}:6"`);
  });

  it('帧内本地调用树默认折叠:主路径默认可见,展开才见 helper 树', () => {
    const sample = buildFlowReviewSample(input());
    // 泳道主路径表不在 details 内(默认可见);帧内组用 <details> 折叠(零脚本)
    expect(sample.html.indexOf('<table class="swimlanes"')).toBeLessThan(
      sample.html.indexOf('<details class="locals-group"')
    );
    expect(sample.html).not.toContain('<details class="locals-group" open');
    expect(sample.html).toContain('<summary>帧内 ·');
    expect(sample.html).toContain('本地调用树 2 条');
  });
});

describe('FLOW-017 跨进程消息呈现', () => {
  it('边显方法/方向/Arg 类型与来源:def 契约随边,未声明如实不猜', () => {
    const sample = buildFlowReviewSample(input());
    // client→base 发送:方向 + def 参数(来源标注 def)
    const send = sample.walkLinks.find(
      link => link.kind === 'send' && link.direction.from === 'client'
    )!;
    expect(send.direction).toEqual({ from: 'client', to: 'base', kind: 'cross-process' });
    expect(send.argNote).toBe('参数(def):UINT32');
    // 远端执行段与发送边同契约(参数+返回)
    const exec = sample.walkLinks.find(
      link => link.kind === 'remote-exec' && link.toLabel.includes('enterGame')
    )!;
    expect(exec.argNote).toBe('参数(def):UINT32;返回(def):None');
    // def 缺口发送:未声明如实
    const unconnected = sample.walkLinks[sample.walkLinks.length - 1];
    expect(unconnected.argNote).toBe('参数:def 未声明(不猜)');
    // 广播不进 def 契约面(FLOW-008 机械保证):不带参数注记
    const broadcast = sample.walkLinks.find(link => link.kind === 'broadcast-send')!;
    expect(broadcast.argNote).toBeNull();
  });

  it('FLOW-008 机械保证:声明且已实现的广播也不产生远端执行帧', () => {
    // showScene 声明+实现齐备:广播仍只记发送步(受众动态集合,不虚构接收帧)
    const withDeclared = buildFlowReviewSample(input({
      resolveDefMethod: (entity, section, methodName) =>
        methodName === 'showScene'
          ? { defFile: '/ws/entity_defs/Avatar.def', line: 34, declaredArgs: ['UINT64'] }
          : DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
      resolveImplementation: (entity, section, methodName) =>
        methodName === 'showScene'
          ? { filePath: CLIENT_AVATAR, line: 4, signature: 'def showScene(self, sceneId)', className: 'Avatar', inheritedFrom: null }
          : IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null
    }));
    // 有过滤器:轨迹与基线一致(广播不追加 send+remote-exec 两段)
    const kinds = withDeclared.walkLinks.map(link => link.kind);
    expect(kinds).toEqual([
      'send',
      'remote-exec',
      'send',
      'remote-exec',
      'broadcast-send',
      'send',
      'remote-exec',
      'send'
    ]);
    const broadcast = withDeclared.walkLinks.find(link => link.kind === 'broadcast-send')!;
    expect(broadcast.connectedToExec).toBe(false);
    expect(broadcast.argNote).toBeNull();
    // 广播发起帧不带 def 参数注记(契约面不进广播)
    expect(withDeclared.html).not.toContain('参数(def):UINT64');
  });

  it('服务端→client 消息标回调;client→服务端不标(方向事实,非执行顺序)', () => {
    const sample = buildFlowReviewSample(input());
    // 回调:cell→client 广播/onEnterGame、base→client onChooseRoleFailed
    const callbackTargets = sample.walkLinks.filter(
      link =>
        link.direction.kind === 'cross-process' &&
        link.direction.to === 'client' &&
        link.direction.from !== 'client'
    );
    expect(callbackTargets.map(link => link.kind).sort()).toEqual([
      'broadcast-send',
      'send',
      'send'
    ]);
    // client→base/cell 方向不标回调(整图恰好 3 处)
    expect(sample.html.match(/回调/g)).toHaveLength(3);
    expect(sample.html).toContain('方向 client→base');
    expect(sample.html).toContain('方向 cell→client');
    // 本地帧内方向不显示(downstream-call 非跨进程)
    const localCall = sample.frameLocals
      .flatMap(group => group.links)
      .find(link => link.kind === 'local-call')!;
    expect(localCall.direction.kind).toBe('downstream-call');
    expect(localCall.argNote).toBeNull();
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

describe('FLOW-019 大图按需展开(截断边界帧)', () => {
  it('帧携带函数名与走查深度:入口帧 depth 0,未截断时无边界帧无续开入口', () => {
    const sample = buildFlowReviewSample(input());
    expect(sample.truncated).toBe(false);
    const allFrames = sample.swimlanes.flatMap(lane => lane.frames);
    // 入口帧:函数名/深度可读(继续展开的定位面)
    const entry = allFrames.find(frame => frame.label.includes('chooseRole'))!;
    expect(entry.functionName).toBe('chooseRole');
    expect(entry.depth).toBe(0);
    expect(entry.truncationBoundary).toBe(false);
    // 未截断:全部帧无边界标注,html 不给续开入口(诚实:没截断不假装)
    expect(allFrames.every(frame => frame.truncationBoundary === false)).toBe(true);
    expect(sample.html).not.toContain('继续展开');
    expect(sample.html).not.toContain('截断边界');
  });

  it('小深度界:边界帧带截断标注与续开入口(文件+函数名),html 可定位', () => {
    const sample = buildFlowReviewSample(input({ maxDepth: 1 }));
    expect(sample.truncated).toBe(true);
    const boundaries = sample.swimlanes.flatMap(lane => lane.frames).filter(f => f.truncationBoundary);
    expect(boundaries.length).toBeGreaterThan(0);
    for (const frame of boundaries) {
      expect(frame.depth).toBeGreaterThanOrEqual(1);
      expect(frame.file).not.toBeNull();
      expect(frame.functionName).not.toBeNull();
    }
    const first = boundaries[0];
    // 续开入口以 data-flow-open-file/fn 给出(面板点击续开新场景)
    expect(sample.html).toContain('截断边界');
    expect(sample.html).toContain('继续展开');
    expect(sample.html).toContain(`data-flow-open-file="${first.file}"`);
    expect(sample.html).toContain(`data-flow-open-fn="${first.functionName}"`);
  });
});
