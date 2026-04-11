import * as vscode from 'vscode';

export interface ComponentDebugConfig {
  telnetHost?: string;
  telnetPort?: number;
  telnetPassword?: string;
  telnetDefaultLayer?: string;
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

const SOURCE_DEFAULT_COMPONENTS: Array<{
  name: string;
  telnetPort: number;
}> = [
  { name: 'loginapp', telnetPort: 31000 },
  { name: 'dbmgr', telnetPort: 32000 },
  { name: 'interfaces', telnetPort: 33000 },
  { name: 'logger', telnetPort: 34000 },
  { name: 'baseapp', telnetPort: 40000 },
  { name: 'cellapp', telnetPort: 50000 },
  { name: 'bots', telnetPort: 51000 }
];

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
    const components = Object.fromEntries(
      SOURCE_DEFAULT_COMPONENTS.map(({ name, telnetPort }) => [
        name,
        {
          telnetHost: '127.0.0.1',
          telnetPort,
          telnetPassword: 'pwd123456',
          telnetDefaultLayer: 'python',
          telnetEnableCommands: [],
          pathMappings: ['baseapp', 'cellapp', 'interfaces', 'bots', 'loginapp', 'dbmgr'].includes(name)
            ? defaultPathMappings
            : undefined
        }
      ])
    );

    return {
      defaultTelnetHost: '127.0.0.1',
      defaultTelnetPort: 0,
      components
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
    this.configWatcher.onDidCreate(() => {
      this.loadConfig();
      vscode.window.showInformationMessage('KBEngine 调试配置已创建');
    });
    this.configWatcher.onDidDelete(() => {
      this.loadConfig();
      vscode.window.showWarningMessage('KBEngine 调试配置已删除，已恢复默认配置');
    });

    this.context.subscriptions.push(this.configWatcher);
  }

  getComponentConfig(componentName: string): ComponentDebugConfig {
    const userConfig = this.config.components[componentName];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return {
      telnetHost: userConfig?.telnetHost || this.config.defaultTelnetHost,
      telnetPort: userConfig?.telnetPort || this.config.defaultTelnetPort,
      telnetPassword: userConfig?.telnetPassword || 'pwd123456',
      telnetDefaultLayer: userConfig?.telnetDefaultLayer || 'python',
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
        name: `KBEngine: Python attach to ${componentName}`,
        type: this.getDebuggerType(),
        request: 'attach',
        processId: '${input:kbengineProcessId}',
        justMyCode: false,
        pathMappings: componentConfig.pathMappings || [{
          localRoot: workspaceFolder,
          remoteRoot: workspaceFolder
        }],
        presentation: {
          group: 'KBEngine',
          order: 1
        }
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

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');

    try {
      await vscode.workspace.fs.createDirectory(vscodeDir);

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

      vscode.window.showInformationMessage('launch.json 已更新为 KBEngine Python 附加配置（telnet 开启调试后再按 PID 附加）');
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
              telnetPort: 40000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
              telnetEnableCommands: [
                '# 先连接源码默认 telnet 端口，再根据项目实际环境输入开启 Python 调试的命令',
                '# KBEngine 源码只明确提供 telnet 控制端口，不内置 debugpy 命令格式'
              ],
              pathMappings: [{
                localRoot: '${workspaceFolder}',
                remoteRoot: '${workspaceFolder}'
              }]
            },
            cellapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 50000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
              telnetEnableCommands: []
            },
            loginapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 31000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
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
    const telnetCommand = `telnet ${config.telnetHost || '127.0.0.1'} ${config.telnetPort || 0}`;
    const telnetMeta = [
      `password: ${config.telnetPassword || 'pwd123456'}`,
      `default layer: ${config.telnetDefaultLayer || 'python'}`
    ];

    const message = telnetLines.length > 0
      ? [
          `KBEngine ${componentName} 调试以 telnet 控制端口为前提，再按 PID 做 Python 附加。`,
          telnetCommand,
          ...telnetMeta,
          ...telnetLines
        ].join('\n')
      : [
          `KBEngine ${componentName} 调试不是直接启动 Python 文件。`,
          `请先连接 telnet 控制端口确认或开启你的项目调试入口，再执行 PID 附加。`,
          telnetCommand,
          ...telnetMeta
        ].join('\n');

    const action = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      '继续附加'
    );

    if (action !== '继续附加') {
      return false;
    }

    return this.attachToComponent(componentName);
  }

  async attachToComponent(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    const processId = await this.promptForProcessId(componentName);

    if (!processId) {
      return false;
    }

    const attachConfig: vscode.DebugConfiguration = {
      name: `KBEngine: Python attach to ${componentName}`,
      type: this.getDebuggerType(),
      request: 'attach',
      processId,
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

  private async promptForProcessId(componentName: string): Promise<number | undefined> {
    const value = await vscode.window.showInputBox({
      prompt: `输入 ${componentName} 进程 PID`,
      placeHolder: '例如 12345',
      validateInput: input => {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) {
          return 'PID 必须是正整数';
        }

        const parsed = Number(trimmed);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return 'PID 必须是有效的正整数';
        }

        return undefined;
      }
    });

    if (!value) {
      return undefined;
    }

    return Number(value.trim());
  }

  dispose(): void {
    if (this.configWatcher) {
      this.configWatcher.dispose();
    }
    this._onDidChangeConfig.dispose();
  }
}
