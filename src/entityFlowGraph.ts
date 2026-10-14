/**
 * 实体架构流程图数据模型(批124)。
 *
 * 回答一个问题:一个实体从客户端到服务端会发生什么——
 *   ① 客户端能调用哪些服务端方法(调用方向由 <Exposed> 决定);
 *   ② 哪些属性会自动同步到 baseapp / cellapp / 客户端(方向与受众由
 *      <Flags> 位决定);
 *   ③ 哪些属性会落到数据库(<Persistent>)。
 *
 * 语义与出处全部对齐引擎源码(kbe/src/... ,file:line 见各 ED_FLAG 常量与
 * CITATIONS 注释),不在本层发明规则:
 *   - 位值真值      entitydef/common.h L19-28 的 8 个 ED_FLAG_* 枚举
 *   - 旗标名→位映射 entitydef/entitydef.cpp L161-174 的 g_entityFlagMapping(12 个拼写)
 *   - 域成员掩码    common.h L41-55(BASE/CELL/CLIENT_DATA_FLAGS 与三个 BROADCAST_*)
 *   - 域注册落点    entitydef.cpp L1150-1168(按掩码位 setBase/setCell/setClient)
 *   - cell→base 备份 cellapp/entity.cpp L1129-1139 backupCellData→addCellDataToStream,
 *                   消息 BaseappInterface::onBackupEntityCellData(L1170) → baseapp.cpp L4674
 *   - 属性变更推送   baseapp/entity.cpp L128(ED_FLAG_BASE_AND_CLIENT 闸门)→ L137
 *                   ClientInterface::onUpdatePropertys;cellapp/entity.cpp L721(其它客户端)、
 *                   L851(自己的客户端)、L863(同一条客户端消息)
 *   - 方法暴露闸门   baseapp/entity.cpp L960、cellapp/entity.cpp L963(not exposed 拒绝)
 *   - 客户端回调入口 client_lib/client_interface.h L81 onRemoteMethodCall
 */

import type {
  DefinitionMethod,
  DefinitionProperty,
  ResolvedDefinitionSemantics
} from './definitionSemantics';

/** 流程图参与方。 */
export type FlowActor = 'client' | 'base' | 'cell' | 'db' | 'aoi';

export const FLOW_ACTORS: FlowActor[] = ['client', 'base', 'cell', 'aoi', 'db'];

export const FLOW_ACTOR_LABELS: Record<FlowActor, string> = {
  client: '客户端实体',
  base: 'baseapp 实体',
  cell: 'cellapp 实体',
  aoi: '空间广播（其它 cell / 其它客户端）',
  db: 'dbmgr（MySQL）'
};

/** 引擎出处:一条边/一条提示的来源行。 */
export interface FlowCitation {
  file: string;
  line: number;
  note: string;
}

/** 边上的一个成员(方法或属性),带声明来源,点击可跳回声明行。 */
export interface FlowMember {
  name: string;
  kind: 'method' | 'property';
  /** 属性:归一后的旗标串;方法为空。 */
  flags?: string;
  /** 方法:<Exposed> 布尔值;属性为空。 */
  exposed?: boolean;
  /** 属性:<Persistent> 值;方法为空。 */
  persistent?: boolean;
  /** 容器属性的下级结构路径(ARRAY 的 `[].value`、FIXED_DICT 的子键)。 */
  structure?: string[];
  /** 声明来源 label(local / interface / parent / component + 拥有者)。 */
  source: string;
  /** 声明文件(def 自身或继承链上的祖先/接口/组件 def)。 */
  filePath: string;
  line: number;
}

export type FlowEdgeKind = 'method' | 'property' | 'persistence';

export interface FlowEdge {
  id: string;
  from: FlowActor;
  to: FlowActor;
  kind: FlowEdgeKind;
  /** 一句话语义:这条边为什么存在、什么条件下发生。 */
  semantic: string;
  /** 驱动这条边的旗标集合(属性边;方法边为空)。 */
  flags: string[];
  members: FlowMember[];
  citations: FlowCitation[];
}

/** 客户端无法调用的方法:不画边,单列并给出引擎拒绝位置。 */
export interface FlowBlockedCall {
  method: string;
  section: 'BaseMethods' | 'CellMethods';
  source: string;
  filePath: string;
  line: number;
  reason: string;
  citation: FlowCitation;
}

export interface EntityFlowStats {
  properties: number;
  methods: number;
  exposedCalls: number;
  clientCallbacks: number;
  persistentProperties: number;
  blockedCalls: number;
}

export interface EntityFlowGraph {
  entityName: string;
  defFilePath: string;
  /** 实体是否有 cell 面(entities.xml hasCell 或 cell 脚本存在)。 */
  hasCell: boolean;
  actors: FlowActor[];
  edges: FlowEdge[];
  blocked: FlowBlockedCall[];
  stats: EntityFlowStats;
}

/** entitydef/common.h L19-28 的位值真值。 */
export const ED_FLAG_BITS = {
  CELL_PUBLIC: 0x00000001,
  CELL_PRIVATE: 0x00000002,
  ALL_CLIENTS: 0x00000004,
  CELL_PUBLIC_AND_OWN: 0x00000008,
  OWN_CLIENT: 0x00000010,
  BASE_AND_CLIENT: 0x00000020,
  BASE: 0x00000040,
  OTHER_CLIENTS: 0x00000080
} as const;

/** common.h L41 BASE | BASE_AND_CLIENT。 */
const BASE_DATA_FLAGS = ED_FLAG_BITS.BASE | ED_FLAG_BITS.BASE_AND_CLIENT;
/** common.h L43 CELL_PUBLIC|CELL_PRIVATE|ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OTHER_CLIENTS|OWN_CLIENT。 */
const CELL_DATA_FLAGS =
  ED_FLAG_BITS.CELL_PUBLIC |
  ED_FLAG_BITS.CELL_PRIVATE |
  ED_FLAG_BITS.ALL_CLIENTS |
  ED_FLAG_BITS.CELL_PUBLIC_AND_OWN |
  ED_FLAG_BITS.OTHER_CLIENTS |
  ED_FLAG_BITS.OWN_CLIENT;
/** common.h L45 BASE_AND_CLIENT|ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OTHER_CLIENTS|OWN_CLIENT。 */
const CLIENT_DATA_FLAGS =
  ED_FLAG_BITS.BASE_AND_CLIENT |
  ED_FLAG_BITS.ALL_CLIENTS |
  ED_FLAG_BITS.CELL_PUBLIC_AND_OWN |
  ED_FLAG_BITS.OTHER_CLIENTS |
  ED_FLAG_BITS.OWN_CLIENT;
/** common.h L47 需要广播给其它 cellapp 的旗标。 */
const BROADCAST_CELL_FLAGS =
  ED_FLAG_BITS.CELL_PUBLIC |
  ED_FLAG_BITS.ALL_CLIENTS |
  ED_FLAG_BITS.CELL_PUBLIC_AND_OWN |
  ED_FLAG_BITS.OTHER_CLIENTS;
/** common.h L49 需要广播给其它客户端(不含自己)的旗标。 */
const BROADCAST_OTHER_CLIENT_FLAGS =
  ED_FLAG_BITS.OTHER_CLIENTS | ED_FLAG_BITS.ALL_CLIENTS;
/** common.h L51 需要广播给自己的客户端的旗标。 */
const BROADCAST_OWN_CLIENT_FLAGS =
  ED_FLAG_BITS.ALL_CLIENTS |
  ED_FLAG_BITS.CELL_PUBLIC_AND_OWN |
  ED_FLAG_BITS.OWN_CLIENT |
  ED_FLAG_BITS.BASE_AND_CLIENT;

/**
 * 旗标名 → 位值(entitydef.cpp L161-174 g_entityFlagMapping 的 12 个拼写)。
 * CELL/CELL_AND_CLIENT/CELL_AND_CLIENTS/CELL_AND_OTHER_CLIENTS 是别名,
 * 落在与目标旗标同一位上——引擎装载时先归一到位,再按掩码判域。
 */
export const PROPERTY_FLAG_BITS: Record<string, number> = {
  BASE: ED_FLAG_BITS.BASE,
  BASE_AND_CLIENT: ED_FLAG_BITS.BASE_AND_CLIENT,
  CELL: ED_FLAG_BITS.CELL_PUBLIC,
  CELL_PUBLIC: ED_FLAG_BITS.CELL_PUBLIC,
  CELL_PRIVATE: ED_FLAG_BITS.CELL_PRIVATE,
  ALL_CLIENTS: ED_FLAG_BITS.ALL_CLIENTS,
  CELL_AND_CLIENTS: ED_FLAG_BITS.ALL_CLIENTS,
  CELL_PUBLIC_AND_OWN: ED_FLAG_BITS.CELL_PUBLIC_AND_OWN,
  CELL_AND_CLIENT: ED_FLAG_BITS.CELL_PUBLIC_AND_OWN,
  OWN_CLIENT: ED_FLAG_BITS.OWN_CLIENT,
  OTHER_CLIENTS: ED_FLAG_BITS.OTHER_CLIENTS,
  CELL_AND_OTHER_CLIENTS: ED_FLAG_BITS.OTHER_CLIENTS
};

export interface PropertyFlagSemantics {
  /** 归一后的旗标串(未知拼写原样保留,不丢信息)。 */
  flags: string;
  bits: number;
  /** 属性注册在 baseapp 的实体上(entitydef.cpp L1150-1152)。 */
  base: boolean;
  /** 属性注册在 cellapp 的实体上(entitydef.cpp L1154-1156)。 */
  cell: boolean;
  /** 属性注册在客户端实体上(entitydef.cpp L1158-1160)。 */
  client: boolean;
  /** cell→其它 cellapp 广播(common.h L47)。 */
  broadcastCells: boolean;
  /** cell→AOI 内其它客户端广播(cellapp/entity.cpp L721)。 */
  broadcastOtherClients: boolean;
  /** →自己的客户端推送(baseapp/entity.cpp L128 / cellapp/entity.cpp L851)。 */
  broadcastOwnClient: boolean;
  /** 引擎未登记的旗标拼写(会被诊断拦,此处如实带出)。 */
  unknownFlags: string[];
}

/**
 * 把 def 里的 <Flags> 文本解成同步语义。引擎是整串查表
 * (entitydef.cpp L1134-1149,先 toupper 再 g_entityFlagMapping.find,查不到
 * 直接返回 false 拒绝装载),本层按 '|' 拆分容错,未知拼写单列不丢。
 */
export function describePropertyFlagSemantics(flags?: string): PropertyFlagSemantics {
  const tokens = (flags ?? '')
    .split('|')
    .map(token => token.trim().toUpperCase())
    .filter(Boolean);
  const unknownFlags: string[] = [];
  let bits = 0;
  for (const token of tokens) {
    const bit = PROPERTY_FLAG_BITS[token];
    if (bit === undefined) {
      if (!unknownFlags.includes(token)) {
        unknownFlags.push(token);
      }
      continue;
    }
    bits |= bit;
  }

  return {
    flags: tokens.join('|'),
    bits,
    base: (bits & BASE_DATA_FLAGS) > 0,
    cell: (bits & CELL_DATA_FLAGS) > 0,
    client: (bits & CLIENT_DATA_FLAGS) > 0,
    broadcastCells: (bits & BROADCAST_CELL_FLAGS) > 0,
    broadcastOtherClients: (bits & BROADCAST_OTHER_CLIENT_FLAGS) > 0,
    broadcastOwnClient: (bits & BROADCAST_OWN_CLIENT_FLAGS) > 0,
    unknownFlags
  };
}

/** 方法暴露闸门:非 Exposed 的方法客户端调用被引擎拒绝。 */
const BASE_EXPOSED_GATE: FlowCitation = {
  file: 'kbe/src/server/baseapp/entity.cpp',
  line: 960,
  note: 'Base Entity::onRemoteMethodCall:非 Exposed 方法直接报错 call is illegal'
};
const CELL_EXPOSED_GATE: FlowCitation = {
  file: 'kbe/src/server/cellapp/entity.cpp',
  line: 963,
  note: 'Cell Entity::onRemoteCallMethodFromClient:非 Exposed 方法直接报错 call is illegal'
};
const BASE_CALL_ENTRY: FlowCitation = {
  file: 'kbe/src/server/baseapp/baseapp_interface.h',
  line: 306,
  note: 'BaseappInterface 的 onRemoteMethodCall 消息(客户端调用直达 base 实体)'
};
const CELL_CALL_FORWARD: FlowCitation = {
  file: 'kbe/src/server/baseapp/baseapp.cpp',
  line: 4533,
  note: 'Baseapp::onRemoteCallCellMethodFromClient:客户端调 cell 方法经 baseapp 转发'
};
const CELL_CALL_ENTRY: FlowCitation = {
  file: 'kbe/src/server/cellapp/cellapp_interface.h',
  line: 113,
  note: 'CellappInterface 的 onRemoteCallMethodFromClient 消息'
};
const CLIENT_CALLBACK_ENTRY: FlowCitation = {
  file: 'kbe/src/lib/client_lib/client_interface.h',
  line: 81,
  note: 'ClientInterface::onRemoteMethodCall:服务端回调在客户端实体的入口'
};
const CLIENT_CALLBACK_DISPATCH: FlowCitation = {
  file: 'kbe/src/lib/client_lib/clientobjectbase.cpp',
  line: 1099,
  note: 'ClientObjectBase::onRemoteMethodCall_ 按 eid 找到客户端实体再分发'
};
const CELL_TO_BASE_BACKUP: FlowCitation = {
  file: 'kbe/src/server/cellapp/entity.cpp',
  line: 1129,
  note: 'Cell Entity::backupCellData → addCellDataToStream(BASEAPP_TYPE, ENTITY_CELL_DATA_FLAGS)'
};
const CELL_TO_BASE_MESSAGE: FlowCitation = {
  file: 'kbe/src/server/baseapp/baseapp.cpp',
  line: 4674,
  note: 'Baseapp::onBackupEntityCellData 收 cell 属性备份并写进 base 实体影子副本'
};
const BASE_TO_CLIENT: FlowCitation = {
  file: 'kbe/src/server/baseapp/entity.cpp',
  line: 128,
  note: 'Base Entity::onDefDataChanged:flags & ED_FLAG_BASE_AND_CLIENT 才推自己的客户端'
};
const CELL_TO_CLIENT_OWN: FlowCitation = {
  file: 'kbe/src/server/cellapp/entity.cpp',
  line: 851,
  note: 'Cell Entity::onDefDataChanged:ENTITY_BROADCAST_OWN_CLIENT_FLAGS 命中才推自己的客户端'
};
const CELL_TO_CLIENT_OTHERS: FlowCitation = {
  file: 'kbe/src/server/cellapp/entity.cpp',
  line: 721,
  note: 'Cell Entity::onDefDataChanged:ENTITY_BROADCAST_OTHER_CLIENT_FLAGS 命中才广播 AOI 内其它客户端'
};
const CLIENT_PROPERTY_MESSAGE: FlowCitation = {
  file: 'kbe/src/lib/client_lib/client_interface.h',
  line: 89,
  note: 'ClientInterface::onUpdatePropertys:属性增量推送到客户端的消息'
};
const PERSISTENT_DIRTY: FlowCitation = {
  file: 'kbe/src/server/baseapp/entity.cpp',
  line: 102,
  note: 'Base Entity::onDefDataChanged:isPersistent 属性变更即 setDirty,进回库队列'
};
const WRITE_TO_DB: FlowCitation = {
  file: 'kbe/src/server/baseapp/entity.cpp',
  line: 1141,
  note: 'Base Entity::writeToDB 打包持久属性交给 dbmgr'
};
const WRITE_TO_DB_VIA_CELL: FlowCitation = {
  file: 'kbe/src/server/baseapp/entity.cpp',
  line: 1224,
  note: 'Entity::writeToDB:cellEntityCall 非空(实体有 cell 面)时改走 CellappInterface::reqWriteToDBFromBaseapp,由 cell 回写'
};

const methodMember = (method: DefinitionMethod): FlowMember => ({
  name: method.name,
  kind: 'method',
  exposed: method.exposed,
  source: method.source.label,
  filePath: method.owner.filePath,
  line: method.line
});

/** 容器属性的下级结构:ARRAY 落 `value` 子列,FIXED_DICT 落同名子列(子键)。 */
const propertyStructure = (property: DefinitionProperty): string[] => {
  const paths: string[] = [];
  if (property.arrayElement) {
    paths.push('[].value');
  }
  for (const child of property.children) {
    paths.push(child.name);
  }
  return paths;
};

const propertyMember = (property: DefinitionProperty): FlowMember => ({
  name: property.name,
  kind: 'property',
  flags: describePropertyFlagSemantics(property.flags).flags,
  persistent: property.persistent === true,
  structure: propertyStructure(property),
  source: property.source.label,
  filePath: property.owner.filePath,
  line: property.line
});

/**
 * 边上的去重旗标集合。入集属性都通过了旗标位过滤(引擎 g_entityFlagMapping
 * 查表命中),flags 恒为非空已知拼写,不需要空串回落。
 */
const distinctFlags = (properties: DefinitionProperty[]): string[] =>
  [...new Set(properties.map(property => property.flags as string))].sort();

export interface EntityFlowInput {
  semantics: ResolvedDefinitionSemantics;
  hasCell: boolean;
}

/**
 * 由解析后的定义语义构建流程图。
 * 方法面:Exposed 的 Base/Cell 方法画客户端→服务端边;ClientMethods 画
 * 服务端→客户端回调边(cell 侧仅在实体有 cell 面时成立)。
 * 属性面:按旗标位分三向——cell 位属性的 cell→base 自动备份、客户端位属性的
 * 服务端→客户端推送(含 AOI 广播)、Persistent 属性的落库。
 */
export function buildEntityFlowGraph(input: EntityFlowInput): EntityFlowGraph {
  const { semantics, hasCell } = input;
  const edges: FlowEdge[] = [];
  const blocked: FlowBlockedCall[] = [];

  const baseMethods = semantics.effectiveMethodsBySection.BaseMethods;
  const cellMethods = semantics.effectiveMethodsBySection.CellMethods;
  const clientMethods = semantics.effectiveMethodsBySection.ClientMethods;

  const exposedBase = baseMethods.filter(method => method.exposed);
  const exposedCell = cellMethods.filter(method => method.exposed);
  const localBase = baseMethods.filter(method => !method.exposed);
  const localCell = cellMethods.filter(method => !method.exposed);

  if (exposedBase.length > 0) {
    edges.push({
      id: 'method-client-base',
      from: 'client',
      to: 'base',
      kind: 'method',
      semantic: `客户端远程调用 base 方法(${exposedBase.length} 个 Exposed)`,
      flags: [],
      members: exposedBase.map(methodMember),
      citations: [BASE_CALL_ENTRY, BASE_EXPOSED_GATE]
    });
  }
  if (exposedCell.length > 0) {
    edges.push({
      id: 'method-client-cell',
      from: 'client',
      to: 'cell',
      kind: 'method',
      semantic: `客户端远程调用 cell 方法(${exposedCell.length} 个 Exposed,经 baseapp 转发)`,
      flags: [],
      members: exposedCell.map(methodMember),
      citations: [CELL_CALL_FORWARD, CELL_CALL_ENTRY, CELL_EXPOSED_GATE]
    });
  }
  for (const method of localBase) {
    blocked.push({
      method: method.name,
      section: 'BaseMethods',
      source: method.source.label,
      filePath: method.owner.filePath,
      line: method.line,
      reason: '未标 <Exposed>,客户端远程调用会被引擎拒绝',
      citation: BASE_EXPOSED_GATE
    });
  }
  for (const method of localCell) {
    blocked.push({
      method: method.name,
      section: 'CellMethods',
      source: method.source.label,
      filePath: method.owner.filePath,
      line: method.line,
      reason: '未标 <Exposed>,客户端远程调用会被引擎拒绝',
      citation: CELL_EXPOSED_GATE
    });
  }

  const callbackMembers = clientMethods.map(methodMember);
  if (callbackMembers.length > 0) {
    const citations = [CLIENT_CALLBACK_ENTRY, CLIENT_CALLBACK_DISPATCH];
    edges.push({
      id: 'method-base-client',
      from: 'base',
      to: 'client',
      kind: 'method',
      semantic: `base 调用客户端回调方法(${callbackMembers.length} 个 ClientMethods)`,
      flags: [],
      members: callbackMembers,
      citations
    });
    if (hasCell) {
      edges.push({
        id: 'method-cell-client',
        from: 'cell',
        to: 'client',
        kind: 'method',
        semantic: `cell 调用客户端回调方法(${callbackMembers.length} 个 ClientMethods)`,
        flags: [],
        members: callbackMembers,
        citations
      });
    }
  }

  const cellProps = semantics.effectiveProperties.filter(property =>
    describePropertyFlagSemantics(property.flags).cell
  );
  if (cellProps.length > 0) {
    edges.push({
      id: 'property-cell-base',
      from: 'cell',
      to: 'base',
      kind: 'property',
      semantic: `属性自动备份到 baseapp(${cellProps.length} 个带 cell 位的属性,entity 销毁/迁移时用于恢复)`,
      flags: distinctFlags(cellProps),
      members: cellProps.map(propertyMember),
      citations: [CELL_TO_BASE_BACKUP, CELL_TO_BASE_MESSAGE]
    });
  }

  const ownClientProps = semantics.effectiveProperties.filter(property =>
    describePropertyFlagSemantics(property.flags).broadcastOwnClient
  );
  if (ownClientProps.length > 0) {
    const baseSide = ownClientProps.filter(property =>
      describePropertyFlagSemantics(property.flags).base
    );
    const cellSide = ownClientProps.filter(property =>
      describePropertyFlagSemantics(property.flags).cell
    );
    if (baseSide.length > 0) {
      edges.push({
        id: 'property-base-client',
        from: 'base',
        to: 'client',
        kind: 'property',
        semantic: `属性自动同步给自己的客户端(${baseSide.length} 个 BASE_AND_CLIENT 属性,变更即推)`,
        flags: distinctFlags(baseSide),
        members: baseSide.map(propertyMember),
        citations: [BASE_TO_CLIENT, CLIENT_PROPERTY_MESSAGE]
      });
    }
    if (cellSide.length > 0) {
      edges.push({
        id: 'property-cell-client',
        from: 'cell',
        to: 'client',
        kind: 'property',
        semantic: `属性自动同步给自己的客户端(${cellSide.length} 个客户端可见的 cell 属性,变更即推)`,
        flags: distinctFlags(cellSide),
        members: cellSide.map(propertyMember),
        citations: [CELL_TO_CLIENT_OWN, CLIENT_PROPERTY_MESSAGE]
      });
    }
  }

  const broadcastProps = semantics.effectiveProperties.filter(property =>
    describePropertyFlagSemantics(property.flags).broadcastOtherClients
  );
  if (broadcastProps.length > 0) {
    edges.push({
      id: 'property-cell-aoi',
      from: 'cell',
      to: 'aoi',
      kind: 'property',
      semantic: `属性自动广播给 AOI 内其它客户端(${broadcastProps.length} 个 ALL_CLIENTS / OTHER_CLIENTS 属性)`,
      flags: distinctFlags(broadcastProps),
      members: broadcastProps.map(propertyMember),
      citations: [CELL_TO_CLIENT_OTHERS, CLIENT_PROPERTY_MESSAGE]
    });
  }

  const cellBroadcastProps = semantics.effectiveProperties.filter(property =>
    describePropertyFlagSemantics(property.flags).broadcastCells
  );
  if (cellBroadcastProps.length > 0 && hasCell) {
    edges.push({
      id: 'property-cell-othercell',
      from: 'cell',
      to: 'aoi',
      kind: 'property',
      semantic: `属性自动广播给其它 cellapp(${cellBroadcastProps.length} 个 CELL_PUBLIC 类属性,跨进程可见)`,
      flags: distinctFlags(cellBroadcastProps),
      members: cellBroadcastProps.map(propertyMember),
      citations: [
        {
          file: 'kbe/src/lib/entitydef/common.h',
          line: 47,
          note: 'ENTITY_BROADCAST_CELL_FLAGS:需要广播给其它 cellapp 的旗标集合'
        }
      ]
    });
  }

  const persistentProps = semantics.effectiveProperties.filter(
    property => property.persistent === true
  );
  if (persistentProps.length > 0) {
    const baseSide = persistentProps.filter(property =>
      describePropertyFlagSemantics(property.flags).base
    );
    const cellSide = persistentProps.filter(property =>
      describePropertyFlagSemantics(property.flags).cell
    );
    if (baseSide.length > 0) {
      edges.push({
        id: 'persistence-base-db',
        from: 'base',
        to: 'db',
        kind: 'persistence',
        semantic: `持久属性写库(${baseSide.length} 个 Persistent 属性由 baseapp 回写${hasCell ? ',经 cell 转写' : ''})`,
        flags: distinctFlags(baseSide),
        members: baseSide.map(propertyMember),
        citations: hasCell ? [PERSISTENT_DIRTY, WRITE_TO_DB, WRITE_TO_DB_VIA_CELL] : [PERSISTENT_DIRTY, WRITE_TO_DB]
      });
    }
    if (cellSide.length > 0) {
      edges.push({
        id: 'persistence-cell-db',
        from: 'cell',
        to: 'db',
        kind: 'persistence',
        semantic: `持久属性写库(${cellSide.length} 个 Persistent 属性只挂在 cell 上,由 cell 回写)`,
        flags: distinctFlags(cellSide),
        members: cellSide.map(propertyMember),
        citations: [PERSISTENT_DIRTY, WRITE_TO_DB_VIA_CELL]
      });
    }
  }

  const actors = FLOW_ACTORS.filter(actor =>
    edges.some(edge => edge.from === actor || edge.to === actor)
  );

  return {
    entityName: semantics.owner.name,
    defFilePath: semantics.owner.filePath,
    hasCell,
    actors,
    edges,
    blocked,
    stats: {
      properties: semantics.effectiveProperties.length,
      methods: baseMethods.length + cellMethods.length + clientMethods.length,
      exposedCalls: exposedBase.length + exposedCell.length,
      clientCallbacks: clientMethods.length,
      persistentProperties: persistentProps.length,
      blockedCalls: blocked.length
    }
  };
}

const EDGE_STYLES: Record<FlowActor, string> = {
  client: 'fill:#fff8e1,stroke:#f9a825,stroke-width:2px;',
  base: 'fill:#e3f2fd,stroke:#1565c0,stroke-width:2px;',
  cell: 'fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;',
  aoi: 'fill:#f3e5f5,stroke:#6a1b9a,stroke-width:1px,stroke-dasharray:4 3;',
  db: 'fill:#eceff1,stroke:#455a64,stroke-width:2px;'
};

/** mermaid 标签转义:引号/井号/方括号会截断标签,统一换成全角形态。 */
const MERMAID_LABEL_ESCAPES: Record<string, string> = {
  '"': '＂',
  '#': '＃',
  '[': '［',
  ']': '］'
};
const mermaidLabel = (text: string): string =>
  // 转义表键集与上面正则字符集一一对应,查表必命中。
  text.replace(/["#[\]]/g, char => MERMAID_LABEL_ESCAPES[char]);

/** mermaid 文本:参与方作节点,边标签带语义摘要。 */
export function renderEntityFlowMermaid(graph: EntityFlowGraph): string {
  const lines: string[] = ['graph LR'];
  for (const actor of graph.actors) {
    lines.push(`  ${actor}["${FLOW_ACTOR_LABELS[actor]}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${edge.from} -->|"${mermaidLabel(edge.semantic)}"| ${edge.to}`);
  }
  for (const actor of graph.actors) {
    lines.push(`  classDef ${actor} ${EDGE_STYLES[actor]}`);
    lines.push(`  class ${actor} ${actor};`);
  }
  return `${lines.join('\n')}\n`;
}

/** 人读文本:边语义 + 旗标 + 引擎出处 + 成员清单,供导出与面板表格复用。 */
export function renderEntityFlowMarkdown(graph: EntityFlowGraph): string {
  const lines: string[] = [
    `# KBEngine 架构流程图：${graph.entityName}`,
    '',
    `定义文件：${graph.defFilePath}`,
    `实体有 cell 面：${graph.hasCell ? '是' : '否'}`,
    `属性 ${graph.stats.properties} / 方法 ${graph.stats.methods} / 客户端可调 ${graph.stats.exposedCalls} / 客户端回调 ${graph.stats.clientCallbacks} / 持久属性 ${graph.stats.persistentProperties}`,
    ''
  ];

  if (graph.edges.length === 0) {
    lines.push('（该实体没有可展示的调用或同步关系）', '');
  }

  for (const edge of graph.edges) {
    lines.push(
      `## ${FLOW_ACTOR_LABELS[edge.from]} → ${FLOW_ACTOR_LABELS[edge.to]}（${edge.kind}）`
    );
    lines.push('');
    lines.push(`语义：${edge.semantic}`);
    if (edge.flags.length > 0) {
      lines.push(`旗标：${edge.flags.map(flag => `\`${flag}\``).join('、')}`);
    }
    lines.push('引擎出处：');
    for (const citation of edge.citations) {
      lines.push(`- \`${citation.file}:${citation.line}\` — ${citation.note}`);
    }
    lines.push('成员：');
    for (const member of edge.members) {
      const detail = member.kind === 'method'
        ? `${member.exposed ? 'Exposed' : '非 Exposed'}`
        : `${member.flags ?? ''}${member.persistent ? ' · Persistent' : ''}${
          member.structure && member.structure.length > 0
            ? ` · 结构 ${member.structure.map(item => `\`${item}\``).join(' ')}`
            : ''
        }`;
      lines.push(
        `- \`${member.name}\`（${detail}）— ${member.source} · \`${member.filePath}:${member.line}\``
      );
    }
    lines.push('');
  }

  if (graph.blocked.length > 0) {
    lines.push('## 客户端调不到的方法', '');
    for (const entry of graph.blocked) {
      lines.push(
        `- \`${entry.method}\`（${entry.section}，${entry.source}）— ${entry.reason}（\`${entry.citation.file}:${entry.citation.line}\`）`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}