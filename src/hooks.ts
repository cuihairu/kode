/**
 * KBEngine 钩子系统数据
 * 基于 KBEngine 源码分析文档
 */

export interface KBEngineHook {
  /** 钩子名称 */
  name: string;
  /** 钩子分类 */
  category: HookCategory;
  /** 简短描述 */
  description: string;
  /** 详细说明 */
  documentation: string;
  /** 函数签名 */
  signature: string;
  /** 调用时机 */
  timing: string;
  /** 使用示例 */
  example?: string;
  /** 源码位置 */
  sourceLocation?: string;
}

export type HookCategory =
  | 'lifecycle'      // 实体生命周期
  | 'network'        // 网络
  | 'database'       // 数据库
  | 'movement'       // 移动
  | 'space'          // 空间
  | 'witness'        // 视野
  | 'position'       // 位置
  | 'teleport'       // 传送
  | 'trap'           // 陷阱
  | 'cell'           // Cell
  | 'script'         // 脚本
  | 'system';        // 系统

export const KBENGINE_HOOKS: KBEngineHook[] = [
  // ==================== 实体生命周期钩子 ====================
  {
    name: 'onCreate',
    category: 'lifecycle',
    description: '实体创建时调用',
    documentation: '在实体创建完成后立即调用，用于初始化实体属性和状态',
    signature: 'def onCreate(self):',
    timing: '实体创建后',
    example: `def onCreate(self):
    INFO_MSG(f"{self.__class__.__name__} created")
    self.hp = self.maxHP
    self.mp = self.maxMP`,
    sourceLocation: 'kbe/src/lib/entitydef/entity_macro.h:1000-1020'
  },
  {
    name: 'onDestroy',
    category: 'lifecycle',
    description: '实体销毁时调用',
    documentation: '在实体销毁前调用，用于清理资源和保存数据',
    signature: 'def onDestroy(self):',
    timing: '实体销毁前',
    example: `def onDestroy(self):
    INFO_MSG(f"{self.__class__.__name__} destroyed")
    self.writeToDB()
    self.delTimer(self.timerID)`,
    sourceLocation: 'kbe/src/lib/entitydef/entity_macro.h:1015-1030'
  },
  {
    name: 'onLogon',
    category: 'lifecycle',
    description: '玩家登录时调用',
    documentation: '玩家登录成功后，Proxy 实体创建时调用',
    signature: 'def onLogon(self, characterID):',
    timing: '玩家登录后',
    example: `def onLogon(self, characterID):
    INFO_MSG(f"Player {self.accountName} logged in")
    if characterID > 0:
        self.createEntityFromDBID(characterID, self.onCharacterLoaded)`
  },
  {
    name: 'onLogout',
    category: 'lifecycle',
    description: '玩家登出时调用',
    documentation: '玩家登出前调用，用于清理登录数据',
    signature: 'def onLogout(self):',
    timing: '玩家登出前',
    example: `def onLogout(self):
    INFO_MSG(f"Player {self.accountName} logged out")
    self.destroy()`
  },

  // ==================== 网络钩子 ====================
  {
    name: 'onRemoteCall',
    category: 'network',
    description: '远程方法调用时',
    documentation: '客户端或其他服务器调用实体方法时触发',
    signature: 'def onRemoteCall(self, methodID, data):',
    timing: '远程方法调用时',
    example: `def onRemoteCall(self, methodID, data):
    INFO_MSG(f"Remote call: methodID={methodID}")`
  },
  {
    name: 'onGetCell',
    category: 'network',
    description: '获取 Cell 实体时',
    documentation: '实体在 CellApp 中创建时调用（仅在 BaseApp 中）',
    signature: 'def onGetCell(self):',
    timing: 'Cell 实体创建后',
    example: `def onGetCell(self):
    INFO_MSG("Entity entered cell")
    self.cellData.syncLocation()`
  },
  {
    name: 'onRemoteCallCellMethod',
    category: 'network',
    description: '调用 Cell 方法时',
    documentation: '从 BaseApp 调用 CellApp 方法时触发',
    signature: 'def onRemoteCallCellMethod(self, methodID, data):',
    timing: 'Cell 方法调用时',
    example: `def onRemoteCallCellMethod(self, methodID, data):
    INFO_MSG(f"Cell method called: {methodID}")`
  },
  {
    name: 'onUpdateDataFromClient',
    category: 'network',
    description: '客户端更新数据时',
    documentation: '客户端修改实体属性时调用',
    signature: 'def onUpdateDataFromClient(self, data):',
    timing: '客户端数据更新时',
    example: `def onUpdateDataFromClient(self, data):
    INFO_MSG(f"Client updated data: {data}")`
  },
  {
    name: 'onClientDeath',
    category: 'network',
    description: '客户端断开连接时',
    documentation: '客户端网络断开时调用',
    signature: 'def onClientDeath(self):',
    timing: '客户端断开时',
    example: `def onClientDeath(self):
    WARNING_MSG(f"Client disconnected: {self.id}")
    self.destroy()`
  },
  {
    name: 'onClientGetTime',
    category: 'network',
    description: '获取服务器时间',
    documentation: '客户端请求服务器时间时调用',
    signature: 'def onClientGetTime(self):',
    timing: '时间请求时',
    example: `def onClientGetTime(self):
    return KBEngine.time()`
  },
  {
    name: 'onClientsReady',
    category: 'network',
    description: '客户端准备就绪',
    documentation: '所有客户端连接准备好时调用',
    signature: 'def onClientsReady(self, ready):',
    timing: '客户端准备时',
    example: `def onClientsReady(self, ready):
    INFO_MSG(f"Clients ready: {ready}")`
  },
  {
    name: 'onLogOnAttempt',
    category: 'network',
    description: '登录尝试时',
    documentation: '玩家尝试登录时调用，可用于验证',
    signature: 'def onLogOnAttempt(self, ip, port):',
    timing: '登录尝试时',
    example: `def onLogOnAttempt(self, ip, port):
    INFO_MSG(f"Login attempt from {ip}:{port}")
    return True  # 允许登录`
  },

  // ==================== 数据库钩子 ====================
  {
    name: 'onWriteToDB',
    category: 'database',
    description: '写入数据库前',
    documentation: '实体数据写入数据库前调用，可修改保存的数据',
    signature: 'def onWriteToDB(self):',
    timing: '写入数据库前',
    example: `def onWriteToDB(self):
    INFO_MSG("Writing to database")
    self.lastLoginTime = time.time()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1200-1250'
  },
  {
    name: 'onDBLoaded',
    category: 'database',
    description: '从数据库加载后',
    documentation: '实体数据从数据库加载完成后调用',
    signature: 'def onDBLoaded(self, dbRef):',
    timing: '数据库加载后',
    example: `def onDBLoaded(self, dbRef):
    INFO_MSG("Loaded from database")
    self.isNew = False`,
    sourceLocation: 'kbe/src/server/dbmgr/dbmgr.cpp:800-850'
  },
  {
    name: 'onSaveEntityCompleted',
    category: 'database',
    description: '保存实体完成',
    documentation: '实体保存到数据库完成后调用',
    signature: 'def onSaveEntityCompleted(self, success, dbRef):',
    timing: '保存完成后',
    example: `def onSaveEntityCompleted(self, success, dbRef):
    if success:
        INFO_MSG("Entity saved successfully")
    else:
        ERROR_MSG("Failed to save entity")`
  },

  // ==================== 移动钩子 ====================
  {
    name: 'onMove',
    category: 'movement',
    description: '实体移动时',
    documentation: '实体位置发生变化时调用',
    signature: 'def onMove(self, movement):',
    timing: '位置更新时',
    example: `def onMove(self, movement):
    INFO_MSG(f"Moving to {self.position}")`,
    sourceLocation: 'kbe/src/server/cellapp/move_controller.cpp:200-250'
  },
  {
    name: 'onMoveOver',
    category: 'movement',
    description: '移动完成时',
    documentation: '实体完成一次移动后调用',
    signature: 'def onMoveOver(self, movement):',
    timing: '移动完成后',
    example: `def onMoveOver(self, movement):
    INFO_MSG(f"Move over: {self.position}")`,
    sourceLocation: 'kbe/src/server/cellapp/move_controller.cpp:250-300'
  },
  {
    name: 'onMoveFailure',
    category: 'movement',
    description: '移动失败时',
    documentation: '实体移动失败时调用（如遇到障碍）',
    signature: 'def onMoveFailure(self, movement):',
    timing: '移动失败时',
    example: `def onMoveFailure(self, movement):
    WARNING_MSG("Move failed: obstacle detected")`,
    sourceLocation: 'kbe/src/server/cellapp/move_controller.cpp:300-350'
  },
  {
    name: 'onTurn',
    category: 'movement',
    description: '转向时',
    documentation: '实体方向改变时调用',
    signature: 'def onTurn(self):',
    timing: '方向改变时',
    example: `def onTurn(self):
    INFO_MSG(f"Turned to {self.direction}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1500-1550'
  },

  // ==================== 空间钩子 ====================
  {
    name: 'onEnterSpace',
    category: 'space',
    description: '进入空间时',
    documentation: '实体进入空间时调用',
    signature: 'def onEnterSpace(self, spaceID, isLogin):',
    timing: '进入空间时',
    example: `def onEnterSpace(self, spaceID, isLogin):
    INFO_MSG(f"Entered space {spaceID}")
    self.currentSpace = spaceID`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1000-1050'
  },
  {
    name: 'onLeaveSpace',
    category: 'space',
    description: '离开空间时',
    documentation: '实体离开空间时调用',
    signature: 'def onLeaveSpace(self, spaceID):',
    timing: '离开空间时',
    example: `def onLeaveSpace(self, spaceID):
    INFO_MSG(f"Left space {spaceID}")
    self.currentSpace = None`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1050-1100'
  },

  // ==================== 视野钩子 ====================
  {
    name: 'onGetWitness',
    category: 'witness',
    description: '获取视野时',
    documentation: '实体开始被其他实体感知时调用',
    signature: 'def onGetWitness(self):',
    timing: '获取视野时',
    example: `def onGetWitness(self):
    INFO_MSG("Entity now witnessed")`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:100-150'
  },
  {
    name: 'onLoseWitness',
    category: 'witness',
    description: '失去视野时',
    documentation: '实体不再被任何实体感知时调用',
    signature: 'def onLoseWitness(self):',
    timing: '失去视野时',
    example: `def onLoseWitness(self):
    INFO_MSG("Entity lost all witnesses")`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:150-200'
  },
  {
    name: 'onEnteredView',
    category: 'witness',
    description: '进入视野时',
    documentation: '其他实体进入本实体视野时调用',
    signature: 'def onEnteredView(self, entity):',
    timing: '实体进入视野时',
    example: `def onEnteredView(self, entity):
    INFO_MSG(f"{entity.__class__.__name__} entered view")`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:200-250'
  },
  {
    name: 'onLeaveView',
    category: 'witness',
    description: '离开视野时',
    documentation: '其他实体离开本实体视野时调用',
    signature: 'def onLeaveView(self, entity):',
    timing: '实体离开视野时',
    example: `def onLeaveView(self, entity):
    INFO_MSG(f"{entity.__class__.__name__} left view")`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:250-300'
  },

  // ==================== 位置钩子 ====================
  {
    name: 'onPositionChanged',
    category: 'position',
    description: '位置改变时',
    documentation: '实体的 position 属性改变时调用',
    signature: 'def onPositionChanged(self):',
    timing: '位置属性改变时',
    example: `def onPositionChanged(self):
    DEBUG_MSG(f"Position changed: {self.position}")`
  },
  {
    name: 'onDirectionChanged',
    category: 'position',
    description: '方向改变时',
    documentation: '实体的 direction 属性改变时调用',
    signature: 'def onDirectionChanged(self):',
    timing: '方向属性改变时',
    example: `def onDirectionChanged(self):
    DEBUG_MSG(f"Direction changed: {self.direction}")`
  },

  // ==================== 传送钩子 ====================
  {
    name: 'onTeleport',
    category: 'teleport',
    description: '传送开始时',
    documentation: '实体开始传送时调用',
    signature: 'def onTeleport(self, spaceID, position):',
    timing: '传送开始时',
    example: `def onTeleport(self, spaceID, position):
    INFO_MSG(f"Teleporting to space {spaceID}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2000-2050'
  },
  {
    name: 'onTeleportSuccess',
    category: 'teleport',
    description: '传送成功时',
    documentation: '实体传送成功后调用',
    signature: 'def onTeleportSuccess(self, entity):',
    timing: '传送成功后',
    example: `def onTeleportSuccess(self, entity):
    INFO_MSG("Teleport successful")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2050-2100'
  },
  {
    name: 'onTeleportFailure',
    category: 'teleport',
    description: '传送失败时',
    documentation: '实体传送失败时调用',
    signature: 'def onTeleportFailure(self, entity, reason):',
    timing: '传送失败时',
    example: `def onTeleportFailure(self, entity, reason):
    ERROR_MSG(f"Teleport failed: {reason}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2100-2150'
  },

  // ==================== 陷阱钩子 ====================
  {
    name: 'onEnterTrap',
    category: 'trap',
    description: '进入陷阱时',
    documentation: '实体进入陷阱区域时调用',
    signature: 'def onEnterTrap(self, entity, trapID):',
    timing: '进入陷阱时',
    example: `def onEnterTrap(self, entity, trapID):
    INFO_MSG(f"{entity.__class__.__name__} entered trap {trapID}")`
  },
  {
    name: 'onLeaveTrap',
    category: 'trap',
    description: '离开陷阱时',
    documentation: '实体离开陷阱区域时调用',
    signature: 'def onLeaveTrap(self, entity, trapID):',
    timing: '离开陷阱时',
    example: `def onLeaveTrap(self, entity, trapID):
    INFO_MSG(f"{entity.__class__.__name__} left trap {trapID}")`
  },

  // ==================== Cell 钩子 ====================
  {
    name: 'onEnteredCell',
    category: 'cell',
    description: '进入 Cell 时',
    documentation: '实体进入新 Cell 时调用',
    signature: 'def onEnteredCell(self):',
    timing: '进入 Cell 后',
    example: `def onEnteredCell(self):
    DEBUG_MSG("Entered new cell")`
  },
  {
    name: 'onEnteringCell',
    category: 'cell',
    description: '即将进入 Cell 时',
    documentation: '实体即将进入新 Cell 时调用（在进入前）',
    signature: 'def onEnteringCell(self):',
    timing: '进入 Cell 前',
    example: `def onEnteringCell(self):
    DEBUG_MSG("About to enter new cell")`
  },
  {
    name: 'onLeavingCell',
    category: 'cell',
    description: '即将离开 Cell 时',
    documentation: '实体即将离开当前 Cell 时调用',
    signature: 'def onLeavingCell(self):',
    timing: '离开 Cell 前',
    example: `def onLeavingCell(self):
    DEBUG_MSG("About to leave cell")`
  },
  {
    name: 'onLeftCell',
    category: 'cell',
    description: '离开 Cell 后',
    documentation: '实体离开当前 Cell 后调用',
    signature: 'def onLeftCell(self):',
    timing: '离开 Cell 后',
    example: `def onLeftCell(self):
    DEBUG_MSG("Left cell")`
  },

  // ==================== 脚本钩子 ====================
  {
    name: 'onScriptAppReady',
    category: 'script',
    description: '脚本准备就绪',
    documentation: '所有脚本加载完成后调用',
    signature: 'def onScriptAppReady(self):',
    timing: '脚本加载完成后',
    example: `def onScriptAppReady(self):
    INFO_MSG("All scripts loaded and ready")`,
    sourceLocation: 'kbe/src/server/baseapp/baseapp.cpp:500-550'
  },
  {
    name: 'onScriptAppTick',
    category: 'script',
    description: '脚本定时器',
    documentation: '每帧调用的脚本钩子',
    signature: 'def onScriptAppTick(self):',
    timing: '每帧调用',
    example: `def onScriptAppTick(self):
    # 每帧调用的逻辑
    pass`
  },

  // ==================== 系统钩子 ====================
  {
    name: 'onShuttingDown',
    category: 'system',
    description: '系统关闭开始',
    documentation: '服务器开始关闭时调用',
    signature: 'def onShuttingDown(self):',
    timing: '关闭开始时',
    example: `def onShuttingDown(self):
    INFO_MSG("Server is shutting down")
    self.saveAllData()`,
    sourceLocation: 'kbe/src/server/baseapp/baseapp.cpp:1000-1050'
  },
  {
    name: 'onGlobalTick',
    category: 'system',
    description: '全局定时器',
    documentation: '服务器全局定时器钩子',
    signature: 'def onGlobalTick(self):',
    timing: '每帧调用',
    example: `def onGlobalTick(self):
    # 全局定时逻辑
    pass`
  }
];

// 钩子分类中文映射
export const HOOK_CATEGORY_NAMES: Record<HookCategory, string> = {
  lifecycle: '实体生命周期',
  network: '网络',
  database: '数据库',
  movement: '移动',
  space: '空间',
  witness: '视野',
  position: '位置',
  teleport: '传送',
  trap: '陷阱',
  cell: 'Cell',
  script: '脚本',
  system: '系统'
};

// 按分类获取钩子
export function getHooksByCategory(category: HookCategory): KBEngineHook[] {
  return KBENGINE_HOOKS.filter(hook => hook.category === category);
}

// 根据名称查找钩子
export function getHookByName(name: string): KBEngineHook | undefined {
  return KBENGINE_HOOKS.find(hook => hook.name === name);
}
