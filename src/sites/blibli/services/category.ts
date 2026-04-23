import type { Page } from "playwright";
import { gotScraping } from "got-scraping";
import { BrowserPool } from "../../../core/browser-pool.js";
import { CacheManager } from "../../../core/cache-manager.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { withRetry } from "../../../utils/retry.js";
import { randomDelay } from "../../../utils/delay.js";
import { type BlibliCategory } from "../schemas.js";

const BLIBLI_CATEGORIES_URL = "https://www.blibli.com/backend/common/categories";

export class CategoryService {
  constructor(
    private browserPool: BrowserPool,
    private cache: CacheManager,
  ) {}

  async getCategories(): Promise<BlibliCategory[]> {
    const cacheKey = "categories:all";
    const cached = await this.cache.get<BlibliCategory[]>(cacheKey);
    if (cached) {
      logger.debug("Category cache hit");
      return cached;
    }

    try {
      const result = await this.executeDirectCategoryFetch();
      await this.cache.set(cacheKey, result, env.CACHE_TTL_SECONDS * 4);
      return result;
    } catch (directErr) {
      logger.warn(
        { err: directErr },
        "Direct API category fetch failed, falling back to browser",
      );
    }

    const result = await withRetry(
      () => this.executeCategoryScrape(),
      { maxRetries: env.MAX_RETRIES },
    );

    await this.cache.set(cacheKey, result, env.CACHE_TTL_SECONDS * 4);
    return result;
  }

  private async executeDirectCategoryFetch(): Promise<BlibliCategory[]> {
    logger.debug("Attempting direct API category fetch");

    const response = await gotScraping({
      url: BLIBLI_CATEGORIES_URL,
      method: "GET",
      http2: true,
      responseType: "json",
      headerGeneratorOptions: {
        browsers: [{ name: "chrome", minVersion: 120 }],
        devices: ["desktop"],
        operatingSystems: ["windows"],
        locales: ["id-ID", "en-US"],
      },
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.blibli.com/",
        "Origin": "https://www.blibli.com",
      },
      timeout: { request: 15000 },
      retry: { limit: 0 },
    });

    const json = response.body as Record<string, unknown>;
    const data = json.data as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Direct category API returned no data");
    }

    const categories = data.map((cat) => this.mapRawCategory(cat));

    logger.info(
      { count: categories.length },
      "Direct API category fetch succeeded",
    );

    return categories;
  }

  private async executeCategoryScrape(): Promise<BlibliCategory[]> {
    const context = await this.browserPool.createContext();
    let page: Page | null = null;

    try {
      page = await context.newPage();

      let apiData: BlibliCategory[] | null = null;

      const apiResponsePromise = page.waitForResponse(
        (resp) =>
          (resp.url().includes("/backend/category") ||
            resp.url().includes("/backend/common/category")) &&
          resp.status() === 200,
        { timeout: env.BROWSER_TIMEOUT_MS },
      );

      await page.goto("https://www.blibli.com", {
        waitUntil: "domcontentloaded",
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      try {
        const resp = await apiResponsePromise;
        const json = (await resp.json()) as Record<string, unknown>;
        const data = json.data as Array<Record<string, unknown>> | undefined;

        if (Array.isArray(data)) {
          apiData = data.map((cat) => this.mapRawCategory(cat));
        }
      } catch {
        logger.debug("Category API intercept missed, parsing DOM");
      }

      if (apiData && apiData.length > 0) {
        return apiData;
      }

      return this.parseCategoriesFromDOM(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  private mapRawCategory(raw: Record<string, unknown>): BlibliCategory {
    const children = raw.children as Array<Record<string, unknown>> | undefined;

    return {
      id: String(raw.id ?? raw.categoryId ?? raw.code ?? ""),
      name: String(raw.name ?? raw.categoryName ?? ""),
      url: raw.url
        ? `https://www.blibli.com${raw.url}`
        : "",
      children: Array.isArray(children)
        ? children.map((c) => this.mapRawCategory(c))
        : [],
    };
  }

  private async parseCategoriesFromDOM(
    page: Page,
  ): Promise<BlibliCategory[]> {
    const navSelector =
      'nav a[href*="/c/"], .category-menu a, [data-testid="navCategory"] a';
    await page.waitForSelector(navSelector, { timeout: 15000 }).catch(() => {});

    const categories: BlibliCategory[] = await page.evaluate((sel) => {
      const result: BlibliCategory[] = [];
      const seen = new Set<string>();

      document.querySelectorAll(sel).forEach((el) => {
        const link = el as HTMLAnchorElement;
        const name = link.textContent?.trim() ?? "";
        const url = link.href;

        if (name && !seen.has(name)) {
          seen.add(name);
          const idMatch = url.match(/\/c\/([^/]+)/);
          result.push({
            id: idMatch?.[1] ?? "",
            name,
            url,
            children: [],
          });
        }
      });

      return result;
    }, navSelector);

    return categories;
  }
}
