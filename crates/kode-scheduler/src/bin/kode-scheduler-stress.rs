//! Scheduler long-running stress lane CLI (RUST-083's former CORE-018).
//!
//! Usage:
//!   cargo run -p kode-scheduler --bin kode-scheduler-stress [options]
//!     --ops 100000       total enqueue operations (default 100000)
//!     --seed 1           random seed (default 1; on failure, replay with the same seed)
//!     --max-queued 0     bounded queue ceiling, 0 = unbounded
//!     --cooldown 50      interactive cooldown in ms
//!     --starvation 5000  background anti-starvation ceiling in ms
//!     --check-every 1000 assert every invariant once every N operations
//!     --cancel-pct 5     cancellation injection ratio (0..=100)
//!
//! Exit code 0 = every invariant holds; non-zero = a violation was found (deadlock / permanent
//! pending / cancellation leak / unbounded memory), with the violation kind and diagnostics on
//! stdout for CI archiving.
//!
//! The long-running CI shape: KODE_STRESS_OPS=2000000 (see .github/workflows/ci.yml).

use kode_scheduler::stress::{run_stress, stress_storm_probe, StressOptions};
use std::env;

fn arg(args: &[String], name: &str, fallback: &str) -> String {
    let index = args.iter().position(|a| a == name);
    index
        .and_then(|i| args.get(i + 1))
        .map(String::from)
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_u64(text: &str, fallback: u64) -> u64 {
    text.parse().unwrap_or(fallback)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // The CI long run injects a large value via environment variable; command-line arguments win
    // (for local reproduction).
    let total_ops = parse_u64(
        &arg(
            &args,
            "--ops",
            &env::var("KODE_STRESS_OPS").unwrap_or_default(),
        ),
        100_000,
    );
    let seed = parse_u64(
        &arg(
            &args,
            "--seed",
            &env::var("KODE_STRESS_SEED").unwrap_or_default(),
        ),
        1,
    );
    let max_queued = parse_u64(
        &arg(
            &args,
            "--max-queued",
            &env::var("KODE_STRESS_MAX_QUEUED").unwrap_or_default(),
        ),
        0,
    ) as usize;
    let interactive_cooldown_ms = parse_u64(
        &arg(
            &args,
            "--cooldown",
            &env::var("KODE_STRESS_COOLDOWN").unwrap_or_default(),
        ),
        50,
    );
    let starvation_limit_ms = parse_u64(
        &arg(
            &args,
            "--starvation",
            &env::var("KODE_STRESS_STARVATION").unwrap_or_default(),
        ),
        5_000,
    );
    let check_every = parse_u64(
        &arg(
            &args,
            "--check-every",
            &env::var("KODE_STRESS_CHECK_EVERY").unwrap_or_default(),
        ),
        1_000,
    );
    let cancel_rate_pct = parse_u64(
        &arg(
            &args,
            "--cancel-pct",
            &env::var("KODE_STRESS_CANCEL_PCT").unwrap_or_default(),
        ),
        5,
    ) as u8;

    let opts = StressOptions {
        total_ops,
        max_queued,
        interactive_cooldown_ms,
        starvation_limit_ms,
        check_every,
        cancel_rate_pct,
    };

    eprintln!(
        "STRESS-ENV seed={seed} ops={total_ops} max_queued={max_queued} cooldown={interactive_cooldown_ms}ms \
starvation={starvation_limit_ms}ms check_every={check_every} cancel_pct={cancel_rate_pct}"
    );

    let elapsed = std::time::Instant::now();

    // Storm merging surface: high-density same-file events, checking for lost events / inability
    // to drain.
    let storm_events = 100_000 + 1000 * total_ops.min(100_000);
    match stress_storm_probe(seed, storm_events) {
        Ok((seen, merged, landed)) => eprintln!(
            "STORM-OK events={seen} merged={merged} landed={landed} ({}s)",
            elapsed.elapsed().as_secs()
        ),
        Err(v) => {
            eprintln!("VIOLATION kind={} detail={}", v.kind, v.detail);
            std::process::exit(1);
        }
    }

    match run_stress(seed, opts) {
        Ok(report) => {
            let secs = elapsed.elapsed().as_secs();
            println!(
                "STRESS-OK created={created} completed={completed} failed={failed} cancelled={cancelled} \
cancel_successes={cancel_successes} checks={checks_run} peaks_queued={peak_queued} \
peak_retained={peak_retained} pauses={pauses} recoveries={recoveries} merged={merged_tasks} \
stale_dropped={stale_dropped} anti_starvation={anti_starvation_promotions} ({secs}s)",
                created = report.created,
                completed = report.completed,
                failed = report.failed,
                cancelled = report.cancelled,
                cancel_successes = report.cancel_successes,
                checks_run = report.checks_run,
                peak_queued = report.peak_queued,
                peak_retained = report.peak_retained,
                pauses = report.pauses,
                recoveries = report.recoveries,
                merged_tasks = report.merged_tasks,
                stale_dropped = report.stale_dropped,
                anti_starvation_promotions = report.anti_starvation_promotions,
            );
        }
        Err(v) => {
            eprintln!("VIOLATION kind={} detail={}", v.kind, v.detail);
            std::process::exit(1);
        }
    }
}
