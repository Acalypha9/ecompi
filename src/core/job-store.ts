import crypto from "crypto";

export interface Job {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  slug: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

class JobStore {
  private jobs: Map<string, Job>;
  private ttlMs = 10 * 60 * 1000; // 10 minutes

  constructor() {
    this.jobs = new Map();
    setInterval(() => this.cleanup(), 60 * 1000).unref();
  }

  createJob(slug: string): Job {
    const id = crypto.randomUUID();
    const now = Date.now();
    const job: Job = {
      id,
      status: 'pending',
      slug,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, update: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, update, { updatedAt: Date.now() });
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        now - job.updatedAt > this.ttlMs
      ) {
        this.jobs.delete(id);
      }
    }
  }
}

export const jobStore = new JobStore();
