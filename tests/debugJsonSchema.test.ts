import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  KBENGINE_DEBUG_JSON_FILE_MATCH,
  buildKbengineDebugJsonSchema,
  kbengineDebugJsonSchema
} from '../src/debugJsonSchema';
import {
  HTTP_METHODS,
  QUICK_ACTION_TYPES,
  parseQuickActionConfigs
} from '../src/quickActionConfig';

// 功能差距盘点 G3(docs/reference-feature-gap.md):`.kbengine/debug.json`
// 交给 VS Code 的 JSON 扩展校验(contributes.jsonValidation),配置错误在
// 编辑器里直接标红。清单指向扩展包内 schema 文件;本文件锁死「JSON 文件 ===
// src/debugJsonSchema.ts 构建产物」,且构建产物由 quickActionConfig.ts 的
// 解析口径(HTTP_METHODS 等)驱动。

const root = join(__dirname, '..');

interface PackageJsonShape {
  contributes: {
    jsonValidation?: Array<{
      fileMatch?: string | string[];
      fileMatches?: unknown;
      url?: string;
    }>;
  };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonShape;
const validation = pkg.contributes.jsonValidation ?? [];

describe('清单贡献 contributes.jsonValidation', () => {
  it('只匹配 .kbengine/debug.json(不进 launch.json 等其他 JSON 文件)', () => {
    expect(validation).toHaveLength(1);
    expect(validation[0].fileMatch).toBe(KBENGINE_DEBUG_JSON_FILE_MATCH);
    expect(validation[0].fileMatch).toBe('**/.kbengine/debug.json');
    expect(validation[0].fileMatches).toBeUndefined();
    expect(validation[0].url).toBe('./schemas/kbengine-debug.schema.json');
  });

  it('清单引用的 schema 文件与 src 构建产物一致(双源漂移锁)', () => {
    const schemaPath = join(root, validation[0].url!.replace(/^\.\//, ''));
    expect(JSON.parse(readFileSync(schemaPath, 'utf8'))).toEqual(kbengineDebugJsonSchema);
  });
});

describe('buildKbengineDebugJsonSchema(结构)', () => {
  const schema = kbengineDebugJsonSchema;

  it('构建产物与导出常量同一份对象来源,不是手写第二份', () => {
    expect(buildKbengineDebugJsonSchema()).toEqual(kbengineDebugJsonSchema);
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
  });

  it('顶层 debug/version 必填,debug 段 components 必填', () => {
    expect(schema.required).toEqual(['version', 'debug']);
    expect(schema.properties.version.type).toBe('string');
    const debug = schema.properties.debug;
    expect(debug.required).toEqual(['components']);
    expect(debug.properties.components.type).toBe('object');
  });

  it('元件段字段的类型与调试配置口径一致(端口是整数)', () => {
    // 默认连接信息在 debug 段一级,元件连接信息在每个元件对象里
    expect(schema.properties.debug.properties.defaultTelnetHost.type).toBe('string');
    expect(schema.properties.debug.properties.defaultTelnetPort.type).toBe('integer');
    const component = debugComponentProps(schema);
    expect(component.telnetPort.type).toBe('integer');
    expect(component.telnetHost.type).toBe('string');
    expect(component.telnetPassword.type).toBe('string');
    expect(component.telnetEnableCommands.type).toBe('array');
    expect(component.telnetEnableCommands.items.type).toBe('string');
    expect(component.pathMappings.items.required).toEqual(['localRoot', 'remoteRoot']);
    expect(component.pathMappings.items.properties.localRoot.type).toBe('string');
    expect(component.pathMappings.items.properties.remoteRoot.type).toBe('string');
  });

  it('quickActions 三后端 anyOf,各自必填项与解析器一致', () => {
    const items = schema.properties.quickActions.items;
    expect(items.anyOf).toHaveLength(3);
    const byType: Record<string, Record<string, unknown>> = {};
    for (const branch of items.anyOf as Array<Record<string, unknown>>) {
      byType[(branch.properties as Record<string, Record<string, unknown>>).type.enum[0]] =
        branch as Record<string, unknown>;
    }
    expect(Object.keys(byType).sort()).toEqual([...QUICK_ACTION_TYPES].sort());
    expect(byType.command.required).toEqual(['type', 'command']);
    expect(byType.script.required).toEqual(['type', 'script']);
    expect(byType.http.required).toEqual(['type', 'url']);
    expect(byType.command.properties.args.type).toBe('array');
    expect(byType.command.properties.command.type).toBe('string');
    expect(byType.script.properties.script.type).toBe('string');
    expect(byType.script.properties.venv.type).toBe('object');
    expect(byType.script.properties.venv.required).toEqual(['enabled']);
    expect(byType.script.properties.venv.properties.enabled.type).toBe('boolean');
    expect(byType.http.properties.url.type).toBe('string');
    expect(byType.http.properties.method.enum).toEqual(HTTP_METHODS);
  });
});

/** 从构建产物里取元件对象属性表(避免测试里重复书写键路径) */
function debugComponentProps(
  schema: typeof kbengineDebugJsonSchema
): Record<string, Record<string, unknown>> {
  const debug = schema.properties.debug as {
    properties: {
      components: { additionalProperties: { properties: Record<string, Record<string, unknown>> } };
    };
  };
  return debug.properties.components.additionalProperties.properties;
}

describe('schema 与解析器同源对拍', () => {
  it('schema 枚举的三后端与 HTTP 方法都能被解析器接收', () => {
    const valid: unknown[] = [
      { name: '开服', type: 'command', command: 'echo on', args: ['-x'] },
      { name: '起服', type: 'script', script: '${workspaceFolder}/scripts/start.sh' },
      { name: '热更', type: 'http', url: 'http://127.0.0.1:8888', method: HTTP_METHODS[0] }
    ];
    const { actions, invalidCount } = parseQuickActionConfigs(valid);
    expect(actions).toHaveLength(3);
    expect(invalidCount).toBe(0);
  });

  it('解析器不收的后端名也不在 schema 枚举里(枚举与解析行为同集合)', () => {
    const { invalidCount } = parseQuickActionConfigs([
      { name: '坏', type: 'ftp', url: 'x' }
    ]);
    expect(invalidCount).toBe(1);
    const items = kbengineDebugJsonSchema.properties.quickActions.items;
    const byType = new Map<string, unknown[]>();
    for (const branch of items.anyOf as Array<Record<string, unknown>>) {
      const props = branch.properties as Record<string, { enum: string[] }>;
      byType.set(props.type.enum[0], branch.required);
    }
    expect([...byType.keys()].sort()).toEqual([...QUICK_ACTION_TYPES].sort());
    expect(byType.has('ftp')).toBe(false);
  });
});
