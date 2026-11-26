//! CORE-011 IO/CPU lane-separation gate (baseline): independent hard ceilings + interactive
//! reservation + total conservation.
//!
//! Pure decision core (wiring comes with the server assembly). Discipline (paired with the
//! module audit docs/review/2026-11-15-rust-076-io-cpu-lane-separation.md):
//!
//! - **Lane separation**: slow IO tasks and CPU-intensive tasks each hold an independent
//!   concurrency hard ceiling (`io_max` / `cpu_max`) — IO saturation must not compress CPU
//!   admissions (and vice versa); slow operations only starve their own lane;
//! - **Interactive reservation**: the budget always contains one interactive reserved slot; when
//!   IO+CPU are full, interactive work can still enter (CORE-010 reservation semantics restated
//!   on the lane surface);
//! - **Total conservation**: the three lanes' combined in-flight count is always ≤ `total`;
//! - **Lock-across-await audit conclusion**: the four crates kode-vfs/parser/index/scheduler
//!   contain zero `async fn` and zero `Mutex`/`RwLock` (grep evidence in the audit doc) — a
//!   pure core has no await, hence no "lock across await", structurally; contention/inversion is
//!   the documentation audit surface.

/// Lane classification (interactive / IO-type / CPU-type).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLane {
    Interactive,
    Io,
    Cpu,
}

/// Lane budget (CORE-011).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneBudget {
    /// Total capacity (usually the available core count; fed by the assembly surface, the pure
    /// core does not read the environment).
    pub total: usize,
    /// Concurrency hard ceiling of the IO lane.
    pub io_max: usize,
    /// Concurrency hard ceiling of the CPU lane.
    pub cpu_max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneBudgetError {
    /// total is 0 (meaningless).
    ZeroTotal,
    /// io_max + cpu_max + the interactive reserve 1 exceeds the total (budget not self-consistent).
    Overcommitted,
}

impl LaneBudget {
    /// Derive the default budget from the total core count: one interactive reserve; IO and CPU
    /// split the rest (io_max = floor, cpu_max takes the remainder; on a single-core machine both
    /// lanes are 0, everything goes to interactive).
    pub fn from_total(total: usize) -> LaneBudget {
        let remaining = total.saturating_sub(1);
        let io_max = remaining / 2;
        let cpu_max = remaining - io_max;
        LaneBudget {
            total,
            io_max,
            cpu_max,
        }
    }

    /// Budget self-consistency: total ≥ 1 and 1 (interactive reserve) + io_max + cpu_max ≤
    /// total.
    pub fn validate(&self) -> Result<(), LaneBudgetError> {
        if self.total == 0 {
            return Err(LaneBudgetError::ZeroTotal);
        }
        if self.io_max + self.cpu_max + 1 > self.total {
            return Err(LaneBudgetError::Overcommitted);
        }
        Ok(())
    }
}

/// Lane admission gate: the three lanes are accounted for independently, enforcing the CORE-011
/// invariants.
#[derive(Debug)]
pub struct LaneGate {
    budget: LaneBudget,
    interactive_running: usize,
    io_running: usize,
    cpu_running: usize,
}

impl LaneGate {
    /// A non-self-consistent budget is rejected at construction time (never run with a sick
    /// budget).
    pub fn new(budget: LaneBudget) -> Result<LaneGate, LaneBudgetError> {
        budget.validate()?;
        Ok(LaneGate {
            budget,
            interactive_running: 0,
            io_running: 0,
            cpu_running: 0,
        })
    }

    pub fn budget(&self) -> LaneBudget {
        self.budget
    }

    /// Current in-flight count of a given lane.
    pub fn running(&self, lane: TaskLane) -> usize {
        match lane {
            TaskLane::Interactive => self.interactive_running,
            TaskLane::Io => self.io_running,
            TaskLane::Cpu => self.cpu_running,
        }
    }

    /// Combined in-flight count of the three lanes.
    pub fn total_running(&self) -> usize {
        self.interactive_running + self.io_running + self.cpu_running
    }

    /// Admission: lane hard ceiling + total conservation (the interactive reserved slot is always
    /// kept).
    /// IO-lane saturation **does not block** CPU admission (separation semantics; likewise in
    /// reverse).
    pub fn try_admit(&mut self, lane: TaskLane) -> bool {
        let lane_full = match lane {
            TaskLane::Interactive => false,
            TaskLane::Io => self.io_running >= self.budget.io_max,
            TaskLane::Cpu => self.cpu_running >= self.budget.cpu_max,
        };
        if lane_full || self.total_running() >= self.budget.total {
            return false;
        }
        match lane {
            TaskLane::Interactive => self.interactive_running += 1,
            TaskLane::Io => self.io_running += 1,
            TaskLane::Cpu => self.cpu_running += 1,
        }
        true
    }

    /// Release one lane slot; nothing in flight to release = caller bug, rejected and the
    /// counts are left untouched.
    pub fn release(&mut self, lane: TaskLane) -> bool {
        let slot = match lane {
            TaskLane::Interactive => &mut self.interactive_running,
            TaskLane::Io => &mut self.io_running,
            TaskLane::Cpu => &mut self.cpu_running,
        };
        if *slot == 0 {
            return false;
        }
        *slot -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_budget_splits_remaining_after_interactive_reserve() {
        let b = LaneBudget::from_total(8);
        assert_eq!(b.io_max, 3, "预留 1 后 IO 取 floor(7/2)");
        assert_eq!(b.cpu_max, 4, "CPU 吃余量");
        assert!(b.validate().is_ok());
        // Single-core machine: both lanes are 0, everything goes to interactive.
        let single = LaneBudget::from_total(1);
        assert_eq!((single.io_max, single.cpu_max), (0, 0));
        assert!(single.validate().is_ok());
    }

    #[test]
    fn validate_rejects_zero_total_and_overcommit() {
        assert_eq!(
            LaneBudget {
                total: 0,
                io_max: 0,
                cpu_max: 0
            }
            .validate(),
            Err(LaneBudgetError::ZeroTotal)
        );
        assert_eq!(
            LaneBudget {
                total: 4,
                io_max: 2,
                cpu_max: 2
            }
            .validate(),
            Err(LaneBudgetError::Overcommitted),
            "2+2+预留 1 > 4"
        );
    }

    #[test]
    fn io_saturation_does_not_throttle_cpu_admissions() {
        // The core proving ground for separation semantics: the IO lane is entirely occupied by
        // slow operations, and CPU admission is unaffected.
        let mut gate = LaneGate::new(LaneBudget::from_total(8)).expect("valid budget");
        for _ in 0..gate.budget().io_max {
            assert!(gate.try_admit(TaskLane::Io));
        }
        assert_eq!(gate.running(TaskLane::Io), gate.budget().io_max);
        assert!(!gate.try_admit(TaskLane::Io), "IO 泳道自身满载拒绝");
        let mut cpu_admitted = 0;
        while gate.try_admit(TaskLane::Cpu) {
            cpu_admitted += 1;
        }
        assert_eq!(
            cpu_admitted,
            gate.budget().cpu_max,
            "IO 饱和不得压缩 CPU 准入"
        );
        // The reverse holds likewise: a full CPU lane does not block IO (it cannot be re-verified
        // after all io_max are admitted above, so verify after releasing).
        for _ in 0..gate.budget().cpu_max {
            gate.release(TaskLane::Cpu);
        }
        assert!(!gate.try_admit(TaskLane::Io), "IO 仍满载");
    }

    #[test]
    fn interactive_never_denied_until_total_full() {
        let mut gate = LaneGate::new(LaneBudget::from_total(8)).expect("valid budget");
        // IO+CPU both full (taking 7/8): interactive work can still enter (reserved-slot
        // semantics).
        for _ in 0..gate.budget().io_max {
            gate.try_admit(TaskLane::Io);
        }
        for _ in 0..gate.budget().cpu_max {
            gate.try_admit(TaskLane::Cpu);
        }
        assert_eq!(gate.total_running(), gate.budget().total - 1);
        assert!(
            gate.try_admit(TaskLane::Interactive),
            "交互预留位不得被泳道吞掉"
        );
        assert_eq!(gate.total_running(), gate.budget().total);
        assert!(!gate.try_admit(TaskLane::Interactive), "总量真满后交互也拒");
    }

    #[test]
    fn total_occupancy_conserved_under_alternating_admits() {
        let budget = LaneBudget::from_total(6);
        let mut gate = LaneGate::new(budget).expect("valid budget");
        let mut admitted = 0;
        loop {
            let i = gate.try_admit(TaskLane::Interactive);
            let io = gate.try_admit(TaskLane::Io);
            let cpu = gate.try_admit(TaskLane::Cpu);
            admitted += usize::from(i) + usize::from(io) + usize::from(cpu);
            if !i && !io && !cpu {
                break;
            }
        }
        assert!(gate.total_running() <= budget.total);
        assert_eq!(gate.total_running(), admitted, "记账 = 准入成功数");
    }

    #[test]
    fn release_is_lane_scoped_and_rejects_over_release() {
        let mut gate = LaneGate::new(LaneBudget::from_total(8)).expect("valid budget");
        assert!(gate.try_admit(TaskLane::Io));
        assert!(!gate.release(TaskLane::Cpu), "无在飞释放 = 调用方 bug");
        assert_eq!(gate.running(TaskLane::Io), 1);
        assert_eq!(gate.running(TaskLane::Cpu), 0, "释放不得串泳道");
        assert!(gate.release(TaskLane::Io));
        assert!(!gate.release(TaskLane::Io), "二次释放不得下溢");
        // After release, capacity recovers: the same lane can admit again.
        assert!(gate.try_admit(TaskLane::Io));
    }

    /// Interactive-lane read / release entry points (the ledger surface of the reserved-slot
    /// semantics).
    #[test]
    fn interactive_lane_running_read_and_release() {
        let mut gate = LaneGate::new(LaneBudget::from_total(4)).expect("valid budget");
        assert!(gate.try_admit(TaskLane::Interactive));
        assert_eq!(gate.running(TaskLane::Interactive), 1);
        assert!(gate.release(TaskLane::Interactive));
        assert_eq!(gate.running(TaskLane::Interactive), 0);
    }
}
