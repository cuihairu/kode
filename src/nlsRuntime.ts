// KODE-I18N-002 运行时文案国际化:共用公共实现 nlsRuntime。
//
// 六类呈现面(Provider/Diagnostics/QuickPick/Notification/Output/Webview)
// 的运行时文案统一经 l10nText() 取词(包装 vscode.l10n.t,机制与既有
// quick fix 分类标签批次一致):key = 英文源串,zh-cn 由 l10n/
// bundle.l10n.zh-cn.json 提供译文;真实 VS Code 英文 locale 无匹配 bundle
// 时 t() 原样返回英文源串。缺 key 回退行为 = 回落英文源串,不空串不裸键
// (tests/nlsRuntime.test.ts 断言)。逐面接线批次沿用既有契约
// (tests/categoryI18n.test.ts):en/zh 键集全等、源串全覆盖、无死键。
import * as vscode from 'vscode';

/** 取词参数:{name} 占位符实参(真实 vscode.l10n 译文替换语义) */
export type NlsArgs = Record<string, string | number | boolean>;

/**
 * 运行时文案取词:所有呈现面的用户可见字符串唯一入口。
 * 英文系统返回英文源串,中文系统返回 zh-cn 包译文,缺 key 回落英文源串。
 */
export function l10nText(message: string, args?: NlsArgs): string {
  return args === undefined ? vscode.l10n.t(message) : vscode.l10n.t(message, args);
}
