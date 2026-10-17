/**
 * HTTP 快捷请求纯逻辑(批105;批152 增官方变量族与真实形态示例):
 * - 设置项 kbengine.httpRequests 的条目解析与校验(坏条目如实跳过,不猜);
 * - 模板变量 ${module}/${file}/${line}/${sel} 的提取与字面替换
 *   (${module}=工作区相对模块路径 entities/fight/FightAI.py →
 *   entities.fight.FightAI,不在任何工作区根下回落为文件名去 .py;
 *   ${file}=文件名;${line}=光标行(1 起);${sel}=选中文本。
 *   变量按字面替换,不做 URL 编码);
 * - 批152:提供编辑器上下文时,官方变量族(VS Code 官方变量表,经
 *   variableSubstitution 单一真源)同样可插——${fileBasename}/
 *   ${fileBasenameNoExtension}/${fileDirname}/${fileExtname}/${relativeFile}/
 *   ${relativeFileDirname}/${workspaceFolder}/${workspaceFolderBasename}/
 *   ${env:NAME} 等;${file} 不入官方口径(本扩展恒为文件名,与官方
 *   绝对路径语义不同);官方表不认识的占位原样保留。
 * - 内置示例一条(默认停用,真实服务形态),与 package.json 默认值由测试锁定同步。
 */

import { resolveVariableExpression, type VariableContext } from './variableSubstitution';

export interface HttpRequestEntry {
  /** 展示名(quick pick 与日志前缀) */
  name: string;
  /** URL 模板,可含 ${module}/${file}/${line}/${sel} 占位 */
  url: string;
  /** HTTP 方法,缺省 GET(统一大写) */
  method: string;
  /** 请求头(值同样走模板替换) */
  headers: Record<string, string>;
  /** 请求体(非空才随请求发送,同样走模板替换) */
  body: string;
  /** 启停开关,缺省启用 */
  enabled: boolean;
  /**
   * 键位展示串(quick pick 详情列显示)。VS Code 无运行时注册键位的 API,
   * 实际快捷键经「键盘快捷方式」为 kbengine.httpRequest.run 配 args.name
   * 绑定,此字段仅作展示与检索。
   */
  keybinding: string;
}

/** 内置示例(默认停用):按用户真实热更新服务形态给出(批152 定型) */
export const BUILTIN_HTTP_REQUEST_EXAMPLE: Readonly<HttpRequestEntry> = Object.freeze({
  name: '热更新(示例)',
  url: 'http://127.0.0.1:8000/api/hotfix?relaod=${module}',
  method: 'GET',
  headers: {},
  body: '',
  enabled: false,
  keybinding: ''
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 解析设置原始值:非数组返回空表;条目缺 name/url 或类型不对则整条跳过,
 * 其余字段逐个回落默认(method 大写化、headers 只收字符串值)。
 */
export function parseHttpRequestEntries(raw: unknown): HttpRequestEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: HttpRequestEntry[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      continue;
    }
    const name = item.name;
    const url = item.url;
    if (typeof name !== 'string' || name.trim().length === 0) {
      continue;
    }
    if (typeof url !== 'string' || url.trim().length === 0) {
      continue;
    }
    const headers: Record<string, string> = {};
    if (isPlainObject(item.headers)) {
      for (const [key, value] of Object.entries(item.headers)) {
        if (typeof value === 'string') {
          headers[key] = value;
        }
      }
    }
    const method = typeof item.method === 'string' && item.method.trim().length > 0
      ? item.method.trim().toUpperCase()
      : 'GET';
    entries.push({
      name,
      url,
      method,
      headers,
      body: typeof item.body === 'string' ? item.body : '',
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      keybinding: typeof item.keybinding === 'string' ? item.keybinding : ''
    });
  }
  return entries;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

const stripPyExtension = (value: string): string => value.replace(/\.py$/i, '');

/**
 * 当前文件的 Python 模块路径:落在任一工作区根下 → 相对路径去 .py 扩展、
 * 分隔符转点(entities/fight/FightAI.py → entities.fight.FightAI);
 * 不在任何根下 → 文件名去 .py(不含目录)。空路径返回空串。
 */
export function resolvePythonModulePath(
  filePath: string,
  workspaceRoots: readonly string[] = []
): string {
  if (filePath.length === 0) {
    return '';
  }
  const normalized = toPosix(filePath);
  for (const root of workspaceRoots) {
    const rootNorm = toPosix(root).replace(/\/+$/, '');
    if (rootNorm.length > 0 && normalized.startsWith(`${rootNorm}/`)) {
      const relative = normalized.slice(rootNorm.length + 1);
      return stripPyExtension(relative).split('/').join('.');
    }
  }
  const parts = normalized.split('/');
  const base = parts[parts.length - 1];
  return stripPyExtension(base);
}

/** 模板变量载体;line 用 0 起光标行入参,导出时转 1 起自然行号 */
export interface TemplateEditorContext {
  filePath?: string;
  cursorLineZeroBased?: number;
  selection?: string;
  workspaceRoots?: readonly string[];
}

export interface TemplateVars {
  module: string;
  /** 末段一层模块名(批152,用户令「只需要一层的 module」):FightAI */
  moduleBasename: string;
  file: string;
  line: string;
  sel: string;
}

/** 从编辑器上下文提取模板变量;无编辑器各值为空串(如实,不猜) */
export function buildTemplateVars(context: TemplateEditorContext): TemplateVars {
  const filePath = context.filePath ?? '';
  const parts = toPosix(filePath).split('/');
  const base = parts[parts.length - 1];
  const line = context.cursorLineZeroBased === undefined || context.cursorLineZeroBased === null
    ? ''
    : String(context.cursorLineZeroBased + 1);
  const module = resolvePythonModulePath(filePath, context.workspaceRoots ?? []);
  const dot = module.lastIndexOf('.');
  return {
    module,
    moduleBasename: dot === -1 ? module : module.slice(dot + 1),
    file: base,
    line,
    sel: context.selection ?? ''
  };
}

/** 字面替换五个已知占位(批152 起 moduleBasename 一层粒度);未知占位原样保留;替换值不做 URL 编码 */
export function applyTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\$\{module\}/g, () => vars.module)
    .replace(/\$\{moduleBasename\}/g, () => vars.moduleBasename)
    .replace(/\$\{file\}/g, () => vars.file)
    .replace(/\$\{line\}/g, () => vars.line)
    .replace(/\$\{sel\}/g, () => vars.sel);
}

/**
 * 编辑器上下文 → 官方变量族上下文(批152):工作区根以 basename 命名
 * (单根形态与 VS Code folder.name 一致),env 不注入走 process.env。
 */
export function buildOfficialVariableContext(
  context: TemplateEditorContext
): VariableContext {
  const basename = (value: string): string => {
    // split 恒返回至少一个元素,末段直接取,无需空表兜底
    const parts = toPosix(value.replace(/\/+$/, '')).split('/');
    return parts[parts.length - 1];
  };
  return {
    folders: (context.workspaceRoots ?? []).map(root => ({
      fsPath: root,
      name: basename(root)
    })),
    filePath: context.filePath
  };
}

/**
 * 单趟合并替换(批152):自定义占位(module/moduleBasename/file/line/sel)优先,
 * 其次官方变量族
 * (variableSubstitution 单一真源),都不认识的占位原样保留——官方表里
 * ${file}=绝对路径 与本扩展 ${file}=文件名 冲突,自定义语义恒胜出。
 */
export function applyTemplateWithContext(
  text: string,
  vars: TemplateVars,
  official: VariableContext
): string {
  return text.replace(/\$\{([^${}]*)\}/g, (raw, expression: string) => {
    if (expression === 'module' || expression === 'moduleBasename' || expression === 'file'
      || expression === 'line' || expression === 'sel') {
      return applyTemplate(raw, vars);
    }
    const value = resolveVariableExpression(expression, official);
    return value === undefined ? raw : value;
  });
}

export interface BuiltHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** 对 URL/请求体/请求头值统一做模板替换后的可执行请求;带官方变量上下文时同趟可插(批152) */
export function buildHttpRequest(
  entry: HttpRequestEntry,
  vars: TemplateVars,
  official?: VariableContext
): BuiltHttpRequest {
  const substitute = (text: string): string =>
    official ? applyTemplateWithContext(text, vars, official) : applyTemplate(text, vars);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.headers)) {
    headers[key] = substitute(value);
  }
  return {
    url: substitute(entry.url),
    method: entry.method,
    headers,
    body: substitute(entry.body)
  };
}
