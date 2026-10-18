/**
 * `.kbengine/debug.json` 的 JSON Schema(功能差距盘点 G3,
 * docs/reference-feature-gap.md):VS Code 的 JSON 扩展按
 * `contributes.jsonValidation` 校验该文件,配置写错在编辑器里直接标红。
 *
 * VS Code 的 jsonValidation 通过 url 加载扩展内的 JSON 文件,因此 schema
 * 存在两处:本模块的构建产物与 schemas/kbengine-debug.schema.json。测试锁定
 * 两者结构一致,枚举一律取自 quickActionConfig.ts 的解析口径(HTTP_METHODS、
 * QUICK_ACTION_TYPES),避免 schema 与解析器各说各话。
 */

import { HTTP_METHODS, QUICK_ACTION_TYPES } from './quickActionConfig';

/** VS Code jsonValidation 的文件匹配(覆盖工作区根与各级子文件夹) */
export const KBENGINE_DEBUG_JSON_FILE_MATCH = '**/.kbengine/debug.json';

interface JsonSchemaObject {
  $schema?: string;
  type?: 'string' | 'object' | 'array' | 'integer' | 'boolean';
  required?: string[];
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: JsonSchemaObject;
  items?: JsonSchemaObject;
  anyOf?: JsonSchemaObject[];
  enum?: string[];
  description?: string;
}

const text = (description: string): JsonSchemaObject => ({
  type: 'string',
  description
});

const integer = (description: string): JsonSchemaObject => ({
  type: 'integer',
  description
});

/** 动作共享字段(schema 与解析器默认值一致:confirm 默认 true、source 默认 manual) */
const ACTION_SHARED_PROPERTIES: Record<string, JsonSchemaObject> = {
  name: text('动作名(必填,展示在动作清单里)'),
  confirm: {
    type: 'boolean',
    description: '执行前是否弹确认;缺省为 true'
  },
  source: {
    type: 'string',
    enum: ['manual', 'scan'],
    description: '动作来源;缺省 manual,首装扫描写入的为 scan'
  },
  category: {
    type: 'string',
    enum: ['server', 'export'],
    description: '动作归类(启停/导表);可省'
  }
};

function actionBranch(
  actionType: string,
  ownProperties: Record<string, JsonSchemaObject>
): JsonSchemaObject {
  return {
    type: 'object',
    required: ['type', Object.keys(ownProperties)[0]],
    properties: {
      ...ACTION_SHARED_PROPERTIES,
      type: { type: 'string', enum: [actionType], description: '执行后端' },
      ...ownProperties
    }
  };
}

const COMMAND_BRANCH = actionBranch(QUICK_ACTION_TYPES[0], {
  command: text('要执行的 VS Code 命令 id'),
  args: {
    type: 'array',
    items: { type: 'string' },
    description: '命令参数;可省(省视为空数组)'
  }
});

const SCRIPT_BRANCH = actionBranch(QUICK_ACTION_TYPES[1], {
  script: text('脚本路径,支持 ${workspaceFolder} 变量'),
  cwd: text('脚本工作目录;可省'),
  venv: {
    type: 'object',
    description: '可选 Python 虚拟环境;启用后将虚拟环境的 bin/Scripts 加入 PATH',
    required: ['enabled'],
    properties: {
      enabled: { type: 'boolean', description: '是否启用 venv;缺省为不启用' },
      path: text('虚拟环境目录;可用 ${workspaceFolder} 变量,省略时自动查找 .venv/venv')
    }
  },
  background: {
    type: 'boolean',
    description: '后台执行不等退出码(启服脚本常用);缺省 false'
  }
});

const HTTP_BRANCH = actionBranch(QUICK_ACTION_TYPES[2], {
  url: text('本地热更新接口地址'),
  method: {
    type: 'string',
    enum: [...HTTP_METHODS],
    description: 'HTTP 方法(执行时统一按大写匹配);缺省 POST'
  },
  body: text('请求体;可省')
});

/** 构建 schema(构建产物即 package.json 内联对象的唯一真源) */
export function buildKbengineDebugJsonSchema(): JsonSchemaObject {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    description: 'kode 的 KBEngine 调试与快速执行动作配置(.kbengine/debug.json)',
    required: ['version', 'debug'],
    properties: {
      version: text('配置版本(模板固定写 "1.0")'),
      debug: {
        type: 'object',
        description: '调试配置段:Start Debugging 提示语与 launch.json 的 pathMappings 来源',
        required: ['components'],
        properties: {
          defaultTelnetHost: text('默认 telnet 主机'),
          defaultTelnetPort: integer('默认 telnet 端口'),
          components: {
            type: 'object',
            description: '按元件名(BotServer / LoginApp / BaseApp / CellApp …)的连接与映射',
            additionalProperties: {
              type: 'object',
              properties: {
                telnetHost: text('元件 telnet 主机'),
                telnetPort: integer('元件 telnet 端口'),
                telnetPassword: text('元件 telnet 密码'),
                telnetDefaultLayer: text('默认层(base/cell/login/account)'),
                telnetEnableCommands: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '允许执行的 telnet 命令白名单'
                },
                pathMappings: {
                  type: 'array',
                  description: '本地/远程路径映射,launch.json 生成用',
                  items: {
                    type: 'object',
                    required: ['localRoot', 'remoteRoot'],
                    properties: {
                      localRoot: text('本地根路径'),
                      remoteRoot: text('远程根路径')
                    }
                  }
                }
              }
            }
          }
        }
      },
      quickActions: {
        type: 'array',
        description: '快速执行动作清单(kbengine.quickActions.show / runDefault 的数据源)',
        items: {
          anyOf: [COMMAND_BRANCH, SCRIPT_BRANCH, HTTP_BRANCH]
        }
      }
    }
  };
}

/** 构建产物(供清单内联对象对拍) */
export const kbengineDebugJsonSchema = buildKbengineDebugJsonSchema();
