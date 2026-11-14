import { describe, expect, it } from 'vitest';
import { buildDefCallChain, findDefMethodByStart } from '../src/backend/defCallChain';
import { parsePythonMethodBlocks } from '../src/entityMappingHelpers';
import type { EntityMappingIndex, IndexedMethodDefinition, IndexedPythonMethodLocation } from '../src/entityMapping';

// FLOW-001(旧 KFLOW-CORE-01)「记录现有图失败样本」审计钉(零生产码,现状钉)。
//
// 样本域 = 现任本地调用树面 buildDefCallChain(src/backend/defCallChain.ts)。
// 四个失败族 × 真实 KBEngine 入口形态,每例先写「预期路径」再钉「当前真值」:
//   S1 缺失本地帧:模块函数调用不可见(普通 name( 调用不在扫描面);
//   S2 缺失本地帧:跨实体接收者调用不可见(found.cell.halt() 非 self. 前缀);
//   S3 错误跨进程落点:非法接收者组合(self.base.X() 在 base 脚本=AttributeError
//      面,引擎九面表 PYTHON_RECEIVER_FACES base.base=null)仍画边——
//      defCallChain.ts:193 findPythonReceiverCalls(bodyText) 未传 callerFace;
//   S4 错误跨进程落点(潜伏面,当前不可达):未解析调用恒标 index.rootName
//      (defCallChain.ts:276 unresolvedNode(index.rootName, …))——继承体一旦
//      (在 FLOW-004 修复后)可展开,继承体内的未解析调用会以根实体名入图;
//   S5 缺失本地帧:继承 def 进入图(resolved=true)但实现体静默截断——双因:
//      ① 实现文件不在本实体索引(文件臂落空);② 即使在场,sameIdentity
//      (entityMappingHelpers.ts:59-68)含 sourceKind 逐字段比较,继承 def
//      'base' vs python 绑定恒 'local' 永不相等(身份臂必落空);
//   S6 合成 client:Exposed 方法无条件获得 client--> 入边(defCallChain.ts
//      Part A :293-311),与客户端源码有无证据无关(FLOW-006 验收禁止伪造
//      Client 函数栈,外部入口须带证据);
//   C1 对照钉:同实体自身的未解析调用按 rootName 标注是正确的——与 S4 形成
//      对照,证明缺陷面在「跨实体继承体」不在「自身体」。
//
// 本文件断言全部是当前真值(接线破坏/语义漂移即红);预期路径只写在注释里,
// 供 FLOW-004..008 实施批对表。原图(mermaid)存档见
// docs/review/2026-11-14-kflow-001-graph-failure-samples.md。

const DEF_FILES: Record<string, string> = {
  Avatar: [
    '<root>',
    '  <Avatar>',
    '    <Properties>',
    '    </Properties>',
    '    <BaseMethods>',
    '      <requestMove> <Exposed/> </requestMove>',
    '      <adminNuke> <Exposed/> </adminNuke>',
    '      <onMoveDone/>',
    '    </BaseMethods>',
    '    <CellMethods>',
    '      <doMove/>',
    '      <attack/>',
    '    </CellMethods>',
    '  </Avatar>',
    '</root>'
  ].join('\n'),
  NPC: [
    '<root>',
    '  <NPC extends="Avatar">',
    '    <BaseMethods/>',
    '    <CellMethods>',
    '      <attack/>',
    '      <stalk/>',
    '    </CellMethods>',
    '  </NPC>',
    '</root>'
  ].join('\n')
};

// .def XML 里方法声明的 1-based 行(上面的布局锁死,供 def 入口行引用)
const DEF_LINES: Record<string, Record<string, number>> = {
  Avatar: { requestMove: 6, adminNuke: 7, onMoveDone: 8, doMove: 11, attack: 12 },
  NPC: { attack: 5, stalk: 6 }
};

const PY_FILES: Record<string, string> = {
  'scripts/base/Avatar.py': [
    'class Avatar:',
    '    def requestMove(self, d):',
    '        self.cell.doMove(d)',
    '        self.base.onMoveDone()',
    '    def adminNuke(self):',
    '        self.cell.doMove(0)',
    '    def onMoveDone(self):',
    '        pass'
  ].join('\n'),
  'scripts/cell/Avatar.py': [
    'from nav_helpers import clamp_pos',
    '',
    'class Avatar:',
    '    def doMove(self, d):',
    '        pos = clamp_pos(d)',
    '        found = KBEngine.entities.get(101)',
    '        found.cell.halt()',
    '        self.cell.rebake()',
    '    def attack(self):',
    '        pass'
  ].join('\n'),
  'scripts/cell/NPC.py': [
    'class NPC:',
    '    def attack(self):',
    '        self.cell.doMove(1)',
    '    def stalk(self):',
    '        self.cell.despawn()'
  ].join('\n'),
  'scripts/client/Avatar.py': [
    'class Avatar:',
    '    def chooseRole(self):',
    '        self.base.requestMove(3)'
  ].join('\n')
};

const defFileOf = (entity: string) => `/ws/scripts/entity_defs/${entity}.def`;
const pyFileOf = (relative: string) => `/ws/${relative}`;

const SECTION_BY_DIR: Record<string, 'BaseMethods' | 'CellMethods' | 'ClientMethods'> = {
  base: 'BaseMethods',
  cell: 'CellMethods',
  client: 'ClientMethods'
};

const methodDef = (
  definingEntity: string,
  symbolName: string,
  section: IndexedMethodDefinition['section'],
  opts: { inherited?: boolean; exposed?: boolean } = {}
): IndexedMethodDefinition => ({
  defFile: defFileOf(definingEntity),
  line: DEF_LINES[definingEntity][symbolName],
  section,
  exposed: opts.exposed ?? false,
  owner: {
    kind: 'entity',
    name: definingEntity,
    filePath: defFileOf(definingEntity),
    line: 2
  },
  declaredArgs: [],
  identity: {
    ownerKind: 'entity',
    ownerName: definingEntity,
    sourceKind: opts.inherited ? 'base' : 'local',
    sourceChain: opts.inherited ? ['NPC', definingEntity] : [definingEntity],
    section,
    symbolName
  }
});

/** 把一个实体脚本文件的全部方法按 parsePythonMethodBlocks 真值绑定进索引。 */
const bindPythonFile = (
  relative: string,
  ownerName: string
): IndexedPythonMethodLocation[] => {
  const filePath = pyFileOf(relative);
  const section = SECTION_BY_DIR[relative.split('/')[1]];
  return parsePythonMethodBlocks(PY_FILES[relative], filePath).map(method => ({
    ...method,
    calls: [],
    binding: {
      pythonFile: filePath,
      identity: {
        ownerKind: 'entity',
        ownerName,
        sourceKind: 'local',
        sourceChain: [ownerName],
        section,
        symbolName: method.methodName
      }
    }
  }));
};

/** Avatar 全链索引:base/cell/client 三个脚本全部绑定(生产常态)。 */
const avatarIndex: EntityMappingIndex = {
  rootName: 'Avatar',
  rootCategory: 'entity',
  rootDefFile: defFileOf('Avatar'),
  semantics: {} as EntityMappingIndex['semantics'],
  propertyDefinitions: [],
  methodDefinitions: [
    methodDef('Avatar', 'requestMove', 'BaseMethods', { exposed: true }),
    methodDef('Avatar', 'adminNuke', 'BaseMethods', { exposed: true }),
    methodDef('Avatar', 'onMoveDone', 'BaseMethods'),
    methodDef('Avatar', 'doMove', 'CellMethods'),
    methodDef('Avatar', 'attack', 'CellMethods')
  ],
  pythonOwnerFiles: [],
  pythonMethods: [
    ...bindPythonFile('scripts/base/Avatar.py', 'Avatar'),
    ...bindPythonFile('scripts/cell/Avatar.py', 'Avatar'),
    ...bindPythonFile('scripts/client/Avatar.py', 'Avatar')
  ]
};

/** NPC 最小索引:只绑定 NPC.py——继承自 Avatar 的实现文件不在本索引
 * (owner 文件发现不全是真实工程常见形态)。 */
const npcMinimalIndex: EntityMappingIndex = {
  rootName: 'NPC',
  rootCategory: 'entity',
  rootDefFile: defFileOf('NPC'),
  semantics: {} as EntityMappingIndex['semantics'],
  propertyDefinitions: [],
  methodDefinitions: [
    methodDef('NPC', 'attack', 'CellMethods'),
    methodDef('NPC', 'stalk', 'CellMethods'),
    methodDef('Avatar', 'doMove', 'CellMethods', { inherited: true })
  ],
  pythonOwnerFiles: [],
  pythonMethods: [...bindPythonFile('scripts/cell/NPC.py', 'NPC')]
};

/** NPC 全链索引:NPC.py + Avatar 的 base/cell 实现都绑定(生产常态)。 */
const npcFullIndex: EntityMappingIndex = {
  ...npcMinimalIndex,
  methodDefinitions: [
    methodDef('NPC', 'attack', 'CellMethods'),
    methodDef('NPC', 'stalk', 'CellMethods'),
    methodDef('Avatar', 'doMove', 'CellMethods', { inherited: true }),
    methodDef('Avatar', 'attack', 'CellMethods', { inherited: true }),
    methodDef('Avatar', 'requestMove', 'BaseMethods', { inherited: true, exposed: true }),
    methodDef('Avatar', 'onMoveDone', 'BaseMethods', { inherited: true })
  ],
  pythonMethods: [
    ...bindPythonFile('scripts/cell/NPC.py', 'NPC'),
    ...bindPythonFile('scripts/base/Avatar.py', 'Avatar'),
    ...bindPythonFile('scripts/cell/Avatar.py', 'Avatar')
  ]
};

const chainFrom = (
  index: EntityMappingIndex,
  entity: keyof typeof DEF_LINES,
  methodName: string
) => {
  const chain = buildDefCallChain(index, {
    filePath: defFileOf(entity),
    line: DEF_LINES[entity][methodName],
    methodName
  }, {
    readPythonFile: filePath => PY_FILES[filePath.replace('/ws/', '')] ?? null
  });
  expect(chain).not.toBeNull();
  return chain!;
};

const nodeIds = (chain: { nodes: Array<{ id: string }> }) => chain.nodes.map(node => node.id);
const edgeKeys = (chain: { edges: Array<{ from: string; to: string; receiver: string }> }) =>
  chain.edges.map(edge => `${edge.from}>${edge.to}:${edge.receiver}`);

describe('FLOW-001 现有图失败样本(现状钉)', () => {
  it('P1 Avatar 真实链:模块函数与跨实体调用帧缺失(S1/S2)+ 非法接收者仍画边(S3)', () => {
    // 入口:客户端经 <Exposed> requestMove(base)→ self.cell.doMove(cell)。
    // 预期路径:requestMove→doMove→(clamp_pos 帧)→(Monster.halt 跨实体边),
    //   self.base.onMoveDone() 是非法组合(base 面 .base 属性不存在,
    //   cellapp/baseapp 九面表 base.base=null)→ 无边(或 AttributeError 标记)。
    const chain = chainFrom(avatarIndex, 'Avatar', 'requestMove');

    // S1 现状钉:clamp_pos(模块函数)无帧
    expect(nodeIds(chain).some(id => id.includes('clamp_pos'))).toBe(false);
    // S2 现状钉:found.cell.halt()(跨实体接收者)无帧
    expect(nodeIds(chain).some(id => id.includes('halt'))).toBe(false);
    // doMove 自身确实展开进入图(证明缺失不是「链没走到」)
    expect(nodeIds(chain)).toContain('Avatar:CellMethods:doMove');
    // S3 现状钉:base 脚本里的 self.base.onMoveDone()(运行期必 AttributeError)
    // 仍解析为已解析节点并画边
    expect(nodeIds(chain)).toContain('Avatar:BaseMethods:onMoveDone');
    expect(edgeKeys(chain)).toContain(
      'Avatar:BaseMethods:requestMove>Avatar:BaseMethods:onMoveDone:base'
    );
    // 同链控制:合法的 self.cell.doMove 边存在
    expect(edgeKeys(chain)).toContain(
      'Avatar:BaseMethods:requestMove>Avatar:CellMethods:doMove:cell'
    );
  });

  it('P3 NPC 最小索引:继承 def 入图(resolved=true)但实现体静默截断(S5)', () => {
    // 入口:NPC(extends Avatar) cell 攻击逻辑 self.cell.doMove()(继承实现)。
    // 预期路径:解析到 Avatar.py 的 doMove 实现并继续展开(clamp_pos/rebake 面)。
    const chain = chainFrom(npcMinimalIndex, 'NPC', 'attack');

    // 现状钉:继承 def 节点存在且标 resolved=true
    const inherited = chain.nodes.find(node => node.id === 'Avatar:CellMethods:doMove');
    expect(inherited).toBeDefined();
    expect(inherited?.resolved).toBe(true);
    expect(inherited?.entity).toBe('Avatar');
    // 现状钉:实现体不展开——rebake(未解析调用)与任何下游帧都不出现
    expect(nodeIds(chain).some(id => id.includes('rebake'))).toBe(false);
    expect(nodeIds(chain).some(id => id.includes('clamp_pos'))).toBe(false);
    expect(edgeKeys(chain)).toEqual(['NPC:CellMethods:attack>Avatar:CellMethods:doMove:cell']);
  });

  it('P4 NPC 全链索引:实现已绑定仍截断——sourceKind 不等臂先于文件臂(S5 深因)', () => {
    // 入口同 P3,但 Avatar 实现文件已在本索引(cell/Avatar.py doMove 已绑定)。
    // 预期路径:继承 def 解析到 Avatar.py 的 doMove 实现并展开(rebake 面出现)。
    // 现状深因:findBoundMethod 第二臂 sameIdentity 逐字段比较含 sourceKind
    // (entityMappingHelpers.ts:59-68)——继承 def 的 identity.sourceKind='base',
    // python 绑定恒为 'local',两臂全落空,文件在索引里也绑不上。
    const chain = chainFrom(npcFullIndex, 'NPC', 'attack');

    // 现状钉:继承 def 节点仍在图(解析面)但实现体不展开——绑定在场也截断
    expect(nodeIds(chain)).toContain('Avatar:CellMethods:doMove');
    expect(nodeIds(chain).some(id => id.includes('rebake'))).toBe(false);
    expect(nodeIds(chain).some(id => id.includes('clamp_pos'))).toBe(false);
    expect(edgeKeys(chain)).toEqual(['NPC:CellMethods:attack>Avatar:CellMethods:doMove:cell']);
    // 潜伏面记录(S4,本例不可达):defCallChain.ts:276 未解析节点恒标
    // index.rootName——一旦 FLOW-004 修好继承绑定,继承体内的未解析调用会
    // 以根实体名入图(错误归属),重做时必须一并改为调用点所属实体。
    // 本例以「Avatar 体不展开」间接锁定:修复绑定后此断言转红即提示补 S4 钉。
  });

  it('C1 对照钉:NPC 自身体的未解析调用按 rootName 标注是正确的', () => {
    // NPC.stalk(本地方法)调 self.cell.despawn()(处处未定义):
    // 未解析节点标 NPC 是正确归属——与 P4 对照,缺陷面只在继承体内。
    const chain = chainFrom(npcFullIndex, 'NPC', 'stalk');
    expect(nodeIds(chain)).toContain('NPC:CellMethods:stalk');
    expect(nodeIds(chain)).toContain('NPC:CellMethods:despawn:unresolved');
  });

  it('P5 合成 client:Exposed 方法无客户端证据仍获 client 入边(S6)', () => {
    // 入口:adminNuke(<Exposed>)。客户端源码(scripts/client/Avatar.py)只调
    // requestMove——adminNuke 无任何客户端调用证据。
    // 预期路径(FLOW-006 验收):无客户端源码证据时只显示外部入口标记+证据
    // (<Exposed> 旗标),不伪造 Client 调用边。
    const chain = chainFrom(avatarIndex, 'Avatar', 'adminNuke');

    // 现状钉:合成 client 源节点 + 入边无条件出现
    expect(nodeIds(chain)).toContain('client');
    expect(edgeKeys(chain)).toContain('client>Avatar:BaseMethods:adminNuke:client');
    // 现状钉:client 源节点不携带任何证据字段/文件来源(纯合成)
    const clientNode = chain.nodes.find(node => node.id === 'client');
    expect(clientNode?.signature).toBe('client');
    expect(clientNode?.methodName).toBe('');
    // 同链 doMove 正常展开(证明链本身健康,只有 client 入边是合成的)
    expect(edgeKeys(chain)).toContain(
      'Avatar:BaseMethods:adminNuke>Avatar:CellMethods:doMove:cell'
    );
  });

  it('P6 入口解析:继承重名 def 的入口按 defFile 同文件臂命中本地声明', () => {
    // NPC.def 声明 attack(line 5,本地覆盖),Avatar.def 也声明 attack(line 12,
    // 继承面)。入口路径锚在 NPC.def——现状(正确面):sameFile 过滤命中 NPC 本地。
    // 记录为回归基准:FLOW 重做入口解析时不得让继承重名吞掉本地声明。
    const resolved = findDefMethodByStart(npcFullIndex, {
      filePath: defFileOf('NPC'),
      line: DEF_LINES.NPC.attack,
      methodName: 'attack'
    });
    expect(resolved?.identity.ownerName).toBe('NPC');
    expect(resolved?.defFile).toBe(defFileOf('NPC'));
    // 反向:入口锚在 Avatar.def 的 attack(继承面)→ 命中 Avatar 声明
    const inheritedResolved = findDefMethodByStart(npcFullIndex, {
      filePath: defFileOf('Avatar'),
      line: DEF_LINES.Avatar.attack,
      methodName: 'attack'
    });
    expect(inheritedResolved?.identity.ownerName).toBe('Avatar');
  });
});
