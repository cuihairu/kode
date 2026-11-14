import { describe, expect, it } from 'vitest';
import { buildFlowNodeInspect } from '../src/backend/flowNodeInspect';

// FLOW-018(旧 KFLOW-UI-05)节点反查纯核钉:上游/下游/未解析三面,
// 未知与歧义可查看,身份精确匹配不猜。

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';
const MOB_BASE = '/ws/scripts/base/Mob.py';

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
  "        getattr(self, 'skillName')()",
  '',
  '    def restartRound(self):',
  '        self.enterGame(1)',
  '        self.playSkill()'
].join('\n');

// 同名异实体:Mob 的 base 段也发 self.cell.enterGame(另一实体的同名 cell
// 方法)——跨进程反查的歧义面(声明节点无实体归属,两个发送者并列)
const MOB_TEXT = [
  'class Mob:',
  '    def summon(self, roleId):',
  '        self.cell.enterGame(roleId)'
].join('\n');

const FILES = new Map<string, string>([
  [CLIENT_AVATAR, CLIENT_TEXT],
  [BASE_AVATAR, BASE_TEXT],
  [CELL_AVATAR, CELL_TEXT],
  [MOB_BASE, MOB_TEXT]
]);

const entityForFile = (filePath: string): string | null =>
  filePath.includes('Mob') ? 'Mob' : filePath.endsWith('.py') ? 'Avatar' : null;

const input = (overrides: Parameters<typeof buildFlowNodeInspect>[0] = {} as never) => ({
  rootKey: '/ws',
  target: { filePath: CELL_AVATAR, functionName: 'enterGame' },
  files: FILES,
  entityForFile,
  canGoBack: false,
  ...overrides
});

describe('FLOW-018 下游反查', () => {
  it('本地调用与跨进程发送两态:pending-def 不给打开图,本地可打开', () => {
    const result = buildFlowNodeInspect(input());
    const local = result.downstream.find(item => item.functionName === 'playSkill')!;
    expect(local.match).toBe('local');
    expect(local.file).toBe(CELL_AVATAR);
    expect(local.callSiteLine0).toBe(4);
    expect(local.openable).toBe(true);
    expect(local.note).toBeNull();
    const send = result.downstream.find(item => item.functionName === 'onEnterGame')!;
    expect(send.match).toBe('cross-process');
    expect(send.file).toBeNull();
    expect(send.openable).toBe(false);
    expect(send.note).toContain('def 契约接线');
  });

  it('未解析边单列未解析面(码+细节+调用点),不混入下游面', () => {
    const result = buildFlowNodeInspect(input({ target: { filePath: CELL_AVATAR, functionName: 'playSkill' } }));
    expect(result.downstream).toEqual([]);
    // getattr 调用产两态:内建面(native-function)+动态分发面(dynamic-getattr)
    expect(result.unresolved.map(entry => entry.code).sort()).toEqual([
      'dynamic-getattr',
      'native-function'
    ]);
    const dynamic = result.unresolved.find(entry => entry.code === 'dynamic-getattr')!;
    expect(dynamic.detail).toContain('不可静态证明');
    expect(dynamic.callSiteLine0).toBe(7);
  });
});

describe('FLOW-018 上游反查', () => {
  it('本地调用者按节点身份精确匹配(文件#函数)', () => {
    const result = buildFlowNodeInspect(input({ target: { filePath: CELL_AVATAR, functionName: 'playSkill' } }));
    // 两个同文件调用者:enterGame + restartRound;精确身份不多收其他边
    expect(result.upstream).toHaveLength(2);
    expect(result.upstream.map(item => item.functionName).sort()).toEqual([
      'enterGame',
      'restartRound'
    ]);
    for (const caller of result.upstream) {
      expect(caller.file).toBe(CELL_AVATAR);
      expect(caller.match).toBe('local');
      expect(caller.note).toBeNull();
    }
    // 目标 enterGame 的本地上游恰一条=restartRound@10(重启轮调 enterGame+playSkill)
    const forEnterGame = buildFlowNodeInspect(input());
    const locals = forEnterGame.upstream.filter(item => item.match === 'local');
    expect(locals).toHaveLength(1);
    expect(locals[0].functionName).toBe('restartRound');
    expect(locals[0].callSiteLine0).toBe(10);
  });

  it('跨进程发送者按角色+方法名匹配,同名异实体并列歧义候选(实体待证)', () => {
    const result = buildFlowNodeInspect(input());
    const cross = result.upstream.filter(item => item.match === 'cross-process');
    expect(cross.map(item => item.file).sort()).toEqual([BASE_AVATAR, MOB_BASE]);
    // 两个发送者调用函数不同(Avatar.chooseRole / Mob.summon),目标同名并列
    expect(cross.map(item => item.functionName).sort()).toEqual(['chooseRole', 'summon']);
    for (const item of cross) {
      expect(item.note).toContain('同名方法不判别实体');
    }
    // 角色面过滤:client 段的 onEnterGame 不混进 cell 方法的上游
    expect(result.upstream.every(item => item.functionName !== 'onEnterGame')).toBe(true);
  });

  it('无静态可证调用者如实为空(入口函数)', () => {
    const result = buildFlowNodeInspect(input({ target: { filePath: CLIENT_AVATAR, functionName: 'chooseRole' } }));
    expect(result.upstream).toEqual([]);
  });

  it('跨进程候选全来自其他文件(目标文件只出下游面+本地上游)', () => {
    const result = buildFlowNodeInspect(input());
    const cross = result.upstream.filter(item => item.match === 'cross-process');
    expect(cross.every(item => item.file !== CELL_AVATAR)).toBe(true);
  });
});

describe('FLOW-018 反查视图 HTML', () => {
  it('三面分区+跳转面+返回面齐备,零栈词汇', () => {
    const result = buildFlowNodeInspect(input({ canGoBack: true }));
    expect(result.html).toContain('反查:enterGame');
    expect(result.html).toContain('上游');
    expect(result.html).toContain('下游');
    expect(result.html).toContain('未解析');
    expect(result.html).toContain('静态可能路径');
    expect(result.html).not.toMatch(/栈帧|调用栈|堆栈/);
    // 打开图链接只给可渲染目标:上游 chooseRole+restartRound+summon + 下游
    // playSkill,恰四处;跨进程声明节点(pending-def)不给链接
    expect(result.html).toContain('data-flow-open-file');
    const openTargets = [...result.html.matchAll(/data-flow-open-fn="([^"]+)"/g)].map(m => m[1]).sort();
    expect(openTargets).toEqual(['chooseRole', 'playSkill', 'restartRound', 'summon']);
    // 跳转面 0 基打开行
    expect(result.html).toContain(`data-flow-jump="${CELL_AVATAR}:4"`);
    // 返回面按 canGoBack 出现
    expect(result.html).toContain('data-flow-back');
    const noBack = buildFlowNodeInspect(input({ canGoBack: false }));
    expect(noBack.html).not.toContain('data-flow-back');
  });

  it('空面如实:无调用者标「无静态可证调用者」不虚构', () => {
    const result = buildFlowNodeInspect(input({ target: { filePath: CLIENT_AVATAR, functionName: 'chooseRole' } }));
    expect(result.html).toContain('无静态可证调用者');
    expect(result.html).toContain('(实体 Avatar)');
  });
});

describe('FLOW-018 诚实缺口', () => {
  it('目标文件不可读/目标函数不在解析面:抛错不虚构', () => {
    expect(() =>
      buildFlowNodeInspect(input({ target: { filePath: '/ws/missing.py', functionName: 'x' } }))
    ).toThrow(/not readable/);
    expect(() =>
      buildFlowNodeInspect(input({ target: { filePath: CELL_AVATAR, functionName: 'ghost' } }))
    ).toThrow(/not found/);
  });
});
