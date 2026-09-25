// fake-vscode 命令登记层(docs/redesign.md 阶段 3):commands.registerCommand
// 真记账、executeCommand 真分发——extension.ts 的 activate 可以在 vitest 内
// 整体装配,注册表/命令执行链均可断言(补 redesign 问题 P14)。

type CommandHandler = (...args: unknown[]) => unknown;

interface CommandRegistration {
  command: string;
  handler: CommandHandler;
  disposed: boolean;
}

const registrations = new Map<string, CommandRegistration>();
/** 注册顺序保持 activate 的注册次序,便于与 package.json 贡献点比对 */
const registrationOrder: CommandRegistration[] = [];

export const commands = {
  registerCommand: (command: string, handler: CommandHandler): { dispose(): void } => {
    const registration: CommandRegistration = { command, handler, disposed: false };
    registrations.set(command, registration);
    registrationOrder.push(registration);
    return {
      dispose: (): void => {
        registration.disposed = true;
        registrations.delete(command);
      }
    };
  },
  executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
    const registration = registrations.get(command);
    if (!registration) {
      throw new Error(`command not registered: ${command}`);
    }
    return registration.handler(...args);
  }
};

export const commandRegistry = {
  registrations,
  /** 按注册次序返回命令 id */
  registeredCommandIds(): string[] {
    return registrationOrder.filter(item => !item.disposed).map(item => item.command);
  },
  /** 全部命令 id(含已 dispose 的注册痕迹),装配断言用 */
  allRegisteredCommandIds(): string[] {
    return registrationOrder.map(item => item.command);
  },
  reset: (): void => {
    registrations.clear();
    registrationOrder.length = 0;
  }
};
