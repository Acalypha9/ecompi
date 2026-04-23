import { BrowserPool } from "./browser-pool.js";
import { CacheManager } from "./cache-manager.js";

export class ScraperEngine {
  constructor(
    public browserPool: BrowserPool,
    public cache: CacheManager,
  ) {}

  async close(): Promise<void> {
    await Promise.all([this.browserPool.close(), this.cache.close()]);
  }
}
