import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { computeNextRunAt } from "./cron.js";

const PolicyFile = z.object({
  version: z.literal(1),
  retries: z.record(
    z.string().regex(/^[a-f0-9]{8}$/),
    z.object({
      sourceScheduleId: z.string().regex(/^[a-f0-9]{8}$/),
      timezone: z.string().min(1),
    }),
  ),
});
export async function readRetryPolicy(home: string, id: string) {
  try {
    const policies = PolicyFile.parse(
      JSON.parse(await readFile(join(home, "schedule-retry-policies.json"), "utf8")),
    );
    const policy = policies.retries[id];
    if (policy?.sourceScheduleId === id)
      throw new Error("A retry schedule cannot depend on itself");
    return policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const SKIPPED = "[retry skipped]";
export function retrySkipReason(
  source: StoredSchedule | null,
  retry: StoredSchedule,
  scheduledFor: string,
  timezone: string,
): string | null {
  if (!source) throw new Error("Retry source schedule is missing");
  // Deliberately a daily retry, not a general workflow/dependency engine.
  if (
    source.cadence.type !== "cron" ||
    !/^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(source.cadence.expression.trim())
  ) {
    throw new Error("Retry policies require a daily fixed-time cron source");
  }
  const key = (time: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(time));
  const day = key(scheduledFor);
  if (source.status !== "active") return "source is not active";
  if (source.runs.some((run) => run.status === "running")) return "source is still running";
  const today = source.runs
    .filter((run) => key(run.scheduledFor) === day && run.scheduledFor <= scheduledFor)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (today.some((run) => run.status === "succeeded" && run.output?.trim()))
    return "source completed with output";
  if (
    retry.runs.some(
      (run) =>
        run.status !== "running" &&
        key(run.scheduledFor) === day &&
        !run.output?.startsWith(SKIPPED),
    )
  )
    return "retry already attempted today";
  if (today.length === 0) {
    const previousDay = new Date(new Date(scheduledFor).getTime() - 24 * 60 * 60 * 1000);
    const due = computeNextRunAt({ ...source.cadence, timezone }, previousDay);
    if (key(due.toISOString()) !== day || due.getTime() > new Date(scheduledFor).getTime())
      return "source is not due yet";
  }
  return null; // failed, empty output, or a missed due run
}
export function skippedRetryOutput(reason: string): string {
  return `${SKIPPED} ${reason}. No agent/model was started.`;
}
