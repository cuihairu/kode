import * as vscode from 'vscode';

export interface ComponentDebugConfig {
  telnetHost?: string;
  telnetPort?: number;
  telnetEnableCommands?: string[];
  pathMappings?: Array<{
    localRoot: string;
    remoteRoot: string;
  }>;
}

export interface KBEngineDebugConfig {
  defaultTelnetHost?: string;
  defaultTelnetPort?: number;
  components: { [componentName: string]: ComponentDebugConfig };
}

export interface DebugConfigFile {
  version: string;
  debug: KBEngineDebugConfig;
}

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

  private getDefaultConfig(): KBEngineDebugConfig {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const defaultPathMappings = [{
      localRoot: workspaceFolder,
      remoteRoot: workspaceFolder
    }];

    return {
      defaultTelnetHost: '127.0.0.1',
      defaultTelnetPort: 0,
      components: {
        baseapp: {
          telnetHost: '127.0.0.1',
          telnetPort: 0,
          telnetEnableCommands: [],
          pathMappings: defaultPathMappings
        },
        cellapp: {
          telnetHost: '127.0.0.1',
          telnetPort: 0,
          telnetEnableCommands: [],
          pathMappings: defaultPathMappings
        },
        loginapp: {
          telnetHost: '127.0.0.1',
          telnetPort: 0,
          telnetEnableCommands: []
        },
        dbmgr: {
          telnetHost: '127.0.0.1',
          telnetPort: 0,
          telnetEnableCommands: []
        }
      }
    };
  }

  private async loadConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const configPath = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine', 'debug.json');

    try {
      const configData = await vscode.workspace.fs.readFile(configPath);
      const configFile: DebugConfigFile = JSON.parse(Buffer.from(configData).toString('utf8'));
      this.config = {
        ...this.config,
        ...configFile.debug
      };
      this._onDidChangeConfig.fire();
    } catch {
      this.config = this.getDefaultConfig();
    }
  }

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

  getComponentConfig(componentName: string): ComponentDebugConfig {
    const userConfig = this.config.components[componentName];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return {
      telnetHost: userConfig?.telnetHost || this.config.defaultTelnetHost,
      telnetPort: userConfig?.telnetPort || this.config.defaultTelnetPort,
      telnetEnableCommands: userConfig?.telnetEnableCommands || [],
      pathMappings: userConfig?.pathMappings || [{
        localRoot: workspaceFolder,
        remoteRoot: workspaceFolder
      }]
    };
  }

  private getDebuggerType(): string {
    return 'debugpy';
  }

  private generateLaunchInputs(existingInputs: any[] = []): any[] {
    const nonKbInputs = existingInputs.filter(item => item.id !== 'kbengineProcessId');
    return [
      ...nonKbInputs,
      {
        id: 'kbengineProcessId',
        type: 'promptString',
        description: '请输入已开启调试的 KBEngine 进程 PID'
      }
    ];
  }

  generateLaunchConfigurations(): any[] {
    const configurations: any[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    for (const [componentName, componentConfig] of Object.entries(this.config.components)) {
      configurations.push({
        name: `KBEngine: Attach to ${componentName}`,
        type: this.getDebuggerType(),
        request: 'attach',
        processId: '${input:kbengineProcessId}',
        justMyCode: false,
        pathMappings: componentConfig.pathMappings || [{
          localRoot: workspaceFolder,
          remoteRoot: workspaceFolder
        }]
      });
    }

    return configurations;
  }

  async updateLaunchJson(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');

    try {
      let existingConfig: any = { configurations: [], inputs: [] };
      try {
        const launchData = await vscode.workspace.fs.readFile(launchJsonPath);
        existingConfig = JSON.parse(Buffer.from(launchData).toString('utf8'));
      } catch {
        existingConfig = { configurations: [], inputs: [] };
      }

      const newConfigurations = this.generateLaunchConfigurations();
      const kbConfigs = newConfigurations.filter(item => item.name?.startsWith('KBEngine:'));
      const userConfigs = (existingConfig.configurations || []).filter(
        (item: any) => !item.name?.startsWith('KBEngine:')
      );

      const finalConfig = {
        version: existingConfig.version || '0.2.0',
        configurations: [...userConfigs, ...kbConfigs],
        inputs: this.generateLaunchInputs(existingConfig.inputs || [])
      };

      await vscode.workspace.fs.writeFile(
        launchJsonPath,
        Buffer.from(JSON.stringify(finalConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('launch.json 已更新为 KBEngine PID 附加配置');
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`更新 launch.json 失败: ${error}`);
      return false;
    }
  }

  async createExampleConfig(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const kbengineDir = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine');

    try {
      await vscode.workspace.fs.createDirectory(kbengineDir);

      const exampleConfig: DebugConfigFile = {
        version: '1.0.0',
        debug: {
          defaultTelnetHost: '127.0.0.1',
          defaultTelnetPort: 0,
          components: {
            baseapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 0,
              telnetEnableCommands: [
                '# 先通过 telnet 连接到 baseapp 的调试控制端口',
                '# 再输入项目实际使用的开启调试命令'
              ],
              pathMappings: [{
                localRoot: '${workspaceFolder}',
                remoteRoot: '${workspaceFolder}'
              }]
            },
            cellapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 0,
              telnetEnableCommands: []
            }
          }
        }
      };

      const configPath = vscode.Uri.joinPath(kbengineDir, 'debug.json');
      await vscode.workspace.fs.writeFile(
        configPath,
        Buffer.from(JSON.stringify(exampleConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('示例调试配置已创建: .kbengine/debug.json');
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`创建调试配置失败: ${error}`);
      return false;
    }
  }

  async startDebugging(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    const telnetLines = (config.telnetEnableCommands || []).filter(Boolean);

    const message = telnetLines.length > 0
      ? [
          `KBEngine ${componentName} 调试需要先通过 telnet 开启调试，再按 PID 附加。`,
          `telnet ${config.telnetHost || '127.0.0.1'} ${config.telnetPort || 0}`,
          ...telnetLines
        ].join('\n')
      : `KBEngine ${componentName} 调试不是启动 Python 文件，而是先通过 telnet 开启调试，再执行 PID 附加。`;

    vscode.window.showInformationMessage(message);
    return this.attachToComponent(componentName);
  }

  async attachToComponent(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);

    const attachConfig: vscode.DebugConfiguration = {
      name: `KBEngine: Attach to ${componentName}`,
      type: this.getDebuggerType(),
      request: 'attach',
      processId: '${input:kbengineProcessId}',
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

  getConfig(): KBEngineDebugConfig {
    return this.config;
  }

  dispose(): void {
    if (this.configWatcher) {
      this.configWatcher.dispose();
    }
    this._onDidChangeConfig.dispose();
  }
}
