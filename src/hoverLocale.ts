import * as vscode from 'vscode';

/**
 * hover 提示语言解析(IDE-I18N-002 用户令 2026-11-06):hover 文案语言可配置,
 * 默认 auto——检测到中文系统(VS Code 界面语言或系统 locale 为 zh*)或
 * UTC+8 时区时默认中文,否则英文;也可显式指定 en / zh-cn。
 *
 * 形态调研结论:不走 vscode.l10n——它只跟随 VS Code 界面语言,无法表达
 * 「显式覆盖为与界面不同的语言」与「UTC+8 时区探测」两条验收,故设独立
 * 配置项 `kbengine.hover.language`(与批154 hover.serverConfig 同段)。
 * manifest/quick-fix 文案仍归 vscode.l10n 体系(IDE-I18N-001),两轨并行。
 */

export type HoverLanguageSetting = 'auto' | 'en' | 'zh-cn';
export type HoverLanguage = 'en' | 'zh-cn';

/** 语言探测环境(resolveHoverLanguage 的纯注入面,测试不依赖宿主时区) */
export interface HoverLanguageEnv {
  /** VS Code 界面语言(vscode.env.language,如 'zh-cn' / 'en'),测试替身可缺省 */
  uiLocale?: string;
  /** 系统级 locale(Intl 解析,如 'zh-CN'),缺省视为未知 */
  systemLocale?: string;
  /** 宿主时区偏移分钟(new Date().getTimezoneOffset(),UTC+8 为 -480) */
  timezoneOffsetMinutes: number;
}

/** 纯解析:显式 en/zh-cn 直落;auto 探测中文系统或 UTC+8 → zh-cn,否则 en */
export function resolveHoverLanguage(
  setting: HoverLanguageSetting,
  env: HoverLanguageEnv
): HoverLanguage {
  if (setting === 'en' || setting === 'zh-cn') {
    return setting;
  }
  const uiLocale = (env.uiLocale ?? '').toLowerCase();
  const systemLocale = (env.systemLocale ?? '').toLowerCase();
  const chineseDetected =
    uiLocale.startsWith('zh') ||
    systemLocale.startsWith('zh') ||
    env.timezoneOffsetMinutes === -480;
  return chineseDetected ? 'zh-cn' : 'en';
}

/** 读配置项 `kbengine.hover.language`(未配置/非法值回落 auto) */
export function readHoverLanguageSetting(): HoverLanguageSetting {
  const value = vscode.workspace
    .getConfiguration('kbengine')
    .get<HoverLanguageSetting>('hover.language', 'auto');
  return value === 'en' || value === 'zh-cn' ? value : 'auto';
}

/** 采集宿主探测环境(独立成函数便于测试替换;测试替身无 vscode.env) */
export function currentHoverLanguageEnv(): HoverLanguageEnv {
  const uiLocale: string | undefined = (vscode as unknown as {
    env?: { language?: string };
  }).env?.language;
  let systemLocale: string | undefined;
  try {
    systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    systemLocale = undefined;
  }
  return {
    uiLocale,
    systemLocale,
    timezoneOffsetMinutes: new Date().getTimezoneOffset()
  };
}

/** 悬停面取当前文案语言:配置 → 探测环境 → 解析 */
export function getHoverLanguage(): HoverLanguage {
  return resolveHoverLanguage(readHoverLanguageSetting(), currentHoverLanguageEnv());
}
