/**
 * 热更 globs 默认值生成(用户令 2026-11-12「globs 应该生成默认值到配置中吧,
 * 方便修改」):把派生口径下实际生效的监视范围写进 kbengine.hotReload.globs,
 * 用户改起来有可见靶子,不必先去配 assetsRoot 再靠插件默默派生。
 *
 * 形态红线(本模块存在的理由):派生口径的 `${workspaceFolder}/<相对>/<py 递归
 * 后缀>` 形态不能原样写进配置。显式 globs 经 setupHotReload 原样交给文件监视
 * 器注册口,而该注册口不展开 `${workspaceFolder}` 变量(派生口径要靠
 * deriveWatcherPattern 的 RelativePattern 才落地)。把变量形态写回配置=变成
 * 显式 glob 后按字面匹配绝对路径,监视范围静默落空。故生成一律给绝对路径形态
 * `${assetsRoot}/<py 递归后缀>`——它本身就是合法 GlobPattern,写回后监视不依赖
 * 派生、也不依赖变量展开,用户改哪个目录都是直接改串。
 *
 * 幂等与守口:
 * - globs 已显式写过(含空数组=显式不监视)→ 不动,提示已可改(不覆盖用户意图);
 * - 未写(unset)→ 才生成;生成需解析出 assetsRoot,缺根如实报错不写空值。
 *
 * 纯逻辑与装配分家:读/写配置经注入面(装配给真 vscode 实现,测试给假体),
 * 本模块不在纯函数里碰 vscode。
 */

export const HOT_RELOAD_MATERIALIZE_GLOBS_COMMAND = 'kbengine.hotReload.materializeGlobs';

/** 热更本职只处理 .py(与 deriveHotReloadGlob 的派生后缀同口径) */
const HOT_RELOAD_GLOB_SUFFIX = '**/*.py';

/** 路径归一成 glob 用正斜杠并去尾斜杠(Windows 反斜杠一并归一) */
const normalizePathForGlob = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * 生成写入配置的监视模式:资产根绝对路径 + py 递归后缀。
 * assetsRoot 为空 → 空串(调用方按缺根如实报错,绝不写「全扫」形态)。
 */
export function materializeHotReloadGlob(assetsRoot: string): string {
  const root = normalizePathForGlob((assetsRoot ?? '').trim());
  if (!root) {
    return '';
  }
  return `${root}/${HOT_RELOAD_GLOB_SUFFIX}`;
}

/**
 * 配置读写口:读原始 globs 值(未写/类型写坏=undefined),写回监视模式数组。
 * update 返回 Thenable 而非 Promise——vscode Configuration.update 的声明
 * 面就是 Thenable<void>,本模块不要求调用方包一层。
 */
export interface HotReloadGlobsConfig {
  readRaw(): unknown;
  update(patterns: string[]): Thenable<void>;
}

/** 已显式写过(数组;空数组也算显式「不监视任何模式」,与 §11.1 同口径) */
const explicitGlobsOf = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? (raw.filter((item): item is string => typeof item === 'string') as string[]) : undefined;

export interface HotReloadGlobsMaterializeResult {
  /** 已生成并写回的模式 */
  readonly written?: string;
  /** 未写的原因(已显式配置 / 缺资产根) */
  readonly skipped?: 'explicit' | 'no-assets-root';
}

export interface HotReloadGlobsMaterializeDeps {
  readonly config: HotReloadGlobsConfig;
  /** 解析资产根(绝对路径;解析不出=空串) */
  resolveAssetsRoot(): string;
}

/**
 * 生成默认值:未写才生成,已写不动。生成成功后配置变更事件驱动 watcher
 * 重建(setupHotReload 既有签名判据),无需额外接线。
 */
export async function materializeHotReloadGlobs(
  deps: HotReloadGlobsMaterializeDeps
): Promise<HotReloadGlobsMaterializeResult> {
  if (explicitGlobsOf(deps.config.readRaw()) !== undefined) {
    return { skipped: 'explicit' };
  }
  const glob = materializeHotReloadGlob(deps.resolveAssetsRoot());
  if (!glob) {
    return { skipped: 'no-assets-root' };
  }
  await deps.config.update([glob]);
  return { written: glob };
}