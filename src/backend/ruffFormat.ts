/**
 * .py 一键格式化 via ruff format(2026-11-18 批 A,巡检单
 * kode-ruff-format-statusbar.md)。A 案 shell out 零 API 耦合,与 ruffLint
 * 同源口径:Rust 侧 `$/kode/ruff/format`(kode-server ruff_format.rs)负责
 * 探测/spawn/stdin→stdout 管道;缺二进制如实 `available:false`(回退不报)。
 * 本文件只做:
 * - 桥(runRuffFormat:载荷契约 content/fileName/ruffPath);
 * - 命令编排(runRuffFormatCommand):活动 .py → format → 全文替换;
 *   缺 ruff 同意式安装(同 ruffLint 成熟先例),拒绝亮手动命令,绝不静默装;
 * - Provider 注册编排(ensureRuffFormatterRegistered):探测到 ruff 自动注册
 *   document/range 两 provider(**不抢默认**:不动 editor.defaultFormatter,
 *   仅用户未配置任何 python 格式化器时一次性提示「一键设为默认」,点才设);
 * - 生成器直通(formatGeneratedPython):探测到 ruff 才多行化,不可用原样
 *   返回(单行兼容)。
 * - 无 vscode import:UI/进程面全经 deps 注入(单测驱动纯编排)。
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { l10nText } from '../nlsRuntime';
import type { RustCall } from './ruffLint';

export interface RuffFormatResult {
  available: boolean;
  version?: string;
  formatted?: string;
}

/** `$/kode/ruff/format` 桥:content/fileName 直传(stdin 管道由 Rust 侧接)。 */
export async function runRuffFormat(
  content: string,
  fileName: string,
  ruffPath?: string
): Promise<RustCall<RuffFormatResult>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust('$/kode/ruff/format', { content, fileName, ruffPath });
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  const record = response.result as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || typeof record.available !== 'boolean') {
    return { status: 'error', reason: 'ruffFormat: unexpected result shape from rust backend' };
  }
  if (record.available && typeof record.formatted !== 'string') {
    return { status: 'error', reason: 'ruffFormat: available face must carry formatted text' };
  }
  return {
    status: 'ok',
    result: {
      available: record.available,
      version: record.version as string | undefined,
      formatted: record.formatted as string | undefined
    }
  };
}

export interface RuffFormatCommandDeps {
  /** 活动编辑器文件(仅 .py;非 .py/无编辑器 = null)。 */
  getActivePythonFile(): { fileName: string; content: string } | null;
  /** 应用格式化全文(编辑替换)。 */
  applyFormattedText(text: string): void;
  /** 当前选定解释器路径(null=未选定)。 */
  getInterpreterPath(): string | null;
  /** 解释器 bin 下 ruff 定位(null=PATH 回落);探测/格式化同源,防探测命中而格式化落空。 */
  getRuffPath?(): string | undefined;
  /** pip 安装(同意后调用);ok=false 时 output 携原始 stdout/stderr。 */
  runPipInstall(interpreterPath: string): Promise<{ ok: boolean; output: string }>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<unknown>;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

const INSTALL_ACTION = l10nText('Install (via pip)');
const SKIP_ACTION = l10nText('Not now');

/**
 * `kbengine.python.ruffFormat`:格式化当前 .py。可用即全文替换;缺 ruff →
 * 同意式安装(装成自动重试一次);安装失败/拒绝如实亮手动命令,不 crash。
 */
export async function runRuffFormatCommand(deps: RuffFormatCommandDeps): Promise<void> {
  const active = deps.getActivePythonFile();
  if (!active) {
    void deps.showInformationMessage(l10nText('Open a Python file to format it with ruff.'));
    return;
  }
  let call = await runRuffFormat(active.content, active.fileName, deps.getRuffPath?.());
  if (call.status === 'ok' && !call.result.available) {
    const interpreter = deps.getInterpreterPath();
    if (interpreter) {
      const choice = await deps.showInformationMessage(
        l10nText('ruff is not installed. Install it now via pip?'),
        INSTALL_ACTION,
        SKIP_ACTION
      );
      if (choice === INSTALL_ACTION) {
        const install = await deps.runPipInstall(interpreter);
        deps.channel.appendLine(install.output);
        if (install.ok) {
          call = await runRuffFormat(active.content, active.fileName, deps.getRuffPath?.());
        } else {
          deps.channel.show(true);
          void deps.showErrorMessage(
            l10nText('pip install failed. Run it manually: {cmd}', {
              cmd: `${interpreter} -m pip install ruff`
            })
          );
          return;
        }
      } else {
        void deps.showErrorMessage(
          l10nText('Manual install command: {cmd}', { cmd: `${interpreter} -m pip install ruff` })
        );
        return;
      }
    }
  }
  if (call.status !== 'ok') {
    void deps.showErrorMessage(
      l10nText('ruff format failed: {reason}', {
        reason: call.status === 'error' ? call.reason : 'rust backend unavailable'
      })
    );
    return;
  }
  if (!call.result.available || call.result.formatted === undefined) {
    // 无解释器可装/仍未装:亮手动命令让用户自己装,不重试风暴。
    void deps.showErrorMessage(l10nText('ruff is not installed. Install it and retry.'));
    return;
  }
  deps.applyFormattedText(call.result.formatted);
}

export interface RuffFormatterRegisterDeps {
  /** 探测 ruff 可用性(解释器 bin/PATH;不弹任何 UI)。 */
  probeRuffAvailable(): Promise<boolean>;
  registerDocumentFormattingEditProvider(
    selector: unknown,
    provider: unknown
  ): unknown;
  registerDocumentRangeFormattingEditProvider(
    selector: unknown,
    provider: unknown
  ): unknown;
  /** 用户 editor.defaultFormatter 当前值(未设=undefined)。 */
  getDefaultFormatter(): string | undefined;
  /** 用户点「设为默认」后实际写入面(装配层注入;未注入=只问不设)。 */
  setDefaultFormatter?(): void;
  /** 解释器 bin 下 ruff 定位(null/未注入=PATH 回落);探测与 provider 同源。 */
  getRuffPath?(): string | undefined;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

const SET_DEFAULT_ACTION = l10nText('Set as default formatter');

/**
 * 激活期探测注册(默认不抢默认):探测到 ruff → 注册 document/range 两
 * provider(python);未探测 → 不注册零打扰。仅当用户未配置任何
 * defaultFormatter 时,一次性提示「一键设为默认」——点才设,绝不自动改。
 */
export async function ensureRuffFormatterRegistered(deps: RuffFormatterRegisterDeps): Promise<boolean> {
  const available = await deps.probeRuffAvailable();
  if (!available) {
    return false;
  }
  const documentProvider = makeRuffFormatProvider(deps.getRuffPath);
  deps.registerDocumentFormattingEditProvider({ language: 'python' }, documentProvider);
  deps.registerDocumentRangeFormattingEditProvider({ language: 'python' }, documentProvider);
  if (!deps.getDefaultFormatter()) {
    void deps.showInformationMessage(
      l10nText('Kode (ruff) can format Python files. Set it as the default formatter?'),
      SET_DEFAULT_ACTION
    ).then(choice => {
      // 「点才设」:装配层接线实际设置面;此处仅编排询问,设置动作由
      // deps 消费方注入(保持本核零 vscode)。
      if (choice === SET_DEFAULT_ACTION) { deps.setDefaultFormatter?.(); }
    });
  }
  return true;
}

/** provider 本体:document/range 共用——内容→runRuffFormat→TextEdit 全文替换。 */
function makeRuffFormatProvider(
  getRuffPath?: () => string | undefined
): {
  provideDocumentFormattingEdits(document: { fileName: string; getText(): string }): Promise<Array<{ range: unknown; newText: string }> | undefined>;
  provideDocumentRangeFormattingEdits(document: { fileName: string; getText(): string }): Promise<Array<{ range: unknown; newText: string }> | undefined>;
} {
  const format = async (document: { fileName: string; getText(): string }) => {
    const call = await runRuffFormat(document.getText(), document.fileName, getRuffPath?.());
    if (call.status !== 'ok' || !call.result.available || call.result.formatted === undefined) {
      return undefined;
    }
    return [{ range: undefined, newText: call.result.formatted }];
  };
  return {
    provideDocumentFormattingEdits: format,
    provideDocumentRangeFormattingEdits: format
  };
}

export interface FormatGeneratedPythonDeps {
  /** format 面(生产=runRuffFormat 的 available 闸;测试注入多行化替身)。 */
  runFormat(content: string, fileName: string): Promise<{ available: boolean; formatted?: string }>;
}

/**
 * 生成器直通(治本):配置类 py 生成后经 ruff format 多行化——FIXED_DICT/
 * ARRAY 长默认值不再挤一行,debug 可读。探测不到 ruff/任何失败 → 原样返回
 * (单行输出兼容不动),绝不因格式化面阻塞生成。
 */
export async function formatGeneratedPython(
  content: string,
  fileName: string,
  deps: FormatGeneratedPythonDeps
): Promise<string> {
  try {
    const result = await deps.runFormat(content, fileName);
    if (result.available && typeof result.formatted === 'string') {
      return result.formatted;
    }
  } catch {
    // 格式化面任何异常不拖垮生成主链
  }
  return content;
}
