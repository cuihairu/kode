import * as net from 'net';

/**
 * KBEngine telnet 协议客户端(kbe/src/lib/server/telnet_server.cpp +
 * telnet_handler.cpp 对齐):
 * - 有密码组件:连接后服务端先发字面 "password:";密码对 → 欢迎横幅 +
 *   提示符 + 五条 IAC 协商(每条末尾带字面 '\0' 终止字节,
 *   telnet_handler.cpp L884-900);密码错 → 静默重发
 *   "[{组件}@password ~]# " 并停在 PASSWD 态。
 * - 无密码组件:连接后直接发欢迎横幅,不发 IAC 协商。
 * - 提示符 "[{组件}@{层} ~]# "(python 层 "[{组件}@python ~] >>> ");
 *   `:quit` 会关闭服务端进程,必须在白名单层恒拒。
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

/** 半包保留上限:恶意/故障服务端持续不产完整帧时强制作帧,内存有界 */
export const TELNET_PENDING_CAP = 64 * 1024;

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

/**
 * 把到达字节切成「完整帧 + 保留半包」:
 * - tail 若落在 IAC 序列中间(IAC 后缺命令/参数、IAC SB 未到 IAC SE) →
 *   该序列起点起保留,正文先出;
 * - 帧尾若截断多字节 UTF-8 字符 → 该字符起点起保留(下一块拼齐再解码),
 *   避免逐块 toString 产生 U+FFFD 替换字符。
 * 返回 frame=可立即解码的完整前缀,rest=待与下一块拼装的半包。
 */
export function consumeTelnetFrame(buf: Buffer): { frame: Buffer; rest: Buffer } {
  let cut = buf.length;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== IAC) {
      continue;
    }
    const next = buf[i + 1];
    if (next === undefined) {
      cut = i;
      break;
    }
    if (next === IAC) {
      i += 1;
      continue;
    }
    if (next === DO || next === DONT || next === WILL || next === WONT) {
      if (buf[i + 2] === undefined) {
        cut = i;
        break;
      }
      i += 2;
      continue;
    }
    if (next === SB) {
      let j = i + 2;
      let complete = false;
      while (j < buf.length) {
        if (buf[j] === IAC) {
          if (buf[j + 1] === SE) {
            complete = true;
            break;
          }
          if (buf[j + 1] === IAC) {
            j += 2;
            continue;
          }
        }
        j += 1;
      }
      if (!complete) {
        cut = i;
        break;
      }
      i = j + 1;
      continue;
    }
    i += 1; // 其他两字节命令:命令字节在位,整体吞掉
  }
  const frameEnd = utf8CompletePrefixLen(buf, cut);
  return { frame: buf.subarray(0, frameEnd), rest: buf.subarray(frameEnd) };
}

/** [0, limit) 内最后一个完整 UTF-8 字符边界(截断尾部字符回退到其起点)。 */
function utf8CompletePrefixLen(buf: Buffer, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  let i = limit - 1;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    i -= 1;
  }
  if (i < 0) {
    return limit;
  }
  const b = buf[i];
  let len: number;
  if ((b & 0x80) === 0x00) {
    len = 1;
  } else if ((b & 0xe0) === 0xc0) {
    len = 2;
  } else if ((b & 0xf0) === 0xe0) {
    len = 3;
  } else if ((b & 0xf8) === 0xf0) {
    len = 4;
  } else {
    return limit; // 孤立续字节/非法头:原样,不猜测
  }
  return i + len <= limit ? limit : i;
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

/**
 * 提示符检测:引擎 getInputStartString() 只产两种形态
 * (telnet_handler.cpp L143-147)——root/readonly 层 "[{组件}@{层} ~]# ",
 * python 层 "[{组件}@python ~] >>> "(`~]` 与 `>>>` 之间有一个空格,
 * 引擎默认 default_layer 就是 python,kbengine_defaults.xml L266)。
 */
export function looksLikePrompt(text: string): boolean {
  return /\[[^\]]+@[^\]]+ ~\]\s*(?:#|>>>|>)\s*$/.test(text) || />\s*>\s*>\s*$/.test(text);
}

/**
 * 命令白名单:命令与白名单项完全一致,或以「项 + 空格」(CLI 带参形态)或
 * 「项 + (」(python 调用带参形态,如 KBEngine.addBots(5))为前缀。
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
    return trimmed === name || trimmed.startsWith(`${name} `) || trimmed.startsWith(`${name}(`);
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
  /**
   * connect 超时毫秒数(KR-AUD-51):无响应 socket 此前会永远停在
   * connecting;超时即 destroy socket 并落 closed。默认 10s。
   */
  connectTimeoutMs?: number;
}

/** connect 默认超时(KR-AUD-51) */
export const TELNET_CONNECT_TIMEOUT_MS = 10_000;

export class KBEngineTelnetClient {
  private socket: net.Socket | null = null;
  private _state: TelnetClientState = 'closed';
  private pending = Buffer.alloc(0);
  private passwordSent = false;
  private connectTimer: NodeJS.Timeout | null = null;
  /** 超时自毁后抑制 close 处理器二次收尾(KR-AUD-51) */
  private timedOut = false;

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
    this.timedOut = false;
    this.socket = factory({ host: this.options.host, port: this.options.port });

    this.socket.on('data', chunk => this.handleData(chunk));
    this.socket.on('close', hadError => {
      this.clearConnectTimer();
      this.socket = null;
      this.passwordSent = false;
      this.pending = Buffer.alloc(0);
      if (this.timedOut) {
        // 超时路径已在定时器里收尾(状态/onClose),此处不再重复
        return;
      }
      const wasAuthRejected = this._state === 'auth-rejected';
      this.setState('closed', wasAuthRejected ? '认证被拒后连接关闭' : '连接已关闭');
      this.options.events.onClose?.(Boolean(hadError));
    });
    this.socket.on('error', () => {
      // close 事件随后必然触发,状态在 close 统一翻转;此处不重复发状态
    });

    // KR-AUD-51:connect 超时——无响应 socket(防火墙静默丢包等)此前会
    // 永远停在 connecting;到点即 destroy 并统一按 closed 收尾一次。
    const timeoutMs = this.options.connectTimeoutMs ?? TELNET_CONNECT_TIMEOUT_MS;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (!this.socket || this._state !== 'connecting') {
        return;
      }
      const socket = this.socket;
      this.socket = null;
      this.timedOut = true;
      socket.destroy();
      this.setState('closed', `连接超时(${timeoutMs}ms 无响应,已销毁 socket)`);
      this.options.events.onClose?.(true);
    }, timeoutMs);
    this.connectTimer.unref?.();
  }

  /** 取消 connect 超时定时器(KR-AUD-51):close/服务端首包即解除 */
  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private handleData(chunk: Buffer): void {
    // 服务端有字节回来即视为连接建立,解除 connect 超时(KR-AUD-51)
    this.clearConnectTimer();
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > TELNET_PENDING_CAP) {
      // 恶意/故障服务端持续不产完整帧:强制作一帧,内存有界不悬挂
      const { frame } = consumeTelnetFrame(this.pending);
      this.pending = Buffer.alloc(0);
      this.emitTelnetFrame(frame);
      return;
    }
    const { frame, rest } = consumeTelnetFrame(this.pending);
    this.pending = rest;
    if (frame.length === 0) {
      // 全为半包(IAC 序列起点 / UTF-8 字符尾部):等下一块拼齐
      return;
    }
    this.emitTelnetFrame(frame);
  }

  private emitTelnetFrame(frame: Buffer): void {
    // 引擎协商字节集中在前几字节;跨块 IAC 序列与多字节 UTF-8 由
    // consumeTelnetFrame 半包拼装,此处每帧必为完整序列。引擎五条 IAC 协商
    // 命令的数组末尾各带字面 '\0' 终止字节(telnet_handler.cpp L884-900):
    // 不属于 IAC 序列、上面的剥离吃不掉,会缀在提示符之后,把结尾检测搅死
    // ——再把 C0 控制字节(\r\n\t 除外)一并剥掉,提示符检测才能看到干净结尾
    const text = stripAnsiEscapes(stripTelnetControl(frame).toString('utf8')).replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      ''
    );
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
    this.clearConnectTimer();
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    if (this._state !== 'closed') {
      this.setState('closed', '已主动断开');
    }
  }
}
