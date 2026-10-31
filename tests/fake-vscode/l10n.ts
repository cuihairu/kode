// vscode.l10n 替身(本地化面,quick fix 文案跟随语言设置)。真实 VS Code 按
// 扩展当前语言加载 l10n/bundle.l10n.<locale>.json,无匹配 bundle(默认 en)
// 时 t() 原样返回传入的英文 message。这里提供可注入 bundle 供 zh-cn 断言;
// 未注入(默认)即英文面,与真实无 bundle 行为一致。
//
// 关键口径:key=调用 t() 时传入的英文源串(含 {name} 占位符),value=该语言
// 译文;占位符在译文内替换(真实 vscode.l10n 先查译文再替换)。

export type L10nArgs = Record<string, unknown>;

let activeBundle: Record<string, string> | null = null;

export const l10n = {
  t(message: string, args?: L10nArgs): string {
    let text = activeBundle?.[message] ?? message;
    if (args) {
      for (const [key, value] of Object.entries(args)) {
        text = text.split(`{${key}}`).join(String(value));
      }
    }
    return text;
  }
};

/** 测试专用:注入当前语言 bundle(模拟 VS Code 载入 l10n/bundle.l10n.<locale>.json);null=英文默认 */
export function setL10nBundle(bundle: Record<string, string> | null): void {
  activeBundle = bundle;
}

/** 测试专用:读取当前注入的 bundle(断言/复位辅助) */
export function getL10nBundle(): Record<string, string> | null {
  return activeBundle;
}
