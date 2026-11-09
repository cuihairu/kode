/**
 * demo 游戏模板装载(DEMO-GAME-006):把 templates/demo-game 目录(夹具
 * tests/fixtures/kbengine-demo-assets 的游戏子集,Training/Elite 导航测试
 * 资产裁掉,entities.xml 收敛为游戏实体注册表)读成项目创建清单
 * (projectTemplate.ProjectTemplateEntry)。
 *
 * 模板住在扩展安装目录(vsce 打包面;.vscodeignore 不排除 templates/),
 * 不在代码里内嵌几十个文件的内容——单一真源是磁盘文件,与夹具的逐字节
 * 对拍契约由 tests/demoGameTemplate.test.ts 锁定(模板文件除
 * scripts/entities.xml 裁剪外必须与夹具同名文件完全一致)。
 *
 * 清单与最小模板同形:目录条目(父先于子)在前、其下文件跟随,落盘侧
 * 既有路径(directory 条目 mkdir recursive、文件原子写)原样复用;冲突
 * 预检面对目录与文件同样生效(已存在的 scripts/ 目录即冲突,整次拒绝,
 * 不写半套——与最小项目同一语义)。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectTemplateEntry } from './backend/projectTemplate';

/** 模板在扩展安装目录内的相对根(测试/产品同路径形态) */
export const DEMO_GAME_TEMPLATE_RELATIVE_ROOT = 'templates/demo-game';

/** 装载依赖(注入以便测试;产品面走真实 fs) */
export interface DemoGameTemplateFs {
  readdirSync(dirPath: string, options: { withFileTypes: true }): readonly fs.Dirent[];
  readFileSync(filePath: string): Buffer;
}

const realFs: DemoGameTemplateFs = {
  readdirSync: (dirPath, options) => fs.readdirSync(dirPath, options),
  readFileSync: filePath => fs.readFileSync(filePath)
};

/**
 * 递归走读模板目录 → 清单(相对路径 POSIX 形态;目录条目父先于子,
 * 同级按名排序保证计划与预览顺序确定)。模板根不存在时如实抛错——
 * 命令面把它当创建失败走回收/报错,不静默落半套。
 */
export function loadDemoGameTemplateEntries(
  templateRoot: string,
  deps: DemoGameTemplateFs = realFs
): ProjectTemplateEntry[] {
  const entries: ProjectTemplateEntry[] = [];
  const walk = (dirPath: string, relativeDir: string): void => {
    const dirents = [...deps.readdirSync(dirPath, { withFileTypes: true })]
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        entries.push({ kind: 'directory', relativePath });
        walk(path.join(dirPath, dirent.name), relativePath);
      } else if (dirent.isFile()) {
        entries.push({
          kind: 'file',
          relativePath,
          content: deps.readFileSync(path.join(dirPath, dirent.name)).toString('utf8')
        });
      }
      // 符号链接等其他形态不产出:清单只认真实文件/目录,防止模板被链接逃逸
    }
  };
  walk(templateRoot, '');
  return entries;
}

/** 模板根解析:扩展安装目录 + 相对根(extension.ts 接线用) */
export function resolveDemoGameTemplateRoot(extensionPath: string): string {
  return path.join(extensionPath, DEMO_GAME_TEMPLATE_RELATIVE_ROOT);
}

/** 清单类型收窄帮助(计划面接受的条目联合形态) */
export type DemoGameTemplateEntries = readonly ProjectTemplateEntry[];
