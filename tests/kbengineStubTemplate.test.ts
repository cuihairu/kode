import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// 批 ③(用户令 2026-11-11 静态模板定案):插件内置 KBEngine 桩包模板落在
// 仓库顶层 typings/(README + KBEngine/ 包目录,与 fork typings 同形,
// VSIX 随包)。这里锁模板的形状契约:清单齐全、__init__ 重导出序(桩包
// shadowing 契约)、Entity/Proxy 关键注入面、导入改写净度、README 钉点。
// 模板由 scripts/derive-kbengine-stub-typings.mjs 从 fork(cuihairu/kbengine,
// 钉点见 README)派生,再生成走脚本,不手改。

const TEMPLATE_ROOT = join(__dirname, '..', 'typings');
const PACKAGE_DIR = join(TEMPLATE_ROOT, 'KBEngine');

const CLASS_FILES = [
  'Entity.pyi',
  'Proxy.pyi',
  'Space.pyi',
  'EntityComponent.pyi',
  'Entities.pyi',
  'EntityCall.pyi',
  'EntityComponentCall.pyi',
  'MemoryStream.pyi',
  'GlobalDataClient.pyi'
];

const LAYER_FILES = [
  '_KBEngine_baseapp.pyi',
  '_KBEngine_bots.pyi',
  '_KBEngine_cellapp.pyi',
  '_KBEngine_common.pyi',
  '_KBEngine_dbmgr.pyi',
  '_KBEngine_interfaces.pyi',
  '_KBEngine_logger.pyi',
  '_KBEngine_loginapp.pyi',
  '_KBEngine_pythonapp.pyi',
  '_KBEngine_server_errors.pyi'
];

const read = (relative: string): string => readFileSync(join(TEMPLATE_ROOT, relative), 'utf8');

describe('typings/ 内置桩包模板(清单)', () => {
  it('KBEngine/ 包 22 件齐全:入口 + 9 类分件 + hooks + 向量 + 10 层文件', () => {
    const entries = readdirSync(PACKAGE_DIR).sort();
    expect(entries).toHaveLength(22);
    for (const classFile of CLASS_FILES) {
      expect(entries, classFile).toContain(classFile);
    }
    for (const layerFile of LAYER_FILES) {
      expect(entries, layerFile).toContain(layerFile);
    }
    expect(entries).toContain('__init__.pyi');
    expect(entries).toContain('hooks.pyi');
    expect(entries).toContain('_vectors.pyi');
    expect(existsSync(join(TEMPLATE_ROOT, 'README.md'))).toBe(true);
  });

  it('README 带 fork 钉点与再生成说明(防手改漂移)', () => {
    const readme = read('README.md');
    expect(readme).toContain('28d2117');
    expect(readme).toContain('derive-kbengine-stub-typings.mjs');
    expect(readme).toContain('copy-if-absent');
  });
});

describe('typings/KBEngine/__init__.pyi(重导出序=shadowing 契约)', () => {
  const init = read('KBEngine/__init__.pyi');

  it('层文件星导入在前,类分件重导出殿后(进程层同名模型被逐类重导出压住)', () => {
    const starImports = init.split('\n').filter(line => /^from \._KBEngine_.+ import \*$/.test(line));
    expect(starImports).toEqual([
      'from ._KBEngine_server_errors import *',
      'from ._KBEngine_pythonapp import *',
      'from ._KBEngine_baseapp import *',
      'from ._KBEngine_cellapp import *',
      'from ._KBEngine_dbmgr import *',
      'from ._KBEngine_interfaces import *',
      'from ._KBEngine_logger import *',
      'from ._KBEngine_loginapp import *',
      'from ._KBEngine_bots import *',
      'from ._KBEngine_common import *'
    ]);
    const lastStarIndex = init.lastIndexOf('import *');
    // Entity 是类重导出的第一行(star-import 之后,进程层客户端模型失位)
    expect(init.indexOf('from .Entity import Entity')).toBeGreaterThan(lastStarIndex);
    expect(init.indexOf('from .Entity import Entity'))
      .toBeLessThan(init.indexOf('from .Proxy import Proxy'));
  });

  it('向量类随包 + __getattr__ 声明(star-import 不重导出下划线名,缺它即断链)', () => {
    expect(init).toContain('from ._vectors import Vector2, Vector3, Vector4');
    expect(init).toContain('def __getattr__(name: str) -> Any:');
    for (const cls of CLASS_FILES.map(file => file.replace('.pyi', ''))) {
      expect(init, cls).toContain(`from .${cls} import ${cls}`);
    }
  });

  it('头部为中英双语(shadowing 契约写明)', () => {
    expect(init).toContain('re-export order');
    expect(init).toContain('re-export 顺序');
  });
});

describe('typings/KBEngine/Entity.pyi(注入面)', () => {
  const entity = read('KBEngine/Entity.pyi');

  it('Entity 类完整,cellData overlay 注入且双语注释(锚点 baseapp/entity.cpp:238)', () => {
    expect(entity).toContain('class Entity:');
    expect(entity).toContain('cellData: Dict[str, Any]');
    expect(entity).toContain('baseapp/entity.cpp:238');
    expect(entity).toContain('cell 侧属性');
    expect(entity).toContain('baseapp-side runtime attribute');
  });
});

describe('typings/KBEngine/Proxy.pyi(内部属性注入面)', () => {
  const proxy = read('KBEngine/Proxy.pyi');

  it('两个登录内部属性在案,带中英双语内部属性标记(锚点 entitydef/common.h + baseapp.cpp)', () => {
    expect(proxy).toContain('class Proxy(');
    expect(proxy).toContain('__ACCOUNT_NAME__: str');
    expect(proxy).toContain('__ACCOUNT_PASSWORD__: str');
    expect(proxy).toContain('entitydef/common.h:142-143');
    expect(proxy).toContain('baseapp.cpp:4241-4246');
    expect(proxy).toContain('内部属性');
    expect(proxy).toContain('internal attribute');
  });
});

describe('typings/KBEngine/_vectors.pyi(kode 唯一自绘面)', () => {
  it('Vector2/3/4 在案,头部声明事实源在 emitKbeVectorStubClasses', () => {
    const vectors = read('KBEngine/_vectors.pyi');
    expect(vectors).toContain('class Vector2:');
    expect(vectors).toContain('class Vector3:');
    expect(vectors).toContain('class Vector4:');
    expect(vectors).toContain('emitKbeVectorStubClasses');
  });
});

describe('typings/ 导入改写净度(派生脚本净度闸)', () => {
  it('全部 .pyi 无未改写的 `from _KBEngine_*` 顶层导入(留了就是断链 import)', () => {
    const violations: string[] = [];
    for (const name of readdirSync(PACKAGE_DIR)) {
      if (!name.endsWith('.pyi')) {
        continue;
      }
      const content = readFileSync(join(PACKAGE_DIR, name), 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (/^from _KBEngine_/.test(line)) {
          violations.push(`KBEngine/${name}:${index + 1}: ${line}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
