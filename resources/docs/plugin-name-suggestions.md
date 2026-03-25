# VSCode KBEngine 插件 - 命名建议

## 🎯 推荐名称（按优先级排序）

### 第一梯队：简洁专业

| 名称 | 英文全称 | 发布ID | 推荐理由 |
|------|----------|--------|----------|
| **KBE** | **KBEngine Editor** | `kbe-editor` | ⭐ 最简洁，易于记忆 |
| **Kode** | **KBEngine IDE** | `kbengine-ide` | ⭐ IDE 全称，专业感强 |
| **KScript** | **KBEngine Script** | `kbengine-script` | ⭐ 强调脚本开发 |
| **KDef** | **KBEngine Definition** | `kbengine-def` | ⭐ 专注 .def 文件 |

### 第二梯队：功能导向

| 名称 | 英文全称 | 发布ID | 推荐理由 |
|------|----------|--------|----------|
| **EntityForge** | Entity Forge | `entity-forge` | 🎮 游戏开发感，实体锻造 |
| **DefMaster** | Def Master | `def-master` | 🔧 .def 文件专家 |
| **KBELang** | KBEngine Language | `kbengine-lang` | 📝 语言支持明确 |
| **KBESmart** | KBEngine Smart Code | `kbengine-smart` | 💡 智能代码助手 |

### 第三梯队：创意特色

| 名称 | 英文全称 | 发布ID | 推荐理由 |
|------|----------|--------|----------|
| **KWorld** | KBEngine World Builder | `kworld-builder` | 🌍 MMO 世界构建 |
| **GameSmith** | Game Smith for KBEngine | `game-smith` | ⚔️ 游戏锻造师 |
| **CodeForge** | KBEngine Code Forge | `code-forge-kbe` | 🔨 代码锻造 |
| **EntityLab** | Entity Laboratory | `entity-lab` | 🧪 实体实验室 |

### 第四梯队：趣味友好

| 名称 | 英文全称 | 发布ID | 推荐理由 |
|------|----------|--------|----------|
| **KBuddy** | KBEngine Buddy | `kbuddy` | 👋 KBEngine 的小伙伴 |
| **KHelper** | KBEngine Helper | `khelper` | 🤝 开发助手 |
| **DefBuddy** | Definition Buddy | `def-buddy` | 😊 .def 文件的好朋友 |

---

## 🏆 最终推荐

### **方案 A: KBE** (最推荐)
```
名称: KBE
副标题: KBEngine Editor
发布ID: kbe-editor
市场名称: KBE - KBEngine Language Support
```
**理由**:
- ✅ 极简，3个字母
- ✅ KBEngine 官方缩写
- ✅ 易于搜索和记忆
- ✅ 专业感强
- ✅ 类似 Python 的 IDLE，Ruby 的 RStudio

### **方案 B: Kode**
```
名称: Kode
副标题: KBEngine IDE
发布ID: kbengine-ide
市场名称: Kode - KBEngine Development Environment
```
**理由**:
- ✅ IDE 全称，功能明确
- ✅ "Kode" = "KBEngine Code" 的组合
- ✅ 发音好听，朗朗上口
- ✅ 类似 VSCode、JetBrains 等知名 IDE

### **方案 C: EntityForge** (最有创意)
```
名称: EntityForge
副标题: KBEngine Entity Definition Editor
发布ID: entity-forge
市场名称: EntityForge - KBEngine Entity Editor
```
**理由**:
- ✅ 游戏开发氛围浓厚
- ✅ "Forge" 体现打造、构建的意思
- ✅ 专注实体定义，功能明确
- ✅ 易于品牌化

---

## 📦 Package.json 配置示例

### 方案 A: KBE
```json
{
  "name": "kbe-editor",
  "displayName": "KBE - KBEngine Language Support",
  "description": "Complete language support for KBEngine game server framework",
  "publisher": "your-publisher",
  "icon": "icon.png",
  "version": "0.0.1"
}
```

### 方案 B: Kode
```json
{
  "name": "kbengine-ide",
  "displayName": "Kode - KBEngine Development Environment",
  "description": "Powerful IDE features for KBEngine game server development",
  "publisher": "your-publisher",
  "icon": "icon.png",
  "version": "0.0.1"
}
```

### 方案 C: EntityForge
```json
{
  "name": "entity-forge",
  "displayName": "EntityForge - KBEngine Entity Editor",
  "description": "Forge your KBEngine entities with powerful editor features",
  "publisher": "your-publisher",
  "icon": "icon.png",
  "version": "0.0.1"
}
```

---

## 🎨 Logo 设计建议

### KBE Logo
```
┌─────────────┐
│   ▲▲▲       │  三角形代表分布式架构
│  ▲  ▲       │  (Machine, BaseApp, CellApp)
│ ▲ K ▲       │  K 代表 KBEngine
│  ▲  ▲       │  整体呈现稳定结构
│   ▼▼▼       │
└─────────────┘
```
颜色方案:
- 主色: #2563EB (蓝色 - 科技感)
- 辅色: #10B981 (绿色 - 服务器)
- 强调色: #F59E0B (橙色 - 活力)

### Kode Logo
```
┌─────────────┐
│  { K }      │  花括号代表代码/实体定义
│   o o       │  o o 代表实体协作
│   ~~~       │  波浪线代表通信
│  [ODE]      │  完整单词
└─────────────┘
```
颜色方案:
- 主色: #7C3AED (紫色 - 创意)
- 辅色: #EC4899 (粉色 - 活力)
- 强调色: #3B82F6 (蓝色 - 专业)

### EntityForge Logo
```
┌─────────────┐
│  ⚒️ E ⚒️    │  锤子代表锻造
│  ⚙️  ⚙️     │  齿轮代表组件
│  🔩  🔩     │  螺丝代表组装
│  FORGE      │  底部文字
└─────────────┘
```
颜色方案:
- 主色: #EA580C (橙红 - 锻造)
- 辅色: #78716C (灰色 - 金属)
- 强调色: #16A34A (绿色 - 成长)

---

## 🌐 域名和资源

### KBE
- GitHub: `github.com/kbe-editor/vscode-kbe`
- NPM: `@kbe-editor/vscode-kbe`
- 网站: `kbe-editor.dev` (如果需要)
- 文档: `docs.kbe-editor.dev`

### Kode
- GitHub: `github.com/kbengine-ide/vscode-kode`
- NPM: `@kbengine-ide/vscode-kode`
- 网站: `kode.dev` (如果需要)
- 文档: `docs.kode.dev`

### EntityForge
- GitHub: `github.com/entity-forge/vscode-entity-forge`
- NPM: `@entity-forge/vscode-entity-forge`
- 网站: `entityforge.dev` (如果需要)
- 文档: `docs.entityforge.dev`

---

## 📊 市场搜索优化

### 关键词（Tags）
所有方案都应该包含：
```json
"keywords": [
  "kbengine",
  "game-server",
  "mmo",
  "entity",
  "def",
  "python",
  "game-development",
  "distributed-systems",
  "mmorpg",
  "server"
]
```

### 描述模板
```markdown
Complete language support for KBEngine game server framework:

Features:
✅ Syntax highlighting for .def files
✅ IntelliSense for types, flags, and methods
✅ Code snippets for common patterns
✅ Go to definition from entities.xml to .def files
✅ Hover documentation for all KBEngine types
✅ Real-time syntax validation
✅ Entity explorer sidebar

Perfect for:
- KBEngine game server developers
- MMO game development teams
- Anyone working with KBEngine entity definitions
```

---

## 🎯 我的最终推荐

### **🥇 第一选择: KBE**

**理由**:
1. **简洁至上** - 3个字母，极致简洁
2. **官方权威** - 直接使用 KBEngine 官方缩写
3. **易于搜索** - "KBE VSCode" 精准命中
4. **专业感强** - 类似 IDE、VIM 等经典工具
5. **国际化友好** - KBE 是全球通用缩写

**配置**:
```json
{
  "name": "kbe-editor",
  "displayName": "KBE - KBEngine Language Support",
  "description": "Complete language support for KBEngine game server framework with syntax highlighting, IntelliSense, and more"
}
```

---

### **🥈 第二选择: EntityForge**

**理由**:
1. **特色鲜明** - 专注实体定义编辑
2. **游戏氛围** - Forge（锻造）符合游戏开发调性
3. **品牌潜力** - 易于扩展和品牌化
4. **功能明确** - 一看就知道是编辑实体的
5. **有趣味性** - 不枯燥，开发者喜欢

**配置**:
```json
{
  "name": "entity-forge",
  "displayName": "EntityForge - KBEngine Entity Editor",
  "description": "Forge your KBEngine entities with powerful syntax highlighting, IntelliSense, and validation"
}
```

---

### **🥉 第三选择: Kode**

**理由**:
1. **朗朗上口** - "Kode" 发音好听
2. **功能全面** - IDE 暗示完整开发环境
3. **现代感强** - 类似现代开发工具命名
4. **易于扩展** - 未来可以添加更多 IDE 功能

**配置**:
```json
{
  "name": "kbengine-ide",
  "displayName": "Kode - KBEngine Development Environment",
  "description": "Powerful IDE features for KBEngine game server development"
}
```

---

## 💬 你的选择？

根据你的使用场景选择：

- **个人项目/学习** → 选 **KBE** (简单直接)
- **开源贡献** → 选 **KBE** (易于发现)
- **公司项目** → 选 **EntityForge** (品牌化)
- **长期维护** → 选 **Kode** (扩展性强)

你更倾向于哪个？或者需要我根据你的特定需求提供更多建议？
