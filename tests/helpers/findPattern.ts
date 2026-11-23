/**
 * findFiles 桩共用形参还原:真实 vscode findFiles 的 include 形参兼收
 * 字符串 glob 与 RelativePattern(2026-11-24 P1 修复起,生产侧扫描根收窄腿
 * 改传 RelativePattern 钉死单 folder,字符串形态会按每个 workspace folder
 * 各匹配一遍,跨项目根泄漏)。桩侧统一还原成 glob 字符串再走既有分支。
 */
export const patternGlob = (pattern: unknown): string => {
  if (typeof pattern === 'string') {
    return pattern;
  }
  const rp = pattern as { pattern?: unknown } | undefined | null;
  return typeof rp?.pattern === 'string' ? rp.pattern : '';
};
