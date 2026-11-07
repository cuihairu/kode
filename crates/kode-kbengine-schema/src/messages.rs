//! 固定消息表(messages_fixed_defaults.xml + 项目 messages_fixed.xml)。
//!
//! 引擎口径( PA-001 §5.1,message_handler.cpp:140-229 / fixed_messages.cpp:29-74):
//! - XML 元素名 = `Component::messageName`,子元素 `<id>` = 固定 ID;
//! - `<arg>` 逐条 = 参数内建类型名(本基准 v2.5.10 用 `<arg>`);
//! - 定长推导:`msgLen == 0` 注册时按 `args->dataSize()` 计算;
//!   参数含 std::string 强制降级为变长(message_handler.cpp:201-215);
//! - 引擎对不在固定表的消息在进程启动时增量分配 ID——静态取证无法还原
//!   (PA-001 §5.2),真实连接的完整表来自登录期 onImportClientMessages
//!   动态导入(协议引擎 PA-003 消费),本表只承载固定表段。

use serde::{Deserialize, Serialize};

use kode_parser::xml::{self, NodeData};

use crate::wire::WireType;

/// 消息长度形状(§4.2)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageLength {
    /// 定长:线上**无**长度字段,接收端查表取长。
    Fixed(u32),
    /// 变长:线上带 u16 msgLen(= 载荷字节数,不含 id+len 头);
    /// 载荷 ≥65535 时 u16 写 65535 哨兵 + u32 实长(§4.2-3)。
    Variable,
}

impl MessageLength {
    pub fn is_variable(&self) -> bool {
        matches!(self, MessageLength::Variable)
    }

    /// 定长值(变长返回 None)。
    pub fn fixed_len(&self) -> Option<u32> {
        match self {
            MessageLength::Fixed(n) => Some(*n),
            MessageLength::Variable => None,
        }
    }
}

/// 单条固定表消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageEntry {
    /// `Component::messageName` 原名(XML 元素名,保留 `::`)。
    pub name: String,
    /// 固定 ID(固定表 `<id>`;项目覆盖时为项目值)。
    pub id: u16,
    /// 参数线类型(声明序)。
    pub args: Vec<WireType>,
    pub length: MessageLength,
}

/// 固定消息表(id 升序;含解析诊断)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageTable {
    pub entries: Vec<MessageEntry>,
    /// 解析诊断(表名 + 行内描述;SYNTAX-005 同规:坏输入不失败)。
    pub diagnostics: Vec<String>,
}

impl MessageTable {
    pub fn find(&self, name: &str) -> Option<&MessageEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    pub fn by_id(&self, id: u16) -> Option<&MessageEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

/// 全参数定长 → Some(Σ字节数);任一参数变长/未知 → None(保守可变)。
fn sum_fixed_sizes(args: &[WireType]) -> Option<u32> {
    let mut total: u64 = 0;
    for a in args {
        total = total.checked_add(a.fixed_size()?)?;
    }
    u32::try_from(total).ok()
}

/// 构建固定消息表。
///
/// `defaults_xml` = 引擎 `kbe/res/server/messages_fixed_defaults.xml`;
/// `project_xml` = 项目 `res/server/messages_fixed.xml`(可选;同名消息
/// 覆盖引擎条目,引擎 notFoundError=false 语义)。
pub fn build_message_table(defaults_xml: &str, project_xml: Option<&str>) -> MessageTable {
    let mut table = MessageTable::default();
    parse_fixed_xml(defaults_xml, false, &mut table);
    if let Some(project) = project_xml {
        parse_fixed_xml(project, true, &mut table);
    }
    table.entries.sort_by_key(|e| e.id);
    table
}

fn parse_fixed_xml(text: &str, is_project_override: bool, table: &mut MessageTable) {
    let doc = xml::parse(text, false);
    let root = match doc.root() {
        Some(r) => r,
        None => {
            table
                .diagnostics
                .push("fixed messages XML has no root element".to_string());
            return;
        }
    };
    for child in doc.child_elements(root) {
        let el = doc.element(child);
        let name = el.name.clone();
        let mut id: Option<u64> = None;
        let mut args: Vec<WireType> = Vec::new();
        let mut arg_names: Vec<String> = Vec::new();
        for &sub in &el.children {
            if let NodeData::Element(sub_el) = &doc.nodes[sub].data {
                match sub_el.name.as_str() {
                    "id" => {
                        let raw = doc.element(sub).text(&doc).trim().to_string();
                        match raw.parse::<u64>() {
                            Ok(v) if v <= u16::MAX as u64 => id = Some(v),
                            _ => table
                                .diagnostics
                                .push(format!("{name}: invalid <id> {raw:?} (dropped)")),
                        }
                    }
                    "arg" | "argType" | "Arg" => {
                        let raw = doc.element(sub).text(&doc).trim().to_string();
                        if raw.is_empty() {
                            continue;
                        }
                        arg_names.push(raw.clone());
                        match crate::wire::builtin_wire_type(&raw) {
                            Some(t) => args.push(t),
                            None => {
                                // 未知参数类型:保守变长 + Unresolved 保留,不猜测。
                                args.push(WireType::Unresolved(raw.clone()));
                                table
                                    .diagnostics
                                    .push(format!("{name}: unknown arg type {raw:?}"));
                            }
                        }
                    }
                    // descr/其他子元素不进 IR。
                    _ => {}
                }
            }
        }
        let Some(id) = id else {
            if !is_project_override {
                // 引擎基线里所有条目都带 <id>;缺 id 记诊断不产条目。
                table.diagnostics.push(format!("{name}: missing <id>"));
            }
            continue;
        };
        // 定长推导:全参数定长 → Fixed(Σsize);任一参数变长 → Variable。
        let length = match sum_fixed_sizes(&args) {
            Some(total) => MessageLength::Fixed(total),
            None => MessageLength::Variable,
        };
        let entry = MessageEntry {
            name,
            id: id as u16,
            args,
            length,
        };
        // 项目覆盖:同名替换引擎条目(保留引擎在 `<arg>` 缺失时的原参数)。
        if let Some(slot) = table.entries.iter_mut().find(|e| e.name == entry.name) {
            let args = if entry.args.is_empty() {
                slot.args.clone()
            } else {
                entry.args.clone()
            };
            let length = if entry.args.is_empty() {
                match sum_fixed_sizes(&args) {
                    Some(total) => MessageLength::Fixed(total),
                    None => MessageLength::Variable,
                }
            } else {
                entry.length
            };
            slot.id = entry.id;
            slot.args = args;
            slot.length = length;
        } else {
            table.entries.push(entry);
        }
        let _ = arg_names;
    }
}
