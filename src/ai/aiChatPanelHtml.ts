// AI 对话面板 HTML(AI-002):自包含零外联——CSP 只认本次渲染 nonce
// (webviewSecurity.webviewScriptCsp,default-src 'none'),无 CDN/无本地
// 媒体。消息协议(宿主⇄面板):ask/cancel/preview/apply →;→ chunk/done/
// error/cancelled/applied。会话历史驻留面板,宿主不落盘。
import { webviewScriptCsp } from '../webviewSecurity';

export interface AiChatPanelHtmlOptions {
  nonce: string;
}

export function renderAiChatPanelHtml(options: AiChatPanelHtmlOptions): string {
  const nonce = options.nonce;
  return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce)}">
  <title>KBEngine AI 对话</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; }
    #log { flex: 1; overflow-y: auto; padding: 8px 12px; }
    .msg { margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
    .user { color: var(--vscode-charts-blue); }
    .assistant { color: var(--vscode-foreground); }
    .error { color: var(--vscode-errorForeground); }
    .cancelled { color: var(--vscode-descriptionForeground); font-style: italic; }
    .suggestion { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 6px 0; padding: 6px 8px; }
    .suggestion pre { white-space: pre-wrap; word-break: break-word; max-height: 10em; overflow-y: auto; }
    .suggestion button { margin-right: 6px; }
    #bar { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border); }
    #input { flex: 1; }
    button { font-family: var(--vscode-font-family); }
  </style>
</head>
<body>
  <div id="log"></div>
  <div id="bar">
    <input id="input" type="text" placeholder="向 AI 提问(kbengine.ai.baseUrl 或宿主语言模型)" />
    <button id="send">发送</button>
    <button id="stop" hidden>中断</button>
  </div>
  <script nonce="${nonce}">
    (function () {
      'use strict';
      var vscode = acquireVsCodeApi();
      var log = document.getElementById('log');
      var input = document.getElementById('input');
      var sendBtn = document.getElementById('send');
      var stopBtn = document.getElementById('stop');
      var streaming = false;

      function div(cls, text) {
        var el = document.createElement('div');
        el.className = 'msg ' + cls;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
      }

      function setStreaming(on) {
        streaming = on;
        sendBtn.hidden = on;
        stopBtn.hidden = !on;
      }

      function addSuggestion(index, lang, code) {
        var box = document.createElement('div');
        box.className = 'suggestion';
        var head = document.createElement('div');
        head.textContent = '代码建议 #' + (index + 1) + (lang ? ' (' + lang + ')' : '') + ' —— 应用会写入当前活动文档(可撤销)';
        var pre = document.createElement('pre');
        pre.textContent = code;
        var previewBtn = document.createElement('button');
        previewBtn.textContent = '查看 diff 预览';
        previewBtn.addEventListener('click', function () { vscode.postMessage({ type: 'preview', index: index }); });
        var applyBtn = document.createElement('button');
        applyBtn.textContent = '应用';
        applyBtn.addEventListener('click', function () { vscode.postMessage({ type: 'apply', index: index }); });
        box.appendChild(head);
        box.appendChild(pre);
        box.appendChild(previewBtn);
        box.appendChild(applyBtn);
        log.appendChild(box);
        log.scrollTop = log.scrollHeight;
      }

      window.addEventListener('message', function (event) {
        var m = event.data || {};
        if (m.type === 'chunk') {
          div('assistant', m.text);
        } else if (m.type === 'done') {
          setStreaming(false);
          (m.suggestions || []).forEach(function (s, i) { addSuggestion(i, s.lang, s.code); });
        } else if (m.type === 'error') {
          div('error', m.message || String(m));
          setStreaming(false);
        } else if (m.type === 'cancelled') {
          div('cancelled', '已中断(已收部分保留)');
          setStreaming(false);
        } else if (m.type === 'applied') {
          div('cancelled', '建议已应用到 ' + m.uri + '(Ctrl+Z 可撤销)');
        } else if (m.type === 'preview') {
          div('cancelled', 'diff 预览已在编辑器组打开');
        }
      });

      function send() {
        var text = input.value.trim();
        if (!text || streaming) { return; }
        div('user', text);
        input.value = '';
        setStreaming(true);
        vscode.postMessage({ type: 'ask', text: text });
      }

      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { send(); } });
      stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
    })();
  </script>
</body>
</html>`;
}
