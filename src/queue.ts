/**
 * The ingest queue.
 *
 * Shared by the API (which enqueues) and the worker (which consumes), so the queue name, the job
 * shape and the retry policy are defined once. A job carries only ids: the payload is in
 * Postgres, which means a job cannot go stale or disagree with the row it refers to.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";

export const INGEST_QUEUE = "contract-ingest";

export type IngestJob = {
  contractId: string;
  userId: string;
};

const url = process.env.REDIS_URL ?? "redis://localhost:6380";

export function createRedis(): IORedis {
  return new IORedis(url, {
    // BullMQ requires this: with a retry limit, a blocking command that outlives a brief Redis
    // outage would throw instead of reconnecting, and the worker would stop consuming silently.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

const globalForQueue = globalThis as unknown as { __ingestQueue?: Queue<IngestJob> };

export function ingestQueue(): Queue<IngestJob> {
  if (globalForQueue.__ingestQueue) return globalForQueue.__ingestQueue;

  const queue = new Queue<IngestJob>(INGEST_QUEUE, {
    connection: createRedis(),
    defaultJobOptions: {
      // Three attempts with backoff: most failures here are a rate-limited or busy free model,
      // which succeeds on a later try. A genuinely broken file fails all three and the row is
      // marked "failed" with the reason, which is what the user needs to see.
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400 },
    },
  });

  globalForQueue.__ingestQueue = queue;
  return queue;
}

/**
 * The job id is the contract id, so enqueuing the same contract twice is a no-op rather than two
 * concurrent ingests writing the same chunks. Same reasoning as a unique index: make the
 * duplicate impossible instead of checking for it.
 */
export async function enqueueIngest(job: IngestJob) {
  return ingestQueue().add("ingest", job, { jobId: job.contractId });
}
