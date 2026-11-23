/**
 * The queue consumer. Run with `npm run worker`, or as the `worker` service in docker-compose.
 *
 * Concurrency is 2 on purpose. The bottleneck is a rate-limited embedding endpoint, not CPU, so
 * raising this does not make a single contract faster - it just produces more 429s. Two lets a
 * second upload start while the first is waiting on the network.
 */
import "dotenv/config";

import { Worker } from "bullmq";

import { createRedis, INGEST_QUEUE, type IngestJob } from "../src/queue";
import { processContract } from "../src/services/ingest";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);

const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  async (job) => {
    const started = Date.now();
    const log = (message: string) => console.log(`[${job.data.contractId}] ${message}`);
    log(`start (attempt ${job.attemptsMade + 1})`);

    await processContract(job.data.contractId, log);

    log(`finished in ${Math.round((Date.now() - started) / 1000)}s`);
  },
  {
    connection: createRedis(),
    concurrency: CONCURRENCY,
    // A stalled job is one whose worker died mid-processing. Reclaiming it is what makes a
    // deploy or a crash survivable: the contract is picked up again instead of staying
    // "processing" forever.
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

worker.on("failed", (job, err) => {
  console.error(`[${job?.data.contractId ?? "unknown"}] failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("worker error:", err.message);
});

console.log(`contract-ingest worker listening (concurrency ${CONCURRENCY})`);

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing in-flight jobs`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
