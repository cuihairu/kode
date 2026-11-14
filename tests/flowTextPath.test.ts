import { describe, expect, it } from 'vitest';
import { buildFlowTextPath } from '../src/backend/flowTextPath';
import { buildFlowReviewSample, type FlowReviewSampleInput } from '../src/backend/flowReviewSample';

// FLOW-020(旧 KFLOW-UI-07)文本路径钉:图和文本消费同一模型(本核只读
// FlowReviewSample,不重新解析),渲染失败路径/未解析原因保留,可重试。

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';

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

const FILES = new Map<string, string>([
  [CLIENT_AVATAR, CLIENT_TEXT],
  [BASE_AVATAR, BASE_TEXT],
  [CELL_AVATAR, CELL_TEXT]
]);

const DEF_REGISTRY: Record<string, { defFile: string; line: number }> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': { defFile: '/ws/entity_defs/Avatar.def', line: 10 },
  'Avatar\u001fCellMethods\u001fenterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonEnterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 34 }
  // onChooseRoleFailed 缺席:未连接发送面(def 缺口如实)
};

const IMPL_REGISTRY: Record<string, { filePath: string; line: number; signature: string; className: string }> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': { filePath: BASE_AVATAR, line: 1, signature: 'def chooseRole(self, roleId)', className: 'Avatar' },
  'Avatar\u001fCellMethods\u001fenterGame': { filePath: CELL_AVATAR, line: 1, signature: 'def enterGame(self, roleId)', className: 'Avatar' },
  'Avatar\u001fClientMethods\u001fonEnterGame': { filePath: CLIENT_AVATAR, line: 4, signature: 'def onEnterGame(self)', className: 'Avatar' }
};

const input = (overrides: Partial<FlowReviewSampleInput> = {}): FlowReviewSampleInput => ({
  rootKey: '/ws',
  entry: { filePath: CLIENT_AVATAR, functionName: 'chooseRole' },
  files: FILES,
  resolveDefMethod: (entity, section, methodName) =>
    DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  resolveImplementation: (entity, section, methodName) =>
    IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  ...overrides
});

describe('FLOW-020 文本路径消费同一模型', () => {
  it('与 HTML 面同一字段面:来源/走查注记/全部链接/证据编号逐条在文', () => {
    const sample = buildFlowReviewSample(input());
    const { text } = buildFlowTextPath(sample);
    // 同一样本的模型面原样入文(不重新解析,不新造证据)
    expect(text).toContain(sample.sourceLabel);
    expect(text).toContain(sample.walkNote);
    for (const link of sample.walkLinks) {
      expect(text).toContain(link.id);
    }
    for (const evidence of sample.evidenceIndex) {
      expect(text).toContain(evidence.id);
    }
    // 证据索引段以计数头呈现(全量可回查,不是零散引用)
    expect(text).toContain(`证据索引 ${sample.evidenceIndex.length} 条:`);
    // 帧行携带角色与深度(HTML 面同字段)
    expect(text).toMatch(/\[client\] 候选帧 Avatar\.chooseRole \(深度 0\)/);
    expect(text).not.toMatch(/栈帧|调用栈|堆栈/);
  });

  it('未连接与未解析原因保留:def 缺口链接带「未连接」,getattr 边带未解析码', () => {
    const sample = buildFlowReviewSample(input());
    const { text } = buildFlowTextPath(sample);
    const unconnected = sample.walkLinks.filter(link => !link.connectedToExec);
    expect(unconnected.length).toBeGreaterThan(0);
    for (const link of unconnected) {
      expect(text).toContain('未连接(def/实现缺口或广播,如实)');
    }
    // 未解析边住 frameLocals(帧内补充面,与 HTML 面同分组)——全量入文
    const locals = sample.frameLocals.flatMap(local => local.links);
    const unresolved = locals.filter(link => link.unresolvedCode !== null);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(text).toContain('未解析 dynamic-getattr');
    expect(text).toContain('不可静态证明');
  });

  it('分支候选与截断注记如实:候选非固定顺序,truncated 显式标出', () => {
    const sample = buildFlowReviewSample(input());
    const { text } = buildFlowTextPath(sample);
    expect(text).toContain(sample.branchNote);
    expect(text).toContain('self.ready');
    expect(text).not.toContain('走查深度截断');
    const bounded = buildFlowReviewSample(input({ maxDepth: 1 }));
    const boundedText = buildFlowTextPath(bounded);
    expect(bounded.truncated).toBe(true);
    expect(boundedText.text).toContain('走查深度截断');
    expect(boundedText.text).toContain('[截断边界]');
  });

  it('html 面是 <pre> 自包含零脚本文档(标签不出格)', () => {
    const sample = buildFlowReviewSample(input());
    const { html } = buildFlowTextPath(sample);
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<script');
    expect(html).toContain('走查序列');
    // 正文是转义后的纯文本:除文档骨架外无裸标签(转义生效的结构证据)
    const body = html.slice(html.indexOf('<pre>'));
    expect(body).not.toMatch(/<(?!\/?pre|\/body|\/html)/);
  });
});
