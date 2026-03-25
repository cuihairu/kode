/**
 * KBEngine 调试配置管理器
 * 为不同组件提供自定义的 Python 调试配置
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SERVER_COMPONENTS, ServerComponent } from './serverManager';

/**
 * 单个组件的调试配置
 */
export interface ComponentDebugConfig {
  /** Python 解释器路径 */
  pythonPath: string;
  /** 工作目录 */
  cwd: string;
  /** 要调试的脚本文件 */
  script?: string;
  /** 参数 */
  args?: string[];
  /** 环境变量 */
  env?: { [key: string]: string };
  /** 调试端口 */
  debugPort: number;
  /** 是否在启动时自动附加 */
  autoAttach: boolean;
  /** 路径映射 */
  pathMappings?: Array<{
    localRoot: string;
    remoteRoot: string;
  }>;
}

/**
 * KBEngine 调试配置
 */
export interface KBEngineDebugConfig {
  /** 默认 Python 解释器路径 */
  defaultPythonPath: string;
  /** 默认调试端口 */
  defaultDebugPort: number;
  /** 组件特定的配置 */
  components: { [componentName: string]: ComponentDebugConfig };
  /** 全局环境变量 */
  globalEnv?: { [key: string]: string };
}

/**
 * 调试配置文件格式（kbengine.debug.json）
 */
export interface DebugConfigFile {
  version: string;
  debug: KBEngineDebugConfig;
}

/**
 * KBEngine 调试配置管理器
 */
export class DebugConfigManager {
  private config: KBEngineDebugConfig;
  private configWatcher: vscode.FileSystemWatcher | null = null;
  private _onDidChangeConfig = new vscode.EventEmitter<void>();
  readonly onDidChangeConfig = this._onDidChangeConfig.event;

  constructor(private context: vscode.ExtensionContext) {
    this.config = this.getDefaultConfig();
    this.loadConfig();
    this.watchConfig();
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): KBEngineDebugConfig {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return {
      defaultPythonPath: 'python',
      defaultDebugPort: 5678,
      components: {
        baseapp: {
          pythonPath: 'python',
          cwd: path.join(workspaceFolder, 'scripts/base'),
          script: 'kbemain.py',
          debugPort: 5678,
          autoAttach: false,
          pathMappings: [{
            localRoot: workspaceFolder,
            remoteRoot: workspaceFolder
          }]
        },
        cellapp: {
          pythonPath: 'python',
          cwd: path.join(workspaceFolder, 'scripts/cell'),
          script: 'kbemain.py',
          debugPort: 5679,
          autoAttach: false,
          pathMappings: [{
            localRoot: workspaceFolder,
            remoteRoot: workspaceFolder
          }]
        },
        loginapp: {
          pythonPath: 'python',
          cwd: path.join(workspaceFolder, 'scripts/login'),
          script: 'kbemain.py',
          debugPort: 5680,
          autoAttach: false
        },
        dbmgr: {
          pythonPath: 'python',
          cwd: path.join(workspaceFolder, 'scripts/db'),
          script: 'kbemain.py',
          debugPort: 5681,
          autoAttach: false
        }
      },
      globalEnv: {
        PYTHONPATH: path.join(workspaceFolder, 'scripts'),
        PYTHONUNBUFFERED: '1'
      }
    };
  }

  /**
   * 加载配置文件
   */
  private async loadConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const configPath = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine', 'debug.json');

    try {
      const configData = await vscode.workspace.fs.readFile(configPath);
      const configFile: DebugConfigFile = JSON.parse(Buffer.from(configData).toString('utf8'));

      // 合并用户配置和默认配置
      this.config = {
        ...this.config,
        ...configFile.debug
      };

      this._onDidChangeConfig.fire();
    } catch (error) {
      // 配置文件不存在或格式错误，使用默认配置
      this.config = this.getDefaultConfig();
    }
  }

  /**
   * 监视配置文件变化
   */
  private watchConfig(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const configPattern = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine', 'debug.json');
    this.configWatcher = vscode.workspace.createFileSystemWatcher(configPattern.toString());

    this.configWatcher.onDidChange(() => {
      this.loadConfig();
      vscode.window.showInformationMessage('KBEngine 调试配置已更新');
    });

    this.context.subscriptions.push(this.configWatcher);
  }

  /**
   * 获取组件的调试配置
   */
  getComponentConfig(componentName: string): ComponentDebugConfig {
    const userConfig = this.config.components[componentName];

    return {
      pythonPath: userConfig?.pythonPath || this.config.defaultPythonPath,
      cwd: userConfig?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      script: userConfig?.script,
      args: userConfig?.args,
      env: {
        ...this.config.globalEnv,
        ...userConfig?.env
      },
      debugPort: userConfig?.debugPort || this.config.defaultDebugPort,
      autoAttach: userConfig?.autoAttach || false,
      pathMappings: userConfig?.pathMappings
    };
  }

  /**
   * 生成 VSCode launch.json 配置
   */
  generateLaunchConfigurations(): any[] {
    const configurations: any[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // 为每个组件生成调试配置
    for (const component of SERVER_COMPONENTS) {
      const config = this.getComponentConfig(component.name);

      if (!config.script) {
        continue; // 没有指定脚本文件，跳过
      }

      configurations.push({
        name: `KBEngine: ${component.displayName}`,
        type: 'debugpy',
        request: 'launch',
        python: config.pythonPath,
        program: path.join(config.cwd, config.script),
        cwd: config.cwd,
        args: config.args || [],
        env: config.env,
        console: 'integratedTerminal',
        justMyCode: false,
        pathMappings: config.pathMappings,
        // 禁用内置的 debugpy 重定向，因为 KBEngine 有自己的日志系统
        subProcess: false
      });
    }

    // 添加"附加到进程"配置
    configurations.push({
      name: 'KBEngine: Attach to Component',
      type: 'debugpy',
      request: 'attach',
      connect: {
        host: 'localhost',
        port: this.config.defaultDebugPort
      },
      pathMappings: [{
        localRoot: workspaceFolder,
        remoteRoot: workspaceFolder
      }],
      justMyCode: false
    });

    return configurations;
  }

  /**
   * 更新或创建 launch.json
   */
  async updateLaunchJson(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const launchJsonPath = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.vscode',
      'launch.json'
    );

    try {
      // 读取现有配置
      let existingConfig: any = { configurations: [] };
      try {
        const launchData = await vscode.workspace.fs.readFile(launchJsonPath);
        existingConfig = JSON.parse(Buffer.from(launchData).toString('utf8'));
      } catch (error) {
        // 文件不存在，使用空配置
      }

      // 生成新配置
      const newConfigurations = this.generateLaunchConfigurations();

      // 合并配置（保留用户自定义的配置）
      const kbConfigs = newConfigurations.filter(c => c.name?.startsWith('KBEngine:'));
      const userConfigs = existingConfig.configurations.filter(
        (c: any) => !c.name?.startsWith('KBEngine:')
      );

      const finalConfig = {
        version: existingConfig.version || '0.2.0',
        configurations: [...userConfigs, ...kbConfigs]
      };

      // 写入文件
      await vscode.workspace.fs.writeFile(
        launchJsonPath,
        Buffer.from(JSON.stringify(finalConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('launch.json 已更新');
      return true;

    } catch (error) {
      vscode.window.showErrorMessage(`更新 launch.json 失败: ${error}`);
      return false;
    }
  }

  /**
   * 创建示例配置文件
   */
  async createExampleConfig(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const kbengineDir = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine');

    try {
      // 创建 .kbengine 目录
      await vscode.workspace.fs.createDirectory(kbengineDir);

      // 创建示例配置文件
      const exampleConfig: DebugConfigFile = {
        version: '1.0.0',
        debug: {
          defaultPythonPath: 'python',
          defaultDebugPort: 5678,
          components: {
            baseapp: {
              pythonPath: 'python',
              cwd: '${workspaceFolder}/scripts/base',
              script: 'kbemain.py',
              debugPort: 5678,
              autoAttach: false,
              env: {
                KB_ENGINE_COMPONENTS: 'Base'
              },
              pathMappings: [{
                localRoot: '${workspaceFolder}',
                remoteRoot: '${workspaceFolder}'
              }]
            },
            cellapp: {
              pythonPath: 'python',
              cwd: '${workspaceFolder}/scripts/cell',
              script: 'kbemain.py',
              debugPort: 5679,
              autoAttach: false
            }
          },
          globalEnv: {
            PYTHONPATH: '${workspaceFolder}/scripts',
            PYTHONUNBUFFERED: '1'
          }
        }
      };

      const configPath = vscode.Uri.joinPath(kbengineDir, 'debug.json');
      await vscode.workspace.fs.writeFile(
        configPath,
        Buffer.from(JSON.stringify(exampleConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('示例配置已创建: .kbengine/debug.json');
      return true;

    } catch (error) {
      vscode.window.showErrorMessage(`创建配置文件失败: ${error}`);
      return false;
    }
  }

  /**
   * 启动组件调试
   */
  async startDebugging(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);

    if (!config.script) {
      vscode.window.showWarningMessage(`组件 ${componentName} 没有配置调试脚本`);
      return false;
    }

    const debugConfig: vscode.DebugConfiguration = {
      name: `KBEngine: ${componentName}`,
      type: 'debugpy',
      request: 'launch',
      python: config.pythonPath,
      program: path.join(config.cwd, config.script),
      cwd: config.cwd,
      args: config.args || [],
      env: config.env,
      console: 'integratedTerminal',
      justMyCode: false,
      pathMappings: config.pathMappings,
      subProcess: false
    };

    try {
      const success = await vscode.debug.startDebugging(undefined, debugConfig);
      return success === true;
    } catch (error) {
      vscode.window.showErrorMessage(`启动调试失败: ${error}`);
      return false;
    }
  }

  /**
   * 附加到运行中的组件
   */
  async attachToComponent(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);

    const attachConfig: vscode.DebugConfiguration = {
      name: `KBEngine: Attach to ${componentName}`,
      type: 'debugpy',
      request: 'attach',
      connect: {
        host: 'localhost',
        port: config.debugPort
      },
      pathMappings: config.pathMappings,
      justMyCode: false
    };

    try {
      const success = await vscode.debug.startDebugging(undefined, attachConfig);
      return success === true;
    } catch (error) {
      vscode.window.showErrorMessage(`附加调试失败: ${error}`);
      return false;
    }
  }

  /**
   * 获取所有配置
   */
  getConfig(): KBEngineDebugConfig {
    return this.config;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.configWatcher) {
      this.configWatcher.dispose();
    }
    this._onDidChangeConfig.dispose();
  }
}
