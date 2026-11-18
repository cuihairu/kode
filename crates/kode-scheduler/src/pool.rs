//! CORE-010 CPU 池容量门(基础版):交互预留 + 后台硬上限。
//!
//! 纯决策核,零运行时依赖:派发线程/真正 worker 池的接线属 server 装配面
//! (随 provider 单);本模块只锁定**准入不变量**——
//!
//! - **交互预留**:`interactive_reserved` 容量恒为交互请求保留;后台满载时
//!   交互请求仍可入(预留位语义),绝不排队等后台让位;
//! - **后台硬上限**:`background_max` 是后台 worker 并发的硬顶,任何情况下
//!   不得越过(绝不把 CPU 全核占满);
//! - **总量守恒**:交互 + 后台在飞数恒 ≤ `total`,后台准入绝不挤占交互预留
//!   (可派发后台数 = min(background_max, total − interactive_reserved −
//!   interactive_in_flight));
//! - **释放记账**:释放超过在飞数 = 调用方 bug,如实拒绝(返回 false)不改
//!   计数,绝不静默下溢。

/// CPU 池预算(CORE-010)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolBudget {
    /// 容量总量(通常 = 可用核数;由装配面喂,纯核不读环境)。
    pub total: usize,
    /// 交互预留容量(恒保留给交互请求)。
    pub interactive_reserved: usize,
    /// 后台 worker 并发硬上限。
    pub background_max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolBudgetError {
    /// total 为 0(无意义)。
    ZeroTotal,
    /// 交互预留 + 后台硬上限超出总量(预算不自洽)。
    Overcommitted,
}

impl PoolBudget {
    /// 由总核数推导缺省预算:交互预留 1;后台 = 其余容量的 3/4(向下取整,
    /// 至少 1——单核机后台 0,全量让给交互)。
    pub fn from_total(total: usize) -> PoolBudget {
        let remaining = total.saturating_sub(1);
        let background_max = if remaining == 0 {
            0
        } else {
            (remaining * 3 / 4).max(1)
        };
        PoolBudget {
            total,
            interactive_reserved: 1,
            background_max,
        }
    }

    /// 预算自洽性:total ≥ 1 且 interactive_reserved + background_max ≤ total。
    pub fn validate(&self) -> Result<(), PoolBudgetError> {
        if self.total == 0 {
            return Err(PoolBudgetError::ZeroTotal);
        }
        if self.interactive_reserved + self.background_max > self.total {
            return Err(PoolBudgetError::Overcommitted);
        }
        Ok(())
    }
}

/// 池准入门:记账交互/后台在飞数并执行 CORE-010 准入不变量。
#[derive(Debug)]
pub struct WorkerPoolGate {
    budget: PoolBudget,
    interactive_running: usize,
    background_running: usize,
}

impl WorkerPoolGate {
    /// 预算不自洽即在构造期拒绝(绝不带病运行)。
    pub fn new(budget: PoolBudget) -> Result<WorkerPoolGate, PoolBudgetError> {
        budget.validate()?;
        Ok(WorkerPoolGate {
            budget,
            interactive_running: 0,
            background_running: 0,
        })
    }

    pub fn budget(&self) -> PoolBudget {
        self.budget
    }

    pub fn interactive_running(&self) -> usize {
        self.interactive_running
    }

    pub fn background_running(&self) -> usize {
        self.background_running
    }

    /// 交互准入:只要总占用 < total 即放行(预留位语义——后台满载也拦不住
    /// 交互请求;恒有 ≥ interactive_reserved 的交互可用容量)。
    pub fn try_admit_interactive(&mut self) -> bool {
        if self.interactive_running + self.background_running >= self.budget.total {
            return false;
        }
        self.interactive_running += 1;
        true
    }

    /// 后台准入:双重硬闸 = background_max 顶 + 总量守恒(绝不挤占交互预留)。
    pub fn try_admit_background(&mut self) -> bool {
        if self.background_running >= self.budget.background_max {
            return false;
        }
        if self.interactive_running + self.background_running
            >= self.budget.total - self.budget.interactive_reserved
        {
            return false;
        }
        self.background_running += 1;
        true
    }

    /// 释放一个交互位;无在飞可释放 = 调用方 bug,拒绝且不改计数。
    pub fn release_interactive(&mut self) -> bool {
        if self.interactive_running == 0 {
            return false;
        }
        self.interactive_running -= 1;
        true
    }

    /// 释放一个后台位;无在飞可释放 = 调用方 bug,拒绝且不改计数。
    pub fn release_background(&mut self) -> bool {
        if self.background_running == 0 {
            return false;
        }
        self.background_running -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_budget_from_total_keeps_headroom() {
        let b = PoolBudget::from_total(8);
        assert_eq!(b.interactive_reserved, 1);
        assert_eq!(b.background_max, 5, "剩余 7 的 3/4 向下取整");
        assert!(b.validate().is_ok());
        // 单核机:后台 0,交互独占(绝不占满全核)。
        let single = PoolBudget::from_total(1);
        assert_eq!(single.interactive_reserved, 1);
        assert_eq!(single.background_max, 0);
        assert!(single.validate().is_ok());
    }

    #[test]
    fn validate_rejects_zero_total_and_overcommit() {
        assert_eq!(
            PoolBudget {
                total: 0,
                interactive_reserved: 0,
                background_max: 0
            }
            .validate(),
            Err(PoolBudgetError::ZeroTotal)
        );
        assert_eq!(
            PoolBudget {
                total: 4,
                interactive_reserved: 2,
                background_max: 3
            }
            .validate(),
            Err(PoolBudgetError::Overcommitted)
        );
    }

    #[test]
    fn interactive_admits_even_when_background_at_hard_cap() {
        let mut gate = WorkerPoolGate::new(PoolBudget::from_total(8)).expect("valid budget");
        while gate.try_admit_background() {}
        assert_eq!(gate.background_running(), 5, "后台顶到硬上限");
        // 后台满载:交互请求仍立即可入(预留位语义,绝不排队等后台让位)。
        assert!(gate.try_admit_interactive(), "交互预留位不得被后台吞掉");
    }

    #[test]
    fn background_hard_cap_never_exceeded_and_reservation_protected() {
        let mut gate = WorkerPoolGate::new(PoolBudget::from_total(8)).expect("valid budget");
        // 交互占满除预留外的容量:后台准入必须让位(绝不挤占交互预留)。
        while gate.try_admit_interactive() {}
        assert!(
            !gate.try_admit_background(),
            "仅剩交互预留容量时后台不得准入"
        );
        assert_eq!(gate.background_running(), 0);
        // 8 个交互里放回两个:非预留容量 7 空出 1 位(7−6),后台才可入。
        gate.release_interactive();
        gate.release_interactive();
        assert!(gate.try_admit_background(), "腾出非预留位后后台可入");
        assert_eq!(gate.background_running(), 1);
    }

    #[test]
    fn total_occupancy_never_exceeds_budget() {
        let budget = PoolBudget::from_total(4);
        let mut gate = WorkerPoolGate::new(budget).expect("valid budget");
        let mut admitted = 0;
        // 交替准入直到两侧都拒绝:总占用不得越过 total。
        loop {
            let i = gate.try_admit_interactive();
            let b = gate.try_admit_background();
            admitted += usize::from(i) + usize::from(b);
            if !i && !b {
                break;
            }
        }
        assert!(gate.interactive_running() + gate.background_running() <= budget.total);
        assert_eq!(
            gate.interactive_running() + gate.background_running(),
            admitted,
            "记账 = 准入成功数"
        );
    }

    #[test]
    fn release_rejects_over_release_and_restores_capacity() {
        let mut gate = WorkerPoolGate::new(PoolBudget::from_total(8)).expect("valid budget");
        assert!(
            !gate.release_interactive(),
            "无在飞释放 = 调用方 bug,如实拒绝"
        );
        assert!(
            !gate.release_background(),
            "无在飞释放 = 调用方 bug,如实拒绝"
        );
        assert!(gate.try_admit_background());
        assert!(gate.release_background());
        assert!(!gate.release_background(), "二次释放不得下溢");
        assert_eq!(gate.background_running(), 0);
        // 释放后容量恢复:后台可重新准入。
        assert!(gate.try_admit_background());
    }

    /// budget() 读取面:构造期校验过的预算原样可见。
    #[test]
    fn budget_getter_returns_validated_budget() {
        let budget = PoolBudget::from_total(6);
        let gate = WorkerPoolGate::new(budget).expect("valid budget");
        assert_eq!(gate.budget(), budget);
    }
}
