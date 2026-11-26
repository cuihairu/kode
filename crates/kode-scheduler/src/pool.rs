//! CORE-010 CPU pool capacity gate (baseline): interactive reservation + background hard ceiling.
//!
//! Pure decision core, zero runtime dependencies: wiring the dispatch threads / the real worker
//! pool belongs to the server assembly surface (with the provider); this module only locks down
//! the **admission invariants** —
//!
//! - **Interactive reservation**: the `interactive_reserved` capacity is always kept for
//!   interactive requests; when background is saturated, interactive requests can still enter
//!   (reserved-slot semantics) and never queue waiting for background to yield;
//! - **Background hard ceiling**: `background_max` is the hard ceiling of background worker
//!   concurrency and must never be exceeded under any circumstances (never occupy every CPU core);
//! - **Total conservation**: interactive + background in-flight count is always ≤ `total`, and
//!   background admissions never crowd out the interactive reservation (dispatchable background
//!   count = min(background_max, total − interactive_reserved − interactive_in_flight));
//! - **Release accounting**: releasing beyond the in-flight count = caller bug; reject it
//!   truthfully (return false) without changing counts, and never silently underflow.

/// CPU pool budget (CORE-010).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolBudget {
    /// Total capacity (usually the available core count; fed by the assembly surface, the pure
    /// core does not read the environment).
    pub total: usize,
    /// Reserved capacity for interactive requests (always kept).
    pub interactive_reserved: usize,
    /// Hard ceiling of background worker concurrency.
    pub background_max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolBudgetError {
    /// total is 0 (meaningless).
    ZeroTotal,
    /// Interactive reservation + background hard ceiling exceed the total (budget not
    /// self-consistent).
    Overcommitted,
}

impl PoolBudget {
    /// Derive the default budget from the total core count: one interactive reserve; background =
    /// 3/4 of the remaining capacity (rounded down, at least 1 — on a single-core machine
    /// background is 0 and everything yields to interactive).
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

    /// Budget self-consistency: total ≥ 1 and interactive_reserved + background_max ≤ total.
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

/// Pool admission gate: accounts for interactive/background in-flight counts and enforces the
/// CORE-010 admission invariants.
#[derive(Debug)]
pub struct WorkerPoolGate {
    budget: PoolBudget,
    interactive_running: usize,
    background_running: usize,
}

impl WorkerPoolGate {
    /// A non-self-consistent budget is rejected at construction time (never run with a sick
    /// budget).
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

    /// Interactive admission: admitted as long as total occupancy < total (reserved-slot
    /// semantics — even a saturated background cannot block interactive requests; there is always
    /// ≥ interactive_reserved of capacity available to interactive work).
    pub fn try_admit_interactive(&mut self) -> bool {
        if self.interactive_running + self.background_running >= self.budget.total {
            return false;
        }
        self.interactive_running += 1;
        true
    }

    /// Background admission: double hard gate = the background_max ceiling + total conservation
    /// (never crowds out the interactive reservation).
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

    /// Release one interactive slot; nothing in flight to release = caller bug, rejected and the
    /// counts are left untouched.
    pub fn release_interactive(&mut self) -> bool {
        if self.interactive_running == 0 {
            return false;
        }
        self.interactive_running -= 1;
        true
    }

    /// Release one background slot; nothing in flight to release = caller bug, rejected and the
    /// counts are left untouched.
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
        // Single-core machine: background 0, interactive exclusive (never occupy all cores).
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
        // Background saturated: an interactive request can still enter immediately (reserved-slot
        // semantics, never queueing for background to yield).
        assert!(gate.try_admit_interactive(), "交互预留位不得被后台吞掉");
    }

    #[test]
    fn background_hard_cap_never_exceeded_and_reservation_protected() {
        let mut gate = WorkerPoolGate::new(PoolBudget::from_total(8)).expect("valid budget");
        // Interactive fills up all capacity except the reservation: background admissions must
        // yield (never crowding out the interactive reservation).
        while gate.try_admit_interactive() {}
        assert!(
            !gate.try_admit_background(),
            "仅剩交互预留容量时后台不得准入"
        );
        assert_eq!(gate.background_running(), 0);
        // Put two back from the 8 interactive slots: the 7 non-reserved slots free up 1
        // (7−6), and only then can background enter.
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
        // Alternate admissions until both sides reject: total occupancy must not cross total.
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
        // After release, capacity recovers: background can be admitted again.
        assert!(gate.try_admit_background());
    }

    /// The budget() read surface: the budget validated at construction time is visible as is.
    #[test]
    fn budget_getter_returns_validated_budget() {
        let budget = PoolBudget::from_total(6);
        let gate = WorkerPoolGate::new(budget).expect("valid budget");
        assert_eq!(gate.budget(), budget);
    }
}
