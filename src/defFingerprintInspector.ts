//! HR-HASH-007/008 接线批:def 指纹 Inspector + 修改触发三路判定。
//!
//! - **Inspector(HR-HASH-007)**:命令 kbengine.def.fingerprintInspector——
//!   活动编辑器须为 .def;完整路径、三类值(fileHash/语义指纹/引擎面)、
//!   算法与版本(resolveFingerprintProfile 档案+DEF_FINGERPRINT_SPEC_VERSION
//!   +插件 API 版本)、计算时间、读面来源、复制按钮(webview 单列面板,
//!   复用既有 createWebviewPanel 模式,不新造框架)。
//! - **修改触发(HR-HASH-008)**:.def 保存事件 → 台账上次快照 vs 当前快照
//!   三路判定(fileChanged/semanticChanged/appliedConsistency)→ 结论落
//!   「KBEngine Def 分析」通道(与 defMd5Check 同名合并);首见只存底不判。
//! - **VFS 字节复用(HR-HASH-002)**:读面经 readSharedFileSnapshot(打开
//!   缓冲区优先,未保存缓冲区进指纹),来源标签如实入面板/台账;不为
//!   UI 显示单独重读文件。
//! - **applied 维度诚实边界**:def 文件无逐文件运行时回执(回执注册表只
//!   收热更 .py 面),三路判定的 applied 路如实 unknown+点名原因;工作区
//!   闭包 MD5 与 SDK 盖章是另一账(defMd5Check 命令面),面板如有最近核查
//!   结果则如实转显并标注其时点,不冒充逐文件 applied 结论。
//! - 编排纯函数化(deps 注入),vscode 面只留薄壳(命令注册/事件订阅/面板)。

import * as path from 'path';
import * as vscode from 'vscode';
import { hashDefContent } from './backend/hotReloadDefHash';
import { DEF_FINGERPRINT_SPEC_VERSION, semanticFingerprintReport } from './backend/hotReloadDefStructure';
import { resolveFingerprintProfile, type FingerprintProfile } from './backend/hotReloadFingerprintCompare';
import {
  DefFingerprintLedger,
  evaluateDefFingerprint,
  type DefAppliedDigestInput,
  type DefFingerprintSnapshot
} from './backend/hotReloadDefFingerprintLedger';
import type { FingerprintTriVerdict } from './backend/hotReloadFingerprintCompare';
import { HOT_RELOAD_PLUGIN_API_VERSION } from './backend/hotReloadPluginApi';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { DEF_MD5_CHANNEL_NAME, type DefMd5CheckOutcome } from './defMd5Check';

export const DEF_FINGERPRINT_INSPECTOR_COMMAND = 'kbengine.def.fingerprintInspector';

/** 编排依赖(注入面;测试给内存替身,缺省走真实通道) */
export interface DefFingerprintDeps {
  /** 读面:打开缓冲区优先(document)/磁盘补载(disk);皆无=null */
  readSnapshot: (fsPath: string) => { content: string; source: 'document' | 'disk' } | null;
  /** 计算时点(epoch ms) */
  now: () => number;
  /** 最近一次引擎盖章核查结果(闭包 MD5+SDK 盖章;无=如实缺,面板不冒充) */
  lastMd5Check: () => DefMd5CheckOutcome | null;
}

/** 缺省依赖:readSharedFileSnapshot 适配(VFS 字节复用面) */
export function defaultDefFingerprintDeps(lastMd5Check: () => DefMd5CheckOutcome | null): DefFingerprintDeps {
  return {
    readSnapshot: fsPath => {
      const snapshot = readSharedFileSnapshot(fsPath);
      return snapshot === null ? null : { content: snapshot.content, source: snapshot.source };
    },
    now: Date.now,
    lastMd5Check
  };
}

/** 当前快照生产:读面字节 → fileHash+语义指纹+计时;读不到=null(如实缺) */
export function computeDefFingerprintSnapshot(
  deps: DefFingerprintDeps,
  fsPath: string
): DefFingerprintSnapshot | null {
  const read = deps.readSnapshot(fsPath);
  if (read === null) {
    return null;
  }
  const started = deps.now();
  const fileHash = hashDefContent(read.content);
  const semantic = semanticFingerprintReport(read.content);
  const finished = deps.now();
  return {
    fileHash: fileHash.digest,
    byteLength: fileHash.byteLength,
    semanticHash: semantic.hash,
    source: read.source,
    at: finished,
    durationMs: Math.max(0, finished - started)
  };
}

/** applied 维度实时输入:无逐文件回执面=不传(unknown 点名原因,不冒充) */
const appliedInput = (): DefAppliedDigestInput | undefined => undefined;

/** 修改触发判定:上次快照 vs 当前快照三路结论(首见=unknown+首见原因) */
export function evaluateDefFingerprintChange(
  ledger: DefFingerprintLedger,
  fsPath: string,
  current: DefFingerprintSnapshot,
  applied?: DefAppliedDigestInput
): { last: DefFingerprintSnapshot | null; verdict: FingerprintTriVerdict } {
  const last = ledger.last(fsPath);
  const verdict = evaluateDefFingerprint(last, current, applied ?? appliedInput());
  ledger.record(fsPath, current);
  return { last, verdict };
}

/** 三路判定行的如实措辞(unknown 一律带原因) */
const verdictFace = (state: 'changed' | 'unchanged' | 'unknown', reason?: string): string =>
  state === 'unknown' ? `未知(${reason ?? '原因未提供'})` : state === 'changed' ? '有变化' : '无变化';

/**
 * 原因归位:compareFingerprints 的 reasons 按 file→semantic→applied 顺序
 * 排队,逐面消费(unknown 面才取);余量留 applied 尾巴,不逐位硬猜。
 */
const attributeReasons = (
  verdict: FingerprintTriVerdict
): { fileReason?: string; semanticReason?: string } => {
  const queue = [...verdict.reasons];
  const take = (state: 'changed' | 'unchanged' | 'unknown'): string | undefined =>
    state === 'unknown' ? queue.shift() : undefined;
  return { fileReason: take(verdict.fileChanged), semanticReason: take(verdict.semanticChanged) };
};

/** 纯文本报告(「KBEngine Def 分析」通道逐行可断言) */
export function renderFingerprintReport(input: {
  fsPath: string;
  snapshot: DefFingerprintSnapshot;
  verdict: FingerprintTriVerdict;
  profile: FingerprintProfile;
  md5Check: DefMd5CheckOutcome | null;
}): string {
  const lines: string[] = [];
  lines.push(`def 指纹详情: ${input.fsPath}`);
  lines.push(`fileHash (sha256): ${input.snapshot.fileHash}(${input.snapshot.byteLength} 字节)`);
  lines.push(
    input.snapshot.semanticHash === null
      ? '语义指纹: 解析失败(null;不猜不补)'
      : `语义指纹: ${input.snapshot.semanticHash}(${DEF_FINGERPRINT_SPEC_VERSION})`
  );
  lines.push(`读面来源: ${input.snapshot.source === 'document' ? '打开缓冲区(VFS 已有字节复用,未重读磁盘)' : '磁盘补载'}`);
  lines.push(`计算耗时: ${input.snapshot.durationMs} ms`);
  lines.push(`算法档案(HR-HASH-006): ${input.profile.label}${input.profile.negotiated ? '(已协商)' : '(未协商,如实 not available)'}`);
  lines.push(`插件 API 版本: ${HOT_RELOAD_PLUGIN_API_VERSION}`);
  const attributed = attributeReasons(input.verdict);
  lines.push(`三路判定: file=${verdictFace(input.verdict.fileChanged, attributed.fileReason)} | semantic=${verdictFace(input.verdict.semanticChanged, attributed.semanticReason)} | applied=${input.verdict.appliedConsistency}`);
  for (const reason of input.verdict.reasons) {
    lines.push(`判定备注: ${reason}`);
  }
  if (input.md5Check === null) {
    lines.push('工作区闭包面: 未运行引擎盖章核查(kbengine.def.checkEngineMd5 显式核查,不随面板补算)');
  } else {
    lines.push(
      `工作区闭包面(另账,最近核查): ${input.md5Check.workspaceMd5 === null ? 'MD5 未知(Rust 不可用)' : input.md5Check.workspaceMd5};SDK 盖章 ${input.md5Check.stamps.length} 处`
    );
  }
  return lines.join('\n');
}

/** 三路判定结论行(修改触发通道面,一行一事件;unknown 面带归位原因) */
export function renderFingerprintChangeLine(fsPath: string, verdict: FingerprintTriVerdict, firstSeen: boolean): string {
  if (firstSeen) {
    return `def 指纹首见(只存底): ${path.basename(fsPath)}`;
  }
  const { fileReason, semanticReason } = attributeReasons(verdict);
  const parts = [
    `file=${verdictFace(verdict.fileChanged, fileReason)}`,
    `semantic=${verdictFace(verdict.semanticChanged, semanticReason)}`,
    `applied=${verdict.appliedConsistency}`
  ];
  const reasons = verdict.reasons.length > 0 ? ` | ${verdict.reasons.join('; ')}` : '';
  return `def 指纹变更判定: ${path.basename(fsPath)} | ${parts.join(' | ')}${reasons}`;
}

/** Inspector 面板体(纯字符串,单列;复制按钮 postMessage 回装配落剪贴板) */
export function renderInspectorHtml(input: {
  fsPath: string;
  snapshot: DefFingerprintSnapshot;
  verdict: FingerprintTriVerdict;
  profile: FingerprintProfile;
  md5Check: DefMd5CheckOutcome | null;
}): string {
  const esc = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const row = (label: string, value: string, copyValue?: string): string => `
    <tr>
      <th>${esc(label)}</th>
      <td><code>${esc(value)}</code>${
        copyValue
          ? `<button class="copy" data-copy="${esc(copyValue)}">复制</button>`
          : ''
      }</td>
    </tr>`;
  const applied = input.verdict.appliedConsistency;
  const attributedHtml = attributeReasons(input.verdict);
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  code { word-break: break-all; }
  button.copy { margin-left: 8px; }
  ul { margin: 4px 0; padding-left: 20px; }
</style></head>
<body>
  <h2>def 指纹详情(HR-HASH-007)</h2>
  <table>
    ${row('完整路径', input.fsPath)}
    ${row('fileHash (sha256)', input.snapshot.fileHash, input.snapshot.fileHash)}
    ${row('字节数', String(input.snapshot.byteLength))}
    ${row(
      '语义指纹',
      input.snapshot.semanticHash === null ? '(解析失败,如实 null)' : input.snapshot.semanticHash,
      input.snapshot.semanticHash === null ? undefined : input.snapshot.semanticHash
    )}
    ${row('指纹规格', DEF_FINGERPRINT_SPEC_VERSION)}
    ${row('算法档案', `${input.profile.label}${input.profile.negotiated ? '(已协商)' : '(未协商)'}`)}
    ${row('插件 API 版本', HOT_RELOAD_PLUGIN_API_VERSION)}
    ${row('读面来源', input.snapshot.source === 'document' ? '打开缓冲区(VFS 已有字节复用)' : '磁盘补载')}
    ${row('计算耗时', `${input.snapshot.durationMs} ms`)}
    ${row('fileHash 对比上次', verdictFace(input.verdict.fileChanged, attributedHtml.fileReason))}
    ${row('语义指纹对比上次', verdictFace(input.verdict.semanticChanged, attributedHtml.semanticReason))}
    ${row('引擎已应用 Digest', applied)}
  </table>
  ${input.verdict.reasons.length > 0 ? `<h3>判定备注</h3><ul>${input.verdict.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}
  <h3>工作区闭包面(另账)</h3>
  ${
    input.md5Check === null
      ? '<p>未运行引擎盖章核查(kbengine.def.checkEngineMd5 显式核查,不随面板补算)。</p>'
      : `<p>闭包 MD5: ${input.md5Check.workspaceMd5 === null ? '未知(Rust 不可用)' : `<code>${esc(input.md5Check.workspaceMd5)}</code>`};SDK 盖章 ${input.md5Check.stamps.length} 处。</p>`
  }
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button.copy').forEach(button => {
      button.addEventListener('click', () => { vscode.postMessage({ type: 'copy', value: button.dataset.copy }); });
    });
  </script>
</body>
</html>`;
}

const inspectorChannels = new WeakMap<vscode.ExtensionContext, vscode.OutputChannel>();

function ensureInspectorChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  let channel = inspectorChannels.get(context);
  if (!channel) {
    channel = vscode.window.createOutputChannel(DEF_MD5_CHANNEL_NAME);
    context.subscriptions.push(channel);
    inspectorChannels.set(context, channel);
  }
  return channel;
}

/**
 * 装配:命令(活动编辑器须 .def → 快照 → 台账判定 → 面板+通道)+保存触发
 * (.def 保存 → 判定 → 通道一行)。台账与命令句柄随 context.subscriptions。
 */
export function setupDefFingerprintInspector(
  context: vscode.ExtensionContext,
  opts: {
    deps?: DefFingerprintDeps;
    onConclusion?: (line: string) => void;
  } = {}
): { ledger: DefFingerprintLedger } {
  const deps = opts.deps ?? defaultDefFingerprintDeps(() => null);
  const ledger = new DefFingerprintLedger();
  // 通道惰性建(与 defMd5Check 同口径):激活零开销,也避免装配期抢建
  // 同名通道让「首个同名通道」断言面拿到空壳。
  const channel = (): vscode.OutputChannel => ensureInspectorChannel(context);
  const reportFor = (fsPath: string): {
    snapshot: DefFingerprintSnapshot;
    verdict: FingerprintTriVerdict;
    firstSeen: boolean;
  } | null => {
    const snapshot = computeDefFingerprintSnapshot(deps, fsPath);
    if (snapshot === null) {
      return null;
    }
    const { last, verdict } = evaluateDefFingerprintChange(ledger, fsPath, snapshot);
    return { snapshot, verdict, firstSeen: last === null };
  };
  const command = vscode.commands.registerCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    const fsPath = editor?.document.uri.fsPath ?? '';
    if (fsPath === '' || !fsPath.endsWith('.def')) {
      void vscode.window.showInformationMessage('打开一个 .def 文件后再次执行「查看 Def 指纹详情」');
      return;
    }
    const outcome = reportFor(fsPath);
    if (outcome === null) {
      void vscode.window.showInformationMessage('def 指纹详情:文件不可读(已删除或双面皆无),无从展示');
      return;
    }
    const profile = resolveFingerprintProfile();
    const md5Check = deps.lastMd5Check();
    const reportInput = { fsPath, snapshot: outcome.snapshot, verdict: outcome.verdict, profile, md5Check };
    channel().appendLine(renderFingerprintReport(reportInput));
    const panel = vscode.window.createWebviewPanel(
      'kbengineDefFingerprint',
      `def 指纹: ${path.basename(fsPath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'copy' && typeof message.value === 'string') {
        void vscode.env.clipboard.writeText(message.value);
      }
    }, undefined, context.subscriptions);
    panel.webview.html = renderInspectorHtml(reportInput);
  });
  context.subscriptions.push(command);
  const saveSubscription = vscode.workspace.onDidSaveTextDocument(document => {
    const fsPath = document.uri.fsPath;
    if (!fsPath.endsWith('.def')) {
      return;
    }
    const outcome = reportFor(fsPath);
    if (outcome === null) {
      return;
    }
    const line = renderFingerprintChangeLine(fsPath, outcome.verdict, outcome.firstSeen);
    channel().appendLine(line);
    opts.onConclusion?.(line);
  });
  context.subscriptions.push(saveSubscription);
  return { ledger };
}
