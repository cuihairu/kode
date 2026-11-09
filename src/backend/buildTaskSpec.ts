/**
 * profile 的构建任务描述(IDE-TSK-001):一个 profile(assets 根 + 解释器)
 * → 一条可精确预览的脚本编译检查任务。四要素 command/args/cwd/env 全部
 * 由 profile 派生且与预览逐字一致——TSK-002 的 TaskProvider 按此描述
 * 注册,TSK-003 的 problem matcher 吃同一输出(compileall -q 只吐错误行)。
 * 任务本体是解释器 `-m compileall` 资产 scripts 目录:纯语法编译,不
 * import 引擎模块,任何 profile 解释器都能跑。
 */

/** 任务类型标识(vscode TaskDefinition.type;TSK-002 TaskProvider 注册面) */
export const BUILD_TASK_TYPE = 'kbengine.build';

export interface BuildTaskSpecInput {
  id: string;
  displayName: string;
  assetsRoot: string;
  /** null=profile 未选解释器,回退 PATH 上的 python3(明细如实标注) */
  interpreterPath: string | null;
}

export interface BuildTaskSpec {
  type: typeof BUILD_TASK_TYPE;
  profileId: string;
  /** 任务名(任务列表展示:profile 显示名 + 动作) */
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** 逐行执行明细(回退标注等;预览与任务详情共用) */
  detail: readonly string[];
}

/** 解释器缺失时的回退(与 debugpy 同步源链同口径:PATH 上的 python3) */
const FALLBACK_INTERPRETER = 'python3';

/**
 * 派生脚本编译检查任务:command=profile 解释器(缺则回退 python3 并
 * 标注),args=`-m compileall -q <assets>/scripts`,cwd=assets 根,
 * env 只带 PYTHONUTF8=1(compileall 错误行里的路径按 UTF-8 稳定输出,
 * Windows 默认 GBK 控制台不乱码)。
 */
export function buildScriptCheckTaskSpec(profile: BuildTaskSpecInput): BuildTaskSpec {
  const assetsRoot = profile.assetsRoot.replace(/\/+$/, '');
  const scriptsDir = `${assetsRoot}/scripts`;
  const detail: string[] = [];
  let command = FALLBACK_INTERPRETER;
  if (profile.interpreterPath) {
    command = profile.interpreterPath;
    detail.push(`解释器:profile 所选 ${command}`);
  } else {
    detail.push(`解释器:profile 未选,回退 PATH 上的 ${FALLBACK_INTERPRETER}`);
  }
  return {
    type: BUILD_TASK_TYPE,
    profileId: profile.id,
    name: `${profile.displayName}: 脚本编译检查`,
    command,
    args: ['-m', 'compileall', '-q', scriptsDir],
    cwd: assetsRoot,
    env: { PYTHONUTF8: '1' },
    detail
  };
}

/** 预览参数加引号规则:含空白即加双引号(与 shell 拆词一致) */
const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/**
 * 预览=准确执行内容:cd 行 + 命令行原文(逐参数按 shell 拆词规则加引号)
 * + env 逐条 + 明细行。任务列表/执行详情直接展示这段文本,所见即所跑。
 */
export function formatBuildTaskPreview(spec: BuildTaskSpec): string {
  const commandLine = [spec.command, ...spec.args].map(quoteIfNeeded).join(' ');
  return [
    `[${spec.type}] ${spec.name}`,
    `cd ${quoteIfNeeded(spec.cwd)}`,
    commandLine,
    `env:`,
    ...Object.entries(spec.env).map(([key, value]) => `  ${key}=${value}`),
    ...spec.detail
  ].join('\n');
}
