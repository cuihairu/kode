import * as net from 'net';

/**
 * KBEngine telnet 协议客户端(kbe/src/lib/server/telnet_server.cpp +
 * telnet_handler.cpp 对齐):
 * - 有密码组件:连接后服务端先发字面 "password:";密码对 → 欢迎横幅 +
 *   IAC 协商;密码错 → 静默重发 "[{组件}@password ~]# " 并停在 PASSWD 态。
 * - 无密码组件:连接后直接发欢迎横幅。
 * - 提示符 "[{组件}@{层} ~]# "(python 层 ">>> ");`:quit` 会关闭服务端
 *   进程,必须在白名单层恒拒。
 *
 * 密码只经 write 发往 socket,不进入任何回调文本/日志面。
 */

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

/** 剥离 telnet 控制序列(IAC 协商/子协商),IAC IAC 转义为字面 IAC 字节 */
export function stripTelnetControl(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte !== IAC) {
      out.push(byte);
      continue;
    }
    const next = buf[i + 1];
    if (next === IAC) {
      out.push(IAC);
      i += 1;
    } else if (next === DO || next === DONT || next === WILL || next === WONT) {
      i += 2;
    } else if (next === SB) {
      // 子协商读到 IAC SE 为止(其间 IAC IAC 为转义字面量)
      i += 2;
      while (i < buf.length) {
        if (buf[i] === IAC && buf[i + 1] === SE) {
          i += 1;
          break;
        }
        i += 1;
      }
    } else {
      // 其他两字节命令(SUPPRESS_GO_AHEAD 等)一并吞掉
      i += 1;
    }
  }
  return Buffer.from(out);
}

/** 剥离 ANSI 转义序列(CSI 与单字符 ESC 序列);\x1b 就是本函数要剥的目标字节 */
export function stripAnsiEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-~]/g, '');
}

export interface TelnetBanner {
  requiresPassword: boolean;
  passwordRejected: boolean;
  text: string;
}

/**
 * 解析服务端下行文本:
 * - 以 "password:" 收尾 → 要求输密码;
 * - 出现 "[{组件}@password ~]#" 提示符 → 密码错被拒(引擎停在 PASSWD 态);
 * - 其余为欢迎横幅/命令回显。
 */
export function parseBanner(text: string): TelnetBanner {
  const trimmed = text.replace(/\r?\n+$/, '');
  const requiresPassword = /password\s*:\s*$/i.test(trimmed);
  const passwordRejected = /\[[^\]]+@password ~\][#>]/.test(trimmed);
  return { requiresPassword, passwordRejected, text: trimmed };
}

/** 提示符检测:"[{组件}@{层} ~]# / >" 或 python 层 ">>> " */
export function looksLikePrompt(text: string): boolean {
  return /\[[^\]]+@[^\]]+ ~\][#>]\s*$/.test(text) || />\s*>\s*>\s*$/.test(text);
}

/**
 * 命令白名单:命令与白名单项完全一致,或以「项 + 空格」为前缀(带参放行)。
 * 空命令一律拒绝;`:quit` 会关闭服务端进程,即使被误配进白名单也恒拒。
 */
export function isCommandAllowed(command: string, whitelist: readonly string[]): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.toLowerCase() === ':quit') {
    return false;
  }
  return whitelist.some(entry => {
    const name = entry.trim();
    if (name.length === 0) {
      return false;
    }
    return trimmed === name || trimmed.startsWith(`${name} `);
  });
}

/** 内置只读快捷命令(查实体数/实体清单/全局数据键,均引擎 python 层表达式) */
export const BUILTIN_QUICK_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: '实体数量', command: 'len(entities)' },
  { label: '实体清单(前50)', command: 'sorted(entities.keys())[:50]' },
  { label: '全局数据键', command: 'list(KBEngine.globalData.keys())' },
  { label: '帮助', command: ':help' }
];

export type TelnetClientState =
  | 'connecting'
  | 'awaiting-password'
  | 'ready'
  | 'auth-rejected'
  | 'closed';

export interface TelnetClientEvents {
  /** 状态迁移(含原因文本,用于面板状态灯) */
  onStateChange?(state: TelnetClientState, detail: string): void;
  /** 清洗后的下行流文本(欢迎横幅/命令回显/命令输出) */
  onData?(text: string): void;
  /** 连接关闭 */
  onClose?(hadError: boolean): void;
}

/** 可注入的 socket 工厂(测试用记录型/仿真服务端 socket) */
export type SocketFactory = (options: { host: string; port: number }) => net.Socket;

const defaultSocketFactory: SocketFactory = options => net.connect(options);

export interface TelnetClientOptions {
  host: string;
  port: number;
  /** 密码经配置下发,只在握手时写 socket,不落任何文本面 */
  password?: string;
  events: TelnetClientEvents;
  socketFactory?: SocketFactory;
}

export class KBEngineTelnetClient {
  private socket: net.Socket | null = null;
  private _state: TelnetClientState = 'closed';
  private pending = Buffer.alloc(0);
  private passwordSent = false;

  constructor(private readonly options: TelnetClientOptions) {}

  get state(): TelnetClientState {
    return this._state;
  }

  private setState(state: TelnetClientState, detail: string): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.options.events.onStateChange?.(state, detail);
  }

  connect(): void {
    if (this.socket) {
      return;
    }
    const factory = this.options.socketFactory ?? defaultSocketFactory;
    this.setState('connecting', `${this.options.host}:${this.options.port}`);
    this.socket = factory({ host: this.options.host, port: this.options.port });

    this.socket.on('data', chunk => this.handleData(chunk));
    this.socket.on('close', hadError => {
      this.socket = null;
      this.passwordSent = false;
      this.pending = Buffer.alloc(0);
      const wasAuthRejected = this._state === 'auth-rejected';
      this.setState('closed', wasAuthRejected ? '认证被拒后连接关闭' : '连接已关闭');
      this.options.events.onClose?.(Boolean(hadError));
    });
    this.socket.on('error', () => {
      // close 事件随后必然触发,状态在 close 统一翻转;此处不重复发状态
    });
  }

  private handleData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    // 逐到达块清洗;引擎协商字节集中在前几字节,不做跨块 IAC 半包拼装
    const text = stripAnsiEscapes(stripTelnetControl(this.pending).toString('utf8'));
    this.pending = Buffer.alloc(0);
    if (text.length === 0) {
      return;
    }
    this.options.events.onData?.(text);

    const banner = parseBanner(text);
    if (banner.requiresPassword) {
      this.setState('awaiting-password', '服务端要求密码');
      if (!this.passwordSent && this.options.password) {
        this.passwordSent = true;
        this.socket?.write(`${this.options.password}\r\n`);
      }
      return;
    }
    if (banner.passwordRejected) {
      this.setState('auth-rejected', '密码被拒(引擎停在 PASSWD 态)');
      return;
    }
    if (looksLikePrompt(text)) {
      this.setState('ready', '已连接(命令提示符就绪)');
    }
  }

  /** 发送命令;:quit 恒拒(会关闭服务端进程) */
  sendCommand(command: string): boolean {
    const trimmed = command.trim();
    if (trimmed.toLowerCase() === ':quit') {
      return false;
    }
    if (!this.socket || this._state !== 'ready') {
      return false;
    }
    this.socket.write(`${trimmed}\r\n`);
    return true;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    if (this._state !== 'closed') {
      this.setState('closed', '已主动断开');
    }
  }
}
