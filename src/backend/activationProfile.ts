import { performance } from 'perf_hooks';
import * as fs from 'fs';

// Staged timing during activation (KODE-PERF activation investigation): activate is a
// synchronous function, and view registration plus heavy work all complete inside the
// synchronous body; the user-visible "There is no data provider registered" and
// "still scanning" symptoms need flame-level evidence — which assembly segments take how
// long. This module only records when KODE_ACTIVATE_PROFILE_OUT (output file path) is
// set: markActivateStage drops labels, and flushActivateProfile appends each segment's
// step/total timings to the file before activate returns.
// When the env var is unset, every call is a zero-overhead passthrough (zero impact on
// the usual gate and in production).

const PROFILE_OUT = process.env.KODE_ACTIVATE_PROFILE_OUT ?? '';

let stageMarks: Array<[string, number]> = [];

/** Record one activation stage mark (performance.now timestamp relative to activate-enter) */
export function markActivateStage(label: string): void {
  if (!PROFILE_OUT) { return; }
  stageMarks.push([label, performance.now()]);
}

/** Flush to disk before activate returns: each line is stage\t<label>\tstep=..\ttotal=.. */
export function flushActivateProfile(): void {
  if (!PROFILE_OUT || stageMarks.length === 0) { return; }
  const t0 = stageMarks[0][1];
  const lines = stageMarks.map(([label, at], index): string => {
    const previous = index === 0 ? at : stageMarks[index - 1][1];
    const stepMs = (at - previous).toFixed(2);
    const totalMs = (at - t0).toFixed(2);
    return `stage\t${label}\tstep=${stepMs}ms\ttotal=${totalMs}ms`;
  });
  try {
    fs.appendFileSync(PROFILE_OUT, lines.join('\n') + '\n');
  } catch {
    /* diagnostic output failure must not affect activation */
  }
  stageMarks = [];
}
