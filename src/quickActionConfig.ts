/**
 * 快速执行动作纯层(设计 1.8 数据结构 / 1.5 变量替换 / 1.4 脚本词表分类)。
 *
 * 动作由 `.kbengine/debug.json` 的顶层 `quickActions` 定义,不塞进 `debug` 段
 * (1.3 边界:动作不是调试配置)。三类执行后端:command(VS Code 命令)、
 * script(本地脚本)、http(本地热更新接口)——白名单式,不做万能 shell 执行。
 *
 * 变量在执行时解析(非扫描/注册时);未知变量一律抛错,绝不静默空串替换(1.5)。
 */

import type { BatchScriptCandidate } from './quickActionScanner';
import { substituteVariables, type VariableFolderRef } from './variableSubstitution';

export type QuickActionCategory = 'server' | 'export';
export type QuickActionSource = 'manual' | 'scan';

interface QuickActionShared {
  name: string;
  confirm: boolean;
  source: QuickActionSource;
  category?: QuickActionCategory;
}

export interface QuickActionCommand extends QuickActionShared {
  type: 'command';
  command: string;
  args: string[];
}

export interface QuickActionScript extends QuickActionShared {
  type: 'script';
  script: string;
  cwd?: string;
  background: boolean;
}

export interface QuickActionHttp extends QuickActionShared {
  type: 'http';
  url: string;
  method: string;
  body?: string;
}

export type QuickAction = QuickActionCommand | QuickActionScript | QuickActionHttp;

/** 路径变量形态:写配置用字面串,执行时才换成实际工作区根 */
export const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** http 后端可接受的方法(解析时统一大写;debug.json schema 的枚举同集合) */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];
/** 三个执行后端(解析器只收这三种;debug.json schema 的枚举同集合) */
export const QUICK_ACTION_TYPES = ['command', 'script', 'http'];
const SERVER_WORDS = ['start', 'stop', 'restart', 'boot', 'server'];
const EXPORT_WORDS = ['export', 'convert', '导表'];

export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '');
}

/** 非空字符串才收(name/script/command/url 共用),坏条目逐条剔除不整表失败 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseCommandArgs(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? (value as string[])
    : null;
}

function parseSharedFields(record: Record<string, unknown>, name: string): QuickActionShared | null {
  if (record.confirm !== undefined && typeof record.confirm !== 'boolean') {
    return null;
  }
  const confirm = record.confirm === undefined ? true : (record.confirm as boolean);
  if (record.source !== undefined && record.source !== 'manual' && record.source !== 'scan') {
    return null;
  }
  const source = record.source === undefined ? 'manual' : (record.source as QuickActionSource);
  if (record.category !== undefined && record.category !== 'server' && record.category !== 'export') {
    return null;
  }
  const category = record.category === undefined
    ? undefined
    : (record.category as QuickActionCategory);
  return { name, confirm, source, category };
}

function parseQuickAction(item: unknown): QuickAction | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const name = nonEmptyString(record.name);
  if (name === null) {
    return null;
  }
  const shared = parseSharedFields(record, name);
  if (shared === null) {
    return null;
  }
  const type = record.type;

  if (type === 'command') {
    const command = nonEmptyString(record.command);
    const args = parseCommandArgs(record.args);
    return command === null || args === null ? null : { ...shared, type, command, args };
  }
  if (type === 'script') {
    const script = nonEmptyString(record.script);
    if (script === null) {
      return null;
    }
    // background/cwd 未给即默认;给了但不是对应类型时回落默认值(不按坏条目剔除)
    const background = typeof record.background === 'boolean' ? (record.background as boolean) : false;
    const cwd = typeof record.cwd === 'string' ? (record.cwd as string) : undefined;
    return { ...shared, type, script, background, cwd };
  }
  if (type === 'http') {
    const url = nonEmptyString(record.url);
    const method = typeof record.method === 'string' ? record.method.toUpperCase() : 'POST';
    const body = typeof record.body === 'string' ? (record.body as string) : undefined;
    return url === null || !HTTP_METHODS.includes(method)
      ? null
      : { ...shared, type, url, method, body };
  }
  return null;
}

export function parseQuickActionConfigs(raw: unknown): {
  actions: QuickAction[];
  invalidCount: number;
} {
  if (!Array.isArray(raw)) {
    return { actions: [], invalidCount: 0 };
  }
  const actions: QuickAction[] = [];
  let invalidCount = 0;
  for (const item of raw) {
    const action = parseQuickAction(item);
    if (action === null) {
      invalidCount += 1;
      continue;
    }
    actions.push(action);
  }
  return { actions, invalidCount };
}

/** 变量解析可用的工作区根(由 quickActions 从 vscode.workspace 映射) */
export type WorkspaceFolderRef = VariableFolderRef;

/**
 * 命令侧变量替换(批141 起委派 src/variableSubstitution,替换逻辑单一真源):
 * 官方变量表全覆盖,未解析一律抛错——静默空串替换会把脚本跑成「路径为空」
 * 的假成功,比报错更糟(${config:} / ${command:} 这类需要真实 VS Code
 * 调试上下文的变量不在本扩展的解析能力内,同样如实报错)。
 */
export function resolveActionVariables(
  text: string,
  folders: readonly WorkspaceFolderRef[] = []
): string {
  const resolved = substituteVariables(text, { folders }, 'throw');
  // 工作区根自带前导 '/',与文本里写死的路径分隔符相遇会产生 '//';折叠成单个
  // (':' 后的 '//' 是 URL 协议分隔,保留不动)
  return resolved.replace(/([^:])\/{2,}/g, match => `${match[0]}/`);
}

/**
 * 脚本词表分类(1.4):启停词优先于导表词,两者都命中归启停(server)。
 * 命中不到返回 null——首装扫描只收这两类,不做泛化。
 */
export function classifyBatchScript(scriptName: string): QuickActionCategory | null {
  const lower = scriptName.toLowerCase();
  if (SERVER_WORDS.some(word => lower.includes(word))) {
    return 'server';
  }
  if (EXPORT_WORDS.some(word => lower.includes(word))) {
    return 'export';
  }
  return null;
}

/**
 * 把扫描候选构造成可写入配置的 script 动作:路径一律转成 ${workspaceFolder}
 * 变量形态(1.3:路径绝不写死),启停类默认后台(起服不等退出码)。
 */
export function buildScannedActions(
  candidates: readonly BatchScriptCandidate[],
  workspaceRoot: string
): QuickActionScript[] {
  const rootPrefix = `${workspaceRoot.replace(/\/+$/, '')}/`;
  return candidates.map(candidate => {
    const fileName = baseNameOf(candidate.path);
    const relative = candidate.path.startsWith(rootPrefix)
      ? candidate.path.slice(rootPrefix.length)
      : fileName;
    const name = stripExtension(fileName);
    const lowerName = name.toLowerCase();
    return {
      name,
      type: 'script',
      script: `${WORKSPACE_FOLDER_VAR}/${relative}`,
      background: lowerName.startsWith('start') || lowerName.startsWith('boot'),
      confirm: true,
      source: 'scan',
      category: candidate.category
    };
  });
}
