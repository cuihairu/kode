/**
 * KODE-RESP-009:drain 感知帧写器(LSP stdio 写背压纯核)。
 *
 * 旧 sendRaw 对 stdin.write 的 false 返回值视而不见——服务端慢消费(语料
 * 镜像洪水对上同步 ingest)时,帧无限堆进 Node 流内部缓冲:内存无界,交互
 * 请求/取消排在积压之后,耗掉超时预算。本写器两条规则:
 * 1. 帧写入串行化(单链 FIFO,帧序=入队序,请求/通知相对顺序不破坏);
 * 2. 写返回 false(管道满)后,下一帧等 drain 再写——判据只认流的权威
 *    writableNeedDrain 态,不养自有等待标志(drain 事件可能在无人监听窗口
 *    被消费,自有标志会泊车在已花事件上永久悬挂)——背压响应式传导给
 *    生产端:await drained()/notifyDrained 的调用方(语料镜像逐帧等写完)
 *    被管道自然限速,客户端缓冲 = OS 管道容量 + 至多一帧(硬上界)。
 * drain/close/error 三事件任一即放行(进程死掉时 close/error 兜底,链不
 * 悬挂);写口异常(exit 竞态 EPIPE 窗口)吞掉,失败语义归客户端 exit
 * 路径统一拒绝。纯核零 vscode,写口与事件面注入。
 */

/** 写口与事件面(注入真实 child.stdin 或测试替身;每帧写时现取) */
export interface FrameWriterHooks {
  /** 写一帧;返回值语义同 stream.Writable.write(false=内部缓冲超限) */
  write(frame: Buffer): boolean;
  /** 流的权威 drain 态(真实 stdin 即 writableNeedDrain):true=有 drain 事件在途 */
  needDrain(): boolean;
  once(event: 'drain' | 'close' | 'error', listener: () => void): void;
  off(event: 'drain' | 'close' | 'error', listener: () => void): void;
}

export class FrameWriter {
  private chain: Promise<void> = Promise.resolve();
  private queuedFrames = 0;

  constructor(private readonly hooks: FrameWriterHooks) {}

  /** 入队一帧(FIFO;不阻塞调用方) */
  send(frame: Buffer): void {
    this.queuedFrames += 1;
    this.chain = this.chain
      .then(() => this.writeFrame(frame))
      .finally(() => {
        this.queuedFrames -= 1;
      });
  }

  /** 本帧(含此前所有帧)真正写完(必要时已等过 drain)后完成 */
  drained(): Promise<void> {
    return this.chain;
  }

  /** 在队未写帧数(RESP-009 缓冲上界观测口;测试/可观测用) */
  get pendingFrames(): number {
    return this.queuedFrames;
  }

  private async writeFrame(frame: Buffer): Promise<void> {
    // 等待判据只认流的权威状态,不养自有等待标志:write=false 后,'drain'
    // 事件可能在无人监听的窗口触发(库 semaphore 用 setImmediate 隔开相邻
    // 两写,事件循环 poll 相插得进;满载下服务端恰在窗口内把管道排空)——
    // 自有标志还挂着、事件却已消费,再守 'drain' 就永久悬挂(KODE-RESP-009
    // CI 楔死根因)。needDrain=false 即管道已空,直接自愈续写。
    if (this.hooks.needDrain()) {
      await this.waitForDrain();
    }
    try {
      this.hooks.write(frame);
    } catch {
      // exit 竞态窗口的同步写失败:吞掉——响应已不可能,客户端 exit 路径
      // 对 in-flight 统一拒绝(与旧 sendRaw 的 catch 口径一致)
    }
  }

  private async waitForDrain(): Promise<void> {
    await new Promise<void>(resolve => {
      const done = (): void => {
        this.hooks.off('drain', done);
        this.hooks.off('close', done);
        this.hooks.off('error', done);
        resolve();
      };
      // 先订阅(不丢在途事件),订阅后复核(防泊车在已花掉的事件上):
      // needDrain 已翻 false 说明 drain 在订阅前触发过,直接放行
      this.hooks.once('drain', done);
      this.hooks.once('close', done);
      this.hooks.once('error', done);
      if (!this.hooks.needDrain()) {
        done();
      }
    });
  }
}
