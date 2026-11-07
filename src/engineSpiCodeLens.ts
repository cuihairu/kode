// KODE-CFG-015:引擎 SPI 实现函数单独 CodeLens 标注。
//
// 被引擎以 SPI 模式调用的函数(getEntryScript() 36 方法:32 必选 + 4 可选
// HasAttr 守卫,权威表见 docs/knowledge/entry-script-spi-methods.md,KODE-CFG-012)
// 在 Python 定义处出一枚独立 CodeLens「引擎 SPI · <方法> · <触发时机>」,与
// 既有 RPC/事件回调/属性镜同面,独立开关 kbengine.codeLens.engineSpi(默认开)。
// 识别依据=配置派生(组件角色,CFG-004 派生面 entryScripts/扫描根)+ 方法名
// 匹配 SPI 表。普通函数(不在表内)不出,开关关闭后不出。
//
// 表真值自 entry-script-spi-methods.md 逐组件表(各组件方法数:baseapp 12 /
// cellapp 9 / loginapp 7 / dbmgr 4 / interfaces 5 / logger 4 / client/bots 3,
// 重复名跨组件计一次,合计 36 个不同名)。required=false 即 HasAttr 守卫的
// 4 个可选方法。

import * as vscode from 'vscode';
import { type PythonMethodDeclaration } from './rpcCodeLens';
import { getLanguageFeatureConfig } from './languageProviders/shared';
import { getConfigDerivedScanRootState } from './configDerive';

/** SPI 方法条目(表真值:组件集合 + 必选/可选 + 触发时机简述) */
export interface EngineSpiMethod {
  /** 该方法被哪些组件以 SPI 模式调用(组件名:baseapp/cellapp/loginapp/dbmgr/interfaces/logger/client/bots) */
  components: string[];
  /** false = 引擎带 PyObject_HasAttrString 守卫的可选方法 */
  required: boolean;
  /** 触发时机简述(镜标题后缀,同 KODE-CFG-012 方法表 Trigger 列) */
  trigger: string;
}

/** 组件脚本目录名 → 组件角色(引擎目录布局:scripts/<dir>/kbemain.py) */
const COMPONENT_DIR_TO_ROLE: Record<string, string> = {
  base: 'baseapp',
  cell: 'cellapp',
  login: 'loginapp',
  db: 'dbmgr',
  logger: 'logger',
  interface: 'interfaces',
  interfaces: 'interfaces',
  bots: 'bots',
  client: 'client'
};

/**
 * 引擎 SPI 36 方法权威表(KODE-CFG-012 取证;方法→组件集合+必选+触发)。
 * 逐组件表:baseapp 12 / cellapp 9 / loginapp 7 / dbmgr 4 / interfaces 5 /
 * logger 4 / client-bots 3;不同名合计 36。
 */
export const ENGINE_SPI_METHODS: Record<string, EngineSpiMethod> = {
  // baseapp(12)
  onInit: { components: ['baseapp', 'cellapp', 'bots', 'client'], required: true, trigger: '首回调,0=启动 1=热载' },
  onBaseAppReady: { components: ['baseapp'], required: true, trigger: '组件就绪' },
  onReadyForLogin: { components: ['baseapp', 'cellapp'], required: false, trigger: '轮询 ≥0.9999 放行登录' },
  onGlobalData: { components: ['baseapp', 'cellapp'], required: true, trigger: '全局数据变更广播' },
  onGlobalDataDel: { components: ['baseapp', 'cellapp'], required: true, trigger: '全局数据删除广播' },
  onBaseAppData: { components: ['baseapp'], required: true, trigger: 'baseapp 数据广播' },
  onBaseAppDataDel: { components: ['baseapp'], required: true, trigger: 'baseapp 数据删除广播' },
  onCellAppDeath: { components: ['baseapp'], required: true, trigger: 'cellapp 死亡' },
  onLoseChargeCB: { components: ['baseapp'], required: true, trigger: '扣费回调' },
  onAutoLoadEntityCreate: { components: ['baseapp'], required: false, trigger: '实体自动加载' },
  onReadyForShutDown: { components: ['baseapp', 'dbmgr', 'logger'], required: false, trigger: '关停前询问' },
  onBaseAppShutDown: { components: ['baseapp'], required: true, trigger: '三段式关停 0/1/2' },
  // cellapp(9)
  onCellAppData: { components: ['cellapp'], required: true, trigger: 'cellapp 数据广播' },
  onCellAppDataDel: { components: ['cellapp'], required: true, trigger: 'cellapp 数据删除广播' },
  onSpaceData: { components: ['cellapp'], required: true, trigger: 'space 数据变更' },
  onSpaceGeometryLoaded: { components: ['cellapp'], required: true, trigger: 'space 几何加载' },
  onAllSpaceGeometryLoaded: { components: ['cellapp'], required: true, trigger: '全部 space 几何加载' },
  // loginapp(7)
  onLoginAppReady: { components: ['loginapp'], required: true, trigger: '登录组件就绪' },
  onRequestLogin: { components: ['loginapp'], required: true, trigger: '登录请求' },
  onLoseLogin: { components: ['loginapp'], required: true, trigger: '登录连接断开' },
  onRequestCreateAccount: { components: ['loginapp', 'interfaces'], required: true, trigger: '创建账号请求' },
  onCreateAccountCallbackFromDB: { components: ['loginapp'], required: true, trigger: 'DB 建号结果' },
  onLoginCallbackFromDB: { components: ['loginapp'], required: true, trigger: 'DB 登录查询结果' },
  onLoginAppShutDown: { components: ['loginapp'], required: true, trigger: '登录组件关停' },
  // dbmgr(4)
  onDBMgrReady: { components: ['dbmgr'], required: true, trigger: 'DB 组件就绪' },
  onSelectAccountDBInterface: { components: ['dbmgr'], required: true, trigger: '账号 DB 接口选择' },
  onDBMgrShutDown: { components: ['dbmgr'], required: true, trigger: 'DB 组件关停' },
  // interfaces(5)
  onInterfaceAppReady: { components: ['interfaces'], required: true, trigger: '接口组件就绪' },
  onRequestAccountLogin: { components: ['interfaces'], required: true, trigger: '账号登录请求' },
  onRequestCharge: { components: ['interfaces'], required: true, trigger: '计费请求' },
  onInterfaceAppShutDown: { components: ['interfaces'], required: true, trigger: '接口组件关停' },
  // logger(4)
  onLoggerAppReady: { components: ['logger'], required: true, trigger: '日志组件就绪' },
  onLoggerAppShutDown: { components: ['logger'], required: true, trigger: '日志组件关停' },
  onLogWrote: { components: ['logger'], required: false, trigger: '日志写入' },
  // client / bots(3)
  onFinish: { components: ['bots', 'client'], required: true, trigger: '组件收尾' },
  onTargetChanged: { components: ['client'], required: true, trigger: '客户端实体目标切换' }
};

/** 由文件路径判定组件角色(组件脚本目录段→角色;脚本根优先,无则启发式) */
export function componentRoleForPath(filePath: string, scriptsRoot: string | null = null): string | null {
  if (!filePath) {
    return null;
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (scriptsRoot) {
    const root = scriptsRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const relative = normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : null;
    if (relative === null) {
      // 文件在脚本根外:非组件脚本,不出镜(不回落启发式——根已知时角色
      // 只由根下首段组件目录决定,避免 /scripts/common/base/foo.py 误判)
      return null;
    }
    const firstSegment = relative.split('/')[0];
    return COMPONENT_DIR_TO_ROLE[firstSegment.toLowerCase()] ?? null;
  }
  // 无脚本根启发式:取最后一个已知组件目录段——路径嵌套越深越靠里,
  // 命中已知组件目录名即认为该文件属该组件脚本树
  const segments = normalized.split('/');
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const role = COMPONENT_DIR_TO_ROLE[segments[i].toLowerCase()];
    if (role) {
      return role;
    }
  }
  return null;
}

/**
 * 模块级(模块作用域)函数声明:引擎经 getEntryScript() 调用的 SPI 函数是入口
 * 模块的属性——模块级 def,含模块级控制流(if/for/try)内的 def(仍绑定为
 * 模块属性);而类方法/函数内嵌套 def 不是模块属性,即使同名也不是 SPI。
 * 故以缩进栈区分:只取不在任何 class/def 体内的 def(列 0 或仅受模块级
 * 控制流包裹),与 RPC 识别(任意缩进)不同,此处不复用
 * rpcCodeLens.findPythonMethodDeclarations。
 */
export function findModuleLevelMethodDeclarations(text: string): PythonMethodDeclaration[] {
  const declarations: PythonMethodDeclaration[] = [];
  const lines = text.split(/\r?\n/);
  // 缩进栈:记录仍打开(class/def)体的缩进;控制流(if/for/try)不入栈,
  // 故其内 def 仍视为模块级;class/def 内 def 因有更低缩进祖先而出栈外
  const blockIndents: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    // 空行与注释不参与作用域:Python 忽略注释缩进(列 0 注释不得弹出
    // 打开中的 class/def 体),空行同理
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const indent = countIndent(line);
    // 收窄:当前行缩进 ≤ 栈顶体缩进 → 该体已结束
    while (blockIndents.length > 0 && blockIndents[blockIndents.length - 1] >= indent) {
      blockIndents.pop();
    }
    const match = MODULE_LEVEL_DECLARATION_PATTERN.exec(trimmed);
    if (match) {
      const methodName = match[1];
      // 模块级 = 不在任何 class/def 体内:所有打开体的缩进都 ≥ 本行缩进
      // (无更浅祖先);有 class/def 祖先(缩进 < 本行)即非模块级
      if (blockIndents.every(bodyIndent => bodyIndent >= indent)) {
        declarations.push({ line: index, character: line.indexOf(methodName), methodName });
      }
    }
    // 该行是 class/def 声明 → 打开一个体(体内容缩进 > 本行缩进)
    if (/^(?:class\b|(?:async\s+)?def\b)/.test(trimmed)) {
      blockIndents.push(indent);
    }
  }
  return declarations;
}

/** 行首缩进宽度:空格 1 列,Tab 按 Python 默认 8 列折算(混缩进亦稳定比较) */
function countIndent(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') {
      width += 1;
    } else if (ch === '\t') {
      width += 8;
    } else {
      break;
    }
  }
  return width;
}

/**
 * 模块级 def 声明(不带头部空白,由 findModuleLevelMethodDeclarations 判
 * 缩进):`def name(` / `async def name(`
 */
export const MODULE_LEVEL_DECLARATION_PATTERN = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** 镜标题:`引擎 SPI · <方法> · <触发时机>`,可选方法触发后加「 · 可选」 */
export function engineSpiCodeLensTitle(methodName: string): string {
  const entry = ENGINE_SPI_METHODS[methodName];
  if (!entry) {
    return `引擎 SPI · ${methodName}`;
  }
  const optional = entry.required ? '' : ' · 可选';
  return `引擎 SPI · ${methodName} · ${entry.trigger}${optional}`;
}

/** 命中规格(声明行 + 方法名;组件角色已定) */
export interface EngineSpiLensSpec {
  declaration: PythonMethodDeclaration;
  methodName: string;
  required: boolean;
  title: string;
}

/**
 * 对一份文件的全部方法声明,按给定组件角色筛 SPI 命中。
 * 纯函数:组件角色不在表内的方法一律不出;普通函数名(表外)不出。
 */
export function buildEngineSpiCodeLenses(
  declarations: PythonMethodDeclaration[],
  componentRole: string | null
): EngineSpiLensSpec[] {
  if (!componentRole) {
    return [];
  }
  const specs: EngineSpiLensSpec[] = [];
  for (const declaration of declarations) {
    const entry = ENGINE_SPI_METHODS[declaration.methodName];
    if (!entry || !entry.components.includes(componentRole)) {
      continue;
    }
    specs.push({
      declaration,
      methodName: declaration.methodName,
      required: entry.required,
      title: engineSpiCodeLensTitle(declaration.methodName)
    });
  }
  return specs;
}

/**
 * 引擎 SPI CodeLens provider(与 RPC/属性镜同面;独立开关
 * kbengine.codeLens.engineSpi,默认开)。识别:文件组件角色(脚本根优先,
 * 配置派生 entryScripts 推导) + 方法名匹配 SPI 表;开关关闭即空。
 */
export class EngineSpiCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  /** 开关变更由 extension 配置监听 fire 即时生效 */
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): vscode.CodeLens[] {
    if (token?.isCancellationRequested || document.isClosed) {
      return [];
    }
    if (!getLanguageFeatureConfig().codeLensEngineSpi) {
      return [];
    }
    const scriptsRoot = this.resolveScriptsRoot(document);
    const role = componentRoleForPath(document.fileName, scriptsRoot);
    if (!role) {
      return [];
    }
    // SPI 函数=入口模块属性(模块级 def);类方法/嵌套函数同名不出
    const declarations = findModuleLevelMethodDeclarations(document.getText());
    return buildEngineSpiCodeLenses(declarations, role).map(spec => {
      const range = new vscode.Range(
        new vscode.Position(spec.declaration.line, spec.declaration.character),
        new vscode.Position(
          spec.declaration.line,
          spec.declaration.character + spec.declaration.methodName.length
        )
      );
      return new vscode.CodeLens(range, {
        // 标注镜:标 SPI 身份与触发时机;点击仅弹信息(引擎侧调用点不属本
        // 仓,无源码可跳),command 必须给出才能渲染为可点镜
        title: spec.title,
        command: 'kbengine.python.showEngineSpi',
        arguments: [document.uri, spec.declaration.line, spec.methodName, spec.title]
      });
    });
  }

  /**
   * 脚本根:优先取配置派生 entryScripts 的共享入口脚本路径(kbengine.py)
   * 父目录(= assets/scripts,CFG-006 事实);派生未就绪返回 null,交启发式。
   */
  private resolveScriptsRoot(document: vscode.TextDocument): string | null {
    try {
      // 只读派生缓存(不触发 refresh):entryScripts 的共享入口脚本
      // kbengine.py 父目录即 assets/scripts(CFG-006 事实)
      const state = getConfigDerivedScanRootState();
      const entry = state?.entryScripts?.find(item => item.path);
      if (entry?.path) {
        const parent = entry.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        return parent || null;
      }
    } catch {
      // configDerive 未装配/异常:回落启发式,不出错
    }
    return null;
  }
}
