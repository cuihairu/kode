/**
 * HTTP 快捷请求纯逻辑(批105;批152 增官方变量族与真实形态示例;批153
 * ${file} 归还官方语义、文件名改名 ${filename}——名实相符,用户令):
 * - 设置项 kbengine.httpRequests 的条目解析与校验(坏条目如实跳过,不猜);
 * - 模板变量 ${module}/${moduleBasename}/${filename}/${line}/${sel} 的提取
 *   与字面替换(${module}=按 __init__.py 包边界扫出的模块路径:
 *   entities/、fight/ 各带 __init__.py 时 entities/fight/FightAI.py →
 *   entities.fight.FightAI;base/cell 这类无 __init__.py 的角色目录不算
 *   模块段,模块名即文件名去 .py;${moduleBasename}=末段一层;
 *   ${filename}=文件名(批152 前叫 ${file},名不副实故改);
 *   ${line}=光标行(1 起);${sel}=选中文本。
 *   变量按字面替换,不做 URL 编码);
 * - 批152 起官方变量族(VS Code 官方变量表,经 variableSubstitution 单一
 *   真源)同趟可插——${file}/${fileBasename}/${fileBasenameNoExtension}/
 *   ${fileDirname}/${fileExtname}/${relativeFile}/${relativeFileDirname}/
 *   ${workspaceFolder}/${workspaceFolderBasename}/${env:NAME} 等;批153 起
 *   ${file} 按官方口径=绝对路径,不再自定义霸占;官方表不认识的占位原样保留。
 * - 内置示例一条(默认停用,真实服务形态),与 package.json 默认值由测试锁定同步。
 */

import { resolveVariableExpression, type VariableContext } from './variableSubstitution';

export interface HttpRequestEntry {
  /** 展示名(quick pick 与日志前缀) */
  name: string;
  /** URL 模板,可含 ${module}/${moduleBasename}/${filename}/${line}/${sel} 占位 */
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
 * 目录是否为 Python 包(含 __init__.py)的探针;由装配层注入真实 fs 判定,
 * 测试注入脚本化假例,纯逻辑层不碰盘。
 */
export type PackageDirProbe = (dirPath: string) => boolean;

/**
 * 当前文件的 Python 模块路径(批153 重铸,用户令「扫描到 __init__.py 才算
 * 模块」):从文件所在目录向上扫包边界——含 __init__.py 的目录才是包段,
 * 首个不含 __init__.py 的目录即边界。KBEngine 脚本基本都在 base/cell
 * 角色 目录下,这类目录没有 __init__.py,不算模块段,模块名自然只剩
 * 文件名(即「没有模块就直接文件名」形态);若 assets 里有真实包结构
 * (entities/、fight/ 各带 __init__.py)则给出 entities.fight.FightAI。
 * 不注入探针时按「无包边界」处理(模块=文件名去 .py)。空路径返回空串。
 */
export function resolvePythonModulePath(
  filePath: string,
  isPackageDir?: PackageDirProbe
): string {
  if (filePath.length === 0) {
    return '';
  }
  const parts = toPosix(filePath).split('/');
  const stem = stripPyExtension(parts[parts.length - 1]);
  // 自文件所在目录逐级向上:是包才收段,首个非包目录截断(i=1 起跳过
  // 绝对路径的空前缀段,win32 盘符段 'C:' 同样不可能是包)
  const segments: string[] = [];
  for (let i = parts.length - 2; i >= 1; i--) {
    if (!isPackageDir || !isPackageDir(parts.slice(0, i + 1).join('/'))) {
      break;
    }
    segments.unshift(parts[i]);
  }
  return [...segments, stem].join('.');
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
  /** 文件名(批153 由 file 改名 filename,名实相符):FightAI.py */
  filename: string;
  line: string;
  sel: string;
}

/** 从编辑器上下文提取模板变量;无编辑器各值为空串(如实,不猜);包探针透传(批153) */
export function buildTemplateVars(
  context: TemplateEditorContext,
  isPackageDir?: PackageDirProbe
): TemplateVars {
  const filePath = context.filePath ?? '';
  const parts = toPosix(filePath).split('/');
  const base = parts[parts.length - 1];
  const line = context.cursorLineZeroBased === undefined || context.cursorLineZeroBased === null
    ? ''
    : String(context.cursorLineZeroBased + 1);
  const module = resolvePythonModulePath(filePath, isPackageDir);
  const dot = module.lastIndexOf('.');
  return {
    module,
    moduleBasename: dot === -1 ? module : module.slice(dot + 1),
    filename: base,
    line,
    sel: context.selection ?? ''
  };
}

/** 字面替换五个已知占位(文件名占位批153 起叫 ${filename});未知占位原样保留;替换值不做 URL 编码 */
export function applyTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\$\{module\}/g, () => vars.module)
    .replace(/\$\{moduleBasename\}/g, () => vars.moduleBasename)
    .replace(/\$\{filename\}/g, () => vars.filename)
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
 * 单趟合并替换(批152;批153 ${file} 移出自定义表):自定义占位
 * (module/moduleBasename/filename/line/sel)优先,其次官方变量族
 * (variableSubstitution 单一真源,${file} 按官方口径=绝对路径),
 * 都不认识的占位原样保留。
 */
export function applyTemplateWithContext(
  text: string,
  vars: TemplateVars,
  official: VariableContext
): string {
  return text.replace(/\$\{([^${}]*)\}/g, (raw, expression: string) => {
    if (expression === 'module' || expression === 'moduleBasename' || expression === 'filename'
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
