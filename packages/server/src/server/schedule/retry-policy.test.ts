import { expect, test } from "vitest";
import { StoredScheduleSchema, type ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { retrySkipReason } from "./retry-policy.js";
const reference = "2026-09-06T20:30:00.000Z"; // September 7, 05:30 KST
const source = StoredScheduleSchema.parse({
  id: "aaaaaaaa",
  name: null,
  prompt: "Audit",
  cadence: { type: "cron", expression: "0 5 * * *", timezone: "Asia/Seoul" },
  target: { type: "new-agent", config: { provider: "pi", cwd: "/tmp" } },
  status: "active",
  createdAt: reference,
  updatedAt: reference,
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
});
const retry = { ...source, id: "bbbbbbbb" };
const run = (
  status: ScheduleRun["status"],
  output: string | null,
  scheduledFor = "2026-09-06T20:00:00.000Z",
): ScheduleRun => ({
  id: "r",
  scheduledFor,
  startedAt: scheduledFor,
  endedAt: reference,
  status,
  output,
  agentId: null,
  error: null,
});
const decide = (runs: ScheduleRun[]) =>
  retrySkipReason({ ...source, runs }, retry, reference, "Asia/Seoul");
test("daily retry distinguishes successful, failed, empty, running and missing runs", () => {
  expect(decide([run("succeeded", "done")])).toContain("completed");
  expect(decide([run("failed", null)])).toBeNull();
  expect(decide([run("succeeded", " ")])).toBeNull();
  expect(decide([run("running", null)])).toContain("running");
  expect(decide([])).toBeNull();
  expect(decide([run("succeeded", "yesterday", "2026-09-05T20:00:00.000Z")])).toBeNull();
});
test("no early, disabled, orphaned or duplicate retry", () => {
  expect(retrySkipReason(source, retry, "2026-09-06T19:30:00.000Z", "Asia/Seoul")).toContain(
    "not due",
  );
  expect(
    retrySkipReason({ ...source, status: "paused" }, retry, reference, "Asia/Seoul"),
  ).toContain("not active");
  expect(() => retrySkipReason(null, retry, reference, "Asia/Seoul")).toThrow("missing");
  expect(
    retrySkipReason(source, { ...retry, runs: [run("failed", null)] }, reference, "Asia/Seoul"),
  ).toContain("already attempted");
});
