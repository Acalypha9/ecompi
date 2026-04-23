import { chromium, type Browser, type BrowserContext } from "playwright";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getRandomUserAgent } from "../utils/user-agents.js";
import { applyStealthScripts } from "./stealth.js";

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

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
    logger.info("Launching stealth browser...");

    const args = [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--no-sandbox",
    ];

    const browser = await chromium.launch({
      headless: env.BROWSER_HEADLESS,
      args,
    });

    browser.on("disconnected", () => {
      logger.warn("Browser disconnected");
      this.browser = null;
    });

    logger.info("Browser launched");
    return browser;
  }

  async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const userAgent = getRandomUserAgent();

    const proxyConfig = env.PROXY_URL
      ? { server: env.PROXY_URL }
      : undefined;

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: "id-ID",
      timezoneId: "Asia/Jakarta",
      javaScriptEnabled: true,
      bypassCSP: true,
      proxy: proxyConfig,
      extraHTTPHeaders: {
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "sec-ch-ua":
          '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
    });

    await applyStealthScripts(context);
    return context;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info("Browser pool closed");
    }
  }
}
