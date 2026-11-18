/**
 * 工作区目录着色纯核(FOLDER-COLOR-001 立项 2026-11-18):「按路径语义给
 * 工作区目录上彩色图标/角标,带开关」——assetsRoot→资产、venv→虚拟环境、
 * docs→文档、configs→配置、logs→日志、scripts/<role>/→进程色(与面包屑批
 * PROC-BREADCRUMB-001 同源 ProcessOwnershipSpec 语义)。
 *
 * 零 vscode 零 IO:规则集与启用态由调用方注入,本核只做 glob 匹配与
 * 语义→面孔映射。能力边界如实:原生 Explorer 无文件夹底色 API,本功能
 * 只装饰「文件」(FileDecorationProvider)+ 自有树视图;目录本身不装饰。
 */

import { resolveScriptRole, type ProcessName } from './processOwnershipLens';

/** 语义名(规则与图标资产一一对应的稳定词表) */
export type FolderColorSemantic = 'assets' | 'venv' | 'docs' | 'configs' | 'logs' | 'process';

/** 语义面孔键:五个目录语义 + 四个进程(进程色复用面包屑批 ProcessName 词表) */
export type FolderColorFaceKey = FolderColorSemantic | ProcessName;

/** 语义→单字母角标 + 主题色 id(badge ≤1 字符是 FileDecoration API 硬限) */
export interface FolderColorFace {
  readonly badge: string;
  readonly colorId: string;
  /** 角标 tooltip 用语义全名(调用方再 l10n/拼接) */
  readonly semantic: FolderColorSemantic;
  /** process 语义判定出的进程;非 process 语义=null */
  readonly process: ProcessName | null;
}

/** 色板:charts.* 系与 hotReloadFileDecorations 同族(主题内建色表,亮暗自适应);
 * venv 用 descriptionForeground 弱化灰(默认弱化口径);进程色按面包屑批进程词表 */
const SEMANTIC_FACES: Readonly<Record<FolderColorFaceKey, { badge: string; colorId: string }>> = {
  assets: { badge: 'A', colorId: 'charts.orange' },
  venv: { badge: 'V', colorId: 'descriptionForeground' },
  docs: { badge: 'D', colorId: 'charts.blue' },
  configs: { badge: 'C', colorId: 'charts.purple' },
  logs: { badge: 'L', colorId: 'charts.red' },
  // process 是「族键」:运行期真面孔按判定出的进程取(baseapp/cellapp/
  // client/bots 各自条目),本条目只为 Record 全量存在,不会被直接命中
  process: { badge: 'P', colorId: 'charts.green' },
  baseapp: { badge: 'B', colorId: 'charts.blue' },
  cellapp: { badge: 'C', colorId: 'charts.green' },
  client: { badge: 'U', colorId: 'charts.yellow' },
  bots: { badge: 'T', colorId: 'charts.purple' }
};

/** 用户可配置规则(glob + 语义名 + 开关);命中互斥=数组序第一条赢 */
export interface FolderColorRule {
  readonly glob: string;
  readonly semantic: FolderColorSemantic;
  readonly enabled: boolean;
}

/**
 * 内置默认规则(顺序即优先序):assetsRoot 子树最优先(资产根是 profile
 * 派生路径,用 `{assetsRoot}` 占位符在解析期展开);venv/docs/configs/logs
 * 按目录名全树匹配(任意层同名目录都命中);scripts 子树按进程色。默认
 * 口径如此,用户可用自定义 rules 数组收窄/调序覆盖。
 */
export const DEFAULT_FOLDER_COLOR_RULES: readonly FolderColorRule[] = [
  { glob: '{assetsRoot}/**', semantic: 'assets', enabled: true },
  { glob: '**/{venv,.venv}/**', semantic: 'venv', enabled: true },
  { glob: '**/docs/**', semantic: 'docs', enabled: true },
  { glob: '**/configs/**', semantic: 'configs', enabled: true },
  { glob: '**/logs/**', semantic: 'logs', enabled: true },
  { glob: '**/scripts/**', semantic: 'process', enabled: true }
];

/** 解析上下文(全部由调用方注入,本核零 IO) */
export interface FolderColorResolveContext {
  /** 工作区根(相对 glob 的锚点;路径分隔统一 /) */
  readonly workspaceRoot: string;
  /** 活动 profile 的资产根(无 profile 或未记录=undefined,`{assetsRoot}` 规则跳过) */
  readonly assetsRoot?: string;
  /** 用户规则集(缺省=内置默认) */
  readonly rules?: readonly FolderColorRule[];
}

/** 路径归一:\ → /(工程实测两平台都会进来),重复分隔压缩 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/** glob → RegExp(零依赖微实现):整段双星=跨段任意(段中双星=零或多层
 * 目录;段尾双星=余下全部),单星=段内任意、问号=单字符、花括号=备选
 * (不嵌套);其余按字面转义。点前缀目录名按字面匹配。注释里不写含
 * 星斜杠的字面 glob——那会把本块注释提前关闭(实测踩过) */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let source = '^';
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        const prev = i > 0 ? normalized[i - 1] : '';
        const next = normalized[i + 2] ?? '';
        if ((prev === '' || prev === '/') && (next === '' || next === '/')) {
          // 整段 `**`:段中(`**/`)=零或多层目录(自带尾分隔,故后随 `/`
          // 一并吸收);段尾=余下全部(含分隔符)
          if (next === '/') {
            source += '(?:.*/)?';
            i += 3;
          } else {
            source += '.*';
            i += 2;
          }
        } else {
          source += '.*'; // 段内嵌 `**` 按跨段通配处理(罕见形态,宽义)
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else if (char === '{') {
      const end = normalized.indexOf('}', i);
      if (end < 0) {
        source += '\\{';
        i += 1;
      } else {
        const body = normalized
          .slice(i + 1, end)
          .split(',')
          .map(alternative => alternative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        source += `(?:${body})`;
        i = end + 1;
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/** `{assetsRoot}` 占位符展开(展开早于 glob 编译,与 `{a,b}` 备选语法不冲突) */
function expandRuleGlob(glob: string, ctx: FolderColorResolveContext): string | null {
  if (!glob.includes('{assetsRoot}')) {
    return glob;
  }
  const root = ctx.assetsRoot?.trim();
  if (!root) {
    return null; // 无资产根=该规则无从展开,如实不命中
  }
  return glob.split('{assetsRoot}').join(normalizePath(root));
}

/**
 * 语义解析:规则集数组序扫描,enabled=false 跳过,第一条命中即赢(互斥;
 * 用户调序即覆盖)。process 语义交 resolveScriptRole 判进程(与面包屑批
 * 同源判定链;判不出=该规则不出面,继续看后续规则——诚实口径不猜)。
 * 目录与文件都可能进来(判定纯按路径),「只装饰文件」由 provider 面过滤。
 */
export function resolveFolderColor(fsPath: string, ctx: FolderColorResolveContext): FolderColorFace | null {
  const rules = ctx.rules ?? DEFAULT_FOLDER_COLOR_RULES;
  const workspaceRoot = normalizePath(ctx.workspaceRoot);
  const absolute = normalizePath(fsPath);
  let relative: string | null = null;
  if (absolute.startsWith(`${workspaceRoot}/`)) {
    relative = absolute.slice(workspaceRoot.length + 1);
  }
  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }
    const pattern = expandRuleGlob(rule.glob, ctx);
    if (pattern === null) {
      continue;
    }
    const matcher = globToRegExp(pattern);
    // 绝对形态 glob(展开后的 `{assetsRoot}` 等):/ 开头或盘符开头;其余按
    // 工作区根相对匹配
    const absolutePattern = pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern);
    const hit = absolutePattern
      ? matcher.test(absolute)
      : relative !== null && matcher.test(relative);
    if (!hit) {
      continue;
    }
    if (rule.semantic === 'process') {
      const process = resolveScriptRole(fsPath);
      if (!process) {
        continue; // scripts/ 直挂文件判不出进程:不出面,不猜
      }
      const entry = SEMANTIC_FACES[process];
      return { badge: entry.badge, colorId: entry.colorId, semantic: 'process', process };
    }
    const entry = SEMANTIC_FACES[rule.semantic];
    return { badge: entry.badge, colorId: entry.colorId, semantic: rule.semantic, process: null };
  }
  return null;
}

/** Kode 主题族判定:label 命中 contributes.themes 的「KBEngine」前缀族
 * (真源=package.json;loader 面读包注入,本核不做 IO) */
export function isKodeThemeFamily(themeLabel: string, kodeThemeLabels: readonly string[]): boolean {
  if (themeLabel.startsWith('KBEngine')) {
    return true; // 前缀兜底(主题 label 微调仍归族)
  }
  return kodeThemeLabels.includes(themeLabel);
}

/** 双条件启用(用户令终版口径):开关开 + Kode 主题族,缺一=零装饰输出 */
export function folderColorsActive(enabled: boolean, themeLabel: string, kodeThemeLabels: readonly string[]): boolean {
  return enabled && isKodeThemeFamily(themeLabel, kodeThemeLabels);
}
