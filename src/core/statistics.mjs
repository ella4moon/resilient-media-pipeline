export function statistics(jobs) {
  const result = { total: jobs.length, completed: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) if (Object.hasOwn(result, job.status)) result[job.status]++;
  return result;
}
