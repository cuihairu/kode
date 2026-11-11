/**
 * 默认部署 profile(用户令 2026-11-10「创建默认的」收口):零 profile 时,
 * 热更通道切换/配置面不再挡人——自动创建并激活一条默认 profile。种子取
 * workspace 发现链:assetsRoot = 选定根/配置/自动发现(resolveAssetsRootForWorkspace,
 * 判不出如实空串),engineRoot = identifyProjectLayout 判定(判不出空串;
 * assetsRoot 为空时短路不调——firstExistingPath 以空基底 join 出相对路径,
 * 会拿进程 cwd 误探),解释器按 profile 解释器解析(缺失如实记录)。已有
 * 任何 profile 时不创建(返回 null,交给既有「选择/激活」流——自动建只兜
 * 「一条都没有」的真空白,不替用户在多 profile 之间做主)。创建成功即激活
 * (经 setActiveProfile,持久化 + 恰发一次切换事件,通道灯等订阅面自行跟刷)。
 */

import { ProjectProfileStore, type ProjectProfile } from './projectProfiles';
import { identifyProjectLayout } from './projectImport';
import { resolveProfileInterpreter } from './profileInterpreter';
import { resolveAssetsRootForWorkspace } from './scanRoots';

export interface EnsureDefaultDeploymentProfileDeps {
  readonly store: ProjectProfileStore;
  /** 激活面:注入 setActiveProfile(memento, id) 的包装 */
  readonly activateProfile: (profileId: string) => Promise<string | null>;
  /** 当前工作区根;null(无文件夹)时种子如实落空(assetsRoot/engineRoot='') */
  readonly workspaceRoot: string | null;
  /** 缺省 resolveAssetsRootForWorkspace(发现链:选定根→配置→自动发现) */
  readonly resolveAssetsRoot?: (workspaceRoot: string) => string;
  /** 缺省 identifyProjectLayout(engineRoot 判定) */
  readonly identifyLayout?: (assetsRoot: string) => { engineRoot?: string | null };
  /** 缺省 resolveProfileInterpreter */
  readonly resolveInterpreter?: (workspaceRoot?: string) => {
    interpreterPath: string | null;
    interpreterSource: string;
  };
}

/**
 * 零 profile 时创建并激活默认 profile,返回新档;已有 profile 返回 null
 * (不创建)。创建/激活一路如实:判不出的字段落空串/缺失,不发明。
 */
export async function ensureDefaultDeploymentProfile(
  deps: EnsureDefaultDeploymentProfileDeps
): Promise<ProjectProfile | null> {
  if (deps.store.list().length > 0) {
    return null;
  }
  const assetsRoot = deps.workspaceRoot
    ? (deps.resolveAssetsRoot ?? resolveAssetsRootForWorkspace)(deps.workspaceRoot)
    : '';
  // assetsRoot 为空时短路:空基底 join 出相对路径,会拿 cwd 误探(见头注)
  const identification = assetsRoot
    ? (deps.identifyLayout ?? identifyProjectLayout)(assetsRoot)
    : null;
  const interpreter = (deps.resolveInterpreter ?? resolveProfileInterpreter)(
    deps.workspaceRoot ?? undefined
  );
  const profile = await deps.store.create({
    displayName: 'default',
    assetsRoot,
    engineRoot: identification?.engineRoot ?? '',
    interpreterPath: interpreter.interpreterPath,
    interpreterSource: interpreter.interpreterSource
  });
  await deps.activateProfile(profile.id);
  return profile;
}
