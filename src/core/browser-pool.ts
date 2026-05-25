import { chromium, type Browser, type BrowserContext } from "patchright";
import { newInjectedContext } from "fingerprint-injector";
import { FingerprintGenerator } from "fingerprint-generator";
import os from "node:os";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { applyStealthScripts } from "./stealth.js";

const cfClearanceCache = new Map<string, { cookies: any; timestamp: number }>();
const CF_CLEARANCE_TTL = 3600000;

const CONTEXT_MAX_AGE_MS = 90_000;
const IDLE_CLEANUP_INTERVAL_MS = 30_000;

interface TrackedContext {
  context: BrowserContext;
  createdAt: number;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private contexts = new Map<BrowserContext, TrackedContext>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupStaleContexts(), IDLE_CLEANUP_INTERVAL_MS);
  }

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launching) return this.launching;

    this.launching = this.launchBrowser();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    logger.info("Launching stealth browser with patchright...");

    const args = [
      '--no-sandbox', 
      '--mute-audio', 
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors', 
      '--no-first-run',
      '--disable-blink-features=Attestation',
      '--disable-features=WebAuthentication,Passkeys,U2F',
      '--disable-dev-shm-usage', 
      '--disable-gpu'
    ];

    const isHeadless = String(env.BROWSER_HEADLESS) === "true";

    const browser = await chromium.launch({
      headless: isHeadless,
      args,
    });

    browser.on("disconnected", () => {
      logger.warn("Browser disconnected");
      this.browser = null;
      this.contexts.clear();
    });

    logger.info("Patchright stealth browser launched");
    return browser;
  }

  async createContext(): Promise<BrowserContext> {
    // Enforce max concurrent contexts
    if (this.contexts.size >= env.BROWSER_POOL_SIZE) {
      // Try to close the oldest context to make room
      await this.evictOldestContext();
    }

    // If still at capacity after eviction, reject
    if (this.contexts.size >= env.BROWSER_POOL_SIZE) {
      throw new Error('Insufficient memory for new browser context');
    }

    if (os.freemem() / os.totalmem() < 0.15) {
      // Attempt to free memory by closing all tracked contexts
      await this.closeAllContexts();
      // Re-check after cleanup
      if (os.freemem() / os.totalmem() < 0.15) {
        throw new Error('Insufficient memory for new browser context');
      }
    }

    const browser = await this.getBrowser();

    const proxyConfig = env.PROXY_URL
      ? { server: env.PROXY_URL }
      : undefined;

    const fingerprint = new FingerprintGenerator().getFingerprint({
      devices: ['desktop'],
      operatingSystems: ['windows'],
      browsers: [{ name: 'chrome' }]
    });

    // fingerprint-injector types reference playwright-core internally;
    // patchright is an API-identical fork, so the cast is safe at runtime.
    const context = await newInjectedContext(browser as any, {
      fingerprint,
      newContextOptions: {
        permissions: [],
        ignoreHTTPSErrors: true,
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
        proxy: proxyConfig
      }
    }) as unknown as BrowserContext;

    // Track context lifecycle
    this.contexts.set(context, { context, createdAt: Date.now() });

    await applyStealthScripts(context);
    
    await this.restoreCFClearance(context);

    return context;
  }

  /** Release a context back to the pool (closes it). Call this in finally blocks. */
  async releaseContext(context: BrowserContext): Promise<void> {
    this.contexts.delete(context);
    await context.close().catch(() => {});
  }

  private async evictOldestContext(): Promise<void> {
    let oldest: TrackedContext | null = null;
    for (const tracked of this.contexts.values()) {
      if (!oldest || tracked.createdAt < oldest.createdAt) {
        oldest = tracked;
      }
    }
    if (oldest) {
      logger.warn({ age: Date.now() - oldest.createdAt }, "Evicting oldest context to make room");
      this.contexts.delete(oldest.context);
      await oldest.context.close().catch(() => {});
    }
  }

  private async cleanupStaleContexts(): Promise<void> {
    const now = Date.now();
    const stale: TrackedContext[] = [];

    for (const tracked of this.contexts.values()) {
      if (now - tracked.createdAt > CONTEXT_MAX_AGE_MS) {
        stale.push(tracked);
      }
    }

    if (stale.length > 0) {
      logger.info({ count: stale.length }, "Cleaning up stale browser contexts");
      for (const entry of stale) {
        this.contexts.delete(entry.context);
        await entry.context.close().catch(() => {});
      }
    }
  }

  private async closeAllContexts(): Promise<void> {
    logger.warn({ count: this.contexts.size }, "Closing all contexts due to memory pressure");
    for (const entry of this.contexts.values()) {
      await entry.context.close().catch(() => {});
    }
    this.contexts.clear();
  }

  private async restoreCFClearance(context: BrowserContext): Promise<void> {
    const cacheEntry = cfClearanceCache.get("blibli.com");
    
    if (cacheEntry) {
      const age = Date.now() - cacheEntry.timestamp;
      if (age < CF_CLEARANCE_TTL) {
        try {
          await context.addCookies(cacheEntry.cookies);
          logger.info("Restored cached cf_clearance cookies");
        } catch (e) {
          logger.warn(
            { error: e instanceof Error ? e.message : String(e) },
            "Failed to restore cf_clearance cookies"
          );
        }
      } else {
        cfClearanceCache.delete("blibli.com");
      }
    }
  }

  async saveCFClearance(cookies: any[]): Promise<void> {
    const cfCookie = cookies.find((c) => c.name === "cf_clearance");
    if (cfCookie) {
      cfClearanceCache.set("blibli.com", {
        cookies: [cfCookie],
        timestamp: Date.now(),
      });
      logger.info("Saved cf_clearance cookie for future reuse");
    }
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.closeAllContexts();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info("Browser pool closed");
    }
  }
}
