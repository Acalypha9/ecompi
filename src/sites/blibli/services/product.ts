import type { Page } from "playwright";
import { BrowserPool } from "../../../core/browser-pool.js";
import { CacheManager } from "../../../core/cache-manager.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { withRetry } from "../../../utils/retry.js";
import { randomDelay } from "../../../utils/delay.js";
import {
  BlibliProductDetailSchema,
  type BlibliProductDetail,
} from "../schemas.js";

export class ProductService {
  constructor(
    private browserPool: BrowserPool,
    private cache: CacheManager,
  ) {}

  async getDetail(slug: string): Promise<BlibliProductDetail> {
    const cacheKey = `product:${slug}`;
    const cached = await this.cache.get<BlibliProductDetail>(cacheKey);
    if (cached) {
      logger.debug({ slug }, "Product cache hit");
      return cached;
    }

    const result = await withRetry(
      () => this.executeProductScrape(slug),
      {
        maxRetries: env.MAX_RETRIES,
        retryableCheck: (err) => {
          const msg = err instanceof Error ? err.message : "";
          return !msg.includes("not found");
        },
      },
    );

    await this.cache.set(cacheKey, result, env.CACHE_TTL_SECONDS * 2);
    return result;
  }

  private async executeProductScrape(
    slug: string,
  ): Promise<BlibliProductDetail> {
    const context = await this.browserPool.createContext();
    let page: Page | null = null;

    try {
      page = await context.newPage();

      const productUrl = `https://www.blibli.com/p/${slug}`;
      logger.debug({ productUrl }, "Navigating to product page");

      let apiData: Record<string, unknown> | null = null;

      const apiResponsePromise = page.waitForResponse(
        (resp) =>
          (resp.url().includes("/backend/product-detail") ||
            resp.url().includes("/backend/common/product")) &&
          resp.status() === 200,
        { timeout: env.BROWSER_TIMEOUT_MS },
      );

      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      try {
        const resp = await apiResponsePromise;
        const json = (await resp.json()) as Record<string, unknown>;
        apiData = (json.data as Record<string, unknown>) ?? json;
      } catch {
        logger.debug("Product API intercept missed, parsing DOM");
      }

      if (apiData) {
        return this.mapApiProductDetail(apiData, slug);
      }

      return this.parseProductFromDOM(page, slug);
    } finally {
      await randomDelay(env.REQUEST_DELAY_MS);
      await context.close().catch(() => {});
    }
  }

  private mapApiProductDetail(
    raw: Record<string, unknown>,
    slug: string,
  ): BlibliProductDetail {
    const price = raw.price as Record<string, unknown> | undefined;
    const merchant = raw.merchant as Record<string, unknown> | undefined;
    const category = raw.category as Record<string, unknown> | undefined;
    const images = (raw.images ?? raw.imageUrls ?? []) as string[];
    const specs = (raw.specifications ?? raw.attributes ?? []) as Array<
      Record<string, unknown>
    >;
    const variants = (raw.variants ?? raw.options ?? []) as Array<
      Record<string, unknown>
    >;

    return BlibliProductDetailSchema.parse({
      id: raw.id ?? raw.itemId ?? "",
      sku: raw.sku ?? raw.itemSku ?? "",
      name: raw.name ?? "",
      brand: raw.brand ?? "",
      url: `https://www.blibli.com/p/${slug}`,
      price: {
        listed: price?.listed ?? price?.strikeThroughPrice,
        offered: price?.offered ?? price?.salePrice,
        discount: price?.discount,
        currency: "IDR",
      },
      images,
      rating: raw.rating,
      reviewCount: raw.reviewCount,
      soldCount: raw.soldCount ?? raw.itemCount,
      location: raw.location ?? raw.merchantLocation,
      merchant: {
        name: merchant?.name ?? raw.merchantName,
        id: merchant?.id ?? raw.merchantCode,
      },
      badges: raw.badges,
      description: raw.description,
      specifications: specs.map((s) => ({
        key: String(s.key ?? s.name ?? ""),
        value: String(s.value ?? ""),
      })),
      variants: variants.map((v) => ({
        name: String(v.name ?? ""),
        sku: String(v.sku ?? ""),
        price: Number(v.price ?? 0),
        stock: Number(v.stock ?? 0),
        attributes: (v.attributes ?? {}) as Record<string, string>,
      })),
      stock: raw.stock ?? raw.totalStock,
      weight: raw.weight,
      category: {
        id: String(category?.id ?? ""),
        name: String(category?.name ?? ""),
        path: category?.path,
      },
    });
  }

  private async parseProductFromDOM(
    page: Page,
    slug: string,
  ): Promise<BlibliProductDetail> {
    await page
      .waitForSelector(
        '[data-testid="pdpProductName"], .product-detail__name, h1',
        { timeout: 15000 },
      )
      .catch(() => {});

    const data = await page.evaluate(() => {
      const getText = (sel: string) =>
        document.querySelector(sel)?.textContent?.trim() ?? "";

      const name =
        getText('[data-testid="pdpProductName"]') ||
        getText(".product-detail__name") ||
        getText("h1");

      const priceText =
        getText('[data-testid="pdpProductPrice"]') ||
        getText(".product-detail__price--after") ||
        getText(".final-price");
      const priceNum = parseInt(priceText.replace(/[^\d]/g, ""), 10) || 0;

      const originalPriceText =
        getText(".product-detail__price--before") ||
        getText(".original-price") ||
        getText(".strike-through-price");
      const originalPriceNum =
        parseInt(originalPriceText.replace(/[^\d]/g, ""), 10) || 0;

      const ratingText =
        getText(".product-rating__score") || getText(".rating-value");
      const rating = parseFloat(ratingText) || 0;

      const reviewText =
        getText(".product-rating__count") || getText(".review-count");
      const reviewCount =
        parseInt(reviewText.replace(/[^\d]/g, ""), 10) || 0;

      const images: string[] = [];
      document
        .querySelectorAll(
          ".product-gallery img, .product-media img, [data-testid] img",
        )
        .forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src && !src.includes("placeholder")) images.push(src);
        });

      const description =
        getText(".product-description__content") ||
        getText('[data-testid="pdpDescriptionContent"]') ||
        getText(".description-content");

      const brand =
        getText('[data-testid="pdpProductBrand"]') ||
        getText(".product-detail__brand");

      const merchant =
        getText('[data-testid="pdpMerchantName"]') ||
        getText(".merchant-name");

      const location =
        getText('[data-testid="pdpMerchantLocation"]') ||
        getText(".merchant-location");

      const specs: Array<{ key: string; value: string }> = [];
      document
        .querySelectorAll(
          ".product-specification__item, .spec-item, tr[data-testid]",
        )
        .forEach((row) => {
          const key =
            row.querySelector(".spec-key, td:first-child")?.textContent?.trim() ??
            "";
          const value =
            row
              .querySelector(".spec-value, td:last-child")
              ?.textContent?.trim() ?? "";
          if (key) specs.push({ key, value });
        });

      return {
        name,
        price: priceNum,
        originalPrice: originalPriceNum,
        rating,
        reviewCount,
        images,
        description,
        brand,
        merchant,
        location,
        specs,
      };
    });

    return BlibliProductDetailSchema.parse({
      id: slug,
      sku: "",
      name: data.name,
      brand: data.brand,
      url: `https://www.blibli.com/p/${slug}`,
      price: {
        listed: data.originalPrice,
        offered: data.price,
        discount:
          data.originalPrice > 0
            ? Math.round(
                ((data.originalPrice - data.price) / data.originalPrice) * 100,
              )
            : 0,
        currency: "IDR",
      },
      images: data.images,
      rating: data.rating,
      reviewCount: data.reviewCount,
      soldCount: 0,
      location: data.location,
      merchant: { name: data.merchant, id: "" },
      badges: [],
      description: data.description,
      specifications: data.specs,
      variants: [],
      stock: 0,
      weight: "",
      category: { id: "", name: "", path: [] },
    });
  }
}
