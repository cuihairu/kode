//! 手写参数解析(验收面的 CLI 形状;零第三方依赖)。

use std::collections::BTreeMap;

/// 解析后的参数:`--opt value` / `--opt=value` 进 `options`(可重复选项
/// 按 key 聚合为多值),孤立 `--flag` 进 `flags`,其余为位置参数。
#[derive(Debug, Default)]
pub struct Args {
    pub positionals: Vec<String>,
    options: BTreeMap<String, Vec<String>>,
    flags: Vec<String>,
}

impl Args {
    pub fn opt(&self, key: &str) -> Option<&str> {
        self.options
            .get(key)
            .and_then(|v| v.last())
            .map(String::as_str)
    }

    pub fn opt_all(&self, key: &str) -> Vec<&str> {
        self.options
            .get(key)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default()
    }

    pub fn has_flag(&self, key: &str) -> bool {
        self.flags.iter().any(|f| f == key)
    }

    fn insert(&mut self, key: String, value: String) {
        self.options.entry(key).or_default().push(value);
    }
}

/// 子命令树(验收原文逐条)。
#[derive(Debug)]
pub enum Command {
    /// `schema validate --project <dir> [--defaults <xml>]`
    SchemaValidate {
        project: String,
        defaults: Option<String>,
    },
    /// `schema build --project <dir> [--defaults <xml>] [--out <file>]`
    SchemaBuild {
        project: String,
        defaults: Option<String>,
        out: Option<String>,
    },
    /// `schema diff --old <schema.json> --new <schema.json>`
    SchemaDiff { old: String, new: String },
    /// `schema inspect --schema <schema.json> [--message <name>]
    ///  [--message-id <n>] [--entity <name>]`
    SchemaInspect {
        schema: String,
        message: Option<String>,
        message_id: Option<u16>,
        entity: Option<String>,
    },
    /// `decode --hex <hex> [--defaults <xml>] [--flow loginapp|baseapp]
    ///  [--direction c2s|s2c]`
    Decode {
        hex: String,
        defaults: Option<String>,
        flow: String,
        direction: String,
    },
    /// `capture analyze (--pcap <file|-> | --raw-flow <flow[.dir]>=<hex>)...
    ///  [--tshark <bin>] [--flow-map <flow>=<sport>,...] [--defaults <xml>]
    ///  [--records <file>]`
    CaptureAnalyze {
        pcap: Option<String>,
        tshark: String,
        flow_map: Vec<(String, u16)>,
        raw_flows: Vec<(String, String)>,
        defaults: Option<String>,
        records_out: Option<String>,
    },
    /// `analyze --records <file|->`:PA-005 分析引擎(记录 JSON → 报告 JSON)。
    Analyze { records: String },
}

/// 退出码约定:0 成功;1 语义失败(validate 不过 / diff 不兼容 / 选择器未命中);
/// 2 用法错误。
#[derive(Debug)]
pub struct Parsed {
    pub command: Command,
    /// 解析失败时的用法/错误文案(stderr)。
    pub usage_error: Option<String>,
}

pub fn parse_args(args: &[String]) -> Parsed {
    if args.is_empty() {
        return Parsed {
            command: no_op_command(),
            usage_error: Some(USAGE.to_string()),
        };
    }
    let mut parsed = Args::default();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(rest) = a.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                parsed.insert(k.to_string(), v.to_string());
            } else if (i + 1) < args.len() && !args[i + 1].starts_with("--") {
                parsed.insert(rest.to_string(), args[i + 1].clone());
                i += 1;
            } else {
                parsed.flags.push(rest.to_string());
            }
        } else {
            parsed.positionals.push(a.clone());
        }
        i += 1;
    }
    let usage_error = |msg: String| Parsed {
        command: no_op_command(),
        usage_error: Some(msg),
    };

    let pos0 = parsed.positionals.first().map(String::as_str);
    match pos0 {
        Some("schema") => {
            let sub = parsed.positionals.get(1).map(String::as_str);
            match sub {
                Some("validate") => match parsed.opt("project") {
                    Some(p) => Parsed {
                        command: Command::SchemaValidate {
                            project: p.to_string(),
                            defaults: parsed.opt("defaults").map(String::from),
                        },
                        usage_error: None,
                    },
                    None => usage_error("schema validate requires --project <dir>".into()),
                },
                Some("build") => match parsed.opt("project") {
                    Some(p) => Parsed {
                        command: Command::SchemaBuild {
                            project: p.to_string(),
                            defaults: parsed.opt("defaults").map(String::from),
                            out: parsed.opt("out").map(String::from),
                        },
                        usage_error: None,
                    },
                    None => usage_error("schema build requires --project <dir>".into()),
                },
                Some("diff") => match (parsed.opt("old"), parsed.opt("new")) {
                    (Some(o), Some(n)) => Parsed {
                        command: Command::SchemaDiff {
                            old: o.to_string(),
                            new: n.to_string(),
                        },
                        usage_error: None,
                    },
                    _ => usage_error("schema diff requires --old <a.json> --new <b.json>".into()),
                },
                Some("inspect") => match parsed.opt("schema") {
                    Some(s) => {
                        let message_id =
                            parsed.opt("message-id").and_then(|v| v.parse::<u16>().ok());
                        if parsed.opt("message-id").is_some() && message_id.is_none() {
                            return usage_error("--message-id expects a u16".into());
                        }
                        Parsed {
                            command: Command::SchemaInspect {
                                schema: s.to_string(),
                                message: parsed.opt("message").map(String::from),
                                message_id,
                                entity: parsed.opt("entity").map(String::from),
                            },
                            usage_error: None,
                        }
                    }
                    None => usage_error("schema inspect requires --schema <file.json>".into()),
                },
                _ => usage_error("schema subcommands: validate | build | diff | inspect".into()),
            }
        }
        Some("decode") => match parsed.opt("hex") {
            Some(h) => Parsed {
                command: Command::Decode {
                    hex: h.to_string(),
                    defaults: parsed.opt("defaults").map(String::from),
                    flow: parsed.opt("flow").unwrap_or("loginapp").to_string(),
                    direction: parsed.opt("direction").unwrap_or("c2s").to_string(),
                },
                usage_error: None,
            },
            None => usage_error("decode requires --hex <hexbytes>".into()),
        },
        Some("capture") => {
            if parsed.positionals.get(1).map(String::as_str) != Some("analyze") {
                return usage_error("capture subcommands: analyze".into());
            }
            let pcap = parsed.opt("pcap").map(String::from);
            let raw_flows: Vec<(String, String)> = parsed
                .opt_all("raw-flow")
                .into_iter()
                .filter_map(|rf| {
                    rf.split_once('=')
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                })
                .collect();
            if pcap.is_none() && raw_flows.is_empty() {
                return usage_error(
                    "capture analyze requires --pcap <file|-> or at least one --raw-flow".into(),
                );
            }
            let mut flow_map = Vec::new();
            for fm in parsed.opt_all("flow-map") {
                for pair in fm.split(',') {
                    let Some((k, v)) = pair.split_once('=') else {
                        return usage_error(format!("bad --flow-map entry: {pair}"));
                    };
                    match v.parse::<u16>() {
                        Ok(port) => flow_map.push((k.to_string(), port)),
                        Err(_) => return usage_error(format!("bad port in --flow-map: {v}")),
                    }
                }
            }
            if pcap.is_some() && flow_map.is_empty() {
                return usage_error(
                    "pcap mode requires --flow-map loginapp=<sport>[,baseapp=<sport>] \
                     (direction/flow attribution needs the server ports)"
                        .into(),
                );
            }
            Parsed {
                command: Command::CaptureAnalyze {
                    pcap,
                    tshark: parsed.opt("tshark").unwrap_or("tshark").to_string(),
                    flow_map,
                    raw_flows,
                    defaults: parsed.opt("defaults").map(String::from),
                    records_out: parsed.opt("records").map(String::from),
                },
                usage_error: None,
            }
        }
        Some("analyze") => match parsed.opt("records") {
            Some(r) => Parsed {
                command: Command::Analyze {
                    records: r.to_string(),
                },
                usage_error: None,
            },
            None => usage_error("analyze requires --records <records.json|->".into()),
        },
        _ => usage_error(format!("unknown command: {}", args[0])),
    }
}

fn no_op_command() -> Command {
    Command::SchemaValidate {
        project: String::new(),
        defaults: None,
    }
}

pub const USAGE: &str = "\
kode-kbengine - KBEngine wire-protocol CLI (todo PA-004)

USAGE:
  kode-kbengine schema validate --project <dir> [--defaults <messages_fixed_defaults.xml>]
  kode-kbengine schema build   --project <dir> [--defaults <xml>] [--out <schema.json>]
  kode-kbengine schema diff    --old <schema.json> --new <schema.json>
  kode-kbengine schema inspect --schema <schema.json> [--message <name>]
                               [--message-id <n>] [--entity <name>]
  kode-kbengine decode --hex <hex> [--defaults <xml>] [--flow loginapp|baseapp]
                       [--direction c2s|s2c]
  kode-kbengine capture analyze (--pcap <file|-> | --raw-flow <flow[.down]>=<hex>)...
                     [--tshark <bin>] [--flow-map loginapp=<sport>[,baseapp=<sport>]]
                     [--defaults <xml>] [--records <records.json>]

  kode-kbengine analyze --records <records.json|->

EXIT CODES: 0 ok; 1 semantic failure (validate/diff/inspect miss); 2 usage error.
";
