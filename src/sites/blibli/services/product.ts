import type { Page } from "patchright";
import { gotScraping } from "got-scraping";
import * as cheerio from "cheerio";
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

const BLIBLI_PDP_API_URL = "https://www.blibli.com/backend/product-detail/products";
const BLIBLI_SEARCH_URL = "https://www.blibli.com/backend/search/products";

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

    // Tier 1: Direct product-detail API (fastest, but CF-protected)
    try {
      const result = await this.executeDirectApiDetail(slug);
      await this.cache.set(cacheKey, result, env.CACHE_TTL_SECONDS * 2);
      return result;
    } catch (directErr) {
      logger.warn(
        { err: directErr instanceof Error ? directErr.message : String(directErr) },
        "Tier 1 (direct API) failed",
      );
    }

    // Tier 2: Search API fallback — search by product name/SKU, match the item.
    // The search endpoint works via HTTP even when product-detail is IP-blocked.
    try {
      const result = await this.executeSearchApiFallback(slug);
      await this.cache.set(cacheKey, result, env.CACHE_TTL_SECONDS * 2);
      return result;
    } catch (searchErr) {
      logger.warn(
        { err: searchErr instanceof Error ? searchErr.message : String(searchErr) },
        "Tier 2 (search API fallback) failed",
      );
    }

    // Tier 3: Full browser scrape with warm-up + challenge handling
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

  private extractItemCode(slug: string): string {
    // slug = "whiskas-makanan-.../ps--ALS-60070-10401" or just "ps--ALS-60070-10401"
    const parts = slug.split("/");
    const skuPart = parts.find(p => /^(ps|is)--[A-Za-z0-9-]+$/.test(p));
    if (!skuPart) return slug;
    // Convert "ps--ALS-60070-10401" to "ALS-60070-10401-00001" (item code format)
    // The SKU prefix (ps/is) maps to product/item, the actual code follows after --
    return skuPart.replace(/^(ps|is)--/, "");
  }

  /**
   * Extract a human-readable search term from the slug.
   * "whiskas-makanan-kucing-kering-adult-tuna-480-g/ps--ALS-60070-10401"
   *  → "whiskas makanan kucing kering adult tuna 480 g"
   */
  private extractSearchTerm(slug: string): string {
    const parts = slug.split("/");
    // Take the first part (product name portion), not the SKU segment
    const namePart = parts.find(p => !/^(ps|is)--/.test(p)) ?? parts[0];
    // Convert hyphens to spaces, trim noise
    return namePart.replace(/-/g, " ").replace(/\d{5,}/g, "").trim();
  }

  /**
   * Extract the full SKU segment (e.g. "ps--ALS-60070-10401") from the slug.
   */
  private extractSkuSegment(slug: string): string | null {
    const parts = slug.split("/");
    return parts.find(p => /^(ps|is)--[A-Za-z0-9-]+$/.test(p)) ?? null;
  }

  /**
   * Tier 2: Search API fallback.
   * The search endpoint (/backend/search/products) works via HTTP even when
   * the product-detail endpoint is IP-blocked. We search by the product name
   * derived from the slug, then match the exact SKU in the results.
   */
  private async executeSearchApiFallback(slug: string): Promise<BlibliProductDetail> {
    const searchTerm = this.extractSearchTerm(slug);
    const targetSku = this.extractSkuSegment(slug);
    const itemCode = this.extractItemCode(slug);

    if (!searchTerm || searchTerm.length < 3) {
      throw new Error("Cannot derive search term from slug");
    }

    logger.debug({ searchTerm, targetSku, itemCode }, "Tier 2: Searching via search API fallback");

    const response = await gotScraping({
      url: BLIBLI_SEARCH_URL,
      method: "GET",
      searchParams: {
        searchTerm,
        start: 0,
        itemPerPage: 40,
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

    const apiData = response.body as Record<string, unknown>;
    const data = apiData?.data as Record<string, unknown> | undefined;
    const products = (data?.products ?? []) as Array<Record<string, unknown>>;

    if (!products.length) {
      throw new Error("Search API returned no products");
    }

    logger.debug({ resultCount: products.length, targetSku }, "Search API returned results, matching SKU");

    // Try to find exact SKU match first
    let matched = products.find(p => {
      const sku = String(p.sku ?? p.itemSku ?? "");
      const id = String(p.id ?? p.itemId ?? "");
      const url = String(p.url ?? "");
      return (
        sku === itemCode ||
        id === itemCode ||
        (targetSku && url.includes(targetSku))
      );
    });

    // If no exact match, try partial match on item code segments
    if (!matched) {
      const codeSegments = itemCode.split("-").filter(s => s.length >= 3);
      matched = products.find(p => {
        const sku = String(p.sku ?? p.itemSku ?? "");
        const id = String(p.id ?? p.itemId ?? "");
        return codeSegments.some(seg => sku.includes(seg) || id.includes(seg));
      });
    }

    // If still no match, take the first result (best match from search)
    if (!matched) {
      logger.warn({ targetSku, itemCode }, "No exact SKU match in search results, using best search result");
      matched = products[0];
    }

    logger.info(
      { name: matched.name, sku: matched.sku ?? matched.itemSku },
      "Tier 2: Matched product via search API",
    );

    // Map the search result to product detail format
    // Search results have less data than product-detail, but it's better than nothing
    const raw = matched;
    const price = raw.price as Record<string, unknown> | undefined;
    const merchant = raw.merchant as Record<string, unknown> | undefined;
    const review = raw.review as Record<string, unknown> | undefined;
    const images = (raw.images ?? (raw.image ? [raw.image] : [])) as string[];

    const detail = BlibliProductDetailSchema.parse({
      id: raw.id ?? raw.itemId ?? "",
      sku: raw.sku ?? raw.itemSku ?? "",
      name: raw.name ?? raw.productName ?? "",
      brand: raw.brand ?? "",
      url: raw.url ? `https://www.blibli.com${raw.url}` : `https://www.blibli.com/p/${slug}`,
      price: {
        listed: price?.listed ?? price?.strikeThroughPrice ?? 0,
        offered: price?.offered ?? price?.salePrice ?? price?.minPrice ?? 0,
        discount: price?.discount ?? 0,
        currency: "IDR",
      },
      images,
      rating: raw.rating ?? review?.rating ?? 0,
      reviewCount: raw.reviewCount ?? review?.count ?? 0,
      soldCount: raw.soldCount ?? raw.itemCount ?? 0,
      location: raw.location ?? raw.merchantLocation ?? "",
      merchant: {
        name: merchant?.name ?? raw.merchantName ?? "",
        id: merchant?.id ?? raw.merchantCode ?? "",
      },
      badges: raw.badges ?? raw.badge ?? [],
      description: raw.description ?? "",
      topSection: "",
      features: [],
      specifications: [],
      variants: [],
      stock: raw.stock ?? 0,
      weight: String(raw.weight ?? ""),
      category: {
        id: String((raw.category as any)?.id ?? ""),
        name: String((raw.category as any)?.name ?? ""),
        path: (raw.category as any)?.path ?? [],
      },
    });

    return await this.enrichFromHTML(slug, detail);
  }

  private async enrichFromHTML(slug: string, detail: BlibliProductDetail): Promise<BlibliProductDetail> {
    try {
      const url = `https://www.blibli.com/p/${slug}`;
      logger.debug({ url }, "Enriching product data from raw HTML");
      
      const response = await gotScraping({
        url,
        method: "GET",
        http2: true,
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 120 }],
          devices: ["desktop"],
          operatingSystems: ["windows"],
          locales: ["id-ID", "en-US"],
        },
        timeout: { request: 15000 },
        retry: { limit: 1 },
      });

      const $ = cheerio.load(response.body);
      
      // Extract Top Section
      const topSection = $('.top-section').text().trim();
      if (topSection && !detail.topSection) {
        detail.topSection = topSection;
      }
      
      // Extract Features
      const featuresText = $('.product-features').text().trim();
      if (featuresText && detail.features.length === 0) {
        // Blibli features are often wrapped in <p> tags inside .product-features
        const featureItems: string[] = [];
        $('.product-features p, .product-features li').each((_, el) => {
          const txt = $(el).text().trim();
          if (txt) featureItems.push(txt);
        });
        
        if (featureItems.length > 0) {
          detail.features = featureItems;
        } else {
          detail.features = [featuresText];
        }
      }

      // Try to extract raw description text if available in DOM
      const descText = $('.product-description-section, .description-content').text().trim();
      if (descText && !detail.description) {
        detail.description = descText;
      }

      // Try to extract any specs present in the HTML
      if (detail.specifications.length === 0) {
        const specs: Array<{ key: string; value: string }> = [];
        $('.product-specification__item, .spec-item').each((_, row) => {
          const key = $(row).find('.spec-key, th, td:first-child').text().trim();
          const value = $(row).find('.spec-value, td:last-child').text().trim();
          if (key && value && key !== value) {
            specs.push({ key, value });
          }
        });
        
        if (specs.length === 0) {
          const rawSpecText = $('.specification').text().trim();
          if (rawSpecText && rawSpecText.length > 5) {
            specs.push({ key: "Spesifikasi", value: rawSpecText });
          }
        }
        
        if (specs.length > 0) {
          detail.specifications = specs;
        }
      }
      
      return detail;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to enrich from HTML");
      return detail;
    }
  }

  private async executeDirectApiDetail(slug: string): Promise<BlibliProductDetail> {
    const itemCode = this.extractItemCode(slug);
    const apiUrl = `${BLIBLI_PDP_API_URL}/${itemCode}`;

    logger.debug({ apiUrl, slug, itemCode }, "Attempting direct API product detail");

    const response = await gotScraping({
      url: apiUrl,
      method: "GET",
      searchParams: {
        channelId: "web",
        showRecommendation: "false",
        is498: "true",
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
        "Referer": `https://www.blibli.com/p/${slug}`,
        "Origin": "https://www.blibli.com",
      },
      timeout: { request: 15000 },
      retry: { limit: 0 },
      responseType: "json",
    });

    const apiData = response.body as Record<string, unknown>;
    const data = (apiData?.data as Record<string, unknown>) ?? apiData;

    if (!data || (!data.name && !data.productName)) {
      throw new Error("Direct API returned no product data");
    }

    return this.mapApiProductDetail(data, slug);
  }

  private async executeProductScrape(
    slug: string,
  ): Promise<BlibliProductDetail> {
    const context = await this.browserPool.createContext();
    let page: Page | null = null;

    try {
      page = await context.newPage();

      // WARM-UP: Visit homepage first to accumulate cookies and establish
      // a legitimate browsing session before hitting product pages.
      // Blibli's anti-bot flags direct product page visits from fresh sessions.
      await this.warmUpSession(page);

      const productUrl = `https://www.blibli.com/p/${slug}`;
      logger.debug({ productUrl }, "Navigating to product page");

      let apiData: Record<string, unknown> | null = null;

      // Set up API interception BEFORE navigation
      const apiResponsePromise = page.waitForResponse(
        (resp) =>
          (resp.url().includes("/backend/product-detail") ||
            resp.url().includes("/backend/common/product")) &&
          resp.status() === 200,
        { timeout: 60000 },
      ).catch(() => null);

      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      // Handle both Cloudflare AND Blibli's own challenge pages
      await this.handleAllChallenges(page, productUrl);

      // After challenge resolves, wait for actual page content
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

      // Wait for Vue SSR hydration state OR meaningful page content
      await page.waitForFunction(
        () => {
          const w = window as any;
          const hasState = !!(w.__INITIAL_STATE__ || w.__NUXT__ || w.__pinia);
          const hasContent = document.title && !document.title.includes("Just a moment") && document.body.innerText.length > 200;
          const onChallenge = location.href.includes("/challenge/");
          return (hasState || hasContent) && !onChallenge;
        },
        { timeout: 30000 },
      ).catch(() => {
        logger.debug("Timed out waiting for page state/content after challenge resolution");
      });

      // Diagnostic: dump what we actually see
      await this.logPageDiagnostics(page);

      const stateProduct = await this.extractFromInitialState(page, slug);
      if (stateProduct) {
        await this.saveCFClearanceCookies(context);
        return stateProduct;
      }

      // Try collecting API response that may have fired during page load
      try {
        const resp = await apiResponsePromise;
        if (resp) {
          const json = (await resp.json()) as Record<string, unknown>;
          apiData = (json.data as Record<string, unknown>) ?? json;
          logger.info({ url: resp.url(), hasData: !!apiData }, "Intercepted product API response");
        }
      } catch {
        logger.debug("Product API intercept missed, parsing DOM");
      }

      await this.saveCFClearanceCookies(context);

      if (apiData) {
        return this.mapApiProductDetail(apiData, slug);
      }

      return this.parseProductFromDOM(page, slug);
    } finally {
      await randomDelay(env.REQUEST_DELAY_MS);
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.browserPool.releaseContext(context);
    }
  }

  /**
   * Warm up the browser session by visiting the Blibli homepage first.
   * This accumulates cookies (cf_clearance, session, tracking) that make
   * subsequent product page visits look like normal browsing behavior.
   */
  private async warmUpSession(page: Page): Promise<void> {
    logger.debug("Warming up session via homepage visit");
    try {
      await page.goto("https://www.blibli.com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Handle CF challenge on homepage if it appears
      await this.handleAllChallenges(page, "https://www.blibli.com");

      // Wait for homepage to actually load
      await page.waitForFunction(
        () => document.body.innerText.length > 500 && !location.href.includes("/challenge/"),
        { timeout: 20000 },
      ).catch(() => {});

      // Simulate brief human browsing — scroll a bit, move mouse
      await randomDelay(1500 + Math.random() * 2000);
      await page.mouse.move(300 + Math.random() * 200, 400 + Math.random() * 300);
      await randomDelay(500);
      await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 200));
      await randomDelay(1000 + Math.random() * 1000);

      logger.debug({ url: page.url() }, "Warm-up complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Warm-up navigation failed, continuing to product page anyway",
      );
    }
  }

  private async logPageDiagnostics(page: Page): Promise<void> {
    try {
      const diag = await page.evaluate(() => {
        const w = window as any;
        return {
          url: location.href,
          title: document.title,
          bodyLength: document.body?.innerText?.length ?? 0,
          hasInitialState: !!w.__INITIAL_STATE__,
          initialStateKeys: w.__INITIAL_STATE__ ? Object.keys(w.__INITIAL_STATE__) : [],
          hasNuxt: !!w.__NUXT__,
          nuxtKeys: w.__NUXT__ ? Object.keys(w.__NUXT__) : [],
          hasPinia: !!w.__pinia,
          piniaKeys: w.__pinia ? Object.keys(w.__pinia) : [],
          // Scan for any window property containing product-like data
          windowStateVars: Object.keys(w).filter((k: string) =>
            /state|store|data|initial|nuxt|pinia|redux|vuex/i.test(k) && typeof w[k] === 'object' && w[k] !== null
          ),
          metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content')?.substring(0, 100) ?? '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
          h1: document.querySelector('h1')?.textContent?.trim()?.substring(0, 100) ?? '',
          scriptCount: document.querySelectorAll('script').length,
        };
      });
      logger.info({ diag }, "Page diagnostics after load");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to collect page diagnostics");
    }
  }

  private async extractFromInitialState(page: Page, slug: string): Promise<BlibliProductDetail | null> {
    try {
      // Dynamically discover state: check __INITIAL_STATE__, __NUXT__, __pinia, and any state-like globals
      const extracted = await page.evaluate(() => {
        const w = window as any;

        // Recursively search an object for a node that looks like product data
        function findProductNode(obj: any, depth: number = 0): any {
          if (!obj || typeof obj !== 'object' || depth > 4) return null;
          // Check if this node itself is product-like
          if (obj.productName || obj.name) {
            // Must also have price-like or sku-like data to avoid false positives
            if (obj.price || obj.salePrice || obj.sku || obj.itemSku || obj.images || obj.imageUrls) {
              return obj;
            }
          }
          // Recurse into children
          for (const key of Object.keys(obj)) {
            if (/^(productDetail|product|pdp|item|detail|data|result|content|pageData|productData)$/i.test(key)) {
              const found = findProductNode(obj[key], depth + 1);
              if (found) return found;
            }
          }
          // Broader search if targeted keys didn't work
          for (const key of Object.keys(obj)) {
            if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
              const found = findProductNode(obj[key], depth + 1);
              if (found) return found;
            }
          }
          return null;
        }

        // Collect all state sources
        const stateSources: Array<{ name: string; obj: any }> = [];
        if (w.__INITIAL_STATE__) stateSources.push({ name: '__INITIAL_STATE__', obj: w.__INITIAL_STATE__ });
        if (w.__NUXT__) stateSources.push({ name: '__NUXT__', obj: w.__NUXT__ });
        if (w.__pinia) stateSources.push({ name: '__pinia', obj: w.__pinia });

        // Also scan for any other state-like globals
        for (const key of Object.keys(w)) {
          if (/state|store|data|initial/i.test(key) && typeof w[key] === 'object' && w[key] !== null) {
            if (!stateSources.some(s => s.name === key)) {
              stateSources.push({ name: key, obj: w[key] });
            }
          }
        }

        for (const source of stateSources) {
          const product = findProductNode(source.obj);
          if (product) {
            return { source: source.name, product, fullState: source.obj };
          }
        }

        return null;
      });

      if (!extracted) {
        logger.debug("No product data found in any window state source");
        return null;
      }

      logger.info({ source: extracted.source }, "Found product data in window state");

      const pd = extracted.product;
      const state = extracted.fullState;

      // Flexibly resolve price, merchant, stock from either the product node or sibling state nodes
      const priceData = state?.productPrice || pd.price || {};
      const merchantData = state?.merchant || pd.merchant || {};
      const stockData = state?.stock || pd.stock || {};

      // Normalize images: handle objects with url property or plain strings
      const rawImages = pd.images || pd.imageUrls || pd.medias || [];
      const images: string[] = rawImages.map((img: any) => {
        if (typeof img === 'string') return img;
        if (img?.url) return img.url;
        if (img?.src) return img.src;
        if (img?.big) return img.big;
        return null;
      }).filter(Boolean);

      return BlibliProductDetailSchema.parse({
        id: pd.itemId || pd.id || pd.productId || "",
        sku: pd.itemSku || pd.sku || pd.productSku || "",
        name: pd.productName || pd.name || "",
        brand: pd.brand || pd.brandName || "",
        url: `https://www.blibli.com/p/${slug}`,
        price: {
          listed: priceData.strikeThroughPrice || priceData.listed || priceData.originalPrice || 0,
          offered: priceData.salePrice || priceData.price || priceData.offered || priceData.minPrice || pd.price || 0,
          discount: priceData.discount || priceData.discountPercentage || 0,
          currency: "IDR",
        },
        images,
        rating: pd.rating || pd.averageRating || 0,
        reviewCount: pd.reviewCount || pd.review?.count || pd.totalReview || 0,
        soldCount: pd.soldCount || pd.itemCount || pd.totalSold || 0,
        location: pd.location || merchantData.location || merchantData.city || "",
        merchant: {
          name: merchantData.merchantName || merchantData.name || pd.merchantName || "",
          id: merchantData.merchantCode || merchantData.id || pd.merchantCode || "",
        },
        badges: pd.badges || pd.badgeList || [],
        description: pd.description || pd.longDescription || "",
        specifications: (pd.specifications || pd.attributes || pd.specificationDetails || []).map((s: any) => ({
          key: String(s.key || s.name || s.label || ""),
          value: String(s.value || s.content || ""),
        })),
        variants: (pd.variants || pd.options || pd.skuList || []).map((v: any) => ({
          name: String(v.name || v.optionName || ""),
          sku: String(v.sku || v.itemSku || ""),
          price: Number(v.price || v.salePrice || 0),
          stock: Number(v.stock || v.availableStock || 0),
          attributes: v.attributes || {},
        })),
        stock: typeof stockData === 'number' ? stockData : (stockData.stockCount || stockData.totalStock || stockData.availableStock || pd.stock || 0),
        weight: String(pd.weight || pd.productWeight || ""),
        category: {
          id: String(pd.category?.id || pd.categoryId || ""),
          name: String(pd.category?.name || pd.categoryName || ""),
          path: pd.category?.path || pd.categoryPath || pd.breadcrumb?.map?.((b: any) => b.name || b.label) || [],
        },
      });
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Failed to extract from window state");
      return null;
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
    const apiDataPromise: Promise<Record<string, unknown> | null> = page
      .waitForResponse(
        (resp) => {
          const url = resp.url();
          return (
            (url.includes("/backend/") || url.includes("/api/")) &&
            (url.includes("product") || url.includes("detail")) &&
            resp.status() === 200
          );
        },
        { timeout: 10000 },
      )
      .then((resp) => resp.json().catch(() => null))
      .catch(() => null);

    await page.waitForFunction(
      () => {
        const title = document.title;
        const hasContent = document.body.innerText.length > 100;
        return title && title !== "Loading..." && hasContent;
      },
      { timeout: 20000 },
    ).catch(() => {});

    const apiData = await apiDataPromise;
    if (apiData && (apiData as any).name) {
      return this.mapApiProductDetail(apiData, slug);
    }

    const data = await page.evaluate(() => {
      const getText = (sel: string) =>
        document.querySelector(sel)?.textContent?.trim() ?? "";

      const getAttr = (sel: string, attr: string) =>
        document.querySelector(sel)?.getAttribute(attr) ?? "";

      const name =
        getText('[data-testid="pdpProductName"]') ||
        getText(".product-detail__name") ||
        getText("h1") ||
        getAttr('meta[property="og:title"]', "content");

      const priceText =
        getText('[data-testid="pdpProductPrice"]') ||
        getText(".product-detail__price--after") ||
        getText(".final-price") ||
        getText("[data-testid*='price']");
      const priceNum = parseInt(priceText.replace(/[^\d]/g, ""), 10) || 0;

      const originalPriceText =
        getText(".product-detail__price--before") ||
        getText(".original-price") ||
        getText(".strike-through-price");
      const originalPriceNum =
        parseInt(originalPriceText.replace(/[^\d]/g, ""), 10) || 0;

      const ratingText =
        getText(".product-rating__score") || 
        getText(".rating-value") ||
        getText("[data-testid*='rating']");
      const rating = parseFloat(ratingText) || 0;

      const reviewText =
        getText(".product-rating__count") || 
        getText(".review-count") ||
        getText("[data-testid*='review']");
      const reviewCount =
        parseInt(reviewText.replace(/[^\d]/g, ""), 10) || 0;

      const images: string[] = [];
      const ogImage = getAttr('meta[property="og:image"]', "content");
      if (ogImage) images.push(ogImage);
      
      document
        .querySelectorAll(
          ".product-gallery img, .product-media img, [data-testid] img, img[alt]",
        )
        .forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src && !src.includes("placeholder") && !src.includes("data:")) {
            images.push(src);
          }
        });

      const description =
        getText(".product-description-section") ||
        getText(".product-description__content") ||
        getText('[data-testid="pdpDescriptionContent"]') ||
        getText(".description-content") ||
        getAttr('meta[property="og:description"]', "content") ||
        getAttr('meta[name="description"]', "content");

      const topSection = getText(".top-section");
      
      const features: string[] = [];
      const featuresText = getText(".product-features");
      if (featuresText) {
        features.push(featuresText);
      }

      const brand =
        getText('[data-testid="pdpProductBrand"]') ||
        getText(".product-detail__brand") ||
        getText("[data-testid*='brand']");

      const merchant =
        getText('[data-testid="pdpMerchantName"]') ||
        getText(".merchant-name") ||
        getText("[data-testid*='merchant']");

      const location =
        getText('[data-testid="pdpMerchantLocation"]') ||
        getText(".merchant-location");

      const specs: Array<{ key: string; value: string }> = [];
      document
        .querySelectorAll(
          ".specification .product-specification__item, .specification .spec-item, .specification tr, .product-specification__item, .spec-item, tr[data-testid], [data-testid*='spec']",
        )
        .forEach((row) => {
          const key =
            row.querySelector(".spec-key, td:first-child, [data-testid*='key'], th")?.textContent?.trim() ??
            "";
          const value =
            row
              .querySelector(".spec-value, td:last-child, [data-testid*='value'], td")
              ?.textContent?.trim() ?? "";
          if (key && value && key !== value) {
            specs.push({ key, value });
          }
        });

      // Fallback if no specs structured rows found but .specification has text
      if (specs.length === 0) {
        const rawSpecText = getText(".specification");
        if (rawSpecText && rawSpecText.length > 5) {
          specs.push({ key: "Spesifikasi", value: rawSpecText });
        }
      }

      return {
        name,
        price: priceNum,
        originalPrice: originalPriceNum,
        rating,
        reviewCount,
        images: [...new Set(images)],
        description,
        topSection,
        features,
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
      topSection: data.topSection,
      features: data.features,
      specifications: data.specs,
      variants: [],
      stock: 0,
      weight: "",
      category: { id: "", name: "", path: [] },
    });
  }

  /**
   * Unified challenge handler: detects and resolves both Cloudflare challenges
   * AND Blibli's own custom anti-bot challenge page (/challenge/landing/).
   *
   * Blibli's challenge says "Ada aktivitas yang tidak biasa" (unusual activity)
   * and has a "Coba lagi" (Try again) button that redirects back to the
   * original page with fresh cookies.
   */
  private async handleAllChallenges(page: Page, targetUrl: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 20;

    while (attempts < maxAttempts) {
      const currentUrl = page.url();
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");

      // Detect Blibli's own challenge page
      const isBlibliChallenge = currentUrl.includes("/challenge/landing") ||
        bodyText.includes("Ada aktivitas yang tidak biasa") ||
        bodyText.includes("aktivitas yang tidak biasa");

      // Detect Cloudflare challenge
      const isCFChallenge = title.includes("Just a moment") ||
        (await page.content().catch(() => "")).includes("cf-challenge");

      if (isBlibliChallenge) {
        logger.debug(
          { attempts, currentUrl },
          "Blibli custom challenge detected, clicking 'Coba lagi'",
        );

        // Simulate human-like delay before clicking
        await randomDelay(2000 + Math.random() * 3000);
        await page.mouse.move(300 + Math.random() * 200, 400 + Math.random() * 200);
        await randomDelay(500);

        // Try clicking "Coba lagi" (Try again) button
        const clicked = await page.evaluate(() => {
          // Look for the retry button by text content
          const buttons = Array.from(document.querySelectorAll("a, button"));
          const retryBtn = buttons.find(el =>
            el.textContent?.trim().toLowerCase().includes("coba lagi")
          );
          if (retryBtn) {
            (retryBtn as HTMLElement).click();
            return true;
          }
          return false;
        });

        if (clicked) {
          logger.debug("Clicked 'Coba lagi' button, waiting for redirect");
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await randomDelay(2000 + Math.random() * 2000);
        } else {
          // No button found — try navigating directly back to target
          logger.debug("No 'Coba lagi' button found, navigating directly to target");
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: env.BROWSER_TIMEOUT_MS,
          });
          await randomDelay(3000 + Math.random() * 2000);
        }

        attempts++;
      } else if (isCFChallenge) {
        logger.debug(
          { attempts },
          "Cloudflare challenge detected, simulating human behavior",
        );

        await randomDelay(2000 + Math.random() * 3000);
        await page.mouse.move(Math.random() * 390, Math.random() * 844);
        await randomDelay(500);
        attempts++;
      } else {
        // No challenge detected — we're through
        logger.debug({ attempts, url: currentUrl }, "All challenges resolved");
        return;
      }
    }

    logger.warn(
      { attempts: maxAttempts },
      "Challenge not resolved after maximum attempts",
    );
    throw new Error("Challenge Bypass Failed: Not resolved after max attempts");
  }

  private async saveCFClearanceCookies(
    context: any,
  ): Promise<void> {
    try {
      const cookies = await context.cookies();
      if (cookies.length > 0) {
        await this.browserPool.saveCFClearance(cookies);
      }
    } catch (e) {
      logger.debug(
        { error: e instanceof Error ? e.message : String(e) },
        "Could not save CF clearance cookies:"
      );
    }
  }
}
