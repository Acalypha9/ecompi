export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(baseMs: number, jitterRatio = 0.5): Promise<void> {
  const jitter = baseMs * jitterRatio * (Math.random() * 2 - 1);
  return delay(Math.max(0, baseMs + jitter));
}
