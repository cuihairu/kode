import { describe, expect, it } from 'vitest';
import {
  assembleFlowCallGraph,
  collectNeededRpcTriples,
  type FlowCallGraphSource
} from '../src/flowCallGraphData';

// FLOW-015(旧 KFLOW-UI-02)按角色分组泳道·数据装配钉。
// 验收:Client/Base/Cell 和已涉及其他进程按角色分泳道;静态角色不冒充
// 运行中实例,运行实例带组件 ID。

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
  '        self.playSkill()'
].join('\n');

const TEXTS = new Map<string, string>([
  [CLIENT_AVATAR, CLIENT_TEXT],
  [BASE_AVATAR, BASE_TEXT],
  [CELL_AVATAR, CELL_TEXT]
]);

/** 静态归属表(替身宿主映射) */
const ENTITY_FOR_FILE = new Map<string, string>([
  [CLIENT_AVATAR, 'Avatar'],
  [BASE_AVATAR, 'Avatar'],
  [CELL_AVATAR, 'Avatar']
]);

const DEF_REGISTRY: Record<
  string,
  { defFile: string; line: number; declaredArgs?: string[]; declaredReturnType?: string | null }
> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': {
    defFile: '/ws/entity_defs/Avatar.def',
    line: 10,
    declaredArgs: ['UINT32']
  },
  'Avatar\u001fCellMethods\u001fenterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonEnterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 34 }
  // onChooseRoleFailed 缺席:def 未声明 → 未连接发送(FLOW-007 口径)
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

const makeSource = (overrides: Partial<FlowCallGraphSource> = {}): FlowCallGraphSource => ({
  rootKey: '/ws',
  listScriptFiles: async () => [...TEXTS.keys()],
  readFile: async filePath => TEXTS.get(filePath) ?? null,
  entityForFile: async filePath => ENTITY_FOR_FILE.get(filePath) ?? null,
  resolveDefMethod: async (entity, section, methodName) =>
    DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  resolveImplementation: async (entity, section, methodName) =>
    IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  ...overrides
});

describe('FLOW-015 三元组收集', () => {
  it('只收集实际发生的跨进程发送三元组(去重,段按声明节点角色)', async () => {
    const needed = await collectNeededRpcTriples(TEXTS, '/ws', async filePath =>
      ENTITY_FOR_FILE.get(filePath) ?? null
    );
    const keys = needed
      .map(triple => `${triple.entity}\u001f${triple.section}\u001f${triple.methodName}`)
      .sort();
    expect(keys).toEqual([
      'Avatar\u001fBaseMethods\u001fchooseRole',
      'Avatar\u001fCellMethods\u001fenterGame',
      'Avatar\u001fClientMethods\u001fonChooseRoleFailed',
      'Avatar\u001fClientMethods\u001fonEnterGame'
    ]);
  });

  it('广播不是三元组(showScene 不进 def/实现解析)', async () => {
    const needed = await collectNeededRpcTriples(TEXTS, '/ws', async filePath =>
      ENTITY_FOR_FILE.get(filePath) ?? null
    );
    expect(needed.some(triple => triple.methodName === 'showScene')).toBe(false);
  });

  it('无实体归属的发送文件不收(不猜实体)', async () => {
    const needed = await collectNeededRpcTriples(TEXTS, '/ws', async () => null);
    expect(needed).toEqual([]);
  });
});

describe('FLOW-015 装配', () => {
  it('泳道按角色分列(client/base/cell),静态角色标注不冒充运行实例', async () => {
    const sample = await assembleFlowCallGraph(makeSource(), {
      filePath: CLIENT_AVATAR,
      functionName: 'chooseRole'
    });
    expect(sample.swimlanes.map(lane => lane.role)).toEqual(['client', 'base', 'cell']);
    expect(sample.html).toContain('泳道:client(静态角色,非运行实例)');
    expect(sample.html).not.toMatch(/栈帧|调用栈|堆栈/);
  });

  it('def/实现解析只发生每个三元组一次(按需,不预解析全方法表)', async () => {
    const defCalls: string[] = [];
    const implCalls: string[] = [];
    const sample = await assembleFlowCallGraph(
      makeSource({
        resolveDefMethod: async (entity, section, methodName) => {
          defCalls.push(`${entity}\u001f${section}\u001f${methodName}`);
          return DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null;
        },
        resolveImplementation: async (entity, section, methodName) => {
          implCalls.push(`${entity}\u001f${section}\u001f${methodName}`);
          return IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null;
        }
      }),
      { filePath: CLIENT_AVATAR, functionName: 'chooseRole' }
    );
    expect(defCalls.sort()).toEqual([
      'Avatar\u001fBaseMethods\u001fchooseRole',
      'Avatar\u001fCellMethods\u001fenterGame',
      'Avatar\u001fClientMethods\u001fonChooseRoleFailed',
      'Avatar\u001fClientMethods\u001fonEnterGame'
    ]);
    // onChooseRoleFailed def null:实现解析仍问一次(如实),装配侧 null=未连接
    expect(implCalls).toHaveLength(4);
    expect(sample.walkLinks[sample.walkLinks.length - 1].connectedToExec).toBe(false);
  });

  it('实现缺失如实:未连接发送只记发送步,def 声明回填 RPC 声明节点', async () => {
    const sample = await assembleFlowCallGraph(
      makeSource({
        resolveImplementation: async () => null
      }),
      { filePath: CLIENT_AVATAR, functionName: 'chooseRole' }
    );
    const sends = sample.walkLinks.filter(link => link.kind === 'send');
    expect(sends.every(link => link.connectedToExec === false)).toBe(true);
    expect(sample.walkLinks.every(link => link.kind !== 'remote-exec')).toBe(true);
    expect(sample.html).toContain('未连接');
  });

  it('入口缺失:抛错不虚构路径', async () => {
    await expect(
      assembleFlowCallGraph(makeSource(), {
        filePath: CLIENT_AVATAR,
        functionName: 'ghostFn'
      })
    ).rejects.toThrow(/not found/);
  });

  it('深度截断如实传通(truncated 不假装完整)', async () => {
    const sample = await assembleFlowCallGraph(
      makeSource(),
      { filePath: CLIENT_AVATAR, functionName: 'chooseRole' },
      { maxDepth: 1 }
    );
    expect(sample.truncated).toBe(true);
    expect(sample.html).toContain('走查深度截断');
  });

  it('def 声明的 Arg 类型经装配传通到边注记(FLOW-017)', async () => {
    const sample = await assembleFlowCallGraph(makeSource(), {
      filePath: CLIENT_AVATAR,
      functionName: 'chooseRole'
    });
    const send = sample.walkLinks.find(link => link.kind === 'send')!;
    expect(send.argNote).toBe('参数(def):UINT32');
    expect(sample.html).toContain('参数(def):UINT32');
  });
});
