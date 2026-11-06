import { afterEach, describe, expect, it } from 'vitest';
import {
  HoverLanguageEnv,
  getHoverLanguage,
  readHoverLanguageSetting,
  resolveHoverLanguage
} from '../src/hoverLocale';
import { configurationOverrides } from './helpers/vscodeStub';

// IDE-I18N-002:hover 文案语言解析。纯函数面(resolveHoverLanguage)注入
// 探测环境,断言不依赖宿主时区/界面语言;配置面走 configurationOverrides
// 替身。验收口径:默认 auto→英文;中文系统(VS Code 界面语言或系统 locale
// 为 zh*)或 UTC+8 时区 → 默认中文;显式 en/zh-cn 直落。

const EN_TZ = 0; // UTC+0
const CN_TZ = -480; // UTC+8(Asia/Shanghai)
const enEnv = (over: Partial<HoverLanguageEnv> = {}): HoverLanguageEnv => ({
  uiLocale: 'en',
  systemLocale: 'en-US',
  timezoneOffsetMinutes: EN_TZ,
  ...over
});

describe('resolveHoverLanguage(IDE-I18N-002)', () => {
  it('显式 en / zh-cn 直落配置值', () => {
    expect(resolveHoverLanguage('en', enEnv({ uiLocale: 'zh-cn', timezoneOffsetMinutes: CN_TZ }))).toBe('en');
    expect(resolveHoverLanguage('zh-cn', enEnv())).toBe('zh-cn');
  });

  it('auto + 英文环境 → 英文', () => {
    expect(resolveHoverLanguage('auto', enEnv())).toBe('en');
  });

  it('auto + VS Code 界面语言 zh*(大小写不敏感)→ 中文', () => {
    expect(resolveHoverLanguage('auto', enEnv({ uiLocale: 'zh-cn' }))).toBe('zh-cn');
    expect(resolveHoverLanguage('auto', enEnv({ uiLocale: 'zh-CN' }))).toBe('zh-cn');
  });

  it('auto + 系统 locale zh*(界面语言英文)→ 中文', () => {
    expect(resolveHoverLanguage('auto', enEnv({ systemLocale: 'zh-CN' }))).toBe('zh-cn');
  });

  it('auto + UTC+8 时区(界面/系统均英文)→ 中文;UTC+9 不算', () => {
    expect(resolveHoverLanguage('auto', enEnv({ timezoneOffsetMinutes: CN_TZ }))).toBe('zh-cn');
    expect(resolveHoverLanguage('auto', enEnv({ timezoneOffsetMinutes: -540 }))).toBe('en');
  });

  it('auto + 探测面缺省(测试替身无 vscode.env/Intl 失败)→ 按已知时区裁决', () => {
    expect(resolveHoverLanguage('auto', { timezoneOffsetMinutes: EN_TZ })).toBe('en');
    expect(resolveHoverLanguage('auto', { timezoneOffsetMinutes: CN_TZ })).toBe('zh-cn');
  });
});

describe('hover.language 配置面(IDE-I18N-002)', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('未配置回落 auto;非法值回落 auto', () => {
    expect(readHoverLanguageSetting()).toBe('auto');
    configurationOverrides.set('kbengine', { 'hover.language': 'fr' });
    expect(readHoverLanguageSetting()).toBe('auto');
  });

  it('getHoverLanguage 走配置 → 探测环境 → 解析(显式覆盖生效)', () => {
    // 显式覆盖与本机探测解耦:无论宿主是否中文环境,显式值必须直落
    configurationOverrides.set('kbengine', { 'hover.language': 'en' });
    expect(getHoverLanguage()).toBe('en');
    configurationOverrides.set('kbengine', { 'hover.language': 'zh-cn' });
    expect(getHoverLanguage()).toBe('zh-cn');
  });
});
