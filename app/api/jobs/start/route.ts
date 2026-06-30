import { createJob } from "@/lib/jobs/jobStore";
import { runJob, REQUEST_BUDGET } from "@/lib/jobs/runner";
import { randomUUID } from "crypto";

export async function POST() {
  const jobId = randomUUID();
  createJob(jobId, REQUEST_BUDGET);

  // Kick off the job without blocking the response
  runJob(jobId).catch((err) => {
    console.error(`[job ${jobId}] unhandled error:`, err);
  });

  return Response.json({ jobId });
}
