// Waiting for a queued run. The server runs one engine run at a time; POST run and POST fork answer at
// once with a job, and this asks after it until it is done or failed, reporting each state it sees so
// the page can say whether the run is waiting its turn or running. A status check that fails (a network
// blip, a busy server) is retried with a growing pause; only the server saying the run failed counts as
// a failure, so the page never invites a second, duplicate run while the first may still finish.
import { ApiError, getJob } from './api';
import type { JobResponse } from './types';

/** Polling settings, exported so tests can shorten them. */
export const jobPolling = { pollMs: 600, maxMisses: 8 };

/** The server reported the run as failed: safe to offer a new run. */
export class JobFailedError extends ApiError {
  constructor(job: JobResponse) {
    super(0, `/jobs/${job.job_id}`, job.error ?? 'the run failed');
    this.name = 'JobFailedError';
  }
}

/** Status checks kept failing: the run may still be queued, running or done, so the page checks again rather than re-running. */
export class JobContactLostError extends Error {
  job: JobResponse;
  constructor(job: JobResponse, cause: unknown) {
    super(`lost contact with the run (${cause instanceof Error ? cause.message : String(cause)}); it may still finish`);
    this.name = 'JobContactLostError';
    this.job = job;
  }
}

/** Ask after a job until it is done (resolve) or failed (JobFailedError), reporting each state seen. */
export async function waitForJob(first: JobResponse, onUpdate: (job: JobResponse) => void = () => {}): Promise<JobResponse> {
  let job = first;
  let misses = 0;
  onUpdate(job);
  while (job.state === 'queued' || job.state === 'running') {
    const pause = jobPolling.pollMs * Math.min(2 ** misses, 8);
    await new Promise((r) => setTimeout(r, pause));
    try {
      job = await getJob(job.job_id);
      misses = 0;
      onUpdate(job);
    } catch (err) {
      misses += 1;
      if (misses >= jobPolling.maxMisses) throw new JobContactLostError(job, err);
    }
  }
  if (job.state === 'failed') throw new JobFailedError(job);
  return job;
}
