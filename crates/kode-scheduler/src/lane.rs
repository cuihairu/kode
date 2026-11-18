//! CORE-011 IO/CPU 泳道分离门(基础版):独立硬顶 + 交互预留 + 总量守恒。
//!
//! 纯决策核(接线随 server 装配单)。纪律(与模块审计
//! docs/review/2026-11-15-rust-076-io-cpu-lane-separation.md 配套):
//!
//! - **泳道分离**:IO 慢任务与 CPU 密集任务各持独立并发硬顶(`io_max` /
//!   `cpu_max`)——IO 饱和**不得**压缩 CPU 准入(反之亦然),慢操作只饿死
//!   自己的泳道;
//! - **交互预留**:预算恒含 1 个交互保留位;IO+CPU 满载时交互仍可入
//!   (CORE-010 预留语义在泳道面重申);
//! - **总量守恒**:三泳道在飞合计恒 ≤ `total`;
//! - **锁跨 await 审计结论**:kode-vfs/parser/index/scheduler 四 crate 零
//!   `async fn`、零 `Mutex`/`RwLock`(grep 证据见审计文档)——纯核无
//!   await 即无「锁跨 await」,结构性成立; contention/反转为文档审计面。

/// 泳道分类(交互 / IO 型 / CPU 型)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLane {
    Interactive,
    Io,
    Cpu,
}

/// 泳道预算(CORE-011)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneBudget {
    /// 容量总量(通常 = 可用核数;装配面喂,纯核不读环境)。
    pub total: usize,
    /// IO 泳道并发硬顶。
    pub io_max: usize,
    /// CPU 泳道并发硬顶。
    pub cpu_max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneBudgetError {
    /// total 为 0(无意义)。
    ZeroTotal,
    /// io_max + cpu_max + 交互预留 1 超出总量(预算不自洽)。
    Overcommitted,
}

impl LaneBudget {
    /// 由总核数推导缺省预算:交互预留 1;IO 与 CPU 平分其余容量
    /// (io_max = floor,cpu_max 吃余量;单核机两泳道皆 0,全给交互)。
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

    /// 预算自洽性:total ≥ 1 且 1(交互预留) + io_max + cpu_max ≤ total。
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

/// 泳道准入门:三泳道独立记账,执行 CORE-011 不变量。
#[derive(Debug)]
pub struct LaneGate {
    budget: LaneBudget,
    interactive_running: usize,
    io_running: usize,
    cpu_running: usize,
}

impl LaneGate {
    /// 预算不自洽即在构造期拒绝(绝不带病运行)。
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

    /// 指定泳道当前在飞数。
    pub fn running(&self, lane: TaskLane) -> usize {
        match lane {
            TaskLane::Interactive => self.interactive_running,
            TaskLane::Io => self.io_running,
            TaskLane::Cpu => self.cpu_running,
        }
    }

    /// 三泳道在飞合计。
    pub fn total_running(&self) -> usize {
        self.interactive_running + self.io_running + self.cpu_running
    }

    /// 准入:泳道硬顶 + 总量守恒(交互预留位恒保留)。
    /// IO 泳道饱和**不拦** CPU 准入(分离语义;反之亦然)。
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

    /// 释放一个泳道位;无在飞可释放 = 调用方 bug,拒绝且不改计数。
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
        // 单核机:两泳道皆 0,全给交互。
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
        // 分离语义的核心考场:IO 泳道全部被慢操作占满,CPU 准入不受影响。
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
        // 反向同理:CPU 满载不拦 IO(已在上面 io_max 全入后无法复验,释放后验)。
        for _ in 0..gate.budget().cpu_max {
            gate.release(TaskLane::Cpu);
        }
        assert!(!gate.try_admit(TaskLane::Io), "IO 仍满载");
    }

    #[test]
    fn interactive_never_denied_until_total_full() {
        let mut gate = LaneGate::new(LaneBudget::from_total(8)).expect("valid budget");
        // IO+CPU 双满载(占 7/8):交互仍可入(预留位语义)。
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
        // 释放后容量恢复:同一泳道可重新准入。
        assert!(gate.try_admit(TaskLane::Io));
    }

    /// 交互泳道读数/释放入口(预留位语义的记账面)。
    #[test]
    fn interactive_lane_running_read_and_release() {
        let mut gate = LaneGate::new(LaneBudget::from_total(4)).expect("valid budget");
        assert!(gate.try_admit(TaskLane::Interactive));
        assert_eq!(gate.running(TaskLane::Interactive), 1);
        assert!(gate.release(TaskLane::Interactive));
        assert_eq!(gate.running(TaskLane::Interactive), 0);
    }
}
