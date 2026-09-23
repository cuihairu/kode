/**
 * KBEngine 实体脚本回调数据
 *
 * 全部条目依据本机 KBEngine 源码取证：
 * 每个回调的 sourceLocation 指向引擎调用该脚本回调的确切位置；
 * 签名参数取自调用点的 Py_BuildValue / SCRIPT_OBJECT_CALL_ARGS 格式串。
 * 未在源码中出现的回调一律不收录。
 */

export interface KBEngineHook {
  /** 回调名称 */
  name: string;
  /** 回调分类 */
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
  /** 引擎源码调用位置（文件:行号） */
  sourceLocation?: string;
}

export type HookCategory =
  | 'lifecycle'      // 实体生命周期
  | 'database'       // 数据库与归档
  | 'movement'       // 移动
  | 'space'          // 空间
  | 'teleport'       // 传送
  | 'trap'           // 陷阱
  | 'cell'           // Cell
  | 'witness'        // 视野
  | 'control'        // 控制权
  | 'client';        // 客户端

export const KBENGINE_HOOKS: KBEngineHook[] = [
  // ==================== 实体生命周期 ====================
  {
    name: 'onDestroy',
    category: 'lifecycle',
    description: '实体销毁时调用',
    documentation: '实体被销毁前由引擎调用，用于清理定时器、保存数据等收尾工作。baseapp 与 cellapp 侧的实体销毁都会触发。',
    signature: 'def onDestroy(self):',
    timing: '实体销毁前',
    example: `def onDestroy(self):
    INFO_MSG(f"{self.__class__.__name__} destroyed")
    self.delTimer(self.timerID)`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:169; kbe/src/server/cellapp/entity.cpp:209'
  },
  {
    name: 'onTimer',
    category: 'lifecycle',
    description: '实体定时器触发时调用',
    documentation: 'addTimer 注册的定时器到期时调用。cellapp 与 baseapp 实体都支持；第二参数为注册时传入的用户整数。',
    signature: 'def onTimer(self, timerID, userArg=None):',
    timing: '定时器到期时',
    example: `def onTimer(self, timerID, userArg=None):
    INFO_MSG(f"timer {timerID} fired with userArg={userArg}")
    self.delTimer(timerID)`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:4322; kbe/src/server/baseapp/entity.cpp:1656'
  },
  {
    name: 'onRestore',
    category: 'lifecycle',
    description: '实体从存档恢复时调用',
    documentation: 'app 进程重启后实体从数据库或内存快照恢复完成时调用，可用于重新初始化运行期状态。',
    signature: 'def onRestore(self):',
    timing: '实体恢复后',
    example: `def onRestore(self):
    INFO_MSG("Entity restored")
    self.rebuildRuntimeState()`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3868; kbe/src/server/baseapp/entity.cpp:1083'
  },

  // ==================== 数据库与归档 ====================
  {
    name: 'onWriteToDB',
    category: 'database',
    description: '实体写入数据库时调用',
    documentation: '实体数据落库时调用。baseapp 侧调用时附带一个 EntityDBContext 参数；cellapp 侧无参数。',
    signature: 'def onWriteToDB(self, dbContext=None):',
    timing: '写入数据库前',
    example: `def onWriteToDB(self, dbContext=None):
    INFO_MSG("Writing to database")
    self.lastSavedAt = time.time()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1399; kbe/src/server/cellapp/entity.cpp:1259'
  },
  {
    name: 'onPreArchive',
    category: 'database',
    description: '实体归档前调用',
    documentation: 'baseapp 按归档间隔把脏属性写入归档缓冲前调用，可用于整理需要持久化的数据。',
    signature: 'def onPreArchive(self):',
    timing: '每次归档前',
    example: `def onPreArchive(self):
    if self.dirty:
        self.checksum = self.computeChecksum()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1292'
  },

  // ==================== 移动 ====================
  {
    name: 'onMove',
    category: 'movement',
    description: '寻路移动过程中每步调用',
    documentation: '实体通过 addProximity/addNavigator 相关的移动控制器沿路径移动时，每到一点触发一次。第二参数为注册控制器时传入的用户整数。',
    signature: 'def onMove(self, controllerID, userArg=None):',
    timing: '移动控制器每次推进时',
    example: `def onMove(self, controllerID, userArg=None):
    DEBUG_MSG(f"moving, controller={controllerID}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2943'
  },
  {
    name: 'onMoveOver',
    category: 'movement',
    description: '一段路径移动完成时调用',
    documentation: '移动控制器走完注册的整条路径后调用。',
    signature: 'def onMoveOver(self, controllerID, userArg=None):',
    timing: '路径走完时',
    example: `def onMoveOver(self, controllerID, userArg=None):
    INFO_MSG("arrived at destination")
    self.cancelController(controllerID)`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2961'
  },
  {
    name: 'onMoveFailure',
    category: 'movement',
    description: '移动失败时调用',
    documentation: '移动控制器推进失败（如目标不可达）时调用。',
    signature: 'def onMoveFailure(self, controllerID, userArg=None):',
    timing: '移动失败时',
    example: `def onMoveFailure(self, controllerID, userArg=None):
    WARNING_MSG("move failed")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2979'
  },
  {
    name: 'onTurn',
    category: 'movement',
    description: '转向控制器完成转向时调用',
    documentation: '实体使用转向控制器旋转到目标朝向后调用。',
    signature: 'def onTurn(self, controllerID, userArg=None):',
    timing: '转向完成时',
    example: `def onTurn(self, controllerID, userArg=None):
    DEBUG_MSG(f"facing new direction, controller={controllerID}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3095'
  },

  // ==================== 空间 ====================
  {
    name: 'onEnterSpace',
    category: 'space',
    description: '实体进入空间时调用',
    documentation: '实体在 cellapp 上完成空间初始化后调用。源码调用时不带参数。',
    signature: 'def onEnterSpace(self):',
    timing: '进入空间后',
    example: `def onEnterSpace(self):
    INFO_MSG("Entered space")
    self.currentSpaceID = self.spaceID`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3820'
  },
  {
    name: 'onLeaveSpace',
    category: 'space',
    description: '实体离开空间时调用',
    documentation: '实体即将从当前空间移除时调用。源码调用时不带参数。',
    signature: 'def onLeaveSpace(self):',
    timing: '离开空间前',
    example: `def onLeaveSpace(self):
    INFO_MSG("Left space")
    self.currentSpaceID = None`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3828'
  },
  {
    name: 'onSpaceGone',
    category: 'space',
    description: '所在空间消失时调用',
    documentation: '实体所在空间被回收（如 cellapp 下线）时调用，之后实体通常会被销毁或迁移。',
    signature: 'def onSpaceGone(self):',
    timing: '空间消失时',
    example: `def onSpaceGone(self):
    WARNING_MSG("space has gone")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:384'
  },

  // ==================== 传送 ====================
  {
    name: 'onTeleport',
    category: 'teleport',
    description: '实体开始传送时调用',
    documentation: 'teleportSpaceID/teleport 等传送流程启动后、实体从当前 cell 移除前调用。源码调用时不带参数。',
    signature: 'def onTeleport(self):',
    timing: '传送开始时',
    example: `def onTeleport(self):
    INFO_MSG(f"teleporting to space {self.teleportSpaceID}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3783'
  },
  {
    name: 'onTeleportSuccess',
    category: 'teleport',
    description: '传送完成时调用',
    documentation: 'cellapp 侧完成传送后回调并附带目标点附近的实体（可能为 None）；baseapp 侧流程结束时无参调用。',
    signature: 'def onTeleportSuccess(self, nearbyEntity=None):',
    timing: '传送成功后',
    example: `def onTeleportSuccess(self, nearbyEntity=None):
    INFO_MSG("teleport success")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3811; kbe/src/server/baseapp/entity.cpp:1561'
  },
  {
    name: 'onTeleportFailure',
    category: 'teleport',
    description: '传送失败时调用',
    documentation: '传送目标空间或目标点无法到达时调用。baseapp 与 cellapp 侧均无参数。',
    signature: 'def onTeleportFailure(self):',
    timing: '传送失败时',
    example: `def onTeleportFailure(self):
    ERROR_MSG("teleport failed")`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1552; kbe/src/server/cellapp/entity.cpp:3794'
  },

  // ==================== 陷阱 ====================
  {
    name: 'onEnterTrap',
    category: 'trap',
    description: '其他实体进入本实体陷阱范围时调用',
    documentation: 'addTrapRange 注册的陷阱区域有实体进入时调用。参数依次为进入的实体、xz 平面半径、y 轴半径、控制器 ID 与用户整数。',
    signature: 'def onEnterTrap(self, entity, range_xz, range_y, controllerID, userArg=None):',
    timing: '实体进入陷阱时',
    example: `def onEnterTrap(self, entity, range_xz, range_y, controllerID, userArg=None):
    INFO_MSG(f"{entity.className} entered trap")
    self.engage(entity)`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1756'
  },
  {
    name: 'onLeaveTrap',
    category: 'trap',
    description: '其他实体离开本实体陷阱范围时调用',
    documentation: 'addTrapRange 注册的陷阱区域有实体离开时调用，参数与 onEnterTrap 相同。',
    signature: 'def onLeaveTrap(self, entity, range_xz, range_y, controllerID, userArg=None):',
    timing: '实体离开陷阱时',
    example: `def onLeaveTrap(self, entity, range_xz, range_y, controllerID, userArg=None):
    DEBUG_MSG(f"{entity.className} left trap")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1765'
  },
  {
    name: 'onLeaveTrapID',
    category: 'trap',
    description: '实体通过 ID 离开陷阱范围时调用',
    documentation: '与 onLeaveTrap 类似，但第一个参数是离开实体的 ID 而非实体对象。',
    signature: 'def onLeaveTrapID(self, entityID, range_xz, range_y, controllerID, userArg=None):',
    timing: '实体离开陷阱时（实体已不可用时）',
    example: `def onLeaveTrapID(self, entityID, range_xz, range_y, controllerID, userArg=None):
    DEBUG_MSG(f"entity {entityID} left trap")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1774'
  },

  // ==================== Cell ====================
  {
    name: 'onGetCell',
    category: 'cell',
    description: 'baseapp 侧实体拿到 cell 实体时调用',
    documentation: 'createCell 流程完成、baseapp 侧实体收到 cell 创建结果后调用。源码调用时不带参数。',
    signature: 'def onGetCell(self):',
    timing: 'cell 实体创建完成后',
    example: `def onGetCell(self):
    INFO_MSG("cell entity created")
    self.cell.ready()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1032'
  },
  {
    name: 'onCreateCellFailure',
    category: 'cell',
    description: 'cell 实体创建失败时调用',
    documentation: 'createCell / createCellAnywhere 等流程失败时调用。源码调用时不带参数。',
    signature: 'def onCreateCellFailure(self):',
    timing: 'cell 创建失败时',
    example: `def onCreateCellFailure(self):
    ERROR_MSG("create cell failed")
    self.giveClientToFallback()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:884'
  },
  {
    name: 'onEnteredCell',
    category: 'cell',
    description: '实体进入新 cell 后调用',
    documentation: '实体（含迁移）完成进入新 cell 后调用。源码调用时不带参数。',
    signature: 'def onEnteredCell(self):',
    timing: '进入 cell 后',
    example: `def onEnteredCell(self):
    DEBUG_MSG("entered new cell")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3836'
  },
  {
    name: 'onEnteringCell',
    category: 'cell',
    description: '实体即将进入新 cell 时调用',
    documentation: '实体进入新 cell 之前调用，可在此做迁移前的最后准备。源码调用时不带参数。',
    signature: 'def onEnteringCell(self):',
    timing: '进入 cell 前',
    example: `def onEnteringCell(self):
    DEBUG_MSG("about to enter new cell")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3844'
  },
  {
    name: 'onLeavingCell',
    category: 'cell',
    description: '实体即将离开当前 cell 时调用',
    documentation: '实体离开当前 cell 之前调用。源码调用时不带参数。',
    signature: 'def onLeavingCell(self):',
    timing: '离开 cell 前',
    example: `def onLeavingCell(self):
    DEBUG_MSG("about to leave cell")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3852'
  },
  {
    name: 'onLeftCell',
    category: 'cell',
    description: '实体离开当前 cell 后调用',
    documentation: '实体完成离开当前 cell 后调用。源码调用时不带参数。',
    signature: 'def onLeftCell(self):',
    timing: '离开 cell 后',
    example: `def onLeftCell(self):
    DEBUG_MSG("left cell")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:3860'
  },

  // ==================== 视野 ====================
  {
    name: 'onGetWitness',
    category: 'witness',
    description: '实体首次被观察者看到时调用',
    documentation: '本实体开始被至少一个拥有视野的实体观察时调用（ witness 计数从 0 变为 1）。源码调用时不带参数。',
    signature: 'def onGetWitness(self):',
    timing: '获得第一个观察者时',
    example: `def onGetWitness(self):
    DEBUG_MSG("entity is now witnessed")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2177'
  },
  {
    name: 'onLoseWitness',
    category: 'witness',
    description: '实体不再被任何观察者看到时调用',
    documentation: '所有观察者都离开视野后调用（witness 计数归零）。源码调用时不带参数。',
    signature: 'def onLoseWitness(self):',
    timing: '失去全部观察者时',
    example: `def onLoseWitness(self):
    DEBUG_MSG("entity has no witnesses")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:2215'
  },
  {
    name: 'onWitnessed',
    category: 'witness',
    description: '实体观察状态变化时调用',
    documentation: '实体被观察状态发生变化时调用，参数为当前是否被观察的布尔值。',
    signature: 'def onWitnessed(self, isWitnessed):',
    timing: '观察状态变化时',
    example: `def onWitnessed(self, isWitnessed):
    if isWitnessed:
        self.playAppearAnimation()`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1483; kbe/src/server/cellapp/entity.cpp:1528'
  },
  {
    name: 'onEnteredView',
    category: 'witness',
    description: '其他实体进入本实体视野时调用',
    documentation: '另一个实体进入本实体（或本实体挂接的观察机制）的视野范围时调用，参数为进入的实体对象。',
    signature: 'def onEnteredView(self, entity):',
    timing: '实体进入视野时',
    example: `def onEnteredView(self, entity):
    INFO_MSG(f"{entity.className} entered view")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1783'
  },
  {
    name: 'onUpdateBegin',
    category: 'witness',
    description: '视野同步开始时调用',
    documentation: 'cellapp 的 witness 机制向客户端推送本轮视野属性更新前调用。源码调用时不带参数。',
    signature: 'def onUpdateBegin(self):',
    timing: '每轮视野同步开始前',
    example: `def onUpdateBegin(self):
    self.bufferClientUpdates = True`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:753'
  },
  {
    name: 'onUpdateEnd',
    category: 'witness',
    description: '视野同步结束时调用',
    documentation: 'cellapp 的 witness 机制完成本轮视野属性更新推送后调用。源码调用时不带参数。',
    signature: 'def onUpdateEnd(self):',
    timing: '每轮视野同步结束后',
    example: `def onUpdateEnd(self):
    self.flushPendingClientLogic()`,
    sourceLocation: 'kbe/src/server/cellapp/witness.cpp:899'
  },

  // ==================== 控制权 ====================
  {
    name: 'onLoseControlledBy',
    category: 'control',
    description: '实体失去被控制权时调用',
    documentation: '本实体被其他实体控制、之后控制关系解除时调用，参数为原控制者的实体 ID。',
    signature: 'def onLoseControlledBy(self, controllerID):',
    timing: '失去被控制权时',
    example: `def onLoseControlledBy(self, controllerID):
    WARNING_MSG(f"no longer controlled by {controllerID}")`,
    sourceLocation: 'kbe/src/server/cellapp/entity.cpp:1510'
  },

  // ==================== 客户端 ====================
  {
    name: 'onClientEnabled',
    category: 'client',
    description: '客户端就绪可以通信时调用',
    documentation: 'Proxy 实体绑定的客户端完成握手、可以开始收发消息后调用。源码调用时不带参数。',
    signature: 'def onClientEnabled(self):',
    timing: '客户端就绪后',
    example: `def onClientEnabled(self):
    INFO_MSG("client enabled")
    self.client.onInitDone()`,
    sourceLocation: 'kbe/src/server/baseapp/proxy.cpp:178'
  },
  {
    name: 'onLogOnAttempt',
    category: 'client',
    description: '客户端重复登录尝试时调用',
    documentation: '已有实体在用时又有客户端尝试以同一账号登录时调用，返回 False 拒绝新连接、返回 True 允许顶替。',
    signature: 'def onLogOnAttempt(self, clientIP, clientPort, clientID):',
    timing: '登录尝试被转发到已存在实体时',
    example: `def onLogOnAttempt(self, clientIP, clientPort, clientID):
    INFO_MSG(f"relogon attempt from {clientIP}:{clientPort}")
    return True`,
    sourceLocation: 'kbe/src/server/baseapp/proxy.cpp:189; kbe/src/server/baseapp/proxy.cpp:205'
  },
  {
    name: 'onClientDeath',
    category: 'client',
    description: '客户端断开连接时调用',
    documentation: 'Proxy/baseapp 实体的客户端网络断开时调用。引擎默认随后销毁实体；如需保留可在其中返回处理。',
    signature: 'def onClientDeath(self):',
    timing: '客户端断开时',
    example: `def onClientDeath(self):
    WARNING_MSG("client disconnected")
    self.writeToDB()`,
    sourceLocation: 'kbe/src/server/baseapp/entity.cpp:1048; kbe/src/server/baseapp/proxy.cpp:237'
  },
  {
    name: 'onClientGetCell',
    category: 'client',
    description: '客户端切换到 cell 实体前调用',
    documentation: 'giveClientTo 等流程把客户端控制权交给 cell 实体前，在 baseapp 侧调用。源码调用时不带参数。',
    signature: 'def onClientGetCell(self):',
    timing: '客户端即将被交给 cell 实体时',
    example: `def onClientGetCell(self):
    DEBUG_MSG("client will be handed to cell")`,
    sourceLocation: 'kbe/src/server/baseapp/proxy.cpp:248'
  },
  {
    name: 'onStreamComplete',
    category: 'client',
    description: '二进制数据流下载完成时调用',
    documentation: '通过 streamToClient 发起的资源流传输结束（无论成功与否）时调用，参数为流 ID 与是否成功。',
    signature: 'def onStreamComplete(self, streamID, success):',
    timing: '数据流传输结束时',
    example: `def onStreamComplete(self, streamID, success):
    if success:
        INFO_MSG(f"stream {streamID} finished")`,
    sourceLocation: 'kbe/src/server/baseapp/proxy.cpp:832'
  }
];

// 钩子分类中文映射
export const HOOK_CATEGORY_NAMES: Record<HookCategory, string> = {
  lifecycle: '实体生命周期',
  database: '数据库与归档',
  movement: '移动',
  space: '空间',
  teleport: '传送',
  trap: '陷阱',
  cell: 'Cell',
  witness: '视野',
  control: '控制权',
  client: '客户端'
};

// 按分类获取钩子
export function getHooksByCategory(category: HookCategory): KBEngineHook[] {
  return KBENGINE_HOOKS.filter(hook => hook.category === category);
}

// 根据名称查找钩子
export function getHookByName(name: string): KBEngineHook | undefined {
  return KBENGINE_HOOKS.find(hook => hook.name === name);
}
