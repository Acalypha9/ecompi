import type { Page } from "playwright";
import { gotScraping } from "got-scraping";
import { BrowserPool } from "../../../core/browser-pool.js";
import { CacheManager } from "../../../core/cache-manager.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { withRetry } from "../../../utils/retry.js";
import { randomDelay } from "../../../utils/delay.js";
import {
  BlibliProductSchema,
  type BlibliProduct,
  type SearchResult,
} from "../schemas.js";

const BLIBLI_SEARCH_URL = "https://www.blibli.com/backend/search/products";

interface RawSearchResponse {
  code: number;
  data: {
    products: Array<Record<string, unknown>>;
    paging: {
      page: number;
      total_page: number;
      total_item: number;
      item_per_page: number;
    };
  };
}

function mapRawProduct(raw: Record<string, any>): Record<string, any> {
  const { price, merchant, images, review, ...rest } = raw;

  return {
    id: rest.id ?? rest.itemId ?? "",
    sku: rest.sku ?? rest.itemSku ?? "",
    name: rest.name ?? "",
    brand: rest.brand ?? "",
    url: rest.url ? `https://www.blibli.com${rest.url}` : "",
    price: {
      listed: price?.listed ?? price?.strikeThroughPrice ?? 0,
      offered: price?.offered ?? price?.salePrice ?? price?.minPrice ?? 0,
      discount: price?.discount ?? 0,
      currency: "IDR",
    },
    images: images ?? (rest.image ? [rest.image] : []),
    rating: rest.rating ?? review?.rating ?? 0,
    reviewCount: rest.reviewCount ?? review?.count ?? 0,
    soldCount: rest.soldCount ?? rest.itemCount ?? 0,
    location: rest.location ?? rest.merchantLocation ?? "",
    merchant: {
      name: merchant?.name ?? rest.merchantName ?? "",
      id: merchant?.id ?? rest.merchantCode ?? "",
    },
    badges: rest.badges ?? rest.badge ?? [],
  };
}

export class SearchService {
  constructor(
    private browserPool: BrowserPool,
    private cache: CacheManager,
  ) {}

  async search(
    keyword: string,
    page: number,
    limit: number,
  ): Promise<SearchResult> {
    const cacheKey = `search:${keyword}:${page}:${limit}`;
    const cached = await this.cache.get<SearchResult>(cacheKey);
    if (cached) {
      logger.debug({ keyword, page }, "Search cache hit");
      return cached;
    }

    try {
      const result = await this.executeDirectSearch(keyword, page, limit);
      await this.cache.set(cacheKey, result);
      return result;
    } catch (directErr) {
      logger.warn(
        { err: directErr instanceof Error ? directErr.message : String(directErr) },
        "Direct API search failed, falling back to browser",
      );
    }

    const result = await withRetry(
      () => this.executeBrowserSearch(keyword, page, limit),
      {
        maxRetries: env.MAX_RETRIES,
        retryableCheck: (err) => {
          const msg = err instanceof Error ? err.message : "";
          return !msg.includes("CAPTCHA") && !msg.includes("blocked");
        },
      },
    );

    await this.cache.set(cacheKey, result);
    return result;
  }

  private async executeDirectSearch(
    keyword: string,
    page: number,
    limit: number,
  ): Promise<SearchResult> {
    const start = (page - 1) * limit;

    logger.debug({ keyword, page, start, limit }, "Attempting direct API search");

    const response = await gotScraping({
      url: BLIBLI_SEARCH_URL,
      method: "GET",
      searchParams: {
        searchTerm: keyword,
        start: start,
        itemPerPage: limit,
      },
      http2: true,
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
      responseType: "json",
    });

    const apiData = response.body as RawSearchResponse;

    if (!apiData?.data?.products) {
      throw new Error("Direct search API returned no products data");
    }

    const products = apiData.data.products
      .map(mapRawProduct)
      .map((p) => BlibliProductSchema.parse(p));
    const paging = apiData.data.paging;

    logger.info(
      { keyword, count: products.length, totalItems: paging?.total_item },
      "Direct API search succeeded",
    );

    return {
      products,
      pagination: {
        currentPage: paging?.page ?? page,
        totalPages: paging?.total_page ?? 0,
        totalItems: paging?.total_item ?? 0,
        itemsPerPage: paging?.item_per_page ?? limit,
      },
      keyword,
    };
  }

  private async executeBrowserSearch(
    keyword: string,
    page: number,
    limit: number,
  ): Promise<SearchResult> {
    const context = await this.browserPool.createContext();
    let searchPage: Page | null = null;

    try {
      searchPage = await context.newPage();
      await searchPage.setExtraHTTPHeaders({
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      });

      let apiData: RawSearchResponse | null = null;

      const apiResponsePromise = searchPage.waitForResponse(
        (resp) =>
          resp.url().includes("/backend/search/products") &&
          resp.status() === 200,
        { timeout: env.BROWSER_TIMEOUT_MS },
      );

      const start = (page - 1) * limit;
      const searchUrl = `https://www.blibli.com/search?searchTerm=${encodeURIComponent(keyword)}&start=${start}&itemPerPage=${limit}`;

      await searchPage.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      try {
        const resp = await apiResponsePromise;
        apiData = (await resp.json()) as RawSearchResponse;
      } catch {
        logger.debug("API intercept missed, falling back to DOM parsing");
      }

      if (apiData?.data?.products) {
        const products = apiData.data.products
          .map(mapRawProduct)
          .map((p) => BlibliProductSchema.parse(p));
        const paging = apiData.data.paging;

        return {
          products,
          pagination: {
            currentPage: paging.page ?? page,
            totalPages: paging.total_page ?? 0,
            totalItems: paging.total_item ?? 0,
            itemsPerPage: paging.item_per_page ?? limit,
          },
          keyword,
        };
      }

      return await this.parseSearchFromDOM(searchPage, keyword, page, limit);
    } finally {
      await randomDelay(env.REQUEST_DELAY_MS);
      await searchPage?.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  private async parseSearchFromDOM(
    page: Page,
    keyword: string,
    pageNum: number,
    limit: number,
  ): Promise<SearchResult> {
    await page.waitForSelector(
      '[data-testid="lstProduct-content-product"], .product-card, a[href*="/p/"]',
      { timeout: 15000 },
    ).catch(() => {});

    const products: BlibliProduct[] = await page.evaluate(() => {
      const items: BlibliProduct[] = [];
      const cards = document.querySelectorAll(
        '[data-testid="lstProduct-content-product"], .product-card, .product__card',
      );

      cards.forEach((card) => {
        const linkEl = card.querySelector("a[href*='/p/']") as HTMLAnchorElement | null;
        const nameEl = card.querySelector(
          '[data-testid="lstProduct-content-product-name"], .product-title, .blu-product__name',
        );
        const priceEl = card.querySelector(
          '[data-testid="lstProduct-content-product-price"], .product-price, .blu-product__price-after',
        );
        const imgEl = card.querySelector("img") as HTMLImageElement | null;
        const locationEl = card.querySelector(
          '.product-location, [data-testid="lstProduct-content-product-location"]',
        );
        const ratingEl = card.querySelector(".product-rating, .blu-product__rating");
        const merchantEl = card.querySelector(
          '.merchant-name, [data-testid="lstProduct-content-product-merchant"]',
        );

        const priceText = priceEl?.textContent?.replace(/[^\d]/g, "") ?? "0";
        const ratingText = ratingEl?.textContent?.match(/[\d.]+/)?.[0] ?? "0";

        const url = linkEl?.href ?? "";
        const skuMatch = url.match(/ps--([A-Za-z0-9-]+)/);

        items.push({
          id: skuMatch?.[1] ?? "",
          sku: skuMatch?.[1] ?? "",
          name: nameEl?.textContent?.trim() ?? "",
          brand: "",
          url,
          price: {
            listed: 0,
            offered: parseInt(priceText, 10) || 0,
            discount: 0,
            currency: "IDR",
          },
          images: imgEl?.src ? [imgEl.src] : [],
          rating: parseFloat(ratingText) || 0,
          reviewCount: 0,
          soldCount: 0,
          location: locationEl?.textContent?.trim() ?? "",
          merchant: {
            name: merchantEl?.textContent?.trim() ?? "",
            id: "",
          },
          badges: [],
        });
      });
      return items;
    });

    return {
      products: products.map((p) => BlibliProductSchema.parse(p)),
      pagination: {
        currentPage: pageNum,
        totalPages: 0,
        totalItems: 0,
        itemsPerPage: limit,
      },
      keyword,
    };
  }
}
