import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../src/sourceRevealCommand';

// IDE-ARC-001 源码 reveal 命令常量单面化:常量只住在 sourceRevealCommand.ts,
// 低层消费者(eventApi/generatedSourceLenses)不得再为取一个常量 import 整个
// languageProviders(反向依赖边切断);命令 id 字符串不得漂移——激活事件与
// package.json 注册面都钉着它。

const root = join(__dirname, '..');

describe('reveal 命令常量归属(IDE-ARC-001)', () => {
  it('常量值仍为 kbengine.source.reveal(激活事件与命令注册共用同一字符串)', () => {
    expect(KBENGINE_SOURCE_REVEAL_COMMAND).toBe('kbengine.source.reveal');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      activationEvents: string[];
      contributes: { commands: Array<{ command: string }> };
    };
    expect(pkg.activationEvents).toContain(`onCommand:${KBENGINE_SOURCE_REVEAL_COMMAND}`);
    expect(pkg.contributes.commands.map(entry => entry.command)).toContain(KBENGINE_SOURCE_REVEAL_COMMAND);
  });

  it('低层消费者不再 import languageProviders(反向依赖边已切断)', () => {
    for (const relative of ['src/eventApi.ts', 'src/generatedSourceLenses.ts']) {
      const source = readFileSync(join(root, relative), 'utf8');
      expect(source.includes("from './languageProviders'"), `${relative} 仍反向依赖 languageProviders`).toBe(false);
      expect(source.includes("from './sourceRevealCommand'"), `${relative} 应改用 sourceRevealCommand`).toBe(true);
    }
  });

  it('languageProviders 不再定义该常量(单一事实源在新模块)', () => {
    // KODE-ARCH-001:拆分后源面为 barrel + 全部子模块;常量本体只在
    // sourceRevealCommand.ts,reveal 面经 import 消费
    const lpSources = ['src/languageProviders.ts',
      ...readdirSync(join(root, 'src/languageProviders')).filter(f => f.endsWith('.ts')).map(f => `src/languageProviders/${f}`)];
    const source = lpSources.map(p => readFileSync(join(root, p), 'utf8')).join('\n');
    expect(source.match(/export const KBENGINE_SOURCE_REVEAL_COMMAND/)).toBe(null);
    expect(source.includes('KBENGINE_SOURCE_REVEAL_COMMAND')).toBe(true);
    expect(/from '(\.\.\/)?sourceRevealCommand'/.test(source), '常量消费面应 import sourceRevealCommand').toBe(true);
  });
});
