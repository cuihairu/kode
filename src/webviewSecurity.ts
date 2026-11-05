/**
 * webview 安全基建共享件(XSS/CSP 统一入口,KR-AUD-38/43/49/50):
 * - randomNonce:每次整页渲染一个脚本 nonce,配 CSP `script-src 'nonce-...'`
 *   让内联 <script> 只认本次渲染,页面其余注入的脚本一律不执行;
 * - toJsonForScript:内联 <script> 里直插 JSON 的唯一合法方式——必须吃掉
 *   `<`,否则数据里出现 `</script>` 会提前断开脚本上下文,后面的数据
 *   直接按 HTML 解析(监控面板的指标/历史序列都来自引擎 watcher,不可信);
 * - webviewScriptCsp:最小 CSP——`default-src 'none'` 断掉一切外联/外帧/
 *   连接通道,样式允许内联(各面板大量用 style 属性与 <style> 块),脚本
 *   只认 nonce(可选追加白名单源,如尚未本地化的 Chart.js CDN 固定路径)。
 */

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function toJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function webviewScriptCsp(nonce: string, extraScriptSources: string[] = []): string {
  const sources = [`'nonce-${nonce}'`, ...extraScriptSources].join(' ');
  return `default-src 'none'; style-src 'unsafe-inline'; script-src ${sources};`;
}
