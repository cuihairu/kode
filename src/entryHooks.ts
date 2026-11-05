/**
 * KBEngine 入口脚本（kbemain）模块级 SPI 回调数据
 *
 * 与 src/hooks.ts 的实体回调（带 self 的 entity method）分离：
 * 入口 SPI 由引擎经 getEntryScript() 调用，是模块级函数，不带 self。
 * 数据源：docs/knowledge/entry-script-spi-methods.md（宏签名/格式/file:line）。
 * sourceLocation 指向引擎调用该回调的确切行；未在源码中出现的回调一律不收录。
 * 当前收录范围：cellapp 空间/导航三件套（SP-1）；其余组件 SPI 后续按需追加。
 */

export interface KBEngineEntryHook {
  /** 回调名称 */
  name: string;
  /** 所属入口脚本组件（决定出现在哪个 kbemain.py） */
  component: 'cellapp';
  /** 简短描述 */
  description: string;
  /** 详细说明 */
  documentation: string;
  /** 模块级函数签名（无 self） */
  signature: string;
  /** 调用时机 */
  timing: string;
  /** 使用示例 */
  example?: string;
  /** 引擎源码调用位置（文件:行号，多个用 ; 分隔） */
  sourceLocation: string;
}

export const KBENGINE_ENTRY_HOOKS: KBEngineEntryHook[] = [
  {
    name: 'onSpaceData',
    component: 'cellapp',
    description: 'spaceData 键值变化时调用',
    documentation:
      'KBEngine.setSpaceData / delSpaceData 变更后由 SpaceMemory::onSpaceDataChanged 通知入口脚本。' +
      'set 路径格式串 Iss（spaceID, key, value），del 路径格式串 IsO（value 为 None）。' +
      '同一变更随后还会广播给空间内有 Witness 的实体（客户端 onSpaceData）。',
    signature: 'def onSpaceData(spaceID, key, value):',
    timing: 'spaceData 被 set/del 后',
    example: `def onSpaceData(spaceID, key, value):
    if value is None:
        DEBUG_MSG(f"space {spaceID} data {key} deleted")
    else:
        DEBUG_MSG(f"space {spaceID} data {key}={value}")`,
    sourceLocation:
      'kbe/src/server/cellapp/spacememory.cpp:613; kbe/src/server/cellapp/spacememory.cpp:619'
  },
  {
    name: 'onSpaceGeometryLoaded',
    component: 'cellapp',
    description: '单个 space 的几何/导航数据加载完成时调用',
    documentation:
      'addSpaceGeometryMapping(shouldLoadOnServer=True) 的异步 LoadNavmeshTask 完成后，' +
      'SpaceMemory::onLoadedSpaceGeometryMapping 回调本方法（格式串 Is：spaceID, mapping 路径），' +
      '随后同一函数内会继续触发 onAllSpaceGeometryLoaded。官方模板未实现本回调，按需在 cell/kbemain.py 补充。',
    signature: 'def onSpaceGeometryLoaded(spaceID, mapping):',
    timing: '该 space 导航/几何加载完成后',
    example: `def onSpaceGeometryLoaded(spaceID, mapping):
    INFO_MSG(f"space {spaceID} geometry ready: {mapping}")`,
    sourceLocation: 'kbe/src/server/cellapp/spacememory.cpp:308'
  },
  {
    name: 'onAllSpaceGeometryLoaded',
    component: 'cellapp',
    description: 'space 全部几何/导航数据就绪时调用',
    documentation:
      '在 onSpaceGeometryLoaded 之后由 SpaceMemory::onAllSpaceGeometryLoaded 触发' +
      '（格式串 Iis：spaceID, isBootstrap, mapping）。当前源码 isBootstrap 恒为 true，' +
      '表示本地空间几何加载完成；模板 kbemain.py 已实现空壳。',
    signature: 'def onAllSpaceGeometryLoaded(spaceID, isBootstrap, mapping):',
    timing: '该 space 几何加载链收尾时',
    example: `def onAllSpaceGeometryLoaded(spaceID, isBootstrap, mapping):
    INFO_MSG(f"space {spaceID} all geometry loaded (bootstrap={isBootstrap})")`,
    sourceLocation: 'kbe/src/server/cellapp/spacememory.cpp:336'
  }
];

/** 入口脚本组件 → 路径段（scripts/<seg>/kbemain.py） */
const COMPONENT_PATH_SEGMENT: Record<KBEngineEntryHook['component'], string> = {
  cellapp: 'cell'
};

/** 判断文件是否为入口脚本 kbemain.py（默认 entryScriptFile 名；不解析自定义配置名） */
export function isEntryScriptFile(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  return normalized.endsWith('/kbemain.py') || normalized === 'kbemain.py';
}

/** 判断文件是否为指定组件的入口脚本（路径含 /cell/kbemain.py 等） */
export function isComponentEntryScriptFile(fileName: string, component: KBEngineEntryHook['component']): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  const segment = COMPONENT_PATH_SEGMENT[component];
  return isEntryScriptFile(normalized) && normalized.includes(`/${segment}/kbemain.py`);
}

/** 根据名称查找入口 SPI 回调；未收录返回 undefined */
export function getEntryHookByName(name: string): KBEngineEntryHook | undefined {
  return KBENGINE_ENTRY_HOOKS.find(hook => hook.name === name);
}
