import * as dgram from 'dgram';
import {
  MACHINE_MSG_QUERY_ALL_INTERFACES,
  buildComponentInfo,
  swapUint16
} from '../../src/kbengineProtocol';
import type { KBEngineComponentInfo } from '../../src/kbengineProtocol';

/**
 * 本地 machine 组件发现仿真器:UDP 应答端,端口由 OS 动态分配。
 *
 * 行为规格(对齐引擎 machine 组件的发现应答,kbe/src/lib/machine):
 * - 收到 msgid=4(MACHINE_MSG_QUERY_ALL_INTERFACES) 的发现请求帧后,
 *   对每个已注册组件回发一个组件广播包(parseComponentInfo 的线序,
 *   不带帧头),目标端口取请求报文的源端口;
 * - 同一 componentType:componentID:pid 身份只回一包(客户端按该
 *   三元组去重,仿真器保持相同语义);
 * - garbage 模式回 2 字节垃圾包,驱动客户端解析失败路径。
 *
 * 组件包构造复用生产侧 buildComponentInfo 编码器——仿真器与插件
 * 共享同一份协议规格(docs/redesign.md G4)。
 */

export interface MachineRequestRecord {
  messageId: number;
  uid: number;
  username: string;
  /** 请求帧内回填的客户端回复端口(swapUint16 归一后) */
  replyPort: number;
  /** UDP 报文实际源端口 */
  sourcePort: number;
  /** 原始请求帧(测试可独立逐字节断言,不信仿真器的解码) */
  raw: Buffer;
}

export interface MachineSimulatorOptions {
  components?: KBEngineComponentInfo[];
  /** 回发垃圾包而不是组件包,驱动客户端 reject 路径 */
  mode?: 'components' | 'garbage';
}

export class MachineSimulator {
  private currentComponents: KBEngineComponentInfo[];

  private constructor(
    readonly port: number,
    private readonly socket: dgram.Socket,
    private readonly requests: MachineRequestRecord[]
  ) {
    this.currentComponents = [];
  }

  static async start(options: MachineSimulatorOptions = {}): Promise<MachineSimulator> {
    const requests: MachineRequestRecord[] = [];

    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => resolve());
    });

    const simulator = new MachineSimulator(
      (socket.address() as dgram.AddressInfo).port,
      socket,
      requests
    );
    simulator.currentComponents = options.components ?? [];

    socket.on('message', (packet, rinfo) => {
      const messageId = packet.readUInt16LE(0);
      const body = packet.subarray(4);
      const uid = body.readInt32LE(0);
      let offset = 4;
      while (offset < body.length && body[offset] !== 0) {
        offset += 1;
      }
      const username = body.toString('utf8', 4, offset);
      const replyPort =
        offset + 3 <= body.length ? swapUint16(body.readUInt16LE(offset + 1)) : 0;
      requests.push({
        messageId,
        uid,
        username,
        replyPort,
        sourcePort: rinfo.port,
        raw: Buffer.from(packet)
      });

      if (messageId !== MACHINE_MSG_QUERY_ALL_INTERFACES) {
        return;
      }

      if ((options.mode ?? 'components') === 'garbage') {
        socket.send(Buffer.from([0x01, 0x02]), rinfo.port, '127.0.0.1');
        return;
      }

      const seen = new Set<string>();
      for (const component of simulator.currentComponents) {
        const key = `${component.componentType}:${component.componentID.toString()}:${component.pid}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        socket.send(buildComponentInfo(component), rinfo.port, '127.0.0.1');
      }
    });

    return simulator;
  }

  /** 已收到的发现请求记录(逐帧,含身份字段与端口回填) */
  getRequests(): MachineRequestRecord[] {
    return [...this.requests];
  }

  /** 清空请求记录(测试间复位) */
  clearRequests(): void {
    this.requests.length = 0;
  }

  /** 动态替换应答组件集(热更新拓扑) */
  setComponents(components: KBEngineComponentInfo[]): void {
    this.currentComponents = components;
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.socket.close(() => resolve()));
  }
}

/** 便捷工厂:构造一份字段合法、可局部覆写的组件描述(undefined 覆盖不生效) */
export function makeSimComponentInfo(
  overrides: Partial<KBEngineComponentInfo> = {}
): KBEngineComponentInfo {
  const defaults: KBEngineComponentInfo = {
    uid: 1001,
    username: 'ci',
    componentType: 6,
    componentID: 900n,
    componentIDEx: 901n,
    globalOrderID: 1,
    groupOrderID: 0,
    genuuidSections: 0,
    intaddr: '127.0.0.1',
    intport: 0,
    extaddr: '127.0.0.1',
    extport: 0,
    extaddrEx: '',
    pid: 4321,
    cpu: 0.5,
    mem: 25,
    usedmem: 1024,
    state: 1,
    machineID: 7,
    extradata: 0n,
    extradata1: 0n,
    extradata2: 0n,
    extradata3: 0n,
    backaddr: 0,
    backport: 0,
    componentName: 'baseapp',
    fullName: 'baseapp0'
  };
  // 显式 undefined 的覆写键不落盘:避免把合法默认值覆盖成 undefined
  const effective = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  );
  return { ...defaults, ...effective };
}
