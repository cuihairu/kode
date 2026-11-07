import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// C-24 配置开关效果流水线一致性闸:switches.json(清单)× package.json
// (contributes.configuration)× manifest.json(截图产物)三方对账。
// 流水线兼作回归测试(交付验收条款),本测试锁住「清单不漂移、产物不缺」:
// ① 清单里每个 setting 都真实存在于 contributes.configuration(不写虚开关);
// ② off/on 状态值不相等(前后帧必有差异面);
// ③ capture=true 的开关必须有 off/on 静态图 + GIF + manifest 条目;
// ④ manifest 条目的文件真实落盘(不指向不存在的产物);
// ⑤ 文档页为生成器产物且覆盖全部开关(截图面+手工清单),防手改漏项。

interface SwitchEntry {
  key: string;
  setting: string;
  off: boolean | string;
  on: boolean | string;
  capture?: boolean;
  name_en: string;
  name_zh: string;
  effect_en: string;
  effect_zh: string;
}

interface ManifestEntry {
  key: string;
  off: string;
  on: string;
  gif: string;
}

const ROOT = path.join(__dirname, '..');

const switches = (
  JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'scripts', 'config-switch-gifs', 'switches.json'),
      'utf8'
    )
  ) as { switches?: SwitchEntry[] } | SwitchEntry[]
);
const switchList: SwitchEntry[] = Array.isArray(switches)
  ? switches
  : (switches.switches as SwitchEntry[]);

const manifest: ManifestEntry[] = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs', 'public', 'config-switch-gifs', 'manifest.json'),
    'utf8'
  )
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
) as { contributes: { configuration: { properties: Record<string, unknown> } } };
const declaredProps = pkg.contributes.configuration.properties;

const byKey = new Map(switchList.map(s => [s.key, s]));

describe('configSwitchGifs 配置开关效果流水线一致性', () => {
  it('清单里每个 setting 都在 contributes.configuration 里真实存在', () => {
    const missing = switchList.filter(s => !(s.setting in declaredProps));
    expect(missing.map(s => s.setting), '虚开关(清单有、贡献点无)').toEqual([]);
  });

  it('每个开关 off/on 状态值不相等(前后帧必有差异面)', () => {
    const identical = switchList.filter(s => s.off === s.on);
    expect(identical.map(s => s.key)).toEqual([]);
  });

  it('effect 文案中英齐全(文档页双语面不缺)', () => {
    const incomplete = switchList.filter(
      s => !s.effect_en?.trim() || !s.effect_zh?.trim()
    );
    expect(incomplete.map(s => s.key)).toEqual([]);
  });

  it('capture=true 的开关必须已有 manifest 截图条目(不多列不漏列)', () => {
    const withCapture = switchList.filter(s => s.capture === true);
    const manifestKeys = new Set(manifest.map(e => e.key));
    const missing = withCapture.filter(s => !manifestKeys.has(s.key));
    expect(missing.map(s => s.key), '清单标了可截图但产物缺').toEqual([]);
    const extra = manifest.filter(e => !byKey.get(e.key)?.capture);
    expect(
      extra.map(e => e.key),
      'manifest 有条目但清单未标可截图(产物与清单脱节)'
    ).toEqual([]);
  });

  it('manifest 条目指向的 off/on 图与 GIF 真实落盘', () => {
    const broken: string[] = [];
    for (const e of manifest) {
      for (const rel of [e.off, e.on, e.gif]) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) {
          broken.push(`${e.key}: ${rel}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('manifest 条目 off/on 指向不同文件(同图即假截图)', () => {
    const same = manifest.filter(e => e.off === e.on);
    expect(same.map(e => e.key)).toEqual([]);
  });

  it('文档页(en+zh)由生成器产出且覆盖全部开关', () => {
    for (const rel of ['docs/guide/config-effects.md', 'docs/zh/guide/config-effects.md']) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text).toContain('scripts/config-switch-gifs/render_docs.py');
      for (const s of switchList) {
        if (s.capture === true) {
          expect(text).toContain(s.setting);
        } else {
          // 手工清单也逐开关列出(不配图不编造,但效果说明必须在)
          expect(text).toContain(s.setting);
        }
      }
    }
  });
});
