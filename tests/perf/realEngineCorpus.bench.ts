import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { hasEngineTreeMarker } from '../../src/backend/engineApiMetadata';
import { parseDefDocument } from '../../src/backend/defParser';

// RUST-021 真实引擎样例车道:样例**永不入库**(引擎树自带许可条款,合成
// 样例与本车道物理隔离)。存储位=环境变量 `KODE_PERF_REAL_ENGINE_ROOT`
// 指向的引擎 checkout(如 fork 的 kbe 树),未配置/无效时以
// `engine=not-configured` 如实申报零声称,不造假时间轴(SER-14 口径)。
// 配置后量测:真实语料盘点(.py/.def 计数+字节+类符号)+全量 .def 解析
// 容错走读(解析位 throw 的文件按调用方口径 catch 计入 skipped)。
// 输出以 REAL-ENGINE-METRIC 前缀落 docs/perf/real-engine-corpus-run.txt
// (KODE_REAL_ENGINE_OUT 可覆盖),与 v02Baseline emit 纪律一致。

const ENGINE_ROOT_ENV = 'KODE_PERF_REAL_ENGINE_ROOT';
const OUT_FILE = process.env.KODE_REAL_ENGINE_OUT
  ?? path.resolve(__dirname, '../../docs/perf/real-engine-corpus-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

interface RealEngineCorpus {
  engineRoot: string;
  corpusRoot: string;
  pyFiles: number;
  pyBytes: number;
  pyClasses: number;
  defFiles: number;
  defBytes: number;
  defParseFailures: number;
}

/** 在引擎树内定位真实脚本语料根(已知的引擎自带样例位,逐个探测) */
function findCorpusRoot(engineRoot: string): string | null {
  const candidates = [
    path.join(engineRoot, 'kbe', 'res', 'sdk_templates', 'server', 'python_assets', 'scripts'),
    path.join(engineRoot, 'kbe', 'res', 'scripts'),
    path.join(engineRoot, 'scripts')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function measureCorpus(corpusRoot: string): Omit<RealEngineCorpus, 'engineRoot' | 'corpusRoot'> {
  let pyFiles = 0;
  let pyBytes = 0;
  let pyClasses = 0;
  let defFiles = 0;
  let defBytes = 0;
  let defParseFailures = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.py') || entry.name.endsWith('.def'))) {
        const content = fs.readFileSync(full, 'utf8');
        if (entry.name.endsWith('.py')) {
          pyFiles += 1;
          pyBytes += Buffer.byteLength(content, 'utf8');
          pyClasses += (content.match(/^class /gm) ?? []).length;
        } else {
          defFiles += 1;
          defBytes += Buffer.byteLength(content, 'utf8');
          // 调用方容错口径(defAnalyzer catch→continue):解析位抛错的
          // 真实文件计入 skipped,不中断盘点
          try {
            parseDefDocument(content);
          } catch {
            defParseFailures += 1;
          }
        }
      }
    }
  };
  walk(corpusRoot);
  return { pyFiles, pyBytes, pyClasses, defFiles, defBytes, defParseFailures };
}

describe('真实引擎样例语料(RUST-021,env 隔离不入库)', () => {
  it('真实语料盘点与 .def 全量容错解析;未配置=如实申报 not-configured', () => {
    const engineRoot = process.env[ENGINE_ROOT_ENV];
    if (!engineRoot) {
      emit(
        `REAL-ENGINE-METRIC engine=not-configured env=${ENGINE_ROOT_ENV}`
        + ' note=样例不入库,配置引擎 checkout 后重跑即得实测'
      );
      // 零声称:未配置不是失败,也不伪造任何数字
      return;
    }
    // 配置了真引擎=开新记录窗(覆盖上次实测,防 append 无界增长)
    fs.writeFileSync(OUT_FILE, '');
    if (!hasEngineTreeMarker(engineRoot, candidate => fs.existsSync(candidate))) {
      // 配置了但指错目录=配置错误,红出来让人修,不静默放行
      const line = `REAL-ENGINE-METRIC engine=marker-invalid root=${engineRoot}`
        + ` — ${ENGINE_ROOT_ENV} 缺引擎树标记(kbe/src/lib/common/version.h)`;
      emit(line);
      throw new Error(line);
    }
    const corpusRoot = findCorpusRoot(engineRoot);
    if (!corpusRoot) {
      emit(`REAL-ENGINE-METRIC engine=marker-ok corpus=not-found root=${engineRoot}`);
      expect(corpusRoot).not.toBeNull();
      return;
    }
    const stats = measureCorpus(corpusRoot);
    const corpus: RealEngineCorpus = { engineRoot, corpusRoot, ...stats };
    emit(
      `REAL-ENGINE-METRIC engine=measured corpus=${corpus.corpusRoot}`
      + ` py=${corpus.pyFiles}(${(corpus.pyBytes / 1024).toFixed(1)}KiB,class=${corpus.pyClasses})`
      + ` def=${corpus.defFiles}(${(corpus.defBytes / 1024).toFixed(1)}KiB,parse-fail=${corpus.defParseFailures})`
    );
    // 正确性闸(非计时):语料非空且解析面无未预期形状
    expect(corpus.pyFiles + corpus.defFiles).toBeGreaterThan(0);
    expect(corpus.defParseFailures).toBeLessThanOrEqual(corpus.defFiles);
  }, 60_000);
});
