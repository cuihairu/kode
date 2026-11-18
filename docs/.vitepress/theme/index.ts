// kode docs theme — 默认主题 + 品牌配色（custom.css 见同目录）
// VitePress 会自动发现本文件，无需在 config.mts 里引用。
// G2-LANG-001：enhanceApp 挂浏览器语言自动识别跳转（纯核 langAutoRedirect.ts，
// 决策矩阵测试 tests/docsLangAutoRedirect.test.ts）。
import type { EnhanceAppContext } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import {
  LANG_AUTO_SESSION_KEY,
  LANG_CHOICE_STORAGE_KEY,
  localeSegmentOf,
  normalizeBase,
  resolveAutoRedirect
} from './langAutoRedirect';
import './custom.css';

// 存储访问全部容错：隐私模式/禁用存储抛异常时按「未记录」处理——
// 宁可少自动跳，不因存储被拒崩站。
const readStoredChoice = (): string | null => {
  try {
    return window.localStorage.getItem(LANG_CHOICE_STORAGE_KEY);
  } catch {
    return null;
  }
};

const recordExplicitChoice = (segment: 'en' | 'zh'): void => {
  try {
    window.localStorage.setItem(LANG_CHOICE_STORAGE_KEY, segment);
  } catch {
    // 记不进：下次访问仍可自动跳，不影响本次浏览
  }
};

const readAutoDone = (): boolean => {
  try {
    return window.sessionStorage.getItem(LANG_AUTO_SESSION_KEY) === '1';
  } catch {
    return false;
  }
};

const markAutoDone = (): void => {
  try {
    window.sessionStorage.setItem(LANG_AUTO_SESSION_KEY, '1');
  } catch {
    // 存不进：大不了 back 键回首页再自动跳一次，无死循环风险
  }
};

/** G2-LANG-001 接线：只在浏览器侧生效（SSG 构建期无 window）。
 * - enhanceApp（mount 前 await）里探测：英文首页 + 浏览器 zh 系 + 从未
 *   显式选过语言 → router.go('/zh/')（SPA 换页，不整页刷新）；
 * - 任何跨语言段的后续导航（语言菜单点击、回退键）= 用户意志，记入
 *   localStorage，自动跳从此让位；我们自己触发的自动跳不算（suppress 标记）。 */
const setupLangAutoRedirect = (ctx: EnhanceAppContext): void => {
  if (typeof window === 'undefined') {
    return;
  }
  const normalizedBase = normalizeBase(ctx.siteData.value.base || '/');
  let suppressNextExplicit = false;
  let lastSegment = localeSegmentOf(window.location.pathname, normalizedBase);
  const previousHook = ctx.router.onAfterRouteChange;
  ctx.router.onAfterRouteChange = async (to: string) => {
    await previousHook?.(to);
    const pathname = new URL(to, window.location.origin).pathname;
    const segment = localeSegmentOf(pathname, normalizedBase);
    if (segment === null || segment === lastSegment) {
      return;
    }
    lastSegment = segment;
    if (suppressNextExplicit) {
      suppressNextExplicit = false; // 我们自己触发的自动跳，不算显式选择
      return;
    }
    recordExplicitChoice(segment);
  };
  if (resolveAutoRedirect({
    pathname: window.location.pathname,
    base: normalizedBase,
    languages: window.navigator.languages?.length
      ? window.navigator.languages
      : [window.navigator.language],
    storedChoice: readStoredChoice(),
    autoDone: readAutoDone()
  }) === 'zh') {
    suppressNextExplicit = true;
    markAutoDone();
    void ctx.router.go(`${normalizedBase}zh/`);
  }
};

export default {
  ...DefaultTheme,
  enhanceApp(ctx: EnhanceAppContext) {
    DefaultTheme.enhanceApp?.(ctx);
    setupLangAutoRedirect(ctx);
  }
};
