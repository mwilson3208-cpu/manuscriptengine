/**
 * Background jobs for the Studio. A run or a regeneration is started by a
 * request that returns at once; the work continues in the server process and
 * the page polls for progress. One job per book at a time.
 */
export type JobStatus = "running" | "done" | "failed";

export interface Job {
  id: number;
  slug: string;
  kind: string;
  status: JobStatus;
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
  stage: string | null;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private seq = 0;

  get(slug: string): Job | null {
    return this.jobs.get(slug) ?? null;
  }

  isRunning(slug: string): boolean {
    return this.jobs.get(slug)?.status === "running";
  }

  /** Start `work` in the background. Throws when the book already has a running job. */
  start(slug: string, kind: string, work: (log: (m: string) => void) => Promise<{ message: string; stage?: string }>): Job {
    if (this.isRunning(slug)) throw new Error(`A ${this.jobs.get(slug)?.kind} job is already running for this book`);
    const job: Job = { id: ++this.seq, slug, kind, status: "running", log: [], startedAt: new Date().toISOString(), finishedAt: null, result: null, stage: null };
    this.jobs.set(slug, job);
    const log = (m: string) => {
      job.log.push(`${new Date().toLocaleTimeString()}  ${m}`);
      if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    };
    log(`Started ${kind}`);
    void work(log).then(
      (r) => {
        job.status = "done";
        job.result = r.message;
        job.stage = r.stage ?? null;
        job.finishedAt = new Date().toISOString();
        log(r.message);
      },
      (e: unknown) => {
        job.status = "failed";
        job.result = (e as Error).message;
        job.finishedAt = new Date().toISOString();
        log(`Failed: ${(e as Error).message}`);
      },
    );
    return job;
  }

  /** Resolves when the book's current job finishes. For tests. */
  async settle(slug: string, timeoutMs = 10000): Promise<Job | null> {
    const start = Date.now();
    while (this.isRunning(slug)) {
      if (Date.now() - start > timeoutMs) throw new Error("job did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.get(slug);
  }
}
