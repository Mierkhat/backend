import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createJobRunner, registerScheduledJobs } from "./jobs.js";
afterEach(() => vi.useRealTimers());

it("rejects unauthenticated scheduler invocations without running jobs", async () => {
  const app = Fastify(),
    run = vi.fn(async () => {});
  registerScheduledJobs(app, "dedicated-scheduler-capability", run);
  for (const method of ["GET", "POST"] as const) {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      "Bearer dedicated-scheduler-capability-extra",
    ])
      expect(
        (
          await app.inject({
            method,
            url: "/v1/internal/run",
            headers: authorization ? { authorization } : {},
          })
        ).statusCode,
      ).toBe(401);
  }
  expect(run).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/internal/run",
        headers: { authorization: "Bearer dedicated-scheduler-capability" },
      })
    ).statusCode,
  ).toBe(200);
  expect(run).toHaveBeenCalledTimes(1);
  await app.close();
});

it("keeps an unconfigured scheduler closed", async () => {
  const app = Fastify(),
    run = vi.fn(async () => {});
  registerScheduledJobs(app, undefined, run);
  expect(
    (await app.inject({ method: "GET", url: "/v1/internal/run" })).statusCode,
  ).toBe(401);
  expect(run).not.toHaveBeenCalled();
  await app.close();
});

it("shares overlapping cycles, resumes after failures, and honors a worker pause", async () => {
  let release!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let enabled = true;
  const runner = createJobRunner([task], () => enabled);
  const first = runner.runOnce(),
    second = runner.runOnce();
  expect(task).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  task.mockRejectedValueOnce(Error("Provider unavailable"));
  await expect(runner.runOnce()).rejects.toThrow("Provider unavailable");
  task.mockResolvedValueOnce(undefined);
  await runner.runOnce();
  enabled = false;
  await runner.runOnce();
  expect(task).toHaveBeenCalledTimes(3);
});

it("bounds background work and shares an active window across requests", async () => {
  vi.useFakeTimers();
  const task = vi.fn(async () => {}),
    runner = createJobRunner([task]);
  const first = runner.runWindow(),
    second = runner.runWindow();
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(task).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60000);
  expect(task).toHaveBeenCalledTimes(4);
});
