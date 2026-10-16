/**
 * 批142(用户 2026-10-16 单 kode-debug-json.md):`.kbengine/debug.json` 缺失即
 * 自动生成,而不是让用户面对「没有这文件」或者一个光秃秃的 `{}`。
 *
 * 几件事共用这一套机制(批143 的 `.pyi` 目录也接这里,不另写一份):
 * - 工作目录可由环境变量 `KBENGINE_WORKSPACE` 指定,取值走批141 的官方变量
 *   替换;优先级 环境变量 > 配置文件 `workspaceRoot` > 首个工作区根,被覆盖的
 *   取值逐条如实说明,当前生效值与来源同时写进骨架注释和 OUTPUT 流水;
 * - 没有配置文件时按本仓既有扫描逻辑(quickActionScanner 的一层 `.bat` 加词表
 *   分类)把启停/导表脚本填进 `quickActions`,不另起一套识别规则;
 * - 骨架按 JSONC 写(带注释,同 `tsconfig.json` 口径),读配置前统一剥注释,
 *   否则「注释方便编辑」与「读得动」会互相打脸。
 */

import * as fs from 'fs';
import { substituteVariables } from './variableSubstitution';
import {
  WORKSPACE_FOLDER_VAR,
  buildScannedActions,
  type QuickAction
} from './quickActionConfig';
import {
  FILE_SYSTEM_KIND_FILE,
  scanBatchScripts,
  type DirectoryEntry
} from './quickActionScanner';
import { SOURCE_DEFAULT_COMPONENTS } from './debugConfig';

/** 生效工作目录与取舍说明落这个 OUTPUT 通道 */
export const DEBUG_CONFIG_CHANNEL_NAME = 'KBEngine 配置';
/** 工作目录环境变量名:与本仓 KBENGINE_* 既有命名风格一致 */
export const DEBUG_WORKSPACE_ENV_VAR = 'KBENGINE_WORKSPACE';
/** 配置文件相对工作目录的固定位置(.kbengine 管理目录,与存根导出同居) */
export const DEBUG_CONFIG_RELATIVE_SEGMENTS = ['.kbengine', 'debug.json'] as const;

export type WorkspaceRootSource = 'env' | 'config' | 'default';

export const WORKSPACE_ROOT_SOURCE_LABELS: Record<WorkspaceRootSource, string> = {
  env: `环境变量 ${DEBUG_WORKSPACE_ENV_VAR}`,
  config: '配置文件 workspaceRoot',
  default: '默认值(首个工作区根)'
};

export interface WorkspaceFolderLike {
  name: string;
  fsPath: string;
}

export interface ResolvedDebugWorkspace {
  root: string;
  source: WorkspaceRootSource;
  /** 被更高优先级来源盖掉的取值,冲突时逐条说明取舍 */
  overridden: string[];
}

function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\/{2,}/g, '/').replace(/\\/g, '/');
}

export function debugConfigPath(workspaceRoot: string): string {
  return joinPath(workspaceRoot, ...DEBUG_CONFIG_RELATIVE_SEGMENTS);
}

/**
 * 剥 JSONC 注释(行注释加块注释)。字符串字面量里的 `//`、`/*` 一律不参与剥除,
 * 转义引号也正确跳过;块注释里的换行保留,行号不错位。
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') {
          out += '\n';
        }
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** 读用户配置:先剥注释再解析,坏 JSON 按没有配置处理(不打断用户) */
export function parseDebugConfigText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonComments(text)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export interface ResolveWorkspaceInput {
  env?: Record<string, string | undefined>;
  /** 已读到的配置内容(读不到/坏 JSON 传 null) */
  fileConfig?: Record<string, unknown> | null;
  workspaceFolders?: readonly WorkspaceFolderLike[];
}

/**
 * 解析当前生效的工作目录:环境变量 > 配置文件 workspaceRoot > 首个工作区根。
 * 取值一律先过批141 的官方变量替换(路径类语义用 empty 口径:替换不成视作没写,
 * 顺位回落下一档,不因为一个变量不存在就让整条链断掉)。
 */
export function resolveDebugWorkspaceRoot(
  input: ResolveWorkspaceInput
): ResolvedDebugWorkspace | null {
  const folders = input.workspaceFolders ?? [];
  const context = {
    folders: folders.map(folder => ({ fsPath: folder.fsPath, name: folder.name })),
    env: input.env ?? process.env
  };
  const fallbackNote = `默认值=${folders[0]?.fsPath ?? ''}`;

  const rawEnv = input.env?.[DEBUG_WORKSPACE_ENV_VAR];
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const resolved = substituteVariables(rawEnv, context, 'empty').trim();
    if (resolved !== '') {
      const overridden = fileConfigNote(input.fileConfig);
      if (folders[0] !== undefined) {
        overridden.push(fallbackNote);
      }
      return { root: resolved, source: 'env', overridden };
    }
  }

  const rawFile = input.fileConfig?.workspaceRoot;
  if (typeof rawFile === 'string' && rawFile.trim() !== '') {
    const resolved = substituteVariables(rawFile, context, 'empty').trim();
    if (resolved !== '') {
      const overridden: string[] = [];
      if (folders[0] !== undefined) {
        overridden.push(fallbackNote);
      }
      return { root: resolved, source: 'config', overridden };
    }
  }

  if (folders[0] === undefined) {
    return null;
  }
  return { root: folders[0].fsPath, source: 'default', overridden: [] };
}

function fileConfigNote(fileConfig: Record<string, unknown> | null | undefined): string[] {
  const raw = fileConfig?.workspaceRoot;
  return typeof raw === 'string' && raw.trim() !== ''
    ? [`配置文件 workspaceRoot=${raw}`]
    : [];
}

function componentExampleLines(): string[] {
  return SOURCE_DEFAULT_COMPONENTS.slice(0, 2).map(({ name, telnetPort }) =>
    `  //     "${name}": { "telnetHost": "127.0.0.1", "telnetPort": ${telnetPort}, "telnetPassword": "", "telnetDefaultLayer": "python", "telnetEnableCommands": [] },`
  );
}

export interface SkeletonInput {
  workspace: ResolvedDebugWorkspace;
  actions: readonly QuickAction[];
}

/**
 * 生成带注释的 JSONC 骨架。每个字段写清含义,路径示例一律
 * `${workspaceFolder}/...` 形态(批141 用户令:打开即可编辑),当前生效的工作
 * 目录与其来源、被盖掉的来源一并落在注释里。
 */
export function buildDebugConfigSkeleton(input: SkeletonInput): string {
  const { workspace, actions } = input;
  // 数组体按 JSON.stringify 的两格缩进再整体右移两格,落成与手写配置同形的
  // 四格缩进;空数组直接写 [] 不换行
  const jsonLines = JSON.stringify(actions, null, 2).split('\n');
  const actionJson = actions.length === 0
    ? '[]'
    : `[\n${jsonLines.slice(1, -1).map(line => `  ${line}`).join('\n')}\n  ]`;
  const overrideLines = workspace.overridden.length > 0
    ? workspace.overridden.map(note => `//   - 已丢弃:${note}`).join('\n')
    : '//   - 无冲突';

  return `// kode 调试与快速执行动作配置(文件缺失时自动生成)
// 本文件按 JSONC 解析,允许 // 与块注释(同 tsconfig.json 口径),
// kode 读配置前会剥注释,所以这里的注释不影响生效。
//
// 当前生效工作目录:${workspace.root}
// 来源:${WORKSPACE_ROOT_SOURCE_LABELS[workspace.source]}
${overrideLines}
//
// 工作目录优先级(高 → 低):
//   1. 环境变量 ${DEBUG_WORKSPACE_ENV_VAR}(支持 VS Code 官方变量替换,例如 \${workspaceFolder}/server)
//   2. 本文件顶层的 "workspaceRoot"
//   3. 默认取首个工作区根
// 想让本文件接管,取消下面一行注释并改成你的路径:
// "workspaceRoot": "${WORKSPACE_FOLDER_VAR}",

{
  // 配置版本号,当前固定 1
  "version": 1,

  // telnet 调试段:只影响「Start Debugging」的提示语与自动登录预填,不参与实际探测
  "debug": {
    // 默认 telnet 主机;留空按本机回环 127.0.0.1
    "defaultTelnetHost": "127.0.0.1",
    // 默认 telnet 端口;0 表示不预填,按元件各自的端口走
    "defaultTelnetPort": 0,
    // 逐元件覆盖默认;键是元件名,值可含 telnetHost / telnetPort / telnetPassword /
    // telnetDefaultLayer / telnetEnableCommands / pathMappings
    "components": {
${componentExampleLines().join('\n')}
    }
  },

  // 快速执行动作:实体浏览器 ▶ 与命令面板共用;三种后端任选其一
  //   script:跑本地脚本   { "name": "起服", "type": "script", "script": "\${workspaceFolder}/start_server.bat", "background": true }
  //   command:跑引擎命令 { "name": "导出配置表", "type": "command", "command": "exportTables" }
  //   http:发 HTTP     { "name": "热更接口", "type": "http", "url": "http://127.0.0.1:8080/hotfix", "method": "POST" }
  "quickActions": ${actionJson}
}
`;
}

export interface DebugConfigBootstrapDeps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdir: (dir: string) => void;
  /** 读工作目录一层(扫描脚本用);读不到由注入的实现自行抛 */
  listDir: (root: string) => DirectoryEntry[];
  log: (line: string) => void;
}

/** 目录项 kind 常量:2 = Directory(vscode.FileSystemKind 同值,fake-vscode 未导出枚举) */
const DIRECTORY_ENTRY_KIND_DIRECTORY = 2;

export const fileSystemBootstrapDeps: DebugConfigBootstrapDeps = {
  exists: (candidate: string): boolean => fs.existsSync(candidate),
  readFile: (path: string): string => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  },
  writeFile: (path: string, content: string): void => {
    fs.writeFileSync(path, content, 'utf8');
  },
  mkdir: (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  },
  listDir: (root: string): DirectoryEntry[] =>
    fs.readdirSync(root, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      type: entry.isFile() ? FILE_SYSTEM_KIND_FILE : DIRECTORY_ENTRY_KIND_DIRECTORY
    })),
  log: () => {
    // 默认不落盘日志:激活期调用方接自己的 OUTPUT 通道
  }
};

export interface EnsureDebugConfigOptions {
  env?: Record<string, string | undefined>;
  workspaceFolders?: readonly WorkspaceFolderLike[];
  /** 覆盖 deps.listDir(测试与虚拟文件系统场景) */
  listDir?: (root: string) => DirectoryEntry[];
}

export type EnsureDebugConfigStatus =
  | 'created'
  | 'exists'
  | 'no-workspace'
  | 'write-failed';

export interface EnsureDebugConfigResult {
  status: EnsureDebugConfigStatus;
  workspaceRoot: string;
  workspaceSource: WorkspaceRootSource | null;
  /** 生成进骨架的动作条数 */
  scannedActions: number;
}

/**
 * 缺失即生成:文件在就直接返回(绝不覆盖用户文件),不在则按生效工作目录建目录、
 * 写骨架,并把生效值与来源记进 OUTPUT 流水。写入失败只如实回报,不影响扩展其余
 * 能力。
 */
export function ensureDebugConfig(
  deps: DebugConfigBootstrapDeps = fileSystemBootstrapDeps,
  options: EnsureDebugConfigOptions = {}
): EnsureDebugConfigResult {
  const env = options.env ?? process.env;
  const folders = options.workspaceFolders ?? [];
  const listDir = options.listDir ?? deps.listDir;

  const resolved = resolveDebugWorkspaceRoot({
    env,
    fileConfig: readWorkspaceConfig(deps, folders[0]?.fsPath ?? ''),
    workspaceFolders: folders
  });
  if (resolved === null) {
    return { status: 'no-workspace', workspaceRoot: '', workspaceSource: null, scannedActions: 0 };
  }

  const target = debugConfigPath(resolved.root);
  if (deps.exists(target)) {
    return {
      status: 'exists',
      workspaceRoot: resolved.root,
      workspaceSource: resolved.source,
      scannedActions: 0
    };
  }

  const candidates = scanCandidates(listDir, resolved.root);
  const actions = candidates.length > 0 ? buildScannedActions(candidates, resolved.root) : [];
  deps.log(`未找到 .kbengine/debug.json,已生成配置骨架:${target}`);
  deps.log(`  工作目录:${resolved.root}(来源:${WORKSPACE_ROOT_SOURCE_LABELS[resolved.source]})`);
  for (const note of resolved.overridden) {
    deps.log(`  取舍:已采用更高优先级来源,丢弃 ${note}`);
  }
  if (actions.length === 0) {
    deps.log('  未扫到启停/导表脚本,quickActions 留空(照骨架注释手写即可)');
  } else {
    deps.log(`  按脚本扫描写入 ${actions.length} 条快速执行动作:${actions.map(action => action.name).join('、')}`);
  }
  try {
    deps.mkdir(joinPath(resolved.root, '.kbengine'));
    deps.writeFile(target, buildDebugConfigSkeleton({ workspace: resolved, actions }));
  } catch {
    deps.log(`  写入失败(${target}):目录不可写?已如实回报,其余能力不受影响`);
    return {
      status: 'write-failed',
      workspaceRoot: resolved.root,
      workspaceSource: resolved.source,
      scannedActions: actions.length
    };
  }
  return {
    status: 'created',
    workspaceRoot: resolved.root,
    workspaceSource: resolved.source,
    scannedActions: actions.length
  };
}

function readWorkspaceConfig(
  deps: DebugConfigBootstrapDeps,
  root: string
): Record<string, unknown> | null {
  if (root === '') {
    return null;
  }
  const target = debugConfigPath(root);
  if (!deps.exists(target)) {
    return null;
  }
  let content: string;
  try {
    content = deps.readFile(target);
  } catch {
    return null;
  }
  return parseDebugConfigText(content);
}

function scanCandidates(
  listDir: (root: string) => DirectoryEntry[],
  root: string
): ReturnType<typeof scanBatchScripts> {
  try {
    return scanBatchScripts(root, () => listDir(root));
  } catch {
    // 目录读不到(权限/虚拟文件系统):按无脚本生成空 quickActions,不打断激活
    return [];
  }
}