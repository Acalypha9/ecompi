import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class InMemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupInterval = setInterval(() => this.evictExpired(), 60_000);
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data;
  }

  async set<T>(key: string, data: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  close(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

export class CacheManager {
  private redis: Redis | null = null;
  private fallback = new InMemoryCache();
  private useRedis = false;

  async connect(): Promise<void> {
    try {
      this.redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        lazyConnect: true,
      });

      await this.redis.connect();
      await this.redis.ping();
      this.useRedis = true;
      logger.info("Redis connected");
    } catch {
      logger.warn("Redis unavailable, using in-memory cache");
      this.redis?.disconnect();
      this.redis = null;
      this.useRedis = false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.useRedis && this.redis) {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    }
    return this.fallback.get<T>(key);
  }

  async set<T>(key: string, data: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? env.CACHE_TTL_SECONDS;
    if (this.useRedis && this.redis) {
      await this.redis.set(key, JSON.stringify(data), "EX", ttl);
      return;
    }
    await this.fallback.set(key, data, ttl);
  }

  async del(key: string): Promise<void> {
    if (this.useRedis && this.redis) {
      await this.redis.del(key);
      return;
    }
    await this.fallback.del(key);
  }

  async close(): Promise<void> {
    this.redis?.disconnect();
    this.fallback.close();
    logger.info("Cache closed");
  }
}
