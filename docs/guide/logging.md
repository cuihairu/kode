# 日志查看

Kode 提供了一个面向 KBEngine logger 的日志查看 WebView，用于实时查看、过滤和导出日志。

## 能力概览

- 连接 logger 端口
- 实时接收日志
- 级别过滤
- 组件过滤
- 关键词搜索
- 正则表达式搜索
- 导出日志

## 相关命令

- `kbengine.logs.showViewer`
- `kbengine.logs.connect`
- `kbengine.logs.disconnect`
- `kbengine.logs.clear`
- `kbengine.logs.export`

命令说明见 [命令与面板](./commands.md)。

## 相关配置

### `kbengine.loggerPort`

控制 logger 连接端口，默认 `20022`。

### `kbengine.logAutoConnect`

启动服务器时是否自动连接日志端口。

### `kbengine.maxLogEntries`

控制日志 WebView 最大缓存条数。

如果你发现：

- 面板变卡
- 滚动明显延迟
- 长时间运行后内存增加

可以优先降低这个值。

## 典型流程

### 日常查看

1. 启动 KBEngine 组件
2. 执行 `Show Log Viewer`
3. 连接 logger
4. 使用级别和组件过滤查看问题

### 排查问题

1. 打开日志面板
2. 用关键词定位实体名、组件名或错误片段
3. 必要时启用正则搜索
4. 导出日志用于二次分析

## 导出

日志支持导出为：

- `txt`
- `log`
- `json`

适合：

- 留存问题现场
- 提交给其他同事排查
- 结合脚本做离线分析

## 使用建议

### 团队协作

建议统一 logger 端口配置，避免多人环境里“扩展能开，但日志接不上”。

### 大日志量环境

建议：

- 减少 `kbengine.maxLogEntries`
- 先用组件过滤
- 再叠加关键词搜索

## 当前边界

当前日志能力更偏“查看器”而不是“完整日志分析平台”。

还没有专门做到：

- 保存过滤器预设
- 多会话对比
- 按实体语义自动聚类
