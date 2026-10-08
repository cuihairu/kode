/**
 * HTTP 快捷请求纯逻辑(批105):
 * - 设置项 kbengine.httpRequests 的条目解析与校验(坏条目如实跳过,不猜);
 * - 模板变量 ${module}/${file}/${line}/${sel} 的提取与字面替换
 *   (${module}=工作区相对模块路径 entities/fight/FightAI.py →
 *   entities.fight.FightAI;${file}=文件名;${line}=光标行(1 起);
 *   ${sel}=选中文本。变量按字面替换,不做 URL 编码);
 * - 内置示例一条(默认停用),与 package.json 默认值由测试锁定同步。
 */

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

/** 内置示例(默认停用):指向本地热更新接口的常规形态 */
export const BUILTIN_HTTP_REQUEST_EXAMPLE: Readonly<HttpRequestEntry> = Object.freeze({
  name: '热更新(示例)',
  url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
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
  return {
    module: resolvePythonModulePath(filePath, context.workspaceRoots ?? []),
    file: base,
    line,
    sel: context.selection ?? ''
  };
}

/** 字面替换四个已知占位;未知占位原样保留;替换值不做 URL 编码 */
export function applyTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\$\{module\}/g, () => vars.module)
    .replace(/\$\{file\}/g, () => vars.file)
    .replace(/\$\{line\}/g, () => vars.line)
    .replace(/\$\{sel\}/g, () => vars.sel);
}

export interface BuiltHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** 对 URL/请求体/请求头值统一做模板替换后的可执行请求 */
export function buildHttpRequest(entry: HttpRequestEntry, vars: TemplateVars): BuiltHttpRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.headers)) {
    headers[key] = applyTemplate(value, vars);
  }
  return {
    url: applyTemplate(entry.url, vars),
    method: entry.method,
    headers,
    body: applyTemplate(entry.body, vars)
  };
}
