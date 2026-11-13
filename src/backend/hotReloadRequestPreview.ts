/**
 * HR-MOD-013 旧配置兼容迁移与请求预览纯逻辑(零 vscode):
 * - **请求预览**:活动文件在各 HTTP 快捷请求条目与零配置默认热更面下
 *   「将会发出什么」——只构造不发送;停用条目也如实列出(带原因),
 *   绝不静默丢弃;
 * - **旧配置兼容迁移**:扫描已保存 kbengine.httpRequests 原始条目里的
 *   `${module}`(legacy 语义,HR-AUDIT-004 审计在案=刻意不动默认语义),
 *   给出「迁移到 `${fullModule}`(双名面,HR-MOD-012)」的建议面;建议只在
 *   scriptRoot 已配置时给出(未配置时 ${fullModule} 展开空串,迁过去等于
 *   断链,如实不建议);改写只动确认条目的模板字符串,其余条目逐字保留
 *   ——「不静默篡改已保存 URL 模板」是硬边界:写入只经用户显式确认
 *   (装配层 quick pick + 二次确认),纯核自身零写配置。
 */

import {
  buildDefaultHotfixRequest,
  resolveDefaultHotfixModule
} from './hotReloadDefaultHotfix';
import {
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  resolvePythonModulePath,
  type HttpRequestEntry,
  type PackageDirProbe
} from './httpRequests';
import { resolveModuleDualName } from './hotReloadTempEdit';

export interface RequestPreviewInput {
  /** 活动文件(空串=无活动编辑器,只出说明行不猜文件) */
  readonly file: string;
  /** 已解析的设置条目(含停用;停用如实列出) */
  readonly entries: readonly HttpRequestEntry[];
  /** 双名解析脚本根(HR-MOD-012 同源) */
  readonly scriptRoot: string;
  /** ${module} 包边界探针 */
  readonly isPackageDir?: PackageDirProbe;
  /** HR-MOD-008 根下单层回退(默认热更面同口径) */
  readonly allowRootLevelStem?: boolean;
  readonly cursorLineZeroBased?: number;
  readonly selection?: string;
  readonly workspaceRoots?: readonly string[];
}

/** 单条请求预览(纯呈现;发送面零涉及) */
export interface RequestPreviewRow {
  readonly name: string;
  /** 来源标签(设置/内置示例/零配置默认热更面) */
  readonly source: string;
  /** 非空=该条不参与运行及原因(如停用);预览仍给出模板形状 */
  readonly skippedReason?: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** 三个名字并列:双名两值(不可解如实空串)+legacy ${module} 语义值 */
  readonly moduleNames: {
    readonly fullModule: string;
    readonly requestModule: string;
    readonly legacyModule: string;
  };
}

/** 预览行构造:每条目一行(停用带原因)+零配置默认热更面一行 */
export function buildRequestPreviewRows(input: RequestPreviewInput): RequestPreviewRow[] {
  const rows: RequestPreviewRow[] = [];
  if (input.file.length === 0) {
    return rows;
  }
  const vars = buildTemplateVars(
    {
      filePath: input.file,
      scriptRoot: input.scriptRoot.length > 0 ? input.scriptRoot : undefined,
      cursorLineZeroBased: input.cursorLineZeroBased,
      selection: input.selection,
      workspaceRoots: input.workspaceRoots
    },
    input.isPackageDir
  );
  const official = buildOfficialVariableContext({
    filePath: input.file,
    workspaceRoots: input.workspaceRoots
  });
  const moduleNames = () => ({
    fullModule: vars.fullModule,
    requestModule: vars.reloadModule,
    legacyModule: vars.module
  });
  for (const entry of input.entries) {
    const built = buildHttpRequest(entry, vars, official);
    rows.push({
      name: entry.name,
      source: 'kbengine.httpRequests 设置',
      ...(entry.enabled ? {} : { skippedReason: '条目停用(enabled=false),不参与运行' }),
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      moduleNames: moduleNames()
    });
  }
  // 零配置默认热更面(用户令 2026-11-06):未配动作名时保存即发;预览同面同源
  const defaultRequest = buildDefaultHotfixRequest(input.file, {
    scriptRoot: input.scriptRoot,
    isPackageDir: input.isPackageDir,
    allowRootLevelStem: input.allowRootLevelStem
  });
  rows.push({
    name: '零配置默认热更面',
    source: '未配动作名时保存 .py 自动发送(HR-MOD-008 开关影响本面模块名)',
    method: defaultRequest.method,
    url: defaultRequest.url,
    headers: defaultRequest.headers,
    body: defaultRequest.body,
    moduleNames: {
      fullModule: dualNamesOf(input).fullModule,
      requestModule: dualNamesOf(input).requestModule,
      legacyModule: resolvePythonModulePath(input.file, input.isPackageDir)
    }
  });
  return rows;
}

/** 双名解析(默认热更面口径:scriptRoot+HR-MOD-008 开关;不可解如实空串) */
const dualNamesOf = (
  input: Pick<RequestPreviewInput, 'file' | 'scriptRoot' | 'allowRootLevelStem'>
): { fullModule: string; requestModule: string } => {
  if (input.scriptRoot.length === 0) {
    return { fullModule: '', requestModule: '' };
  }
  const dual = resolveModuleDualName(input.file, input.scriptRoot, {
    ...(input.allowRootLevelStem === true ? { allowRootLevelStem: true } : {})
  });
  return 'unsupported' in dual ? { fullModule: '', requestModule: '' } : {
    fullModule: dual.fullModule,
    requestModule: dual.requestModule
  };
};

/** 单文件的默认热更模块名预览(HR-MOD-008 开关口径,与发送面逐字同源) */
export const previewDefaultHotfixModule = (
  file: string,
  deps: { scriptRoot?: string; isPackageDir?: PackageDirProbe; allowRootLevelStem?: boolean } = {}
): string => resolveDefaultHotfixModule(file, deps);

/** 旧模板占位(legacy ${module};审计 HR-AUDIT-004 刻意保留默认语义) */
export const LEGACY_MODULE_PLACEHOLDER = '${module}';
/** 迁移目标占位(HR-MOD-012 双名面 fullModule) */
export const TARGET_MODULE_PLACEHOLDER = '${fullModule}';

/** 一条原始条目里的 ${module} 占位分布(url/body/headers 值) */
export interface RawLegacyUsage {
  readonly index: number;
  /** 条目名(缺/非字符串如实 '(未命名)') */
  readonly name: string;
  readonly fields: ReadonlyArray<{ field: 'url' | 'body' | 'header'; key?: string; count: number }>;
  readonly total: number;
}

export interface LegacyMigrationAnalysis {
  readonly usages: readonly RawLegacyUsage[];
  /** 建议是否可给:scriptRoot 已配置(${fullModule} 才有值) */
  readonly canSuggest: boolean;
  /** 不可建议时的如实原因(给 UI 直接显示) */
  readonly suggestReason: string;
}

/**
 * 扫描已保存 kbengine.httpRequests 的**原始**条目(不经解析规范化——写回时
 * 其余条目逐字保留,不引入解析器的默认值补全)。非数组/非对象条目如实跳过。
 */
export function analyzeRawLegacyModuleEntries(raw: unknown): LegacyMigrationAnalysis {
  const usages: RawLegacyUsage[] = [];
  if (!Array.isArray(raw)) {
    return {
      usages,
      canSuggest: false,
      suggestReason: 'kbengine.httpRequests 未配置或不是数组,无可迁移条目'
    };
  }
  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      return;
    }
    const entry = item as Record<string, unknown>;
    const fields: Array<RawLegacyUsage['fields'][number]> = [];
    const url = entry.url;
    if (typeof url === 'string' && url.includes(LEGACY_MODULE_PLACEHOLDER)) {
      fields.push({ field: 'url', count: countOccurrences(url) });
    }
    const body = entry.body;
    if (typeof body === 'string' && body.includes(LEGACY_MODULE_PLACEHOLDER)) {
      fields.push({ field: 'body', count: countOccurrences(body) });
    }
    const headers = entry.headers;
    if (typeof headers === 'object' && headers !== null) {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
          fields.push({ field: 'header', key, count: countOccurrences(value) });
        }
      }
    }
    if (fields.length > 0) {
      usages.push({
        index,
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : '(未命名)',
        fields,
        total: fields.reduce((sum, field) => sum + field.count, 0)
      });
    }
  });
  return { usages, canSuggest: true, suggestReason: '' };
}

const countOccurrences = (text: string): number => text.split(LEGACY_MODULE_PLACEHOLDER).length - 1;

/**
 * 改写一条原始条目:url/body/headers 值里的 `${module}` 全部替换为
 * `${fullModule}`;其余字段逐字保留(引用不换,值不补默认)。条目无占位时
 * 原样返回(changedFields 空)。
 */
export function rewriteRawEntryLegacyModule(
  entry: Record<string, unknown>
): { next: Record<string, unknown>; changedFields: string[] } {
  const changedFields: string[] = [];
  const next: Record<string, unknown> = { ...entry };
  const rewrite = (field: 'url' | 'body'): void => {
    const value = next[field];
    if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
      next[field] = value.split(LEGACY_MODULE_PLACEHOLDER).join(TARGET_MODULE_PLACEHOLDER);
      changedFields.push(field);
    }
  };
  rewrite('url');
  rewrite('body');
  const headers = next.headers;
  if (typeof headers === 'object' && headers !== null) {
    const nextHeaders: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
    let headerChanged = false;
    for (const [key, value] of Object.entries(nextHeaders)) {
      if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
        nextHeaders[key] = value.split(LEGACY_MODULE_PLACEHOLDER).join(TARGET_MODULE_PLACEHOLDER);
        headerChanged = true;
      }
    }
    if (headerChanged) {
      next.headers = nextHeaders;
      changedFields.push('headers');
    }
  }
  return { next, changedFields };
}

/**
 * 把改写后的条目按索引放回原始数组(其余元素**同一引用**逐字保留);
 * 越界/负索引如实返回原数组。写入只经装配层用户确认后发生,本函数纯。
 */
export function spliceMigratedEntry(
  raw: readonly unknown[],
  index: number,
  next: Record<string, unknown>
): unknown[] {
  if (!Number.isInteger(index) || index < 0 || index >= raw.length) {
    return [...raw];
  }
  const next_ = [...raw];
  next_[index] = next;
  return next_;
}
