import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// HR-QA-013(RUST-425)结构独立钉:「Rust Core 正在重建索引时热更新可继续
// 工作」的结构性保障——热更发送面(保存管线/磁盘监听/语法闸/通道发送/台账)
// 零引用索引调度面(IndexScheduler/IndexTask*)。索引重建与热更发送无共享
// 调用图,重建不阻塞热更(「可继续工作」半边的结构证明)。若有人把索引
// 依赖搬进热更发送路径(比如 fire 前等索引就绪/按索引状态闸门),此门红。
//   ①热更发送面全部模块零索引调度面 token;
//   ②自证非空转:同一 token 命中真实耦合面(activate/coreServices),
//     证明扫描器能抓真耦合,不是恒绿;
//   ③语法闸走解释器子进程(resolveInterpreter+compile),非读索引。
// 反向半边(索引重建的 CPU/线程池/锁不恶化语言服务尾延迟)需重建并发
// 压测,属 bench 车道,见 todo RUST-425 残差注记,本门不冒充覆盖。

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const INDEX_TOKENS = [
  'indexScheduler',
  'IndexScheduler',
  'IndexTaskSpec',
  'IndexTaskHandle',
  'IndexTaskKind',
  'IndexTaskPriority'
];

function allTs(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'target') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(path.relative(SRC_ROOT, full));
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

/** 热更发送面:根装配+激活装配+视图面板+后端 hotReload* 全族 */
function isHotReloadSurface(rel: string): boolean {
  const base = path.basename(rel);
  return (
    rel === 'activate/hotReload.ts' ||
    /^hotReload[^/]*\.ts$/.test(base) ||
    (rel.startsWith('backend/') && base.startsWith('hotReload'))
  );
}

describe('HR-QA-013 索引独立:热更发送面零索引调度依赖(RUST-425)', () => {
  it('①热更发送面全部模块零索引调度面 token(重建不阻塞热更)', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const rel of allTs()) {
      if (!isHotReloadSurface(rel)) {
        continue;
      }
      scanned += 1;
      const content = read(rel);
      for (const token of INDEX_TOKENS) {
        if (content.includes(token)) {
          hits.push(`${rel}:${token}`);
        }
      }
    }
    // 扫描面非空自证:热更发送面在库(防路径漂移后恒绿)
    expect(scanned, '热更发送面扫描到 0 个模块,路径谓词疑似漂移').toBeGreaterThan(20);
    expect(hits, `热更发送面引用了索引调度面: ${hits.join(', ')}`).toEqual([]);
  });

  it('②自证非空转:同一 token 命中真实耦合面(activate/coreServices)', () => {
    const content = read('activate/coreServices.ts');
    const hit = INDEX_TOKENS.some(token => content.includes(token));
    expect(hit, 'coreServices 未命中索引 token,扫描器或 token 集已漂移(恒绿风险)').toBe(true);
  });

  it('③语法闸走解释器子进程(resolveInterpreter+compile),非读索引', () => {
    const content = read('backend/hotReloadSyntaxGate.ts');
    expect(content.includes('resolveInterpreter'), '语法闸缺 resolveInterpreter 面').toBe(true);
    expect(content.includes('compile('), '语法闸缺 compile 调用面').toBe(true);
  });
});
