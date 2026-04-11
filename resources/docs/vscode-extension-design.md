# KBEngine VSCode 插件设计方案

## 一、插件概述

### 1.1 项目名称
**KBEngine Language Extension** (KBEngine 语言支持扩展)

### 1.2 目标用户
- KBEngine 游戏服务器开发者
- 使用 KBEngine 进行 MMO 开发的团队
- 需要维护 KBEngine 项目的技术人员

### 1.3 核心价值
- ✅ 提供 .def 文件的完整语法支持
- ✅ 实现实体定义的智能提示和跳转
- ✅ 实时语法检查和错误提示
- ✅ 集成 KBEngine 官方文档
- ✅ 提供代码片段和模板
- ✅ 实体依赖关系可视化

---

## 二、.def 文件语法分析

### 2.1 文件结构
```xml
<root>
    <!-- 属性定义 -->
    <Properties>
        <PropertyName>
            <Type> TYPE_NAME </Type>
            <Flags> FLAG_LIST </Flags>
            <Default> DEFAULT_VALUE </Default>
            <Database> DATABASE_LENGTH </Database>
            <DetailLevel> LEVEL </DetailLevel>
            <Identifier> ID </Identifier>
        </PropertyName>
    </Properties>

    <!-- 客户端方法 -->
    <ClientMethods>
        <MethodName>
            <Arg> TYPE </Arg>
            <!-- 可以有多个 Arg -->
        </MethodName>
    </ClientMethods>

    <!-- BaseApp 方法 -->
    <BaseMethods>
        <MethodName>
            <Arg> TYPE </Arg>
        </MethodName>
    </BaseMethods>

    <!-- CellApp 方法 -->
    <CellMethods>
        <MethodName>
            <Arg> TYPE </Arg>
        </MethodName>
    </CellMethods>
</root>
```

### 2.2 支持的数据类型
```xml
<!-- 基础类型 -->
UINT8, UINT16, UINT32, UINT64
INT8, INT16, INT32, INT64
FLOAT, DOUBLE
BOOL, STRING
VECTOR2, VECTOR3, VECTOR4
ENTITYCALL

<!-- 容器类型 -->
ARRAY<TYPE>
FIXED_DICT
    <implementedBy>
        <Type> PythonClass </Type>
    </implementedBy>
    <Properties>
        <PropName>
            <Type> TYPE </Type>
        </PropName>
    </Properties>
</FIXED_DICT>

TUPLE
    <Type> TYPE1 </Type>
    <Type> TYPE2 </Type>
</TUPLE>
```

### 2.3 支持的 Flags
```
<!-- 基础标志 -->
BASE           - 仅 Base
CELL_PUBLIC    - CellApp 公开
CELL_PRIVATE   - CellApp 私有
ALL_CLIENTS    - 所有客户端可见
OWN_CLIENT     - 仅拥有者客户端可见
BASE_AND_CLIENT - Base 与客户端

<!-- 组合标志（常用） -->
CELL           = CELL_PUBLIC
CELL_AND_CLIENT = CELL_PUBLIC_AND_OWN
```

### 2.4 entities.xml 格式
```xml
<root>
    <Account hasClient="true"></Account>
    <Avatar hasCell="true" hasBase="true" hasClient="true"></Avatar>
    <Monster hasCell="true"></Monster>
</root>
```

---

## 三、插件功能设计

### 3.1 核心功能模块

#### 3.1.1 语法高亮 (Syntax Highlighting)
**实现方式**: TextMate 语法规则

**需要高亮的关键词**:
- XML 标签: `<Properties>`, `<ClientMethods>`, `<BaseMethods>`, `<CellMethods>`
- 类型名称: `UINT8`, `STRING`, `VECTOR3`, `ARRAY`, `FIXED_DICT`, `TUPLE`
- Flags 标志: `BASE_AND_CLIENT`, `CELL_PUBLIC`, `ALL_CLIENTS`
- 特殊标签: `<Type>`, `<Flags>`, `<Default>`, `<DatabaseLength>`, `<Identifier>`, `<DetailLevel>`

**颜色方案建议**:
```json
{
  "keyword.control.xml.kbengine": "#569CD6",  // 蓝色 - XML 标签
  "support.type.primitive.kbengine": "#4EC9B0",  // 青色 - 基础类型
  "support.type.container.kbengine": "#DCDCAA",  // 黄色 - 容器类型
  "constant.other.flag.kbengine": "#CE9178",  // 橙色 - Flags
  "entity.name.function.method.kbengine": "#DCDCAA",  // 黄色 - 方法名
  "entity.name.property.kbengine": "#9CDCFE"  // 浅蓝 - 属性名
}
```

#### 3.1.2 智能提示 (IntelliSense)

**触发场景**:
1. 输入 `<` 时提示可用标签
2. 在 `<Type>` 内提示所有类型
3. 在 `<Flags>` 内提示所有 Flags
4. 在 `<Arg>` 内提示所有类型
5. 输入 `.` 在 FIXED_DICT 中提示属性

**提示内容**:
```typescript
// 类型提示
const types = [
  // 基础类型
  { label: 'UINT8', detail: '无符号8位整数', documentation: '范围: 0-255' },
  { label: 'UINT16', detail: '无符号16位整数', documentation: '范围: 0-65535' },
  { label: 'UINT32', detail: '无符号32位整数', documentation: '范围: 0-4294967295' },
  { label: 'STRING', detail: '字符串', documentation: '变长字符串' },
  { label: 'VECTOR3', detail: '3D向量', documentation: '包含 x, y, z 三个浮点数' },
  // 容器类型
  { label: 'ARRAY', detail: '数组', documentation: '动态数组类型' },
  { label: 'FIXED_DICT', detail: '固定字典', documentation: '类Python字典结构' },
  { label: 'TUPLE', detail: '元组', documentation: '固定长度元组' }
];

// Flags 提示
const flags = [
  { label: 'BASE_AND_CLIENT', detail: 'Base 与客户端', documentation: '对应源码中的 BASE_AND_CLIENT' },
  { label: 'CELL_PUBLIC', detail: 'CellApp公开', documentation: '其他实体可访问' },
  { label: 'ALL_CLIENTS', detail: '所有客户端可见', documentation: '广播给所有客户端' },
  { label: 'OWN_CLIENT', detail: '仅拥有者可见', documentation: '仅控制该实体的客户端可见' }
];
```

#### 3.1.3 跳转定义 (Go to Definition)

**支持跳转的场景**:
1. 从 Python 脚本中的实体类跳转到 .def 文件
2. 从 Python 脚本中的属性访问跳转到 .def 文件中的定义
3. 从 entities.xml 中的实体名跳转到对应的 .def 文件

**实现逻辑**:
```typescript
// 示例：从 Python 跳转到 .def
// Python: self.position (在 Avatar.py 中)
// 跳转到: entity_defs/Avatar.def -> <Position>

function findDefinition(document: TextDocument, position: Position): Definition {
  const text = document.getText();
  const entityType = extractEntityType(text);  // 从文件名或类名提取
  const propertyOrMethod = extractAtPosition(text, position);

  // 查找对应的 .def 文件
  const defFile = findEntityDef(entityType);

  // 定位到具体的属性或方法
  const defPosition = findInDefFile(defFile, propertyOrMethod);

  return new Location(defFile, defPosition);
}
```

#### 3.1.4 语法检查 (Diagnostics)

**检查项目**:
1. ✅ XML 结构合法性
2. ✅ 类型名称拼写检查
3. ⚠️ 仅检查源码可证实的 Flags 名称
4. ✅ 属性名重复检查
5. ✅ 方法名重复检查
6. ❌ 默认值类型严格匹配
7. ✅ 实体引用存在性检查（entities.xml）

**错误示例**:
```typescript
// 类型拼写错误
<WrongType>  // Error: 未知类型 'WrongType'

// Flags 组合错误
<Flags> BASE_CLIENT CELL_PUBLIC </Flags>  // 旧设计示意，当前已不作为源码事实

// 默认值类型不匹配
<Level>
    <Type> UINT32 </Type>
    <Default> "abc" </Default>  // Error: 默认值类型应该是整数
</Level>

// 属性名重复
<Properties>
    <Name> ... </Name>
    <Name> ... </Name>  // Error: 属性 'Name' 重复定义
</Properties>
```

#### 3.1.5 代码片段 (Snippets)

**提供的代码片段**:
```json
{
  "KBEngine Property Basic": {
    "prefix": "kbe-prop",
    "description": "KBEngine 基础属性定义",
    "body": [
      "<${1:PropertyName}>",
      "\t<Type> ${2|UINT8,UINT16,UINT32,UINT64,INT8,INT16,INT32,INT64,FLOAT,DOUBLE,BOOL,STRING,VECTOR3|} </Type>",
      "\t<Flags> ${3|BASE_AND_CLIENT,CELL_PUBLIC,CELL_PRIVATE,ALL_CLIENTS,OWN_CLIENT|} </Flags>",
      "\t<Default> ${4:0} </Default>",
      "</${1:PropertyName}>"
    ]
  },
  "KBEngine Array Property": {
    "prefix": "kbe-array",
    "description": "KBEngine 数组属性",
    "body": [
      "<${1:PropertyName}>",
      "\t<Type>",
      "\t\tARRAY<${2|UINT8,UINT16,UINT32,UINT64,INT8,INT16,INT32,INT64,FLOAT,DOUBLE,BOOL,STRING,VECTOR3|}>",
      "\t</Type>",
      "\t<Flags> ${3|BASE_AND_CLIENT,CELL_PUBLIC|} </Flags>",
      "\t<Default> </Default>",
      "</${1:PropertyName}>"
    ]
  },
  "KBEngine FIXED_DICT Property": {
    "prefix": "kbe-dict",
    "description": "KBEngine 固定字典属性",
    "body": [
      "<${1:PropertyName}>",
      "\t<Type>",
      "\t\t<FIXED_DICT>",
      "\t\t\t<implementedBy>",
      "\t\t\t\t<Type> ${2:PythonClassName} </Type>",
      "\t\t\t</implementedBy>",
      "\t\t\t<Properties>",
      "\t\t\t\t${3:<!-- 添加字典属性 -->}",
      "\t\t\t</Properties>",
      "\t\t</FIXED_DICT>",
      "\t</Type>",
      "\t<Flags> BASE_AND_CLIENT </Flags>",
      "\t<Default> </Default>",
      "</${1:PropertyName}>"
    ]
  },
  "KBEngine Base Method": {
    "prefix": "kbe-base-method",
    "description": "KBEngine BaseApp 方法定义",
    "body": [
      "<${1:methodName}>",
      "\t<Arg> ${2|UINT8,UINT16,UINT32,UINT64,STRING,VECTOR3|} </Arg>",
      "</${1:methodName}>"
    ]
  },
  "KBEngine Cell Method": {
    "prefix": "kbe-cell-method",
    "description": "KBEngine CellApp 方法定义",
    "body": [
      "<${1:methodName}>",
      "\t<Arg> ${2|UINT8,UINT16,UINT32,UINT64,STRING,VECTOR3|} </Arg>",
      "</${1:methodName}>"
    ]
  }
}
```

#### 3.1.6 实体依赖关系图

**功能**:
- 解析 entities.xml
- 解析所有 .def 文件
- 构建实体继承关系
- 构建实体引用关系（ENTITY_COMPONENT）
- 可视化展示

**实现方式**: 使用 Graphviz 或 Mermaid
```typescript
interface EntityRelation {
  name: string;
  hasCell: boolean;
  hasBase: boolean;
  hasClient: boolean;
  components: string[];  // ENTITY_COMPONENT 引用的实体
  references: string[];  // ENTITYCALL / 容器中的实体引用
}

function generateGraph(entities: EntityRelation[]): string {
  // 生成 Mermaid 图表
  let graph = 'graph TD;\n';

  entities.forEach(entity => {
    graph += `  ${entity.name}[${entity.name}];\n`;

    entity.components.forEach(comp => {
      graph += `  ${entity.name} -->|component| ${comp};\n`;
    });

    entity.references.forEach(ref => {
      graph += `  ${entity.name} -->|ref| ${ref};\n`;
    });
  });

  return graph;
}
```

#### 3.1.7 文档集成 (Documentation)

**功能**:
- 鼠标悬停显示文档
- 集成 KBEngine 官方文档
- 内置常用 API 说明
- 钩子函数快速查询

**实现**:
```typescript
function provideHover(document: TextDocument, position: Position): Hover {
  const word = getWordAtPosition(document, position);

  // 类型文档
  if (isKBEType(word)) {
    return {
      contents: getTypeDocumentation(word)
    };
  }

  // Flag 文档
  if (isKBEFlag(word)) {
    return {
      contents: getFlagDocumentation(word)
    };
  }

  // 钩子文档
  if (isKBEHook(word)) {
    return {
      contents: getHookDocumentation(word)
    };
  }

  return null;
}
```

#### 3.1.8 实体浏览器 (Entity Explorer)

**功能**:
- 侧边栏显示所有实体
- 展示实体的属性和方法
- 快速跳转到定义
- 显示实体统计信息

**UI 设计**:
```
┌─────────────────────────────────┐
│ KBEngine Entities               │
├─────────────────────────────────┤
│ 📊 Stats                        │
│   Entities: 15                  │
│   Properties: 234               │
│   Methods: 156                  │
├─────────────────────────────────┤
│ ▼ Account                      │
│   📦 Properties (5)            │
│     name: STRING               │
│     password: STRING           │
│   📞 BaseMethods (3)           │
│     login                      │
│     createAvatar               │
├─────────────────────────────────┤
│ ▼ Avatar                       │
│   📦 Properties (12)           │
│     position: VECTOR3          │
│     level: UINT32              │
│   📞 CellMethods (8)           │
│     move                       │
│     attack                     │
└─────────────────────────────────┘
```

---

## 四、技术实现

### 4.1 技术栈
```
- 语言: TypeScript
- 运行时: Node.js
- 框架: VS Code Extension API
- 解析器: XML2JS / Fast XML Parser
- 测试: Mocha + Chai
```

### 4.2 项目结构
```
vscode-kbengine/
├── src/
│   ├── extension.ts              # 主入口
│   ├── kbengine/
│   │   ├── parser.ts             # .def 文件解析器
│   │   ├── entities.ts           # entities.xml 解析器
│   │   ├── types.ts              # 类型定义
│   │   ├── diagnostics.ts        # 诊断检查
│   │   ├── hover.ts              # 悬停文档
│   │   ├── completion.ts         # 智能提示
│   │   ├── definition.ts         # 跳转定义
│   │   └── symbols.ts            # 符号解析
│   ├── views/
│   │   └── entityExplorer.ts     # 实体浏览器视图
│   └── test/
│       ├── parser.test.ts
│       ├── diagnostics.test.ts
│       └── completion.test.ts
├── syntaxes/
│   └── kbengine.tmLanguage.json  # TextMate 语法文件
├── snippets/
│   └── kbengine.json             # 代码片段
├── resources/
│   └── docs/                     # 内置文档
├── package.json
├── tsconfig.json
└── README.md
```

### 4.3 核心代码实现

#### 4.3.1 .def 文件解析器
```typescript
// parser.ts
import XMLParser from 'fast-xml-parser';

interface PropertyDef {
  name: string;
  type: string;
  flags: string[];
  default?: any;
  database?: number;
  identifier?: number;
  detailLevel?: string;
}

interface MethodDef {
  name: string;
  args: string[];
  type: 'client' | 'base' | 'cell';
}

interface EntityDef {
  name: string;
  hasCell: boolean;
  hasBase: boolean;
  hasClient: boolean;
  properties: Map<string, PropertyDef>;
  clientMethods: Map<string, MethodDef>;
  baseMethods: Map<string, MethodDef>;
  cellMethods: Map<string, MethodDef>;
}

export class KBEngineDefParser {
  async parse(filePath: string): Promise<EntityDef> {
    const content = await readFile(filePath);
    const xml = XMLParser.parse(content);

    const entity: EntityDef = {
      name: basename(filePath, '.def'),
      hasCell: false,
      hasBase: false,
      hasClient: false,
      properties: new Map(),
      clientMethods: new Map(),
      baseMethods: new Map(),
      cellMethods: new Map()
    };

    // 解析属性
    if (xml.root?.Properties) {
      for (const [name, prop] of Object.entries(xml.root.Properties)) {
        entity.properties.set(name, {
          name,
          type: prop.Type,
          flags: prop.Flags?.split(' ') || [],
          default: prop.Default,
          database: prop.Database,
          identifier: prop.Identifier,
          detailLevel: prop.DetailLevel
        });
      }
    }

    // 解析方法
    if (xml.root?.ClientMethods) {
      for (const [name, method] of Object.entries(xml.root.ClientMethods)) {
        entity.clientMethods.set(name, {
          name,
          args: method.Arg ? [method.Arg].flat() : [],
          type: 'client'
        });
      }
    }

    return entity;
  }
}
```

#### 4.3.2 智能提示提供者
```typescript
// completion.ts
import * as vscode from 'vscode';

export class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const line = document.lineAt(position.line);
    const text = line.text.substring(0, position.character);

    // 在 <Type> 标签内提示类型
    if (text.match(/<Type>\s*$/)) {
      return KBEngineTypes.map(type => ({
        label: type.name,
        detail: type.detail,
        documentation: type.documentation,
        kind: vscode.CompletionItemKind.Class
      }));
    }

    // 在 <Flags> 标签内提示标志
    if (text.match(/<Flags>\s*$/)) {
      return KBEngineFlags.map(flag => ({
        label: flag.name,
        detail: flag.detail,
        documentation: flag.documentation,
        kind: vscode.CompletionItemKind.Enum
      }));
    }

    return items;
  }
}
```

#### 4.3.3 诊断检查器
```typescript
// diagnostics.ts
import * as vscode from 'vscode';

export class KBEngineDiagnostics {
  private diagnostics = vscode.languages.createDiagnosticCollection('kbengine');

  async validateDocument(document: vscode.TextDocument): Promise<void> {
    const diagnostics: vscode.Diagnostic[] = [];
    const entity = await parser.parse(document.uri.fsPath);

    // 检查属性名重复
    const propertyNames = new Set<string>();
    for (const prop of entity.properties.values()) {
      if (propertyNames.has(prop.name)) {
        diagnostics.push(new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `属性 '${prop.name}' 重复定义`,
          vscode.DiagnosticSeverity.Error
        ));
      }
      propertyNames.add(prop.name);
    }

    // 检查类型有效性
    for (const prop of entity.properties.values()) {
      if (!isValidKBEngineType(prop.type)) {
        diagnostics.push(new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `未知类型 '${prop.type}'`,
          vscode.DiagnosticSeverity.Error
        ));
      }
    }

    this.diagnostics.set(document.uri, diagnostics);
  }
}
```

---

## 五、开发计划

### 5.1 MVP 版本 (最小可行产品) - 2 周
- ✅ 基础语法高亮
- ✅ 基础智能提示（类型、Flags）
- ✅ 代码片段
- ✅ 基础文档悬停

### 5.2 V1.0 版本 - 4 周
- ✅ 完整的语法检查
- ✅ 跳转定义功能
- ✅ 实体浏览器
- ✅ entities.xml 验证

### 5.3 V2.0 版本 - 6 周
- ✅ 实体依赖关系图
- ✅ Python 脚本集成（跳转到 .def）
- ✅ 重构支持（重命名属性/方法）
- ✅ 代码生成器（生成 Python 实体类模板）

### 5.4 高级功能
- ✅ 实体性能分析建议
- ✅ 自动优化建议（如推荐使用 FIXED_DICT 替代大 ARRAY）
- ✅ 团队协作功能（共享实体定义文档）
- ✅ KBEngine 版本兼容性检查

---

## 六、发布和维护

### 6.1 发布到 VS Code Marketplace
```bash
# 安装发布工具
npm install -g vsce

# 打包
vsce package

# 发布
vsce publish
```

### 6.2 持续集成
```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: 16
      - run: npm install
      - run: npm test
      - run: npm run compile
```

---

## 七、收益评估

### 7.1 开发效率提升
- 智能提示减少 50% 的查阅文档时间
- 语法检查减少 80% 的运行时错误
- 代码片段减少 60% 的重复输入
- 跳转定义减少 70% 的代码导航时间

### 7.2 代码质量提升
- 实时语法检查保证代码规范性
- 依赖关系可视化帮助架构优化
- 性能建议帮助避免常见陷阱

### 7.3 团队协作
- 统一的代码风格
- 共享的实体文档
- 降低新成员学习成本

---

## 八、参考资源

### 8.1 VS Code 扩展 API
- [官方文档](https://code.visualstudio.com/api)
- [扩展开发指南](https://code.visualstudio.com/api/extension-capabilities/overview)

### 8.2 类似项目参考
- [vscode-python](https://github.com/microsoft/vscode-python)
- [vscode-json](https://github.com/microsoft/vscode-json)
- [XML](https://marketplace.visualstudio.com/items?itemName=DotJoshJohnson.xml)

### 8.3 KBEngine 文档
- [官方文档](https://github.com/kbengine/kbengine)
- 本文档: `KBEngine-Deep-Dive-Complete.md`

---

## 九、下一步行动

如果你决定开发这个插件，建议的步骤：

1. **设置开发环境**
   ```bash
   npm install -g yo generator-code
   yo code
   ```

2. **创建基础项目结构**
   - 选择 TypeScript
   - 添加声明文件

3. **实现 MVP 功能**
   - 语法高亮
   - 基础提示
   - 代码片段

4. **测试和优化**
   - 编写单元测试
   - 邀请团队成员试用
   - 收集反馈

5. **发布和维护**
   - 发布到 Marketplace
   - 持续更新和维护

---

## 附录：配置文件示例

### package.json 关键配置
```json
{
  "name": "vscode-kbengine",
  "displayName": "KBEngine Language Support",
  "description": "KBEngine 实体定义语言支持",
  "version": "0.0.1",
  "engines": {
    "vscode": "^1.60.0"
  },
  "categories": [
    "Programming Languages",
    "Snippets",
    "Linters"
  ],
  "contributes": {
    "languages": [{
      "id": "kbengine-def",
      "aliases": ["KBEngine Def", "kbengine-def"],
      "extensions": [".def"],
      "configuration": "./language-configuration.json"
    }],
    "grammars": [{
      "language": "kbengine-def",
      "scopeName": "source.kbengine-def",
      "path": "./syntaxes/kbengine.tmLanguage.json"
    }],
    "snippets": [{
      "language": "kbengine-def",
      "path": "./snippets/kbengine.json"
    }],
    "viewsContainers": {
      "activitybar": [{
        "id": "kbengine-explorer",
        "title": "KBEngine Explorer",
        "icon": "resources/icon.svg"
      }]
    }
  }
}
```
