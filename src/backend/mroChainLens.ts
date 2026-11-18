// MRO-CHAIN(用户令 2026-11-18「mixin 遍历调用的执行顺序推导」):demo 例
// onCrossDay() 多 mixin 实现 + 根类 for cls in type(self).__mro__ 遍历调度
// (tests/fixtures/kbengine-demo-assets training 族)。链序 = MRO 序过滤出
// 定义了该方法的类 = 遍历/super() 接力的真实执行序,静态可推导(C3 由基类
// 声明序决定);tests/mroChainLens.test.ts 用 python3 真跑对拍钉死。
// 本模块只放纯格式化/形状函数(零 vscode 依赖,可单测);数据面在
// pythonClassIndex.resolveMroMethodChains,呈现面在 languageProviders/codeLens.ts。
import type { MroChainEntry, MroMethodChain } from './pythonClassIndex';

/** 链 reveal 命令 id(CodeLens arguments → QuickPick 按执行序列出全部落点) */
export const MRO_CHAIN_COMMAND = 'kbengine.python.mroChain';

/** 标题里最多直列的类名数,超出折叠为「… (+N)」 */
const MAX_TITLE_NAMES = 6;

/** 是否有呈现价值:任一链 ≥2 定义者(单定义者无顺序可言,不出镜) */
export const hasMroChainToPresent = (chains: readonly MroMethodChain[]): boolean =>
  chains.some(chain => chain.entries.length >= 2);

const joinEntryNames = (names: readonly string[]): string =>
  names.length <= MAX_TITLE_NAMES
    ? names.join(' → ')
    : `${names.slice(0, MAX_TITLE_NAMES - 1).join(' → ')} → … (+${names.length - (MAX_TITLE_NAMES - 1)})`;

/** 首链标题(执行序链);多根视角时附根数,全部链进 QuickPick 不止首链 */
export const formatMroChainTitle = (chains: readonly MroMethodChain[]): string => {
  const first = chains[0];
  const title = `链 ${first.entries.length}: ${joinEntryNames(first.entries.map(entry => entry.className))}`;
  return chains.length > 1 ? `${title}(+${chains.length - 1} 根)` : title;
};

/** QuickPick 项形状(vscode-free 纯数据;codeLens.ts 包成 QuickPickItem) */
export interface MroChainPickShape {
  label: string;
  description: string;
  detail: string;
  filePath: string;
  line: number;
  character: number;
}

/** 全部链按执行序展开成 QuickPick 项:序号=执行位次,根标注在每链首项 */
export const chainPickShapes = (chains: readonly MroMethodChain[]): MroChainPickShape[] => {
  const items: MroChainPickShape[] = [];
  for (const chain of chains) {
    chain.entries.forEach((entry: MroChainEntry, index: number) => {
      items.push({
        label: `${index + 1}. ${entry.className}`,
        description: index === 0 ? `根 ${chain.rootClassName}` : '',
        detail: `${entry.filePath}:${entry.line + 1}`,
        filePath: entry.filePath,
        line: entry.line,
        character: entry.character
      });
    });
  }
  return items;
};
