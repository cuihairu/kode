// SRC-004(阶段 1):codeGenerator.ts 纯渲染/模板函数迁出。纯移动:19 个
// 类私有渲染/模板方法(generateDefContent/generatePropertyCode/generateMethodCode/
// containerGuardEmptyOf/partPropertiesOf/generatePythonContent/generatePythonMethodCode/
// generateEntityRegistration + 10 个 get*Template)迁出为模块级自由函数;this.<渲染>
// 调用改为直接调用,区域原文零改动,无 vscode/path/fs 依赖,仅需类型导入(自
// codeGenerator 类型-only,运行时无环);类经本模块导入回注。
import type {
  EntityDefinition,
  PropertyDefinition,
  MethodDefinition,
  EntityTypeConfig
} from './codeGenerator';
import { fixedDictTypeName, type EntityWizardPart } from './entityWizard';


export function generateDefContent(entity: EntityDefinition): string {
  const lines: string[] = [];

  // 文件头注释
  lines.push(`<!DOCTYPE entity>`);
  lines.push(`<!--`);
  lines.push(`  实体: ${entity.config.name}`);
  if (entity.config.description) {
    lines.push(`  描述: ${entity.config.description}`);
  }
  lines.push(`  生成时间: ${new Date().toISOString()}`);
  lines.push(`-->`);
  lines.push('');

  // 根节点
  lines.push('<root>');
  lines.push('');

  if (entity.config.parent) {
    lines.push('  <Parent>');
    lines.push(`    <${entity.config.parent}/>`);
    lines.push('  </Parent>');
    lines.push('');
  }

  const allProperties = [
    ...(entity.baseProperties || []),
    ...(entity.cellProperties || []),
    ...(entity.clientProperties || [])
  ];

  if (allProperties.length > 0) {
    lines.push('  <Properties>');
    for (const prop of allProperties) {
      lines.push(generatePropertyCode(prop, '    '));
    }
    lines.push('  </Properties>');
    lines.push('');
  }

  // BaseMethods 节点
  if (entity.baseMethods && entity.baseMethods.length > 0) {
    lines.push('  <BaseMethods>');
    for (const method of entity.baseMethods) {
      lines.push(generateMethodCode(method, '    ', true));
    }
    lines.push('  </BaseMethods>');
    lines.push('');
  }

  // CellMethods 节点
  if (entity.cellMethods && entity.cellMethods.length > 0) {
    lines.push('  <CellMethods>');
    for (const method of entity.cellMethods) {
      lines.push(generateMethodCode(method, '    ', true));
    }
    lines.push('  </CellMethods>');
    lines.push('');
  }

  // ClientMethods 节点
  if (entity.clientMethods && entity.clientMethods.length > 0) {
    lines.push('  <ClientMethods>');
    for (const method of entity.clientMethods) {
      lines.push(generateMethodCode(method, '    ', false));
    }
    lines.push('  </ClientMethods>');
    lines.push('');
  }

  // 根节点结束
  lines.push('</root>');

  return lines.join('\n');
}

/**
 * 生成属性代码
 */

export function generatePropertyCode(prop: PropertyDefinition, indent: string): string {
  const lines: string[] = [];

  lines.push(`${indent}<${prop.name}>`);
  lines.push(`${indent}  <Type>${prop.type}</Type>`);
  lines.push(`${indent}  <Flags>${prop.flags}</Flags>`);

  if (prop.default !== undefined) {
    lines.push(`${indent}  <Default>${prop.default}</Default>`);
  }

  if (prop.persistent !== undefined) {
    lines.push(`${indent}  <Persistent>${prop.persistent}</Persistent>`);
  }

  if (prop.dbLength !== undefined) {
    lines.push(`${indent}  <DatabaseLength>${prop.dbLength}</DatabaseLength>`);
  }

  if (prop.detailLevel) {
    lines.push(`${indent}  <DetailLevel>${prop.detailLevel}</DetailLevel>`);
  }

  if (prop.identifier !== undefined) {
    lines.push(`${indent}  <Identifier>${prop.identifier}</Identifier>`);
  }

  lines.push(`${indent}</${prop.name}>`);

  return lines.join('\n');
}

/**
 * 生成方法代码
 */

export function generateMethodCode(method: MethodDefinition, indent: string, supportsExposed: boolean): string {
  const lines: string[] = [];

  lines.push(`${indent}<${method.name}>`);

  if (supportsExposed && method.exposed) {
    lines.push(`${indent}  <Exposed/>`);
  }

  if (method.args && method.args.length > 0) {
    for (const arg of method.args) {
      lines.push(`${indent}  <Arg>${arg.type}</Arg>`);
    }
  }

  lines.push(`${indent}</${method.name}>`);

  return lines.join('\n');
}

/**
 * 生成 Python 脚本(KR-AUD-74 引擎布局):hasBase→scripts/base/<Name>.py、
 * hasCell→scripts/cell/<Name>.py、hasClient→scripts/client/<Name>.py 分段
 * 落盘(引擎按 <part>/<类名>.py 加载,单文件 scripts/<Name>.py 不被装载)。
 * IDE-GEN-002:任一段同名实现已存在时整体拒绝——保留使用者代码,不写半套。
 */

export function containerGuardEmptyOf(typeName: string, entityName: string): '[]' | '{}' | null {
  const trimmed = typeName.trim();
  if (/^ARRAY\b/.test(trimmed)) {
    return '[]';
  }
  if (trimmed === fixedDictTypeName(entityName)) {
    return '{}';
  }
  return null;
}

/** 本段(Flags 域)的属性列表:base/cell/client 三段各取自己的属性数组 */

export function partPropertiesOf(
  entity: EntityDefinition,
  part: EntityWizardPart
): PropertyDefinition[] {
  if (part === 'base') {
    return entity.baseProperties ?? [];
  }
  if (part === 'cell') {
    return entity.cellProperties ?? [];
  }
  return entity.clientProperties ?? [];
}

/**
 * 生成某段 Python 实体脚本内容。
 * KR-AUD-74:引擎约定——类名=实体名(entities.xml/def 登记名,引擎按类名
 * 加载脚本,HeroCell/HeroBase 之类后缀类名永远不会被实例化);base/cell/
 * client 三段分别落 scripts/<part>/<Name>.py,继承 KBEngine.Entity 并先调
 * 基类构造(对齐 GEN-DEF-2 新建实体向导 entityWizard 的段脚本骨架)。
 */

export function generatePythonContent(entity: EntityDefinition, part: EntityWizardPart): string {
  const name = entity.config.name;
  const lines: string[] = [];

  // 文件头
  lines.push('# -*- coding: utf-8 -*-');
  lines.push(`#`);
  lines.push(`# ${name} (${part} 段)`);
  if (entity.config.description) {
    lines.push(`# ${entity.config.description}`);
  }
  lines.push(`# 生成时间: ${new Date().toISOString()}`);
  lines.push(`#`);
  lines.push('');
  lines.push('import KBEngine');
  lines.push('');
  lines.push('');
  lines.push(`class ${name}(KBEngine.Entity):`);
  lines.push('');
  lines.push('    def __init__(self):');
  lines.push('        KBEngine.Entity.__init__(self)');
  // GEN-DEF-1(用户令 2026-11-02):容器属性 __init__ 初始化守卫——仅该段
  // (Flags 域)的 FIXED_DICT/ARRAY 引用型生成 `if self.<prop> is None:`,
  // 简单类型不生成,绝不 `if not self.`(falsy 判断会把引擎合法默认
  // 0/""/[] 误判并重建,引用失效;口径同 entityWizard.containerGuardProperties)。
  for (const property of partPropertiesOf(entity, part)) {
    const guardEmpty = containerGuardEmptyOf(property.type, name);
    if (guardEmpty === null) {
      continue;
    }
    lines.push(`        if self.${property.name} is None:`);
    lines.push(`            self.${property.name} = ${guardEmpty}`);
  }
  lines.push('');
  lines.push('    def onTimer(self, id, userArg):');
  lines.push('        """');
  lines.push('        KBEngine method.');
  lines.push('        使用 addTimer 后, 当时间到达则该接口被调用');
  lines.push('        @param id: addTimer 的返回值 ID');
  lines.push('        @param userArg: addTimer 最后一个参数所给入的数据');
  lines.push('        """');
  lines.push('        pass');
  lines.push('');

  if (part === 'base') {
    // base 段:onWriteToDB(self, cellData) —— cellData 即「cell 数据字典」约定
    lines.push('    def onWriteToDB(self, cellData):');
    lines.push('        """');
    lines.push('        KBEngine method.');
    lines.push('        将 cell 数据持久化到数据库时调用, cellData 为需要保存的 cell 数据字典。');
    lines.push('        """');
    lines.push('        pass');
    lines.push('');
    if (entity.baseMethods && entity.baseMethods.length > 0) {
      lines.push('    # ----------------------- Base 方法 -----------------------');
      lines.push('');
      for (const method of entity.baseMethods) {
        lines.push(generatePythonMethodCode(method));
      }
    }
  } else if (part === 'cell') {
    lines.push('    def onEnterWorld(self):');
    lines.push('        """');
    lines.push('        KBEngine method.');
    lines.push('        进入世界时调用（仅 Cell 段实体）');
    lines.push('        """');
    lines.push('        pass');
    lines.push('');
    lines.push('    def onLeaveWorld(self):');
    lines.push('        """');
    lines.push('        KBEngine method.');
    lines.push('        离开世界时调用（仅 Cell 段实体）');
    lines.push('        """');
    lines.push('        pass');
    lines.push('');
    if (entity.cellMethods && entity.cellMethods.length > 0) {
      lines.push('    # ----------------------- Cell 方法 -----------------------');
      lines.push('');
      for (const method of entity.cellMethods) {
        lines.push(generatePythonMethodCode(method));
      }
    }
  } else {
    lines.push('    def onClientEnabled(self):');
    lines.push('        """');
    lines.push('        KBEngine method.');
    lines.push('        该 entity 被正式激活为可使用, 此时已建立 client 对应实体。');
    lines.push('        """');
    lines.push('        pass');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 引擎段清单:hasBase→base、hasCell→cell、hasClient→client(对齐新向导
 * entityWizardPartsToGenerate 的段映射)。
 */

export function generatePythonMethodCode(method: MethodDefinition): string {
  const lines: string[] = [];

  // 方法签名
  const args = method.args ? method.args.map(a => a.name).join(', ') : '';
  lines.push(`    def ${method.name}(self${args ? ', ' + args : ''}):`);
  lines.push(`        """`);
  lines.push(`        ${method.name} 方法`);
  if (method.returnType) {
    lines.push(`        返回: ${method.returnType}`);
  }
  lines.push(`        """`);
  lines.push(`        pass`);
  lines.push('');

  return lines.join('\n');
}

/**
 * 在 entities.xml 中注册实体。
 * AUD-064:回滚记账进调用方的本次调用账本(每次调用独立,不共享实例状态)。
 */

export function generateEntityRegistration(config: EntityTypeConfig): string {
  const attrs: string[] = [];

  attrs.push(`hasCell="${config.hasCell}"`);
  attrs.push(`hasBase="${config.hasBase}"`);
  attrs.push(`hasClient="${config.hasClient}"`);

  return `  <${config.name} ${attrs.join(' ')} />`;
}

/**
 * 显示生成器向导
 */

export function getEmptyTemplate(): EntityDefinition {
  return {
    config: {
      name: 'EmptyEntity',
      hasBase: true,
      hasCell: false,
      hasClient: false,
      description: '空实体模板'
    }
  };
}

/**
 * 获取账号实体模板
 */

export function getAccountTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Account',
      hasBase: true,
      hasCell: false,
      hasClient: true,
      description: '玩家账号实体'
    },
    baseProperties: [
      { name: 'accountName', type: 'STRING', flags: 'BASE', default: '""', dbLength: 64, persistent: true },
      { name: 'password', type: 'STRING', flags: 'BASE', default: '""', dbLength: 64, persistent: true },
      { name: 'lastLoginTime', type: 'UINT64', flags: 'BASE', default: '0', persistent: true }
    ],
    baseMethods: [
      { name: 'login', exposed: true, args: [{ name: 'password', type: 'STRING' }] },
      { name: 'createAvatar', exposed: true, args: [{ name: 'roleType', type: 'UINT8' }] }
    ]
  };
}

/**
 * 获取角色实体模板
 */

export function getAvatarTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Avatar',
      hasBase: true,
      hasCell: true,
      hasClient: true,
      description: '游戏角色实体'
    },
    baseProperties: [
      { name: 'name', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
      { name: 'roleType', type: 'UINT8', flags: 'BASE', default: '0', persistent: true },
      { name: 'level', type: 'UINT32', flags: 'BASE', default: '1', persistent: true },
      { name: 'exp', type: 'UINT64', flags: 'BASE', default: '0', persistent: true }
    ],
    // position/direction/spaceID 为引擎受限名(ENTITY_LIMITED_PROPERTYS),
    // hasCell 实体由引擎自动提供,在 <Properties> 中声明会导致实体加载失败
    cellProperties: [
      { name: 'hp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_OWN', default: '100' },
      { name: 'mp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_OWN', default: '100' }
    ],
    clientMethods: [
      { name: 'onHPChanged', exposed: true, args: [{ name: 'oldHP', type: 'UINT32' }, { name: 'newHP', type: 'UINT32' }] }
    ],
    cellMethods: [
      { name: 'moveTo', exposed: true, args: [{ name: 'position', type: 'VECTOR3' }] },
      { name: 'takeDamage', exposed: true, args: [{ name: 'damage', type: 'UINT32' }] }
    ]
  };
}

/**
 * 获取 NPC 实体模板
 */

export function getNpcTemplate(): EntityDefinition {
  return {
    config: {
      name: 'NPC',
      hasBase: true,
      hasCell: true,
      hasClient: true,
      description: '非玩家角色实体'
    },
    baseProperties: [
      { name: 'npcID', type: 'UINT32', flags: 'BASE', default: '0', persistent: true },
      { name: 'name', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true }
    ],
    cellProperties: [
      { name: 'hp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_OWN', default: '100' }
    ]
  };
}

/**
 * 获取物品实体模板
 */

export function getItemTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Item',
      hasBase: true,
      hasCell: false,
      hasClient: true,
      description: '游戏物品实体'
    },
    baseProperties: [
      { name: 'itemID', type: 'UINT32', flags: 'BASE', default: '0', persistent: true },
      { name: 'itemType', type: 'UINT8', flags: 'BASE', default: '0', persistent: true },
      { name: 'count', type: 'UINT32', flags: 'BASE', default: '1', persistent: true }
    ]
  };
}

/**
 * 获取怪物实体模板
 */

export function getMonsterTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Monster',
      hasBase: true,
      hasCell: true,
      hasClient: true,
      description: '游戏怪物实体'
    },
    baseProperties: [
      { name: 'monsterID', type: 'UINT32', flags: 'BASE', default: '0', persistent: true },
      { name: 'name', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
      { name: 'level', type: 'UINT8', flags: 'BASE', default: '1', persistent: true },
      { name: 'respawnTime', type: 'UINT32', flags: 'BASE', default: '0', persistent: true }
    ],
    cellProperties: [
      { name: 'hp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_OWN', default: '100' },
      { name: 'moveSpeed', type: 'FLOAT', flags: 'CELL_PRIVATE', default: '5.0' },
      { name: 'aggroRange', type: 'UINT32', flags: 'CELL_PRIVATE', default: '20' }
    ],
    baseMethods: [
      { name: 'respawn' }
    ],
    cellMethods: [
      { name: 'takeDamage', exposed: true, args: [{ name: 'damage', type: 'UINT32' }] },
      { name: 'die' }
    ],
    clientMethods: [
      { name: 'onMonsterDead', args: [{ name: 'killerID', type: 'UINT64' }] }
    ]
  };
}

/**
 * 获取场景实体模板
 */

export function getSpaceTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Space',
      hasBase: true,
      hasCell: true,
      hasClient: false,
      description: '场景/空间实体'
    },
    baseProperties: [
      { name: 'spaceKey', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
      { name: 'spaceType', type: 'UINT8', flags: 'BASE', default: '0', persistent: true }
    ],
    cellMethods: [
      { name: 'onEnter', exposed: true, args: [{ name: 'entityCall', type: 'ENTITYCALL' }] },
      { name: 'onLeave', exposed: true, args: [{ name: 'entityCall', type: 'ENTITYCALL' }] }
    ]
  };
}

/**
 * 获取公会实体模板
 */

export function getGuildTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Guild',
      hasBase: true,
      hasCell: false,
      hasClient: true,
      description: '玩家公会实体'
    },
    baseProperties: [
      { name: 'guildName', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
      { name: 'level', type: 'UINT8', flags: 'BASE', default: '1', persistent: true },
      { name: 'announcement', type: 'STRING', flags: 'BASE', default: '""', dbLength: 256, persistent: true },
      { name: 'memberCount', type: 'UINT8', flags: 'BASE', default: '0', persistent: true }
    ],
    baseMethods: [
      { name: 'inviteMember', exposed: true, args: [{ name: 'memberID', type: 'UINT64' }] },
      { name: 'kickMember', exposed: true, args: [{ name: 'memberID', type: 'UINT64' }] },
      { name: 'disband' }
    ],
    clientMethods: [
      { name: 'onGuildLevelChanged', args: [{ name: 'newLevel', type: 'UINT8' }] }
    ]
  };
}

/**
 * 获取队伍实体模板
 */

export function getTeamTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Team',
      hasBase: true,
      hasCell: false,
      hasClient: true,
      description: '玩家组队实体'
    },
    baseProperties: [
      { name: 'captainID', type: 'UINT64', flags: 'BASE', default: '0', persistent: true },
      { name: 'maxMemberCount', type: 'UINT8', flags: 'BASE', default: '5', persistent: true },
      { name: 'memberIDs', type: 'ARRAY<of>UINT64</of>', flags: 'BASE', persistent: true }
    ],
    baseMethods: [
      { name: 'joinTeam', exposed: true, args: [{ name: 'memberID', type: 'UINT64' }] },
      { name: 'leaveTeam', exposed: true, args: [{ name: 'memberID', type: 'UINT64' }] }
    ],
    clientMethods: [
      { name: 'onTeamChanged' }
    ]
  };
}

/**
 * 获取邮件实体模板
 */

export function getMailTemplate(): EntityDefinition {
  return {
    config: {
      name: 'Mail',
      hasBase: true,
      hasCell: false,
      hasClient: true,
      description: '游戏邮件实体'
    },
    baseProperties: [
      { name: 'senderName', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
      { name: 'receiverID', type: 'UINT64', flags: 'BASE', default: '0', persistent: true },
      { name: 'title', type: 'STRING', flags: 'BASE', default: '""', dbLength: 64, persistent: true },
      { name: 'content', type: 'STRING', flags: 'BASE', default: '""', dbLength: 256, persistent: true },
      { name: 'sendTime', type: 'UINT64', flags: 'BASE', default: '0', persistent: true },
      { name: 'isRead', type: 'UINT8', flags: 'BASE', default: '0', persistent: true }
    ],
    baseMethods: [
      { name: 'markRead', exposed: true },
      { name: 'deleteMail', exposed: true }
    ],
    clientMethods: [
      { name: 'onMailReceived' }
    ]
  };
}

/**
 * 清理资源
 */
