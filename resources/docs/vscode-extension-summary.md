# VSCode KBEngine 插件 - 快速开始指南

> 状态标注（2026-10-04）：本文是立项期的脚手架记录，保留当时的工作过程叙述，
> 不代表当前实现。当前功能与配置以 [README](../../README.md) 和
> [docs/guide](../../docs/guide/) 为准；文中已发现并修正的差异：
> `kbe-tuple` 片段从未落地（引擎 TUPLE 类型未注册）、`kbe-fixed-dict`
> 实际位于 `snippets/kbengine-types-xml.json`（types.xml 别名）、
> 「预期效果」一节的效率百分比无测量依据、`KBEngine-Deep-Dive-Complete.md`
> 不在本仓库。

## 已创建的文件

当时创建的 VSCode KBEngine 插件开发框架，包含以下文件：

### 1. 设计文档
**`vscode-extension-design.md`**
- 完整的插件设计方案
- 详细的功能说明
- 技术实现细节
- 开发路线图

### 2. 示例代码文件
立项期示例代码位于工作区草稿目录（未入库）；本仓库的实际代码在根目录
`src/`、`snippets/`、`syntaxes/`，结构见 README「项目结构」一节。

#### 核心文件
```
examples/
├── package.json                    # 扩展配置文件
├── tsconfig.json                   # TypeScript 配置
├── language-configuration.json     # 语言配置
├── extension.ts                    # 主入口文件（完整实现）
├── README.md                       # 开发指南
├── syntaxes/
│   └── kbengine.tmLanguage.json   # 语法高亮规则
└── snippets/
    └── kbengine.json              # 代码片段
```

---

## 5 分钟快速开始

### 步骤 1: 创建扩展项目

```bash
# 安装工具
npm install -g yo generator-code

# 生成项目
yo code

# 选择：
# - New Extension (TypeScript)
# - 项目名: vscode-kbengine
```

### 步骤 2: 替换示例文件

将 `examples/` 目录中的文件复制到你的项目中：

```bash
# 假设你的项目在 ~/vscode-kbengine
cd ~/vscode-kbengine

# 替换配置文件
cp /path/to/examples/package.json ./
cp /path/to/examples/tsconfig.json ./
cp /path/to/examples/language-configuration.json ./

# 复制源代码
mkdir -p src syntaxes snippets
cp /path/to/examples/extension.ts ./src/
cp /path/to/examples/syntaxes/* ./syntaxes/
cp /path/to/examples/snippets/* ./snippets/
```

### 步骤 3: 安装依赖和编译

```bash
npm install
npm run compile
```

### 步骤 4: 调试运行

```bash
# 在 VS Code 中打开项目
code .

# 按 F5 启动调试
# 会打开一个新的 VS Code 窗口
```

### 步骤 5: 测试功能

在新窗口中创建一个 `.def` 文件：

```xml
<root>
    <Properties>
        <Level>
            <Type> UINT32 </Type>
            <Flags> BASE_AND_CLIENT </Flags>
            <Default> 1 </Default>
        </Level>
    </Properties>
</root>
```

测试以下功能：
- [输入 `<Type>` 然后空格，应该看到类型提示]
- [输入 `kbe-prop` 然后 Tab，应该插入属性模板]
- [鼠标悬停在 `UINT32` 上，应该看到类型说明]
- [检查语法高亮是否正确]

---

## 已实现的功能

### 核心功能

| 功能 | 状态 | 说明 |
|------|------|------|
| **语法高亮** | ✅ | 支持 .def 文件的完整语法高亮 |
| **智能提示** | ✅ | 类型、Flags、DetailLevel 自动补全 |
| **代码片段** | ✅ | 17 个常用代码模板 |
| **悬停文档** | ✅ | 类型、Flag 的详细说明 |
| **跳转定义** | ✅ | 从 entities.xml 跳转到 .def |
| **语法检查** | ✅ | 检测未知类型、Flags、DetailLevel、重复定义等源码可证实问题 |
| **实体浏览器** | ✅ | 侧边栏显示所有实体 |

### 支持的类型提示

**基础类型**: `UINT8`, `UINT16`, `UINT32`, `UINT64`, `INT8`, `INT16`, `INT32`, `INT64`, `FLOAT`, `DOUBLE`, `BOOL`, `STRING`, `VECTOR2`, `VECTOR3`, `VECTOR4`, `ENTITYCALL`

**容器类型**: `ARRAY`, `FIXED_DICT`, `TUPLE`

### 支持的 Flags

`BASE`, `BASE_AND_CLIENT`, `CELL_PUBLIC`, `CELL_PRIVATE`, `ALL_CLIENTS`, `OWN_CLIENT`, `CELL_PUBLIC_AND_OWN`, `OTHER_CLIENTS`

### 代码片段

| 前缀 | 说明 |
|------|------|
| `kbe-prop` | 基础属性定义 |
| `kbe-vector3` | VECTOR3 属性 |
| `kbe-array` | 数组属性 |
| `kbe-fixed-dict` | FIXED_DICT 类型别名（位于 `snippets/kbengine-types-xml.json`，供 types.xml 使用；`.def` 内联 FIXED_DICT 引擎不解析） |
| `kbe-prop-db` | 带数据库长度的属性 |
| `kbe-prop-detail` | 带细节级别的属性 |
| `kbe-client-method` | 客户端方法 |
| `kbe-base-method` | BaseApp 方法 |
| `kbe-cell-method` | CellApp 方法 |
| `kbe-method-multi` | 多参数方法 |
| `kbe-comment` | 实体注释 |
| `kbe-entity-reg` | 实体注册 |

---

## 语法高亮效果

插件支持以下语法元素的色彩高亮：

```xml
<!-- 关键字 -->
<Properties>      <!-- 蓝色 - 区块标签 -->
<ClientMethods>   <!-- 蓝色 - 区块标签 -->

<!-- 类型 -->
<Type> UINT32 </Type>           <!-- 青色 - 基础类型 -->
<Type> VECTOR3 </Type>          <!-- 青色 - 基础类型 -->
<Type> ARRAY<UINT32> </Type>    <!-- 黄色 - 容器类型 -->

<!-- Flags -->
<Flags> BASE_AND_CLIENT </Flags>    <!-- 橙色 - Flags -->
<Flags> CELL_PUBLIC </Flags>    <!-- 橙色 - Flags -->

<!-- 方法名 -->
<move>                          <!-- 黄色 - 方法名 -->
<attack>                        <!-- 黄色 - 方法名 -->

<!-- 属性名 -->
<Position>                      <!-- 浅蓝 - 属性名 -->
<Level>                         <!-- 浅蓝 - 属性名 -->
```

---

## 自定义和扩展

### 添加新的类型

编辑 `src/extension.ts`：

```typescript
const KBENGINE_TYPES = [
  // ... 现有类型
  {
    name: 'YOUR_TYPE',
    detail: '类型描述',
    documentation: '详细说明'
  }
];
```

### 添加新的代码片段

编辑 `snippets/kbengine.json`：

```json
{
  "Your Custom Snippet": {
    "prefix": "your-prefix",
    "description": "你的代码片段",
    "body": [
      "your code here"
    ]
  }
}
```

### 添加新的语法检查

编辑 `src/extension.ts` 中的 `validateDocument` 函数：

```typescript
// 添加你的检查逻辑
if (someCondition) {
  diagnosticsList.push(new vscode.Diagnostic(
    new vscode.Range(startPos, endPos),
    '错误信息',
    vscode.DiagnosticSeverity.Error
  ));
}
```

---

## 下一步建议

### MVP 完善后，可以添加：

1. **Python 集成**
   - 从 Python 脚本跳转到 .def 文件
   - Python 实体类的智能提示
   - 属性和方法的路由检查

2. **高级功能**
   - 实体依赖关系图
   - 重构支持（重命名属性/方法）
   - 代码生成器（生成 Python 实体类模板）

3. **可视化工具**
   - 实体关系图
   - 属性同步流程图
   - 性能分析报告

4. **团队协作**
   - 共享实体定义文档
   - 版本兼容性检查
   - 代码审查工具

---

## 调试技巧

### 查看日志

```typescript
// 在 extension.ts 中添加日志
console.log('Debug info:', data);
```

然后在扩展开发主机的 "开发工具" 中查看。

### 使用断点

1. 在 `extension.ts` 中设置断点
2. 按 F5 启动调试
3. 断点会自动触发

### 查看诊断信息

```typescript
// 输出所有诊断信息
diagnostics.forEach(d => {
  console.log(d.message, d.range);
});
```

---

## 参考资料

### 官方文档
- [VS Code 扩展 API](https://code.visualstudio.com/api)
- [语法高亮指南](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)
- [智能提示指南](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)

### KBEngine 文档
- [KBEngine GitHub](https://github.com/kbengine/kbengine)

---

## 需要帮助？

如果在开发过程中遇到问题：

1. 查看 `README.md` 中的详细说明
2. 查看 `vscode-extension-design.md` 中的设计文档
3. 参考 VS Code 官方文档
4. 查看 KBEngine 官方仓库了解引擎架构

---

**祝你开发顺利！** 🎉

有任何问题随时联系我！
