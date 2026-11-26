// MRO-CHAIN (user order 2026-11-18 "derive the execution order of mixin traversal calls"):
// the demo's onCrossDay() has multiple mixin implementations and the root class dispatches
// with `for cls in type(self).__mro__` (tests/fixtures/kbengine-demo-assets training family).
// Chain order = the MRO order filtered down to the classes that define the method = the real
// execution order of the traversal/super() relay, statically derivable (C3 is determined by
// base-class declaration order); tests/mroChainLens.test.ts nails it by actually running
// python3 and comparing. This module holds only pure formatting/shape functions (zero vscode
// dependencies, unit-testable); the data face lives in
// pythonClassIndex.resolveMroMethodChains, the presentation face in languageProviders/codeLens.ts.
import type { MroChainEntry, MroMethodChain } from './pythonClassIndex';

/** Chain reveal command id (CodeLens arguments -> QuickPick lists every landing point in execution order) */
export const MRO_CHAIN_COMMAND = 'kbengine.python.mroChain';

/** Max number of class names inlined in the title; beyond that fold into "… (+N)" */
const MAX_TITLE_NAMES = 6;

/** Whether there is anything worth presenting: any chain with >=2 definers (a single definer has no order to speak of, so it does not appear) */
export const hasMroChainToPresent = (chains: readonly MroMethodChain[]): boolean =>
  chains.some(chain => chain.entries.length >= 2);

const joinEntryNames = (names: readonly string[]): string =>
  names.length <= MAX_TITLE_NAMES
    ? names.join(' → ')
    : `${names.slice(0, MAX_TITLE_NAMES - 1).join(' → ')} → … (+${names.length - (MAX_TITLE_NAMES - 1)})`;

/** First-chain title (execution-order chain); with multiple roots, append the root count -- all chains go into the QuickPick, not just the first */
export const formatMroChainTitle = (chains: readonly MroMethodChain[]): string => {
  const first = chains[0];
  const title = `链 ${first.entries.length}: ${joinEntryNames(first.entries.map(entry => entry.className))}`;
  return chains.length > 1 ? `${title}(+${chains.length - 1} 根)` : title;
};

/** QuickPick item shape (vscode-free pure data; codeLens.ts wraps it into QuickPickItem) */
export interface MroChainPickShape {
  label: string;
  description: string;
  detail: string;
  filePath: string;
  line: number;
  character: number;
}

/** Expand all chains into QuickPick items in execution order: the number = execution position, the root is annotated on each chain's first item */
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
