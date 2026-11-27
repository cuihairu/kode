// 进程归属 vscode 面(PROC-TAG-001 立项 2026-11-13;PROC-BREADCRUMB-001
// 改面 2026-11-18):判定链与互链推导在纯核 src/backend/processOwnershipLens,
// 本文件保留 openCell/openBase 切换命令(面包屑子节点 detail 的切换后端)
// 并承载 python 面包屑合成根 provider。文件顶部进程 CodeLens 渲染面已按
// 用户令移除(面包屑常驻可见,头部镜属重复展示;kbengine.codeLens.
// processOwnership 设置项连同声明一并删除,不留死开关)。
import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  buildPythonProcessBreadcrumb,
  switchTargetProcess,
  type ProcessBreadcrumbSpec,
  type ProcessName
} from '../backend/processOwnershipLens';

/**
 * python 面包屑合成根(第二刀):scripts/<role>/ 目录布局命中才返回节点
 * (判不出=null 零干扰 Pylance);节点 range=全文档,Outline 合并多
 * provider 结果时按 range 排序自然置首。与 Pylance 符号共存(VS Code 合并
 * 所有 DocumentSymbolProvider 输出)。当前进程(目录判定)带▸排首位,
 * children=互链对端段(Event,detail=对端路径+快捷键提示;无本文件锚点,
 * selectionRange 落文件头)。
 */
export class ProcessBreadcrumbPythonSymbolProvider implements vscode.DocumentSymbolProvider {
  private readonly fileExists: (path: string) => boolean;

  constructor(deps: { fileExists?: (path: string) => boolean } = {}) {
    this.fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
  }

  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): vscode.DocumentSymbol[] | null {
    const spec = buildPythonProcessBreadcrumb(document.fileName, this.fileExists);
    if (!spec) {
      return null;
    }
    const fileHead = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    // 全文档 range 经 positionAt 换算(真 API 与测试替身同面;lineCount 替身缺)
    const fullDocument = new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length)
    );
    const root = new vscode.DocumentSymbol(
      spec.name,
      `当前进程:${spec.processes[0]}(scripts/<role> 目录判定);其余=同名对端文件,行首「跳 base/cell →」/右上角箭头按钮或 ctrl+alt+shift+b/c 切换。`,
      vscode.SymbolKind.Namespace,
      fullDocument,
      fileHead
    );
    root.children = spec.children.map(child => new vscode.DocumentSymbol(
      child.process,
      `对端同名文件:${child.siblingPath ?? ''};行首「跳 base/cell →」/右上角箭头按钮或 ctrl+alt+shift+b/c 切换`,
      vscode.SymbolKind.Event,
      fullDocument,
      fileHead
    ));
    return [root];
  }
}

/**
 * 面包屑对端跳转按钮(PROC-BREADCRUMB-002,用户令 2026-11-25「点击无法跳转
 * 到对应的同名文件」):DocumentSymbol 无 command 面(跨文件跳转 API 缺位),
 * 在文件首行挂 CodeLens 按钮执行已注册的 openCell/openBase 命令。当前文件
 * 判得出归属且对端存在才出按钮(判不出/无对端=零按钮,不猜)。与热更状态镜
 * 同行共存:按钮排热更镜后(VS Code 行内 lens 平铺)。
 */
export class ProcessOwnershipSwitchCodeLensProvider implements vscode.CodeLensProvider {
  private readonly fileExists: (path: string) => boolean;

  constructor(deps: { fileExists?: (path: string) => boolean } = {}) {
    this.fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const spec = buildPythonProcessBreadcrumb(document.fileName, this.fileExists);
    if (!spec) {
      return [];
    }
    const lineZero = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    return spec.children
      .filter(child => child.siblingPath)
      .map(child => new vscode.CodeLens(lineZero, {
        title: `跳 ${child.process === 'baseapp' ? 'base' : child.process === 'cellapp' ? 'cell' : child.process} →`,
        command: child.process === 'baseapp'
          ? KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND
          : child.process === 'cellapp'
            ? KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND
            : '',
        tooltip: `打开对端同名文件:${child.siblingPath ?? ''}`
      }));
  }
}

/** 快捷键切换命令(FILE-TIME-001 批,用户令 2026-11-17「最好能绑定快捷键,
 * 如果在 cell 可以可以快速切换到 base」):base↔cell 同名文件双向跳;
 * client/bots 无键,面包屑子节点 detail 携对端路径。目录判定与互链复用
 * 纯核 buildProcessOwnershipSpec(与判定链同一条,不造第二套);
 * 目标缺位如实提示不静默。 */
export const KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND = 'kbengine.processOwnership.openCell';
export const KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND = 'kbengine.processOwnership.openBase';

export function registerProcessOwnershipSwitchCommands(context: vscode.ExtensionContext): void {
  // SWITCH-DEGRADE-001(用户报「第一次正常,切换几次后失效」):旧实现每次
  // 按键现问 activeTextEditor,而 showTextDocument 是异步的——连按期间读到
  // 的还是切换前的旧编辑器,方向判定漂移,交替按几次后失效。三件套:
  // ① 在途互斥 + 连按只认最新一次(在途期间的新按键只记账,链尾续跳);
  // ② 续跳以「刚打开的文件」为源,不问编辑器(纯状态交替,不受时序影响);
  // ③ 停泊侧记账(source/target):静止后的下一次按键若编辑器仍停在上一轮
  //    的来源文件(=陈旧值),以停泊侧为源;编辑器指到第三处(用户手动跳走)
  //    则如实以编辑器为准,状态机不覆盖真实导航。
  let switchInFlight = false;
  let latestQueued: 'cellapp' | 'baseapp' | null = null;
  let lastSwitchSource: string | null = null;
  let lastSwitchTarget: string | null = null;

  // ④ 真实编辑器变化即作废旧停泊账(SWITCH-DEGRADE-001 第六轮复核 BLOCKER):
  // 用户切换后在编辑器里手动回到来源文件,若仍拿旧账当「陈旧编辑器」回退,
  // 下一次按键会把来源误判成目标、报「未找到同名」不跳。只有落点等于上一轮
  // 目标(自诱导 showTextDocument 或用户就停在目标上)时保留账,其余导航一律
  // 作废 → 以当前编辑器为准。宿主 stub 无该事件时跳过(同 reveal.ts 惯例)。
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    const subscription = vscode.window.onDidChangeActiveTextEditor(editor => {
      const file = editor?.document?.fileName;
      if (file === undefined || file !== lastSwitchTarget) {
        lastSwitchSource = null;
        lastSwitchTarget = null;
      }
    });
    context.subscriptions.push(subscription);
  }

  const runSwitch = async (
    process: 'cellapp' | 'baseapp',
    sourceFile?: string
  ): Promise<void> => {
    const editorFile = vscode.window.activeTextEditor?.document.fileName;
    const source =
      sourceFile ??
      (editorFile !== undefined && lastSwitchTarget !== null && editorFile === lastSwitchSource
        ? lastSwitchTarget
        : editorFile);
    if (!source) {
      return;
    }
    const spec = buildPythonProcessBreadcrumb(source, candidate => fs.existsSync(candidate));
    if (!spec) {
      void vscode.window.showInformationMessage(
        '当前文件判不出进程归属(需 scripts/<role> 目录),无法切换'
      );
      return;
    }
    // ⑤ 同侧键翻到另一侧(2026-11-27 用户令「已在该侧再按同侧键应切过去」):
    // 按键指向的侧=当前所在侧时翻转 base/cell 对(toggle);client/bots 当前侧
    // 与跨侧按键保持原请求。对端缺位仍按翻转后的侧如实提示。
    const wanted = switchTargetProcess(spec.processes[0], process);
    const target = spec.children.find(child => child.process === wanted);
    if (!target || !target.siblingPath) {
      void vscode.window.showInformationMessage(`未找到同名 ${wanted} 对应文件`);
      return;
    }
    const openedPath = target.siblingPath;
    await vscode.window.showTextDocument(vscode.Uri.file(openedPath), { preview: false });
    // 停泊侧记账:source 对显式续跳链=上一跳打开的文件,对首跳=判定出的源
    // (含陈旧回退后的停泊侧);两键共用同一份账(方向状态跨命令共享)。
    lastSwitchSource = source;
    lastSwitchTarget = openedPath;
    if (latestQueued) {
      const next = latestQueued;
      latestQueued = null;
      await runSwitch(next, openedPath);
    }
  };

  const openSibling =
    (process: 'cellapp' | 'baseapp') =>
    async (): Promise<void> => {
      if (switchInFlight) {
        // 连按/竞态:只认最新一次,当前链收尾后续跳
        latestQueued = process;
        return;
      }
      switchInFlight = true;
      try {
        await runSwitch(process);
      } finally {
        switchInFlight = false;
        latestQueued = null;
      }
    };
  context.subscriptions.push(
    vscode.commands.registerCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND, openSibling('cellapp')),
    vscode.commands.registerCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND, openSibling('baseapp'))
  );
}

/**
 * 标题栏对端跳转按钮上下文键(PROC-BREADCRUMB-002 标题栏载体,2026-11-25
 * 用户裁定载体=编辑器标题栏按钮;与行首跳转镜双载体共存,真机走查后再裁
 * 去留):激活编辑器变化时经纯核判「对端同名文件存在且方向可跳」,置
 * canOpenCell/canOpenBase 两枚上下文键(package.json editor/title 菜单
 * when 消费,group=navigation 图标化)。判不出归属/无对端=双键 false,
 * 按钮不亮不猜。事件面用 typeof 守卫(测试宿主 stub 缺
 * onDidChangeActiveTextEditor,与 reveal.ts 同惯例)。
 */
export const KBENGINE_PROCESS_OWNERSHIP_CONTEXT_CAN_OPEN_CELL = 'kbengine.processOwnership.canOpenCell';
export const KBENGINE_PROCESS_OWNERSHIP_CONTEXT_CAN_OPEN_BASE = 'kbengine.processOwnership.canOpenBase';

/** 双键纯决策(测试直测;spec 判不出=null → 双 false) */
export function titleContextKeys(
  spec: ProcessBreadcrumbSpec | null
): { canOpenCell: boolean; canOpenBase: boolean } {
  const canOpen = (process: ProcessName): boolean =>
    spec?.children.some(child => child.process === process && child.siblingPath !== null) ?? false;
  return { canOpenCell: canOpen('cellapp'), canOpenBase: canOpen('baseapp') };
}

export class ProcessOwnershipTitleContext {
  private readonly fileExists: (path: string) => boolean;
  private readonly setContext: (key: string, value: boolean) => void;
  private readonly unsubscribe: () => void;

  constructor(deps: {
    fileExists?: (path: string) => boolean;
    setContext?: (key: string, value: boolean) => void;
  } = {}) {
    this.fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
    this.setContext =
      deps.setContext ??
      ((key, value) => {
        void vscode.commands.executeCommand('setContext', key, value);
      });
    if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
      const subscription = vscode.window.onDidChangeActiveTextEditor(() => this.update());
      this.unsubscribe = () => subscription.dispose();
    } else {
      this.unsubscribe = () => {};
    }
  }

  /** 重算双键并置位(激活编辑器变化与注册首查同一路径) */
  update(): void {
    const editor = vscode.window.activeTextEditor;
    const spec = editor
      ? buildPythonProcessBreadcrumb(editor.document.fileName, this.fileExists)
      : null;
    const keys = titleContextKeys(spec);
    this.setContext(KBENGINE_PROCESS_OWNERSHIP_CONTEXT_CAN_OPEN_CELL, keys.canOpenCell);
    this.setContext(KBENGINE_PROCESS_OWNERSHIP_CONTEXT_CAN_OPEN_BASE, keys.canOpenBase);
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/** 标题栏载体装配(与切换命令同批注册;subscriptions 统一交 context) */
export function registerProcessOwnershipTitleContext(context: vscode.ExtensionContext): void {
  const titleContext = new ProcessOwnershipTitleContext();
  titleContext.update();
  context.subscriptions.push(titleContext);
}
