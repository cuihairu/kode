/**
 * 原始日志 ERROR 扫描(盘点 G6):
 * - 原始日志文件按行过 LogParser,ERROR/CRITICAL 行按「组件 + 归一签名」聚合计数;
 * - 归一签名把数字串折成 N、空白压缩、截顶,避免同一报错因 id/计数不同被拆多行;
 * - 聚合结果进 webview 面板:计数/级别/组件/签名/最近时间,点击行打开源文件命中行,
 *   「重新扫描」按钮按上一批文件重跑;
 * - 目标来自用户选择(文件/文件夹);文件夹只扫一层 .log/.txt/.out,按名排序;
 * - 读取面按 quickActions 口径容错:单文件超 64MB 上限、读取失败记入 readError,
 *   不中断其余文件。
 */

import * as vscode from 'vscode';
import { baseNameOf } from './quickActionConfig';
import { LogLevel, LogParser } from './logParser';

/** 单文件读取上限:超出记 readError,不把大文件整份读进内存 */
export const ERROR_SCAN_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** 归一签名截顶长度(字符):签名只是聚键,截掉不影响去重 */
export const ERROR_SCAN_MAX_SIGNATURE_LENGTH = 160;

export const LOG_ERROR_SCAN_VIEW_TYPE = 'kbengine.logErrorScan';
export const LOG_ERROR_SCAN_PANEL_TITLE = 'KBEngine ERROR 扫描';

export const LOG_ERROR_SCAN_DIALOG_OPTIONS: vscode.OpenDialogOptions = {
  canSelectFiles: true,
  canSelectFolders: true,
  canSelectMany: true,
  openLabel: '扫描',
  filters: { '日志文件': ['log', 'txt', 'out'] }
};

/** vscode.FileType 取值(File=1);fake-vscode 未导出该枚举,这里按真值常量收口 */
export const RAW_LOG_ENTRY_KIND_FILE = 1;
/** vscode.FileType 取值(Directory=2);同上口径 */
export const RAW_LOG_ENTRY_KIND_DIRECTORY = 2;

const ERROR_SCAN_FILE_EXTENSIONS = ['.log', '.txt', '.out'];

/** 行内含带时间戳的格式(logger 线格式/标准格式均为 `[YYYY-MM-DD HH:mm:ss]`) */
const TIMESTAMPED_LOG_PATTERN = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

/** 扫描命中:同一签名跨文件/跨行合并计数 */
export interface RawErrorHit {
  /** 归一签名(数字已折 N) */
  readonly signature: string;
  readonly component: string;
  /** ERROR 与 CRITICAL 同签名合并时取高 */
  level: LogLevel;
  count: number;
  /** 最早出现行的 epoch ms(仅行内含时间戳时);否则 null */
  readonly firstTime: number | null;
  /** 最近带时间戳命中行的 epoch ms;从未命中带时间戳的行则为 null */
  lastTime: number | null;
  /** 最早出现行的原始内容(点击行打开它所在位置) */
  readonly firstRaw: string;
  /** 最近一次命中的原始行(面板悬停样例) */
  lastRaw: string;
  /** 首见文件 fsPath 与行号(1-based,供点击定位) */
  readonly firstFile: string;
  readonly firstLine: number;
}

export interface RawLogScanFileReport {
  readonly uri: vscode.Uri;
  readonly name: string;
  /** 扫描的非空行数;未读成时为 0 */
  readonly lineCount: number;
  /** 其中 ERROR/CRITICAL 行数;未读成时为 0 */
  readonly errorCount: number;
  /** 读取失败原因;成功为 null */
  readonly readError: string | null;
}

export interface RawLogScanReport {
  readonly files: RawLogScanFileReport[];
  /** 命中按计数降序、签名升序 */
  readonly hits: RawErrorHit[];
  readonly totalLines: number;
  readonly totalErrors: number;
}

/** 读取面注入点:默认走 vscode.workspace.fs;测试与换实现可整体替换 */
export interface LogErrorScanDeps {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  readDirectory(uri: vscode.Uri): Thenable<Array<[string, number]>>;
  stat(uri: vscode.Uri): Thenable<{ size: number; type: number }>;
}

export const realLogErrorScanDeps: LogErrorScanDeps = {
  readFile: uri => vscode.workspace.fs.readFile(uri),
  readDirectory: uri => vscode.workspace.fs.readDirectory(uri),
  stat: uri => vscode.workspace.fs.stat(uri)
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 归一签名:去首尾、空白压成一个空格、数字串折 N、截顶 */
export function normalizeErrorSignature(message: string): string {
  const folded = message.trim().replace(/\s+/g, ' ').replace(/\d+/g, 'N');
  return folded.length > ERROR_SCAN_MAX_SIGNATURE_LENGTH
    ? folded.slice(0, ERROR_SCAN_MAX_SIGNATURE_LENGTH)
    : folded;
}

export function isScannableLogFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ERROR_SCAN_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * 单文件扫描:非空行计数,ERROR/CRITICAL 行并入共享命中表。
 * 行序即日志时间序:first 保持最早命中,last 每次命中刷新。
 */
export function scanRawLogFileContent(
  content: string,
  file: vscode.Uri,
  hits: Map<string, RawErrorHit>
): { lineCount: number; errorCount: number } {
  let lineCount = 0;
  let errorCount = 0;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    lineCount += 1;
    const entry = LogParser.parseLoggerMessage(line);
    // 与 logParser.parseBatch 同口径(批71):parseLoggerMessage 对字符串输入
    // 恒不返 null(catch 仅对非字符串入参可达),判空分支无触发路径。
    /* istanbul ignore start */
    if (entry === null) {
      continue;
    }
    /* istanbul ignore stop */
    if (entry.level < LogLevel.ERROR) {
      continue;
    }
    errorCount += 1;
    // 非标准启发式解析的行时间取的是扫描时刻,不作数:只有行内含时间戳的
    // 格式(logger 线格式/标准格式)才把解析出的时间写进命中
    const time = TIMESTAMPED_LOG_PATTERN.test(line) ? entry.timestamp.getTime() : null;
    const signature = normalizeErrorSignature(entry.message);
    const key = `${entry.component}\n${signature}`;
    const existing = hits.get(key);
    if (existing === undefined) {
      hits.set(key, {
        signature,
        component: entry.component,
        level: entry.level,
        count: 1,
        firstTime: time,
        lastTime: time,
        firstRaw: line,
        lastRaw: line,
        firstFile: file.fsPath,
        firstLine: index + 1
      });
      continue;
    }
    existing.count += 1;
    existing.lastRaw = line;
    if (entry.level > existing.level) {
      existing.level = entry.level;
    }
    if (time !== null) {
      existing.lastTime = time;
    }
  }

  return { lineCount, errorCount };
}

/**
 * 展开用户选择:文件直通(不按扩展名过滤——用户显式选了就扫);
 * 文件夹读一层,只收可扫扩展名的文件,按名排序;按 fsPath 去重。
 * 对话框与扫描之间路径消失的项静默跳过。
 */
export async function collectScanTargets(
  picked: readonly vscode.Uri[],
  deps: LogErrorScanDeps
): Promise<vscode.Uri[]> {
  const targets: vscode.Uri[] = [];
  const seen = new Set<string>();
  const push = (uri: vscode.Uri): void => {
    const key = uri.fsPath;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(uri);
  };

  for (const uri of picked) {
    let stat: { size: number; type: number };
    try {
      stat = await deps.stat(uri);
    } catch {
      continue;
    }
    if ((stat.type & RAW_LOG_ENTRY_KIND_DIRECTORY) !== 0) {
      let entries: Array<[string, number]>;
      try {
        entries = await deps.readDirectory(uri);
      } catch {
        // 文件夹读不到(权限/虚拟文件系统):照 quickActions 口径静默跳过
        continue;
      }
      const names = entries
        .filter(
          ([name, type]) => type === RAW_LOG_ENTRY_KIND_FILE && isScannableLogFileName(name)
        )
        .map(([name]) => name)
        .sort();
      for (const name of names) {
        push(vscode.Uri.joinPath(uri, name));
      }
      continue;
    }
    push(uri);
  }

  return targets;
}

/** 整批扫描:每文件一行报告 + 跨文件合并的命中表 */
export async function scanRawLogErrors(
  targets: readonly vscode.Uri[],
  deps: LogErrorScanDeps
): Promise<RawLogScanReport> {
  const hits = new Map<string, RawErrorHit>();
  const files: RawLogScanFileReport[] = [];

  for (const uri of targets) {
    try {
      const stat = await deps.stat(uri);
      if (stat.size > ERROR_SCAN_MAX_FILE_BYTES) {
        files.push({
          uri,
          name: baseNameOf(uri.fsPath),
          lineCount: 0,
          errorCount: 0,
          readError: `文件超过 ${Math.round(ERROR_SCAN_MAX_FILE_BYTES / 1024 / 1024)}MB 读取上限(${stat.size} 字节),已跳过`
        });
        continue;
      }
      const bytes = await deps.readFile(uri);
      const { lineCount, errorCount } = scanRawLogFileContent(
        Buffer.from(bytes).toString('utf8'),
        uri,
        hits
      );
      files.push({ uri, name: baseNameOf(uri.fsPath), lineCount, errorCount, readError: null });
    } catch (error) {
      files.push({
        uri,
        name: baseNameOf(uri.fsPath),
        lineCount: 0,
        errorCount: 0,
        readError: errorMessage(error)
      });
    }
  }

  const hitList = [...hits.values()].sort(
    (a, b) => b.count - a.count || a.signature.localeCompare(b.signature)
  );

  return {
    files,
    hits: hitList,
    totalLines: files.reduce((sum, file) => sum + file.lineCount, 0),
    totalErrors: files.reduce((sum, file) => sum + file.errorCount, 0)
  };
}

/** 点击命中行的默认打开链:源文件打开并把选区落在首见行 */
export const realOpenLogScanTarget = async (uri: vscode.Uri, line: number): Promise<void> => {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    selection: new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line, 0))
  });
};

/** 命令层编排:对话框 → 目标展开 → 扫描 → 面板 */
export async function runLogErrorScanCommand(
  view: LogErrorScanView,
  deps: LogErrorScanDeps = realLogErrorScanDeps,
  pickFiles: () => Thenable<readonly vscode.Uri[] | undefined> = () =>
    vscode.window.showOpenDialog(LOG_ERROR_SCAN_DIALOG_OPTIONS)
): Promise<void> {
  const picked = await pickFiles();
  if (!picked || picked.length === 0) {
    return;
  }
  const targets = await collectScanTargets(picked, deps);
  if (targets.length === 0) {
    await vscode.window.showInformationMessage('所选位置没有可扫描的日志文件(.log/.txt/.out)');
    return;
  }
  const report = await scanRawLogErrors(targets, deps);
  view.show(report);
}

function formatScanTime(time: number | null): string {
  if (time === null) {
    return '—';
  }
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 扫描聚合面板:汇总条 + 文件报告 + 命中表;消息两通道(open/rescan) */
export class LogErrorScanView {
  private panel: vscode.WebviewPanel | null = null;
  private report: RawLogScanReport | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly rescan: (previous: RawLogScanReport) => Thenable<RawLogScanReport>,
    private readonly openTarget: (uri: vscode.Uri, line: number) => Thenable<void> = realOpenLogScanTarget
  ) {
    this.context.subscriptions.push({ dispose: () => this.dispose() });
  }

  show(report: RawLogScanReport): void {
    this.report = report;
    if (this.panel !== null) {
      this.panel.webview.html = this.getHtml(report);
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      LOG_ERROR_SCAN_VIEW_TYPE,
      LOG_ERROR_SCAN_PANEL_TITLE,
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );
    this.panel = panel;
    panel.webview.html = this.getHtml(report);
    void panel.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.panel = null;
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { command?: string; file?: string; line?: number };
    if (msg.command === 'rescan') {
      if (this.report === null) {
        return;
      }
      const report = await this.rescan(this.report);
      this.show(report);
      return;
    }
    if (msg.command === 'open' && msg.file !== undefined && msg.line !== undefined) {
      try {
        await this.openTarget(vscode.Uri.file(msg.file), msg.line);
      } catch (error) {
        await vscode.window.showErrorMessage(`打开日志文件失败: ${errorMessage(error)}`);
      }
    }
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  private getHtml(report: RawLogScanReport): string {
    const fileItems = report.files
      .map(
        file =>
          `<li class="scan-file"><span class="scan-file-name">${this.escapeHtml(file.name)}</span> — ${
            file.readError === null
              ? `${file.lineCount} 行 / ${file.errorCount} 条`
              : `<span class="scan-file-error">读取失败: ${this.escapeHtml(file.readError)}</span>`
          }</li>`
      )
      .join('');

    const hitsSection =
      report.hits.length === 0
        ? '<div class="empty-state">未发现 ERROR/CRITICAL 行</div>'
        : `<table class="hit-table"><thead><tr>
             <th>计数</th><th>级别</th><th>组件</th><th>签名</th><th>最近时间</th>
           </tr></thead><tbody id="hitBody">${report.hits
             .map(
               hit =>
                 `<tr class="hit-row" data-file="${this.escapeHtml(hit.firstFile)}" data-line="${hit.firstLine}">` +
                 `<td class="hit-count">${hit.count}</td>` +
                 `<td><span class="level-badge ${
                   hit.level === LogLevel.CRITICAL ? 'level-critical' : 'level-error'
                 }">${LogLevel[hit.level]}</span></td>` +
                 `<td class="hit-component">${this.escapeHtml(hit.component)}</td>` +
                 `<td class="hit-signature" title="${this.escapeHtml(hit.lastRaw)}">${this.escapeHtml(
                   hit.signature
                 )}</td>` +
                 `<td class="hit-time">${formatScanTime(hit.lastTime)}</td></tr>`
             )
             .join('')}</tbody></table>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KBEngine ERROR 扫描</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background-color: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    padding: 10px;
  }
  .toolbar { display: flex; gap: 10px; padding: 8px 0; margin-bottom: 10px; }
  .toolbar button {
    padding: 4px 14px;
    background-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 2px; cursor: pointer;
  }
  .toolbar button:hover { background-color: var(--vscode-button-hoverBackground); }
  .summary {
    padding: 8px 10px; margin-bottom: 10px; line-height: 1.6;
    color: var(--vscode-descriptionForeground);
    border-left: 3px solid var(--vscode-testing-iconFailed);
    background-color: var(--vscode-inputValidation-errorBackground);
  }
  .section-title { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 10px 0 4px; }
  .scan-file { padding: 3px 0 3px 14px; list-style: none; }
  .scan-file-name { font-family: var(--vscode-editor-font-family); }
  .scan-file-error { color: var(--vscode-testing-iconFailed); }
  .hit-table { width: 100%; border-collapse: collapse; }
  .hit-table th, .hit-table td {
    text-align: left; padding: 5px 8px; font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    vertical-align: top;
  }
  .hit-table th { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .hit-row { cursor: pointer; }
  .hit-row:hover { background-color: var(--vscode-list-hoverBackground); }
  .hit-count { font-weight: bold; color: var(--vscode-testing-iconFailed); }
  .hit-signature { font-family: var(--vscode-editor-font-family); }
  .hit-time { white-space: nowrap; color: var(--vscode-descriptionForeground); }
  .level-badge { padding: 1px 6px; border-radius: 2px; color: white; font-size: 11px; }
  .level-error { background-color: #F44336; }
  .level-critical { background-color: #D32F2F; }
  .empty-state { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="toolbar">
  <button id="rescanBtn">重新扫描</button>
  <span class="summary" style="border: none; background: none; padding: 0;">
    点击命中行打开源文件对应行
  </span>
</div>
<div class="summary">
  ${report.files.length} 个文件 · ${report.totalLines} 行 · ${report.totalErrors} 条 ERROR/CRITICAL · ${report.hits.length} 种签名
</div>
<div class="section-title">扫描文件</div>
<ul>${fileItems}</ul>
<div class="section-title">ERROR/CRITICAL 聚合(按计数降序)</div>
${hitsSection}
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('rescanBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'rescan' });
  });
  document.getElementById('hitBody').addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('tr[data-file]') : null;
    if (row) {
      vscode.postMessage({
        command: 'open',
        file: row.dataset.file,
        line: parseInt(row.dataset.line, 10)
      });
    }
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.panel !== null) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}
