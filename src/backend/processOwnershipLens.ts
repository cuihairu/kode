/**
 * 进程归属纯核(PROC-TAG-001 立项 2026-11-13;PROC-BREADCRUMB-001 改面
 * 2026-11-18):「显示当前文件属于哪一个进程,根据 Flags 和 BaseMethods 和
 * CellMethods 之类的可以判断;其他进程也存在对应的文件也需要显示其他进程
 * 的 tag,可以点击快速切换文件」。展示面从文件顶部 CodeLens 迁到面包屑
 * 合成根节点(用户令:头部镜要拉到顶部才看到,不实用)。
 *
 * 判定链(按优先级,判不出就不出镜,诚实口径不猜):
 * 1. 目录角色:scripts/<role>/ 目录名 → 进程(base→baseapp、cell→cellapp、
 *    client→client、bots→bots)。scripts 与文件名之间的共享目录层
 *    (interfaces/interface/common)跳过后再认角色;跳过完直达文件名仍未见
 *    角色目录=判不出。
 * 2. def 区块佐证:目录判不出时,实现文件 def 声明的方法区块若恰好落在
 *    单一进程族(BaseMethods→baseapp / CellMethods→cellapp /
 *    ClientMethods→client)可佐证归属;跨族并存(双进程实体)或无区块=
 *    歧义/无证据,如实 null。
 * 3. 两者都判不出 → 不出镜。
 *
 * 互链:当前文件的 scripts/<role>/ 锚点展开到其余角色目录的同名文件
 * (cell/Hero.py ↔ base/Hero.py ↔ bots/Hero.py),存在者列为对端段。
 * 零 vscode 零 IO:文件存在性由调用方注入,本核只做路径推导。
 */

/** 进程名(lens 展示与互链排序的稳定词表) */
export type ProcessName = 'baseapp' | 'cellapp' | 'client' | 'bots';

/** scripts/ 下角色目录 → 进程(目录物理名即角色;client 与 bots 是两个
 * 独立进程形态,互链按物理目录对,不做 client↔bots 合并) */
const ROLE_DIR_TO_PROCESS: Readonly<Record<string, ProcessName>> = {
  base: 'baseapp',
  cell: 'cellapp',
  client: 'client',
  bots: 'bots'
};

/** 角色目录之间的共享目录层:角色判定时跳过(跳过后直达文件名=判不出) */
const SHARED_DIR_NAMES: ReadonlySet<string> = new Set(['interfaces', 'interface', 'common']);

/**
 * 判定链第一优先级:目录角色。路径按 / 与 \ 双分隔切段(工程实测两平台
 * 都会进来),取最深一层 scripts 段,向后跳过共享目录层,首个角色目录段
 * 即归属;无 scripts 段或角色判不出 → null(不出镜,不猜)。
 */
export function resolveScriptRole(fsPath: string): ProcessName | null {
  const segments = fsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  if (scriptsIndex < 0) {
    return null;
  }
  // 尾段是文件名,只扫目录段
  for (let i = scriptsIndex + 1; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (SHARED_DIR_NAMES.has(segment)) {
      continue;
    }
    return ROLE_DIR_TO_PROCESS[segment] ?? null;
  }
  return null;
}

/**
 * 判定链第二优先级:def 方法区块佐证。区块集合恰好落在单一进程族才
 * 佐证;跨族并存或空集=歧义/无证据,如实 null。bots 进程实现的是
 * client 侧实体脚本(BotsApp 框架),def 区块无法区分 client 与 bots,
 * 只佐证到 client——bots 归属只能由目录判定,这是判据的如实边界。
 */
export function processFromDefSections(sections: ReadonlySet<string>): ProcessName | null {
  const families = new Set<ProcessName>();
  if (sections.has('BaseMethods')) {
    families.add('baseapp');
  }
  if (sections.has('CellMethods')) {
    families.add('cellapp');
  }
  if (sections.has('ClientMethods')) {
    families.add('client');
  }
  return families.size === 1 ? [...families][0] : null;
}

/** 其他进程同名对应文件(互链 tag) */
export interface ProcessSiblingFile {
  readonly process: ProcessName;
  readonly path: string;
}

/** 进程归属规格:当前进程 + 其他进程同名文件(lens 渲染唯一输入形状) */
export interface ProcessOwnershipSpec {
  readonly current: ProcessName;
  readonly siblings: readonly ProcessSiblingFile[];
}

/**
 * 组装归属规格:目录角色判定 + 同名互链展开(其余角色目录同名文件,
 * 存在性由注入的 fileExists 判,本核零 IO)。目录判不出 → null(不出镜)。
 * 目录判得出但互链全缺 → siblings 空数组(只出当前进程展示镜)。
 */
export function buildProcessOwnershipSpec(
  fsPath: string,
  fileExists: (path: string) => boolean
): ProcessOwnershipSpec | null {
  const current = resolveScriptRole(fsPath);
  if (!current) {
    return null;
  }
  const segments = fsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  const name = segments[segments.length - 1];
  const prefix = segments.slice(0, scriptsIndex + 1);
  const seen = new Set<string>();
  const siblings: ProcessSiblingFile[] = [];
  for (const [dir, process] of Object.entries(ROLE_DIR_TO_PROCESS)) {
    if (process === current) {
      continue;
    }
    const candidate = [...prefix, dir, name].join('/');
    if (seen.has(candidate) || !fileExists(candidate)) {
      continue;
    }
    seen.add(candidate);
    siblings.push({ process, path: candidate });
  }
  return { current, siblings };
}

// ─── 面包屑进程切换器(PROC-BREADCRUMB-001,用户令 2026-11-18)──────────────
// 头部进程 CodeLens 已移除(拉到顶部才看到=不实用;面包屑常驻可见);判定链
// 与本文件纯核全量复用,合成根节点由 DocumentSymbolProvider 出(Outline 与
// 面包屑同源单点)。跨文件跳转 DocumentSymbol 无 command 面:child 落本文件
// 锚点(诚实降级),detail 携对端路径与 openCell/openBase 切换提示。

/** def 方法段 → 进程段(def 面数据源,与判定链同一词表) */
const DEF_SECTION_TO_PROCESS: Readonly<Record<string, ProcessName>> = {
  BaseMethods: 'baseapp',
  CellMethods: 'cellapp',
  ClientMethods: 'client'
};

/** 进程段 → scripts/ 角色目录名(对端 py 推导用) */
const PROCESS_TO_ROLE_DIR: Readonly<Record<ProcessName, string>> = {
  baseapp: 'base',
  cellapp: 'cell',
  client: 'client',
  bots: 'bots'
};

/** 面包屑子节点规格:进程段 + 本文件锚点(诚实降级跳转)+ 对端路径(可缺) */
export interface ProcessBreadcrumbChildSpec {
  readonly process: ProcessName;
  /** 本文件锚点段名(def 面=def 区块;python 面=null 无锚) */
  readonly section: string | null;
  /** 锚点区间(0 基行号,含头不含尾);无锚点=null */
  readonly anchor: { startLine: number; endLine: number } | null;
  /** 对端实现文件路径;推导不出或不存在=null(detail 如实不带) */
  readonly siblingPath: string | null;
}

/** 面包屑合成根节点规格(provider 半边唯一输入形状) */
export interface ProcessBreadcrumbSpec {
  /** `实体名 · 段1▸·段2…`(▸ 标锚定段;单段不加标记) */
  readonly name: string;
  readonly entityName: string;
  /** 进程段全列(锚定段排首位) */
  readonly processes: readonly ProcessName[];
  readonly children: readonly ProcessBreadcrumbChildSpec[];
}

/** 合成 name:锚定段(首位)带 ▸;单段不加标记(钉子1 口径) */
function breadcrumbName(entityName: string, processes: readonly ProcessName[]): string {
  const segments =
    processes.length > 1
      ? processes.map((process, index) => (index === 0 ? `${process}▸` : process))
      : [...processes];
  return `${entityName} · ${segments.join('·')}`;
}

/**
 * def 面合成根(.def 第一刀):进程段全列=本 def 声明的方法段映射,按文档序
 * (锚定段=文档序首段——def 无目录角色,「当前段」无判定面,取首段作锚定并
 * 排首位,▸ 只在多段时标);children=其余段,锚点=本文件对应 def 区块,
 * 对端路径=scripts/<role>/<实体名>.py(存在才带)。无方法段=null 不插节点。
 */
export function buildDefProcessBreadcrumb(
  defFsPath: string,
  sections: ReadonlyArray<{ section: string; startLine: number; endLine: number }>,
  fileExists: (path: string) => boolean
): ProcessBreadcrumbSpec | null {
  const seen = new Set<ProcessName>();
  const processes: ProcessName[] = [];
  const sectionByProcess = new Map<ProcessName, { section: string; startLine: number; endLine: number }>();
  for (const entry of sections) {
    const process = DEF_SECTION_TO_PROCESS[entry.section];
    if (!process || seen.has(process)) {
      continue;
    }
    seen.add(process);
    processes.push(process);
    sectionByProcess.set(process, entry);
  }
  if (processes.length === 0) {
    return null;
  }
  const segments = defFsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  const fileBase = segments[segments.length - 1];
  const entityName = fileBase.replace(/\.def$/i, '');
  const siblingOf = (process: ProcessName): string | null => {
    if (scriptsIndex < 0) {
      return null;
    }
    const candidate = [...segments.slice(0, scriptsIndex + 1), PROCESS_TO_ROLE_DIR[process], `${entityName}.py`].join('/');
    return fileExists(candidate) ? candidate : null;
  };
  const children: ProcessBreadcrumbChildSpec[] = [];
  for (const process of processes.slice(1)) {
    const block = sectionByProcess.get(process)!;
    children.push({
      process,
      section: block.section,
      anchor: { startLine: block.startLine, endLine: block.endLine },
      siblingPath: siblingOf(process)
    });
  }
  return {
    name: breadcrumbName(entityName, processes),
    entityName,
    processes,
    children
  };
}

/**
 * python 面合成根(第二刀):目录角色命中才出节点(判不出=null 零干扰
 * Pylance);进程段全列=当前+互链存在者,当前段(真·目录判定)带 ▸ 排首位。
 * children=互链段,无本文件锚点(anchor=null),对端路径=互链文件。
 */
export function buildPythonProcessBreadcrumb(
  fsPath: string,
  fileExists: (path: string) => boolean
): ProcessBreadcrumbSpec | null {
  const spec = buildProcessOwnershipSpec(fsPath, fileExists);
  if (!spec) {
    return null;
  }
  const segments = fsPath.split(/[\\/]/);
  const entityName = segments[segments.length - 1].replace(/\.py$/i, '');
  const processes: ProcessName[] = [spec.current, ...spec.siblings.map(sibling => sibling.process)];
  return {
    name: breadcrumbName(entityName, processes),
    entityName,
    processes,
    children: spec.siblings.map(sibling => ({
      process: sibling.process,
      section: null,
      anchor: null,
      siblingPath: sibling.path
    }))
  };
}
