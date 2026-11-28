# kode 代码规范补充(用户令 2026-11-28): f-string

## 规则
Python demo 代码（templates/assets/scripts/）字符串格式化**一律使用 f-string**：
- 新代码：只用 `f'...'`
- 旧代码：改动到哪个文件，就把该文件内的 percent-formatting（`% ()`）就地转 f-string
  （不专项扫全仓，随改随转）

## 基线（2026-11-28 盘点）
base/ + common/ 共 **83 处 percent 拼接**，0 处 f-string。

## 验收
- 新增/改动文件的 diff 中不出现新增的 percent-formatting
- 转换不改变行为（等价替换：`%s`→`{}`、`%d`→`{:d}`、字典键访问照搬）
