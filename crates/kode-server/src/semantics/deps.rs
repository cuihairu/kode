//! BAS-09 增量依赖边(骨架;接线在对应批次)。
//!
//! 目标(todo.md KSEM-BAS-09):记录 def/types/Python/config 到消费文件的
//! 反向依赖;单文件变更只失效相关项。本文件目前只占模块位,保证
//! [`crate::semantics`] 模块树可编译;实现批次落地时替换。
