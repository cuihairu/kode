//! EXPOSED_AND_CALLER_CHECK 特殊 caller 规则(KSEM-RPC-07)。
//!
//! 引擎把「暴露方法实现是否多一个 callerID 参数」升级为独立暴露类型
//! EXPOSED_AND_CALLER_CHECK(method.h:27-37:EXPOSED=1 可不加调用者参数,
//! =2 第一参数为调用者 ID 供脚本校验来源合法性)。本模块按引擎源码语义
//! 把四个数量的语境分开:
//!
//! - **传输/Python 调用点**(stream 上流与脚本源码调用):恒按 def 声明位,
//!   callerID 不上流(addToStream 按 offset 跳过首位 method.cpp:165-171),
//!   脚本调用方永不传 callerID;
//! - **实现签名**:cellapp 的 cell 段 exposed 方法在 createFromStream 注入
//!   `EntityDef::context().currEntityID` 到元组首位(method.cpp:175-192,
//!   cellapp/entity.cpp:1025 置 srcEntityID 进上下文)——实现位 = 声明位+1;
//!   其余语境(baseapp/client/base/client 段)offset=0,实现位 = 声明位;
//! - **启动对账**(entitydef.cpp:1840-1892):实现位恰多一参且 exposed →
//!   升级 caller-check;其余不合 → ERROR「parameter is incorrect」(:1879);
//! - **劝告**:cell 段 exposed 而实现未带 callerID → 启动 WARNING 建议
//!   `def m(self, callerID, ...)` 形态(:1886-1892),非错误。
//!
//! 数量误报的两向防线:调用点数量**不按实现位比**(callerID 引擎注入,
//! 非调用方所传);实现侧数量**不按声明位比**(注入成立时恰多一参)。
//! [`expected_arity`] 显式暴露两侧数量,消费方按侧取数,不共用一个数。

use super::id::Facet;

/// 实现签名事实(Python 侧,消费方从 `dispatch::PyMethodFacts` 转述)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImplArity {
    /// 实现参数个数(self 除外)。
    pub params: usize,
    /// 实现首参名(仅报告用;引擎判定纯按参数数量,不按名——
    /// hint 文案里的 callerEntityID 只是示例名,method.cpp:246-253)。
    pub first_param: Option<String>,
}

/// caller 契约核查输入(def 侧事实 + 可选实现侧事实)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerFacts {
    /// def 声明所在段。
    pub facet: Facet,
    /// def 是否 exposed。
    pub exposed: bool,
    /// def `<Arg>` 声明位数 = 传输/调用点位数。
    pub declared_args: usize,
    /// Python 实现侧事实;None = 实现未知(类缺/方法缺/文件未解析)。
    pub impl_arity: Option<ImplArity>,
}

/// 数量不合的两种成因(引擎行为不同,消费方措辞不同)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MismatchReason {
    /// 启动即拒:非 exposed 实现+1,或 exposed 实现 ± 非 0/+1
    /// (entitydef.cpp:1879-1885 ERROR「parameter is incorrect」,def 载入失败)。
    StartupRejected,
    /// exposed 实现恰+1 但段不是 cell:启动对账会静默把暴露类型升级为
    /// caller-check 标记(entitydef.cpp:1872-1877 只查 isExposed 不查段),
    /// 但运行时注入条件 `g_componentType == CELLAPP_TYPE && isCell()`
    /// (method.cpp:83/:165/:185)不满足 → 不注入,每次调用 TypeError,
    /// 引擎尾部才提示「try adding callerEntityID」(method.cpp:246-253)。
    /// base/client 段的实现+1 是真缺陷,不是 callerID 合同。
    CallerNeverInjected,
}

/// caller 契约核查结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerCheck {
    /// callerID 注入成立(唯一语境:cell 段 + exposed + 实现恰多一参)。
    /// 实现位 = 声明位+1,首位即 callerID(运行时整数实体 ID,
    /// 脚本惯例 `if callerID == self.id` 自校验来源)。
    CallerInjected {
        declared: usize,
        impl_params: usize,
        /// 实现首参名(报告用,可为 None)。
        first_param: Option<String>,
    },
    /// 数量精确(实现位 = 声明位)。cell 段 exposed 时 `advisory=true`:
    /// 引擎启动 WARNING 劝告补 callerID(entitydef.cpp:1886-1892),
    /// 劝告非错误,方法可达、数量合同成立。
    Exact {
        declared: usize,
        impl_params: usize,
        advisory: bool,
    },
    /// 实现未知——不判实现位数量;传输契约独立成立(声明位数照常可信)。
    ImplUnknown { declared: usize },
    /// 数量不合,按成因分述(见 [`MismatchReason`])。
    CountMismatch {
        declared: usize,
        impl_params: usize,
        reason: MismatchReason,
    },
}

/// 数量按哪一侧取:传输/调用点 or 实现签名。
///
/// 误报防线入口——消费方校验「调用点实参个数」必须取
/// [`AritySide::Transmission`](恒 = 声明位);校验/展示实现签名取
/// [`AritySide::Implementation`]。两侧数值可差一(caller-check),共用
/// 一个数必然出一向误报。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AritySide {
    /// 传输上流与 Python 调用点:callerID 不上流(method.cpp:165-171),
    /// 调用方永不传——恒按 def 声明位。
    Transmission,
    /// 实现签名(引擎注入后的元组形状)。
    Implementation,
}

/// 核查 caller 契约(引擎启动对账 entitydef.cpp:1840-1892 的静态版)。
///
/// 判定次序(逐条对应引擎行为,注释给行号):
/// 1. 实现未知 → `ImplUnknown`(不硬判);
/// 2. 实现位 = 声明位 → `Exact`;cell 段 exposed 附劝告;
/// 3. cell 段 + exposed + 实现位 = 声明位+1 → `CallerInjected`;
/// 4. exposed + 实现位 = 声明位+1 但段非 cell → `CallerNeverInjected`;
/// 5. 其余(非 exposed 的 +1、任何 ± 其它值)→ `StartupRejected`。
pub fn check_caller_contract(facts: &CallerFacts) -> CallerCheck {
    let Some(impl_arity) = &facts.impl_arity else {
        return CallerCheck::ImplUnknown {
            declared: facts.declared_args,
        };
    };

    let declared = facts.declared_args;
    let params = impl_arity.params;

    if params == declared {
        return CallerCheck::Exact {
            declared,
            impl_params: params,
            advisory: facts.facet == Facet::Cell && facts.exposed,
        };
    }

    if params == declared + 1 {
        if facts.facet == Facet::Cell && facts.exposed {
            return CallerCheck::CallerInjected {
                declared,
                impl_params: params,
                first_param: impl_arity.first_param.clone(),
            };
        }
        if facts.exposed {
            // 启动对账仍会升级标记(entitydef.cpp:1872-1877 不查段),
            // 但注入条件(method.cpp:83)永不满足——真缺陷。
            return CallerCheck::CountMismatch {
                declared,
                impl_params: params,
                reason: MismatchReason::CallerNeverInjected,
            };
        }
        // 非 exposed:+1 不享受升级(entitydef.cpp:1872-1877 要求 isExposed)
        // → 启动 ERROR「parameter is incorrect」,def 载入失败。
        return CallerCheck::CountMismatch {
            declared,
            impl_params: params,
            reason: MismatchReason::StartupRejected,
        };
    }

    // 非 exposed 的 +1 与一切其它偏差:启动 ERROR「parameter is incorrect」
    // (entitydef.cpp:1879-1885,升级分支要求 isExposed)。
    CallerCheck::CountMismatch {
        declared,
        impl_params: params,
        reason: MismatchReason::StartupRejected,
    }
}

/// 按侧取期望数量;不可判定侧返回 None(不造数)。
///
/// - Transmission:恒 = 声明位(callerID 不上流、调用点永不传);
/// - Implementation:注入成立 = 声明位+1,数量精确 = 声明位,
///   实现未知/数量不合 = None(前者未知、后者错误面由报告措辞承担,
///   不再产出「期望数」助长误报)。
pub fn expected_arity(check: &CallerCheck, side: AritySide) -> Option<usize> {
    match side {
        AritySide::Transmission => match check {
            CallerCheck::CallerInjected { declared, .. }
            | CallerCheck::Exact { declared, .. }
            | CallerCheck::ImplUnknown { declared }
            | CallerCheck::CountMismatch { declared, .. } => Some(*declared),
        },
        AritySide::Implementation => match check {
            CallerCheck::CallerInjected { declared, .. } => Some(declared + 1),
            CallerCheck::Exact { declared, .. } => Some(*declared),
            CallerCheck::ImplUnknown { .. } | CallerCheck::CountMismatch { .. } => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(facet: Facet, exposed: bool, declared: usize, impl_params: Option<usize>) -> CallerFacts {
        CallerFacts {
            facet,
            exposed,
            declared_args: declared,
            impl_arity: impl_params.map(|p| ImplArity {
                params: p,
                first_param: if p == 0 { None } else { Some("arg0".to_string()) },
            }),
        }
    }

    #[test]
    fn caller_check_cell_exposed_plus_one_is_injected() {
        // 唯一合法语境:cell 段 exposed 实现恰多一参(method.cpp:83)。
        let check = check_caller_contract(&facts(Facet::Cell, true, 2, Some(3)));
        assert_eq!(
            check,
            CallerCheck::CallerInjected {
                declared: 2,
                impl_params: 3,
                first_param: Some("arg0".to_string()),
            }
        );
        // 传输侧 = 声明位;实现侧 = 声明位+1——两侧各取各的。
        assert_eq!(expected_arity(&check, AritySide::Transmission), Some(2));
        assert_eq!(expected_arity(&check, AritySide::Implementation), Some(3));
    }

    #[test]
    fn transmission_side_never_includes_caller() {
        // 注入成立时调用点仍按声明位比:2 个实参合法,3 个反而不合。
        let check = check_caller_contract(&facts(Facet::Cell, true, 2, Some(3)));
        assert_eq!(expected_arity(&check, AritySide::Transmission), Some(2));
        assert_ne!(expected_arity(&check, AritySide::Transmission), Some(3));
    }

    #[test]
    fn cell_exposed_exact_counts_carries_advisory() {
        // cell 段 exposed 但实现未带 callerID:启动 WARNING 劝告
        // (entitydef.cpp:1886-1892),非错误。
        let check = check_caller_contract(&facts(Facet::Cell, true, 1, Some(1)));
        assert_eq!(
            check,
            CallerCheck::Exact {
                declared: 1,
                impl_params: 1,
                advisory: true,
            }
        );
        assert_eq!(expected_arity(&check, AritySide::Implementation), Some(1));
    }

    #[test]
    fn base_and_client_exact_no_advisory() {
        // 劝告只给 cell 段 exposed;base/client 段实现=声明位无话可说。
        for facet in [Facet::Base, Facet::Client] {
            let check = check_caller_contract(&facts(facet, true, 2, Some(2)));
            assert_eq!(
                check,
                CallerCheck::Exact {
                    declared: 2,
                    impl_params: 2,
                    advisory: false,
                },
                "{facet:?}"
            );
        }
    }

    #[test]
    fn non_cell_exposed_plus_one_never_gets_injection() {
        // base/client 段 exposed 实现+1:启动静默升级标记
        // (entitydef.cpp:1872-1877 只查 isExposed),但注入条件
        // (method.cpp:83 CELLAPP && isCell)永不满足——运行时必 TypeError。
        for facet in [Facet::Base, Facet::Client] {
            let check = check_caller_contract(&facts(facet, true, 2, Some(3)));
            assert_eq!(
                check,
                CallerCheck::CountMismatch {
                    declared: 2,
                    impl_params: 3,
                    reason: MismatchReason::CallerNeverInjected,
                },
                "{facet:?}"
            );
            // 错误面不再产「期望数」。
            assert_eq!(expected_arity(&check, AritySide::Implementation), None);
        }
    }

    #[test]
    fn non_exposed_plus_one_is_startup_rejected() {
        // 非 exposed 实现+1:升级分支要求 isExposed
        // (entitydef.cpp:1872-1877),落 ERROR「parameter is incorrect」。
        let check = check_caller_contract(&facts(Facet::Cell, false, 1, Some(2)));
        assert_eq!(
            check,
            CallerCheck::CountMismatch {
                declared: 1,
                impl_params: 2,
                reason: MismatchReason::StartupRejected,
            }
        );
    }

    #[test]
    fn other_arity_drift_is_startup_rejected() {
        // exposed 但实现 ± 非 0/+1(多二/少一)同样启动即拒。
        for delta in [-1i64, 2, -2] {
            let declared = 3usize;
            let params = (declared as i64 + delta) as usize;
            let check = check_caller_contract(&facts(Facet::Cell, true, declared, Some(params)));
            assert_eq!(
                check,
                CallerCheck::CountMismatch {
                    declared,
                    impl_params: params,
                    reason: MismatchReason::StartupRejected,
                },
                "delta={delta}"
            );
        }
    }

    #[test]
    fn unknown_impl_keeps_wire_contract() {
        // 实现未知不判实现位;传输契约独立成立(声明位照常可信)。
        let check = check_caller_contract(&facts(Facet::Cell, true, 4, None));
        assert_eq!(check, CallerCheck::ImplUnknown { declared: 4 });
        assert_eq!(expected_arity(&check, AritySide::Transmission), Some(4));
        assert_eq!(expected_arity(&check, AritySide::Implementation), None);
    }

    #[test]
    fn zero_arg_cell_exposed_without_caller_still_advised() {
        // 无参 cell exposed 实现 self() 也吃劝告(与参数无关,只看段+暴露)。
        let check = check_caller_contract(&facts(Facet::Cell, true, 0, Some(0)));
        assert_eq!(
            check,
            CallerCheck::Exact {
                declared: 0,
                impl_params: 0,
                advisory: true,
            }
        );
        assert_eq!(expected_arity(&check, AritySide::Transmission), Some(0));
    }

    #[test]
    fn non_exposed_exact_is_plain_python_dispatch() {
        // 非 exposed 实现位=声明位:普通派发,无劝告无注入。
        let check = check_caller_contract(&facts(Facet::Base, false, 2, Some(2)));
        assert_eq!(
            check,
            CallerCheck::Exact {
                declared: 2,
                impl_params: 2,
                advisory: false,
            }
        );
    }

    #[test]
    fn injected_impl_arity_side_is_only_implementation() {
        // 注入成立时两侧数量必差一——共用一个数必出一向误报(验收核心)。
        let check = check_caller_contract(&facts(Facet::Cell, true, 3, Some(4)));
        let t = expected_arity(&check, AritySide::Transmission);
        let i = expected_arity(&check, AritySide::Implementation);
        assert_eq!(t, Some(3));
        assert_eq!(i, Some(4));
        assert_ne!(t, i);
    }

    #[test]
    fn first_param_name_does_not_gate_classification() {
        // 引擎判定按数量不按名:首参不叫 callerID 也成立,叫了也不豁免数量。
        // (首参名随结论带出,仅作报告数据,不影响分类。)
        for name in ["callerEntityID", "whatever"] {
            let check = check_caller_contract(&CallerFacts {
                facet: Facet::Cell,
                exposed: true,
                declared_args: 1,
                impl_arity: Some(ImplArity {
                    params: 2,
                    first_param: Some(name.to_string()),
                }),
            });
            assert!(
                matches!(check, CallerCheck::CallerInjected { .. }),
                "name={name}"
            );
        }
    }
}
