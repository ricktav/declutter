import { eq } from "drizzle-orm";
import { captures } from "@db/schema";
import { getDb } from "../queries/connection";
import { getTriageModel } from "./ai";
import { isClaudeCliDevMode } from "./claudeCli";
import { logEvent } from "./events";
import { loadSettings } from "./settings";

/**
 * Background triage: new photo snaps are triaged one at a time in this
 * process, so a Sort card arrives with its suggestion filled in. State lives
 * in memory only; after a restart a pending snap simply has no suggestion and
 * the manual button still works. A failure stays visible on the snap
 * (`triageState: "failed"` with the reason) and in the capture's history.
 */
export type TriageJobState = { state: "queued" | "running" | "failed"; error: string | null };

type Job = { captureId: number; houseId: number | null; attempt: number };

const states = new Map<number, TriageJobState>();
const pending: Job[] = [];
let worker: Promise<void> | null = null;

export function clearTriageJobState(captureId: number): void {
  if (states.get(captureId)?.state === "failed") states.delete(captureId);
}

export function triageJobState(captureId: number): TriageJobState | null {
  return states.get(captureId) ?? null;
}

export async function autoTriageReady(): Promise<boolean> {
  if (loadSettings().autoTriage !== true) return false;
  if (isClaudeCliDevMode()) return true;
  try {
    await getTriageModel();
    return true;
  } catch {
    return false;
  }
}

/** Queue a photo snap for triage when the setting is on and a provider is configured. */
export async function maybeAutoTriage(capture: { id: number; kind: string }, houseId: number | null): Promise<boolean> {
  if (capture.kind !== "image") return false;
  if (!(await autoTriageReady())) return false;
  enqueueTriage(capture.id, houseId);
  return true;
}

export function enqueueTriage(captureId: number, houseId: number | null): void {
  const s = states.get(captureId);
  if (s && s.state !== "failed") return;
  states.set(captureId, { state: "queued", error: null });
  pending.push({ captureId, houseId, attempt: 0 });
  worker ??= drain().finally(() => {
    worker = null;
  });
}

/** Resolves once the queue is empty (tests, shutdown). */
export async function triageJobsIdle(): Promise<void> {
  while (worker) await worker;
}

/** Tests only: forget every job and state. */
export function resetTriageJobs(): void {
  pending.length = 0;
  states.clear();
}

async function drain(): Promise<void> {
  for (let job = pending.shift(); job; job = pending.shift()) {
    states.set(job.captureId, { state: "running", error: null });
    let error: string | null = null;
    let retryable = false;
    try {
      const cap = await getDb().query.captures.findFirst({ where: eq(captures.id, job.captureId) });
      if (!cap || cap.status !== "pending" || cap.suggestion != null) {
        states.delete(job.captureId);
        continue;
      }
      const { triageCapture } = await import("../routers/inbox");
      const res = await triageCapture(job.captureId, job.houseId);
      if (res.ok) {
        states.delete(job.captureId);
        continue;
      }
      error = res.error;
      retryable = res.retryable;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      retryable = true;
    }
    if (retryable && job.attempt === 0) {
      states.set(job.captureId, { state: "queued", error });
      pending.push({ ...job, attempt: 1 });
      continue;
    }
    states.set(job.captureId, { state: "failed", error });
    console.error(`[triage] capture #${job.captureId} failed: ${error}`);
    await logEvent({
      entityType: "capture",
      entityId: job.captureId,
      action: "triage-failed",
      summary: `Background triage failed: ${error}`,
      actor: "ai",
    }).catch((e) => console.error(`[triage] could not log the failure of capture #${job.captureId}:`, e));
  }
}
