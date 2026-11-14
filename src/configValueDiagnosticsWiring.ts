// KSEM-CFG-05 配置值校验接线层:kbengine.xml 值面诊断发布。
// 纯逻辑在 src/backend/configValueValidation.ts(证据分级:类型面 error /
// 枚举面 warning / 未知键面 information;范围/必填无证据源零产出)。
// 本模块只做:
//   - 独立诊断集合 kbengine-config-value(与既有规则各自独立集合同模式,
//     extension.test 注册面按创建序对账);
//   - 自持事件监听(激活首扫 + 配置 XML 打开/保存即扫 + FileSystemWatcher
//     变更即重算,与 configContractDiagnostics 同款,不进主调度链);
//   - 分析产物复用 prepareConfigAnalysis(与配置补全 provider 同一份
//     defaultsTree 身份 WeakMap 缓存)。
// 开关(默认开,关即清空零产出):kbengine.configValueDiagnostics。
// custom 树缺失(工作区无 kbengine.xml)即静默零产出,不猜。

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildConfigTreePair } from './serverConfigMerge';
import { prepareConfigAnalysis } from './configCompletionProvider';
import {
  computeConfigValueFindings,
  configLineSpan,
  CONFIG_VALUE_MESSAGE_TEMPLATES,
  type ConfigValueFinding,
} from './backend/configValueValidation';
import { l10nText } from './nlsRuntime';

/** 独立诊断集合名(extension.test 注册面对账) */
export const CONFIG_VALUE_DIAGNOSTIC_COLLECTION = 'kbengine-config-value';

export const CONFIG_VALUE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 配置值诊断目标文件名(与配置补全选择器的 custom 面同源) */
const TARGET_BASENAMES = new Set(['kbengine.xml', 'kbengine_defaults.xml']);

export function wireConfigValueDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(CONFIG_VALUE_DIAGNOSTIC_COLLECTION);
  context.subscriptions.push(collection);

  let scanSeq = 0;
  let publishedUri: string | null = null;

  const clearPublished = (): void => {
    if (publishedUri !== null) {
      collection.delete(vscode.Uri.parse(publishedUri));
      publishedUri = null;
    }
  };

  const scanOnce = (): void => {
    const seq = ++scanSeq;
    const enabled = vscode.workspace.getConfiguration('kbengine')
      .get<boolean>('configValueDiagnostics', CONFIG_VALUE_DIAGNOSTICS_ENABLED_DEFAULT);
    if (!enabled) {
      clearPublished();
      return;
    }
    const pair = buildConfigTreePair();
    if (pair.defaultsTree === null || pair.customTree === null || pair.customPath === null) {
      clearPublished();
      return;
    }
    const { scan, extraction } = prepareConfigAnalysis(pair.defaultsTree, pair.customTree);
    let customText: string;
    try {
      customText = fs.readFileSync(pair.customPath, 'utf8');
    } catch {
      clearPublished();
      return;
    }
    const findings = computeConfigValueFindings({
      customText,
      customTree: pair.customTree,
      extraction,
      scan,
    });
    if (seq !== scanSeq) {
      return; // 更新代已接管,丢弃旧代产物
    }
    if (findings.length === 0) {
      clearPublished();
      return;
    }
    const diagnostics = findings.map((finding) => toDiagnostic(customText, finding));
    const uri = vscode.Uri.file(pair.customPath);
    collection.set(uri, diagnostics);
    publishedUri = uri.toString();
  };

  const isTarget = (document: vscode.TextDocument): boolean =>
    TARGET_BASENAMES.has(path.basename(document.uri.fsPath));

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isTarget(document)) {
        scanOnce();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isTarget(document)) {
        scanOnce();
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/kbengine.xml');
  context.subscriptions.push(watcher);
  const onChange = (): void => {
    // 外部改 kbengine.xml:resolve 缓存由 serverConfigMerge 自己的监听失效,
    // 这里延一拍重算(先失效后重算的次序由事件序保证)
    scanOnce();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);

  scanOnce();
}

function toDiagnostic(text: string, finding: ConfigValueFinding): vscode.Diagnostic {
  const span = configLineSpan(text, finding.line);
  const range = new vscode.Range(finding.line - 1, span.start, finding.line - 1, span.end);
  const severity = finding.severity === 'error'
    ? vscode.DiagnosticSeverity.Error
    : finding.severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
  const diagnostic = new vscode.Diagnostic(range, l10nText(finding.message, finding.args), severity);
  diagnostic.source = 'kbengine';
  diagnostic.code = finding.code;
  return diagnostic;
}

// 模板面被 l10nText 动态取词(字面量扫描抓不到),此处引用即对账锚点:
// tests/categoryI18n.test.ts dynamicKeys() 点名 CONFIG_VALUE_MESSAGE_TEMPLATES。
void CONFIG_VALUE_MESSAGE_TEMPLATES;
