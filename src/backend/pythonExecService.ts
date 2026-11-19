import { ChildProcessWithoutNullStreams } from 'child_process';

import { spawnProcess } from './processManager';

/**
 * RUST-002 判据③：脚本执行须独立的可复用执行服务。
 *
 * 现状差距（2026-11-15 审计）：Python 脚本执行面全是「每次调用新起一次解释器
 * 并等它退出」——热更保存语法闸每次定稿都 spawn 一个解释器跑 compile()。
 * 本模块把其中最频繁又无状态的一面换成**常驻解释器 + stdin/stdout 帧协议**：
 * 一个进程承载任意多次编译，只在退出/故障/超时后重建。与 Rust Core
 * （kodeCoreClient 单进程 + stdio LSP 多路复用）同构。
 *
 * 帧协议（双向）：`<十进制字节长度>\n<恰好那么多字节>\n`。
 * - 长度前缀使多行源码跨帧无损传递，换行只作分隔不进载荷（长度即边界）；
 * - 长度恒为 **utf-8 字节数**。解释器侧回包 `ensure_ascii=False` 时载荷可含
 *   非 ASCII（中文/弯引号语法错误文案），字节数>字符数——收包侧全程按
 *   Buffer 字节流缓冲与切分（KODE-FULL-001:旧实现 setEncoding 成字符串后按
 *   字符 slice,非 ASCII 回包永远切不出等长载荷,语法错误被误收口成基建
 *   超时,热更语法闸随之 fail-open）。
 *
 * 并发与超时语义：协议是单请求-单回包。并发指令进**队列**按 FIFO 兑现
 * （不拒、不乱序）。**超时不摘队**——迟到的帧会串到下一条请求上造成错位，
 * 故超时即拆掉子进程并按故障兑现，下一次 runCompile 惰性重建：宁可重付一次
 * 进程启动，也不交出错位的判定结果。
 *
 * 执行器语义红线：**只 compile() 不执行**，用户代码永不运行（迁移自
 * 一次性编译模块的语义，不得扩大权限）。
 */

/** 单条编译指令 */
export interface PythonCompileTask {
  readonly content: string;
}

/**
 * 执行服务判定结果。ok=false 时 error 为解释器侧错误行。
 * infra=true 区分「执行服务自身故障」与「真语法错误」——调用方（热更语法闸）
 * 据此 fail-open（故障放行不拦热更），语法错误才拦。
 */
export interface PythonExecOutcome {
  readonly ok: boolean;
  readonly error?: string;
  /** 故障类失败（进程退出/超时/未就绪/回包不可解析）；语法错误不设此位 */
  readonly infra?: boolean;
}

/** 服务句柄 */
export interface PythonExecService {
  runCompile(task: PythonCompileTask): Promise<PythonExecOutcome>;
  /** 永久关闭:后续调用如实报「未启动」,不再重建 */
  dispose(): void;
  /** 当前常驻子进程 pid；未起或已回收时 0 */
  pid(): number;
  /** 排队等待回包的指令数（含在途） */
  pendingCount(): number;
}

export interface PythonExecServiceOptions {
  /** 单条指令等待上限；默认 5000ms（与旧一次性编译路径同口径） */
  readonly timeoutMs?: number;
  /** 握手帧等待上限；默认 2000ms */
  readonly handshakeTimeoutMs?: number;
  /** 解释器可执行文件；缺省 python3。变更须新建服务(旧进程解释器已陈旧) */
  readonly interpreter?: string;
  /** 注入以便测试；默认 spawnProcess（真起子进程） */
  readonly spawn?: typeof spawnProcess;
}

/** 与旧一次性编译路径同口径的默认等待窗 */
export const PYTHON_EXEC_TIMEOUT_MS = 5000;
/** 握手（等 ready 帧）默认上限 */
export const PYTHON_EXEC_HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * 常驻服务内的执行器源码。协议：stdin 逐帧读源码 → compile() → stdout 逐帧回
 * `{ok:true}` 或 `{ok:false,error:<错误行>}`。
 *
 * 只 import json/sys/traceback——零副作用、不执行用户代码；compile() 的
 * filename 保留诊断文件名便于定位。stdin 全程走二进制 buffer（不与 text
 * 包装层混用，避免 readline/read 交错读乱）。
 */
export const PYTHON_EXEC_SERVICE_SOURCE = `import json
import sys
import traceback

def read_line():
    return sys.stdin.buffer.readline()

def read_bytes(n):
    buf = b""
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf

def read_frame():
    size_line = read_line()
    if size_line == b"":
        return None
    length = int(size_line.strip())
    payload = read_bytes(length)
    read_line()
    return payload.decode("utf-8")

def write_frame(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    out = sys.stdout.buffer
    out.write(("%d\\n" % len(data)).encode("ascii"))
    out.write(data)
    out.write(b"\\n")
    out.flush()

write_frame({"ready": True})

while True:
    source = read_frame()
    if source is None:
        break
    try:
        compile(source, "<kbengine-hotreload>", "exec")
        write_frame({"ok": True})
    except SyntaxError:
        last_line = traceback.format_exc(limit=0).strip().splitlines()[-1]
        write_frame({"ok": False, "error": last_line})
    except Exception as error:
        write_frame({"ok": False, "error": str(error)})
`;

/** 帧编码：字节长度前缀 + 载荷 + 换行分隔 */
function encodeFrame(payload: string): string {
  return `${Buffer.byteLength(payload, 'utf8')}\n${payload}\n`;
}

interface PendingCall {
  resolve: (outcome: PythonExecOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * 建常驻 Python 执行服务。
 *
 * 生命周期：**惰性 spawn**（首次 runCompile 才起）→ 等 `ready` 帧 → 逐帧按
 * FIFO 兑现请求 → 退出/故障/超时即拆掉，下一次调用重建。dispose 是永久关闭。
 */
export function createPythonExecService(options: PythonExecServiceOptions = {}): PythonExecService {
  const timeoutMs = options.timeoutMs ?? PYTHON_EXEC_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? PYTHON_EXEC_HANDSHAKE_TIMEOUT_MS;
  const spawn = options.spawn ?? spawnProcess;
  const interpreter = options.interpreter ?? 'python3';

  let disposed = false;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBytes: Buffer = Buffer.alloc(0);
  let stderrTail = '';
  let ready = false;
  const queue: PendingCall[] = [];
  let handshake: Promise<boolean> | null = null;

  const settle = (index: number, outcome: PythonExecOutcome): void => {
    const call = queue[index];
    if (!call) {
      return;
    }
    clearTimeout(call.timer);
    queue.splice(index, 1);
    call.resolve(outcome);
  };

  const settleAll = (error: string): void => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      settle(index, { ok: false, error, infra: true });
    }
  };

  /** 拆掉当前子进程并让在途请求如实失败；disposed 之外一律可重建 */
  const teardown = (reason?: string): void => {
    if (!child) {
      ready = false;
      handshake = null;
      return;
    }
    const target = child;
    const exitCode = target.exitCode ?? '?';
    const signal = target.signalCode ?? '—';
    child = null;
    ready = false;
    handshake = null;
    stdoutBytes = Buffer.alloc(0);
    settleAll(
      reason ?? `解释器进程退出(code=${exitCode}, signal=${signal})${stderrTail.trim() ? `: ${lastLine(stderrTail)}` : ''}`
    );
    if (target.exitCode === null && target.signalCode === null) {
      // 仍在跑(超时/故障主动拆)才需要击杀;已自然退出的不重复击杀
      try {
        target.kill('SIGKILL');
      } catch {
        // 已退出的子进程击杀失败:无害
      }
    }
  };

  const drainFrames = (): void => {
    for (;;) {
      const decoded = decodeFrame(stdoutBytes);
      if (decoded === null) {
        return;
      }
      stdoutBytes = decoded.remainder;
      if (!ready) {
        ready = true;
        continue; // 首帧=握手证据,不作为请求回包
      }
      if (queue.length === 0) {
        continue; // 无在途请求的迟到帧:如实丢弃,不冒充结果
      }
      let parsed: { ok?: boolean; error?: string };
      try {
        parsed = JSON.parse(decoded.body) as { ok?: boolean; error?: string };
      } catch {
        settle(0, { ok: false, error: '执行服务回包不可解析', infra: true });
        continue;
      }
      settle(0, parsed.ok === false ? { ok: false, error: parsed.error ?? '解释器回包异常' } : { ok: true });
    }
  };

  const wire = (proc: ChildProcessWithoutNullStreams): void => {
    // KODE-FULL-002:代际守卫——超时/故障拆掉旧进程后新进程已接管(child!==proc),
    // 旧进程迟到的 exit/error/stdout 帧不再属于本代,一律忽略;否则旧 exit
    // 会把新进程一并 teardown,旧残字节会污染新代帧缓冲
    const stale = (): boolean => child !== proc;
    // KODE-FULL-001:stdout 保持字节流(不 setEncoding)——帧边界按字节判定,
    // 多字节字符跨 chunk 断裂也不会被逐块 utf8 解码弄脏
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      if (stale()) { return; }
      stdoutBytes = Buffer.concat([stdoutBytes, chunk as Buffer]);
      drainFrames();
    });
    proc.stderr.on('data', chunk => {
      if (stale()) { return; }
      // 有界尾部(错误行取最后一行),不随长会话无界增长
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2048);
    });
    proc.on('error', error => {
      if (stale()) { return; }
      teardown(error.message);
    });
    proc.on('exit', () => {
      if (stale()) { return; }
      teardown();
    });
  };

  /** 惰性起进程并等握手帧；失败返回 false（调用方按未启动如实上报） */
  const ensureStarted = async (): Promise<boolean> => {
    if (disposed) {
      return false;
    }
    if (child && ready) {
      return true;
    }
    if (!child) {
      stderrTail = '';
      stdoutBytes = Buffer.alloc(0);
      ready = false;
      child = spawn(interpreter, ['-c', PYTHON_EXEC_SERVICE_SOURCE], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      wire(child);
    }
    if (!handshake) {
      handshake = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          if (ready) {
            resolve(true);
            return;
          }
          teardown(`握手超时(${handshakeTimeoutMs}ms)`);
          resolve(false);
        }, handshakeTimeoutMs);
        timer.unref?.();
        const poll = (): void => {
          if (ready) {
            clearTimeout(timer);
            resolve(true);
            return;
          }
          if (!child) {
            clearTimeout(timer);
            resolve(false);
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      }).then(ok => {
        handshake = null;
        return ok;
      });
    }
    return handshake;
  };

  return {
    async runCompile(task): Promise<PythonExecOutcome> {
      const started = await ensureStarted();
      if (!started || disposed || !child) {
        return { ok: false, error: disposed ? '执行服务已关闭' : '执行服务未就绪', infra: true };
      }
      let resolveCall: (outcome: PythonExecOutcome) => void = (): void => undefined;
      const promise = new Promise<PythonExecOutcome>(resolve => {
        resolveCall = resolve;
      });
      const call: PendingCall = {
        resolve: outcome => resolveCall(outcome),
        timer: setTimeout(() => {
          // 超时=卡死:摘队会串帧,故直接拆服务(在途其余请求同批失败),
          // 下一次调用重建——不错位、不悬挂
          const index = queue.indexOf(call);
          if (index >= 0) {
            settle(index, { ok: false, error: `编译超时(${timeoutMs}ms)`, infra: true });
          }
          teardown(`编译超时(${timeoutMs}ms)`);
        }, timeoutMs)
      };
      queue.push(call);
      child.stdin.write(encodeFrame(task.content));
      return promise;
    },
    dispose(): void {
      disposed = true;
      teardown('执行服务已关闭');
    },
    pid(): number {
      return child?.pid ?? 0;
    },
    pendingCount(): number {
      return queue.length;
    }
  };
}

/**
 * 帧解码(字节管道):无完整帧返回 null;消费掉已解码帧并返回载荷与余量。
 * KODE-FULL-001:长度=字节数,缓冲/切分/余量全程 Buffer——按字节切出的
 * 载荷再整体 utf8 解码,非 ASCII 载荷与跨 chunk 断裂的多字节字符都无损。
 */
function decodeFrame(buffer: Buffer): { body: string; remainder: Buffer } | null {
  const headerEnd = buffer.indexOf(0x0a);
  if (headerEnd < 0) {
    return null;
  }
  const sizeText = buffer.subarray(0, headerEnd).toString('ascii');
  if (!/^\d{1,10}$/.test(sizeText)) {
    // 帧边界已被破坏:清缓冲避免死锁
    return { body: '', remainder: Buffer.alloc(0) };
  }
  const size = Number(sizeText);
  const payloadStart = headerEnd + 1;
  // 帧完整 = 载荷 size 字节 + 1 字节帧尾换行都已到达
  if (buffer.length < payloadStart + size + 1) {
    return null;
  }
  const payload = buffer.subarray(payloadStart, payloadStart + size).toString('utf8');
  return { body: payload, remainder: buffer.subarray(payloadStart + size + 1) };
}

/** 取最后一行非空文本(错误行展示用) */
function lastLine(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}