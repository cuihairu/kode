import * as vscode from 'vscode';

/**
 * 工作区门控(书 PR-002 / AUDIT-003 负案例):
 *
 * 现状(门控前):onLanguage:python 激活无工作区特征检查——任意 Python 工作区
 * (与 KBEngine 毫无关系)激活即拉起全套 KBEngine 机械:IndexScheduler 首扫
 * 入队、EntityMappingManager 三个 watcher 与全量 .def 扫描、PythonClassIndex
 * 后台全量 .py 扫描。门控后:激活期先做一次有界特征探测,确认工作区确有
 * KBEngine 特征(.def / entities.xml / types.xml / alias.xml / kbengine*.xml)
 * 才启动索引机械;无特征的纯 Python 工作区零后台扫描、零 watcher。
 *
 * 行为结果不变的两条保证:
 * 1. fail-open:探测本身抛错(VS Code API 异常等)一律按「是 KBEngine 工作区」
 *    处理,回到门控前的全量启动路径;
 * 2. 按需启动兜底:门控未放行时,任何经 EntityMappingManager 公开查询/命令
 *    入口的调用都会先幂等 ensureStartup()——结果与门控前一致(查询总会等到
 *    全量口径),只是把启动成本从「激活期无条件」挪到「确有使用证据」。
 */

/** KBEngine 工作区特征(vscode.workspace.findFiles 单次合并探测,命中即真) */
const KBENGINE_SIGNAL_GLOB =
  '{**/*.def,**/entities.xml,**/types.xml,**/alias.xml,**/kbengine*.xml}';

export interface WorkspaceGateDeps {
  /** findFiles 注入(fake-vscode 测试面);生产用 vscode.workspace.findFiles */
  findFiles: (
    include: string,
    maxResults: number
  ) => Thenable<Array<{ fsPath: string }>>;
  /** 工作区文件夹根列表(空 = 无工作区,直接判非 KBEngine) */
  workspaceRoots: readonly string[];
}

/**
 * 有界特征探测:合并 glob 单次 findFiles(maxResults=1,命中即短路返回),
 * 不做全仓 walk;无工作区文件夹 → false(无从谈起 KBEngine 特征)。
 * 任何异常 → true(fail-open,保持门控前行为)。
 */
export async function detectKbEngineWorkspace(
  deps: WorkspaceGateDeps
): Promise<boolean> {
  if (deps.workspaceRoots.length === 0) {
    return false;
  }
  try {
    const hits = await deps.findFiles(KBENGINE_SIGNAL_GLOB, 1);
    return hits.length > 0;
  } catch {
    // fail-open:探测失败不惩罚 KBEngine 工作区,回退全量启动
    return true;
  }
}

/**
 * 激活期门控决策入口。生产实现:读真实 vscode.workspace。
 * 返回 true = 放行索引机械启动(与门控前一致)。
 */
export async function shouldStartKbEngineIndexing(): Promise<boolean> {
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .map(folder => folder?.uri?.fsPath)
    .filter((fsPath): fsPath is string => typeof fsPath === 'string');
  return detectKbEngineWorkspace({
    workspaceRoots: roots,
    findFiles: (include, maxResults) =>
      vscode.workspace.findFiles(include, null, maxResults)
  });
}
