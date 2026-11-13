/**
 * 文件顶部进程归属纯核(PROC-TAG-001,用户令 2026-11-13):
 * 「在文件的顶部显示当前文件属于哪一个进程,根据 Flags 和 BaseMethods 和
 * CellMethods 之类的可以判断;其他进程也存在对应的文件也需要显示其他进程
 * 的 tag,可以点击快速切换文件」。
 *
 * 判定链(任务单口径,按优先级,判不出就不出镜,诚实口径不猜):
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
 * (cell/Hero.py ↔ base/Hero.py ↔ bots/Hero.py),存在者列为可点击 tag
 * (lens 半边负责换成 vscode 命令)。零 vscode 零 IO:文件存在性由调用方
 * 注入,本核只做路径推导。
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
