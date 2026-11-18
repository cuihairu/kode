// G2-LANG-001 docs 站浏览器语言自动识别跳转（2026-11-18 用户拍板拉起）：
// 首页 JS 探测 navigator.language 以 zh 开头且未显式选择过语言时 → /zh/；
// 显式切换（VitePress 语言菜单等任何跨语言段导航）记入 localStorage，
// 此后自动跳永久让位；本会话已自动跳过一次后不再拦（back 键回首页可用）。
// 纯核零 vitepress 依赖——接线在 theme/index.ts，测试在
// tests/docsLangAutoRedirect.test.ts。
//
// 语义边界（对齐任务书口径）：只处理英文首页（locale root 落地页）这一种
// 入口；直接深链进英文子页不跳（任务书只令首页探测）；中文页（/zh/）永不
// 反向跳英文——双向自动跳会互相打架，显式选择才是唯一回程通道。

/** localStorage：用户显式选过的语言（'en' | 'zh'），存在即自动跳让位 */
export const LANG_CHOICE_STORAGE_KEY = 'kode-docs-lang-choice';

/** sessionStorage：本会话已自动跳过一次（防 back 键回首页被再拦成死循环） */
export const LANG_AUTO_SESSION_KEY = 'kode-docs-lang-auto';

export type LocaleSegment = 'en' | 'zh';

/** 归一 base 为「首尾都带 /」形态（config 里是 '/' 或 '/kode/'） */
export const normalizeBase = (base: string): string => {
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
};

/** 剥掉 base 后的站内路径（保留前导 /）；剥不掉=非本站路径 → null */
export const stripBase = (pathname: string, base: string): string | null => {
  const normalized = normalizeBase(base);
  if (normalized === '/') {
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  }
  if (!pathname.startsWith(normalized)) {
    return null;
  }
  const rest = pathname.slice(normalized.length - 1);
  return rest === '' ? '/' : rest;
};

/** 英文首页（locale root 落地页）：'/'、'/index.html' 或空 */
export const isRootHomepage = (rest: string): boolean =>
  rest === '/' || rest === '/index.html' || rest === '';

/** 站内路径的语言段：/zh… → zh，其余站内路径 → en，非本站 → null */
export const localeSegmentOf = (pathname: string, base: string): LocaleSegment | null => {
  const rest = stripBase(pathname, base);
  if (rest === null) {
    return null;
  }
  return rest === '/zh' || rest.startsWith('/zh/') || rest.startsWith('/zh.') ? 'zh' : 'en';
};

export interface AutoRedirectInput {
  /** window.location.pathname（含 base） */
  pathname: string;
  /** 站点 base（siteData.base，'/' 或 '/kode/'） */
  base: string;
  /** navigator.languages（空数组=浏览器不可探测） */
  languages: readonly string[];
  /** localStorage 里的显式选择记录（无 = null） */
  storedChoice: string | null;
  /** 本会话是否已自动跳过一次 */
  autoDone: boolean;
}

/** 唯一决策点：满足「英文首页 + 未显式选过 + 本会话未自动跳 + 浏览器语言
 *  zh 系」全部条件 → 'zh'（该跳中文）；任何一条不满足 → null（留在原页） */
export const resolveAutoRedirect = (input: AutoRedirectInput): LocaleSegment | null => {
  const rest = stripBase(input.pathname, input.base);
  if (rest === null || !isRootHomepage(rest)) {
    return null;
  }
  if (input.storedChoice !== null && input.storedChoice !== '') {
    return null;
  }
  if (input.autoDone) {
    return null;
  }
  // 任务书口径=navigator.language（首选位）以 zh 开头；后位含 zh 不算
  // （en-US 为主 + zh 为辅的用户首选英文，不该被跳走）
  const preferred = input.languages[0] ?? '';
  return preferred.toLowerCase().startsWith('zh') ? 'zh' : null;
};
