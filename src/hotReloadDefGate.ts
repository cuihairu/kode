/**
 * def 结构闸判定面(IDE-HOT-005 / RT-3 复用):把「批内 .def 逐文件对比会话
 * 滚动基线的结构指纹,结构性/无基线/不可读/无读取通道一律拦下」这一判定抽
 * 成独立模块,fire 路径(setupHotReload)与失败目标重试(hotReloadRetryCommand)
 * 共用同一实例与同一基线册——重试不复用闸判定就会让结构性 def 变更经「重试」
 * 通道以普通 reload 下发(RT-3)。基线逐次滚动语义与 fire 闸一致:被拦批次也
 * 把基线滚到当前内容,下次判定不重复拦同一内容。拦下理由逐条点名;纯 Python
 * 批/无 .def 批照常放行(空理由数组)。
 */

import { classifyDefChange } from './hotReloadDefStructure';

/** 所发文件内容读取口(与 HotReloadTargetStateWiring.readFileContent 同形) */
export type DefContentReader = (file: string) => Promise<string | null> | string | null;

export interface DefStructuralGate {
  /**
   * 对一批待发送文件做 def 结构判定,返回拦下理由列表(空数组=放行)。
   * 副作用仅限基线册滚动:每个可读 .def 见到后基线更新为当前内容。
   */
  check(files: readonly string[]): Promise<string[]>;
}

export function createDefStructuralGate(
  reader: DefContentReader | undefined,
  baselines: Map<string, string>
): DefStructuralGate {
  return {
    async check(files): Promise<string[]> {
      const defFiles = files.filter(file => file.toLowerCase().endsWith('.def'));
      if (defFiles.length === 0) {
        return [];
      }
      if (!reader) {
        return ['def 无内容读取通道,证明不了无结构变化(保守不发)'];
      }
      const contents = await Promise.all(
        defFiles.map(file => Promise.resolve(reader(file)).catch(() => null))
      );
      const reasons: string[] = [];
      defFiles.forEach((file, index) => {
        const after = contents[index];
        if (after === null) {
          reasons.push(`${file}: 内容不可读(保守按结构性,不发)`);
          return;
        }
        const baseline = baselines.get(file);
        if (baseline === undefined) {
          reasons.push(`${file}: 无基线(本次会话首次见到,证明不了无结构变化)`);
        } else {
          const verdict = classifyDefChange(baseline, after);
          if (verdict.structural) {
            reasons.push(`${file}: ${verdict.reasons.join(';')}`);
          }
        }
        baselines.set(file, after);
      });
      return reasons;
    }
  };
}
