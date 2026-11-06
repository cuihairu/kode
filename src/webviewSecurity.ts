/**
 * webview 安全基建共享件(XSS/CSP 统一入口,KR-AUD-38/43/49/50/53):
 * - randomNonce:每次整页渲染一个脚本 nonce,配 CSP `script-src 'nonce-...'`
 *   让内联 <script> 只认本次渲染,页面其余注入的脚本一律不执行;
 * - toJsonForScript:内联 <script> 里直插 JSON 的唯一合法方式——必须吃掉
 *   `<`,否则数据里出现 `</script>` 会提前断开脚本上下文,后面的数据
 *   直接按 HTML 解析(监控面板的指标/历史序列都来自引擎 watcher,不可信);
 * - webviewScriptCsp:最小 CSP——`default-src 'none'` 断掉一切外联/外帧/
 *   连接通道,样式允许内联(各面板大量用 style 属性与 <style> 块),脚本
 *   只认 nonce + 扩展自带本地资源的源(离线打包的 mermaid/chart.js 走
 *   cspSource,不再引 CDN);图片源默认不开,需要时(data:/blob: 导出图)
 *   经 extraImgSources 显式开洞;
 * - webviewAssetUri:扩展 media/ 下离线打包资源的 webview URI,与 CSP 的
 *   cspSource 同源;无 webview/extensionUri(纯逻辑测试)回落相对路径,
 *   口径与 defCallChainProvider 的 scriptUri 一致。
 */
import * as vscode from 'vscode';

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

export function webviewScriptCsp(
  nonce: string,
  extraScriptSources: string[] = [],
  extraImgSources: string[] = []
): string {
  const sources = [`'nonce-${nonce}'`, ...extraScriptSources].join(' ');
  const img = extraImgSources.length > 0 ? `img-src ${extraImgSources.join(' ')}; ` : '';
  return `default-src 'none'; ${img}style-src 'unsafe-inline'; script-src ${sources};`;
}

/** 扩展自带媒体资源(离线打包)的 webview URI */
export function webviewAssetUri(
  webview: Pick<vscode.Webview, 'asWebviewUri'> | undefined,
  extensionUri: vscode.Uri | undefined,
  ...segments: string[]
): string {
  if (webview && typeof webview.asWebviewUri === 'function' && extensionUri) {
    return String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments)));
  }
  return segments.join('/');
}
