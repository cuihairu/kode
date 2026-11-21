/**
 * RUST-400(HR-HASH-013)①:`.def` 编辑器 CodeLens——根元素行显示文件指纹
 * (sha256 原始字节 hash + 规范化语义指纹短 hash),点击开既有 Hash Inspector。
 *
 * 口径:
 * - 懒加载(巨大工程):CodeLens 只在 `.def` 文档可见(编辑器按活动文档触发
 *   provideCodeLenses)时按需计算指纹,绝不对全项目扫描/预计算;指纹读面
 *   复用 VFS 字节(与 Inspector 同一 DefFingerprintDeps),不为显示重读磁盘。
 * - 语义指纹 scope 如实标注(file-only):行内只显示短 hash;完整详情、算法
 *   档案、三路判定在 Inspector 面板呈现(不重复实现,点击即开)。
 * - 需重启态不在此重复呈现:文件生命周期态(含 RESTART_REQUIRED)已有
 *   HotReloadFileStateCodeLensProvider 在文档顶部挂状态点,职责不叠。
 * - 读不到内容 = 不挂指纹枚举(如实缺,不冒充)。
 *
 * 纯逻辑与宿主解耦:provider 只吃注入依赖(compute),测试给内存替身;
 * 宿主装配在 activate/infrastructure.ts(Inspector 同处,deps 同源)。
 */

import * as vscode from 'vscode';
import { DEF_FINGERPRINT_INSPECTOR_COMMAND, type DefFingerprintDeps, computeDefFingerprintSnapshot } from './defFingerprintInspector';
import type { DefFingerprintSnapshot } from './backend/hotReloadDefFingerprintLedger';

/** `.def` 文档 languageId(package.json kbengine-def) */
export const DEF_FINGERPRINT_CODE_LENS_LANGUAGE = 'kbengine-def';

/** 指纹短 hash 展示长度(完整 hash 在 Inspector 面板,行内只给可对位前缀) */
const SHORT_HASH = 12;

export interface DefFingerprintCodeLensDeps {
  /** 按需计算该文件指纹(读不到=null,行内不显示指纹枚举,不冒充) */
  compute: (fsPath: string) => DefFingerprintSnapshot | null;
}

/** 缺省依赖:复用 Inspector 的读面(VFS 字节),与面板同源 */
export function defaultDefFingerprintCodeLensDeps(
  fingerprintDeps: DefFingerprintDeps
): DefFingerprintCodeLensDeps {
  return {
    compute: fsPath => computeDefFingerprintSnapshot(fingerprintDeps, fsPath)
  };
}

/**
 * `.def` 根元素起始行:首条以 `<` 开头的非 prolog/非注释/非空白行;
 * 全无 = 第 0 行(占位,不把 CodeLens 挂空)。纯函数便于单测。
 */
export function findDefRootLine(text: string): number {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('<') && !line.startsWith('<?') && !line.startsWith('<!--')) {
      return index;
    }
  }
  return 0;
}

export class DefFingerprintCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly deps: DefFingerprintCodeLensDeps) {}

  /** 内容变化后手动刷(保存事件驱动;CodeLens 变化即自动重取) */
  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== DEF_FINGERPRINT_CODE_LENS_LANGUAGE) {
      return [];
    }
    const fsPath = document.uri.fsPath;
    // 懒加载:指纹只对当前可见文档按需算;算不出(读不到)就不挂枚举
    const snapshot = this.deps.compute(fsPath);
    if (snapshot === null) {
      return [];
    }
    const rootLine = findDefRootLine(document.getText());
    const semantic =
      snapshot.semanticHash === null ? '解析失败' : `${snapshot.semanticHash.slice(0, SHORT_HASH)}…`;
    return [
      new vscode.CodeLens(new vscode.Range(rootLine, 0, rootLine, 0), {
        title: `指纹 sha256:${snapshot.fileHash.slice(0, SHORT_HASH)}… · 语义:${semantic} · Hash 详情`,
        command: DEF_FINGERPRINT_INSPECTOR_COMMAND
      })
    ];
  }
}

/** 装配:注册 CodeLens provider(生命周期随 context 拆) */
export function setupDefFingerprintCodeLens(
  context: vscode.ExtensionContext,
  deps: DefFingerprintCodeLensDeps
): DefFingerprintCodeLensProvider {
  const provider = new DefFingerprintCodeLensProvider(deps);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: DEF_FINGERPRINT_CODE_LENS_LANGUAGE },
      provider
    )
  );
  return provider;
}
