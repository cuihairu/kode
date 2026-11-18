// G2-LANG-001 docs 站浏览器语言自动识别跳转——纯核决策矩阵（2026-11-18
// 用户拍板拉起）：英文首页 + 浏览器 zh 系 + 未显式选过语言 → /zh/；显式
// 切换记录让位；本会话已自动跳过不再拦（back 键可用）；深链子页不跳；
// 中文页永不反向跳。接线面（theme/index.ts enhanceApp）由 docs:build 与
// Docs CI 门守（esbuild 编译 + 站点构建），此处只钉纯核语义。
import { describe, expect, it } from 'vitest';
import {
  isRootHomepage,
  localeSegmentOf,
  normalizeBase,
  resolveAutoRedirect,
  stripBase
} from '../docs/.vitepress/theme/langAutoRedirect';

describe('G2-LANG-001 纯核：base 归一与剥离', () => {
  it('normalizeBase：三种输入形态都归一到首尾带斜杠', () => {
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('/kode/')).toBe('/kode/');
    expect(normalizeBase('/kode')).toBe('/kode/');
    expect(normalizeBase('kode/')).toBe('/kode/');
  });

  it('stripBase：根 base 原样、子 base 剥前缀保留前导斜杠、站外路径 null', () => {
    expect(stripBase('/', '/')).toBe('/');
    expect(stripBase('/guide/features.html', '/')).toBe('/guide/features.html');
    expect(stripBase('/kode/', '/kode/')).toBe('/');
    expect(stripBase('/kode/zh/guide/', '/kode/')).toBe('/zh/guide/');
    expect(stripBase('/other/x', '/kode/')).toBeNull();
  });

  it('isRootHomepage：/、/index.html、空是首页，其余不是', () => {
    expect(isRootHomepage('/')).toBe(true);
    expect(isRootHomepage('/index.html')).toBe(true);
    expect(isRootHomepage('')).toBe(true);
    expect(isRootHomepage('/guide/')).toBe(false);
    expect(isRootHomepage('/zh/')).toBe(false);
  });

  it('localeSegmentOf：/zh… 是 zh，其余站内是 en，站外 null', () => {
    expect(localeSegmentOf('/', '/')).toBe('en');
    expect(localeSegmentOf('/guide/x.html', '/')).toBe('en');
    expect(localeSegmentOf('/zh/', '/')).toBe('zh');
    expect(localeSegmentOf('/zh/guide/', '/')).toBe('zh');
    expect(localeSegmentOf('/zh/index.html', '/')).toBe('zh');
    expect(localeSegmentOf('/kode/zh/', '/kode/')).toBe('zh');
    expect(localeSegmentOf('/kode/guide/', '/kode/')).toBe('en');
    expect(localeSegmentOf('/other/', '/kode/')).toBeNull();
  });
});

describe('G2-LANG-001 纯核：自动跳决策矩阵（唯一决策点）', () => {
  const zhBrowser = ['zh-CN', 'en-US'];
  const enBrowser = ['en-US', 'zh-CN'];

  it('英文首页 + zh 系浏览器 + 无记录 + 未自动跳过 → zh', () => {
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: zhBrowser,
      storedChoice: null, autoDone: false
    })).toBe('zh');
    expect(resolveAutoRedirect({
      pathname: '/index.html', base: '/', languages: ['zh-TW'],
      storedChoice: null, autoDone: false
    })).toBe('zh');
    expect(resolveAutoRedirect({
      pathname: '/kode/', base: '/kode/', languages: ['zh'],
      storedChoice: null, autoDone: false
    })).toBe('zh');
  });

  it('浏览器语言非 zh 开头（zh 在后位也不算）→ null 留在原页', () => {
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: enBrowser,
      storedChoice: null, autoDone: false
    })).toBeNull();
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: [],
      storedChoice: null, autoDone: false
    })).toBeNull();
  });

  it('显式选择已记录（en 或 zh）→ 永不自动跳', () => {
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: zhBrowser,
      storedChoice: 'en', autoDone: false
    })).toBeNull();
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: zhBrowser,
      storedChoice: 'zh', autoDone: false
    })).toBeNull();
  });

  it('本会话已自动跳过一次（back 键回到首页）→ 不再拦', () => {
    expect(resolveAutoRedirect({
      pathname: '/', base: '/', languages: zhBrowser,
      storedChoice: null, autoDone: true
    })).toBeNull();
  });

  it('深链英文子页不跳（任务书只令首页探测）；中文页不在此面', () => {
    expect(resolveAutoRedirect({
      pathname: '/guide/features.html', base: '/', languages: zhBrowser,
      storedChoice: null, autoDone: false
    })).toBeNull();
    expect(resolveAutoRedirect({
      pathname: '/kode/guide/', base: '/kode/', languages: zhBrowser,
      storedChoice: null, autoDone: false
    })).toBeNull();
  });
});
