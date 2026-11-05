/**
 * def 结构闸判定面(IDE-HOT-005 / RT-3 复用):把「批内 .def 逐文件对比
 * 引擎已加载版本的结构指纹,结构性/无基线/不可读/无读取通道一律拦下」
 * 这一判定抽成独立模块,fire 路径(setupHotReload)与失败目标重试
 * (hotReloadRetryCommand)共用同一实例与同一基线册——重试不复用闸判定
 * 就会让结构性 def 变更经「重试」通道以普通 reload 下发(RT-3)。
 *
 * F1(2026-11-05 审核):基线=目标引擎当前已加载的结构版本,只在两种
 * 时机前滚/建立——
 *  1. commit:批次通过闸判定且即将真实发送时,由调用方显式前滚到本次所
 *     发内容(目标即将加载的版本);
 *  2. confirmLoaded:用户明确重启确认(引擎已加载当前内容)后重建基线。
 * 被拦批次(结构性/无基线/不可读)绝不前滚基线:否则第一次拦截即把基线
 * 滚到未加载内容,第二次发送同一内容(或其非结构变体)指纹相同即放行,
 * 绕过需重启(F1 反例);无基线文件在确认前持续保守拦截。拦下理由逐条
 * 点名;纯 Python 批/无 .def 批照常放行(空理由数组)。
 */

import { classifyDefChange } from './hotReloadDefStructure';

/** 所发文件内容读取口(与 HotReloadTargetStateWiring.readFileContent 同形) */
export type DefContentReader = (file: string) => Promise<string | null> | string | null;

export interface DefStructuralGate {
  /**
   * 对一批待发送文件做 def 结构判定,返回拦下理由列表(空数组=放行)。
   * 纯判定面:本方法绝不改基线册(F1——被拦批次不得前滚基线);放行
   * 批次由调用方在真实发送前调 commit 前滚基线。
   */
  check(files: readonly string[]): Promise<string[]>;
  /**
   * F1:基线前滚口——仅当批次已通过判定且即将真实发送时由调用方调用。
   * 把每个可读 .def 的基线滚到当前内容(=本次所发、目标即将加载的版本)。
   */
  commit?(files: readonly string[]): Promise<void>;
  /**
   * F1:明确重启确认口——用户确认引擎已重启并加载当前内容后调用,把
   * 基线(重新)建立为当前内容。不传 files 时对会话内闸见过的全部 def
   * 文件重建。返回建立/更新基线的文件数(不可读的跳过,不虚构)。
   */
  confirmLoaded?(files?: readonly string[]): Promise<number>;
}

export function createDefStructuralGate(
  reader: DefContentReader | undefined,
  baselines: Map<string, string>
): DefStructuralGate {
  // 会话内闸判定见过的 def 文件(含被拦的)——confirmLoaded 的默认重建面
  const seenDefFiles = new Set<string>();
  const readContent = async (file: string): Promise<string | null> => {
    if (!reader) {
      return null;
    }
    try {
      const content = await Promise.resolve(reader(file));
      return content === null || content === undefined ? null : content;
    } catch {
      return null;
    }
  };
  const readAll = async (files: readonly string[]): Promise<(string | null)[]> =>
    Promise.all(files.map(file => readContent(file)));
  const isDef = (file: string): boolean => file.toLowerCase().endsWith('.def');

  return {
    async check(files): Promise<string[]> {
      const defFiles = files.filter(isDef);
      if (defFiles.length === 0) {
        return [];
      }
      if (!reader) {
        return ['def 无内容读取通道,证明不了无结构变化(保守不发)'];
      }
      for (const file of defFiles) {
        seenDefFiles.add(file);
      }
      const contents = await readAll(defFiles);
      const reasons: string[] = [];
      defFiles.forEach((file, index) => {
        const after = contents[index];
        if (after === null) {
          reasons.push(`${file}: 内容不可读(保守按结构性,不发)`);
          return;
        }
        const baseline = baselines.get(file);
        if (baseline === undefined) {
          reasons.push(`${file}: 无基线(本次会话首次见到,证明不了无结构变化;重启后请确认基线)`);
        } else {
          const verdict = classifyDefChange(baseline, after);
          if (verdict.structural) {
            reasons.push(`${file}: ${verdict.reasons.join(';')}`);
          }
        }
        // F1:判定面不再前滚基线——被拦批次滚动基线会让第二次发送绕过
        // 需重启;放行批次由调用方 commit 前滚(见 gateDefChanges/重试)。
      });
      return reasons;
    },
    async commit(files): Promise<void> {
      const defFiles = files.filter(isDef);
      if (!reader || defFiles.length === 0) {
        return;
      }
      const contents = await readAll(defFiles);
      defFiles.forEach((file, index) => {
        const content = contents[index];
        if (content !== null) {
          baselines.set(file, content);
        }
      });
    },
    async confirmLoaded(files): Promise<number> {
      if (!reader) {
        return 0;
      }
      const targets = (files ? [...files] : [...seenDefFiles]).filter(isDef);
      const contents = await readAll(targets);
      let confirmed = 0;
      targets.forEach((file, index) => {
        const content = contents[index];
        if (content !== null) {
          baselines.set(file, content);
          confirmed += 1;
        }
      });
      return confirmed;
    }
  };
}
