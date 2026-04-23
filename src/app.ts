import fastify, { FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { BrowserPool } from "./core/browser-pool.js";
import { CacheManager } from "./core/cache-manager.js";
import { ScraperEngine } from "./core/engine.js";
import { errorHandler } from "./plugins/error-handler.js";
import { registerAllSites } from "./sites/index.js";
import { apiSuccess } from "./shared/api-response.js";

export async function buildApp(): Promise<{
  app: FastifyInstance;
  engine: ScraperEngine;
}> {
  const app = fastify({
    logger: env.NODE_ENV === "development",
    disableRequestLogging: true,
  });

  const browserPool = new BrowserPool();
  const cache = new CacheManager();
  const engine = new ScraperEngine(browserPool, cache);

  await cache.connect();

  app.setErrorHandler(errorHandler);

  // Global Health Check
  app.get("/health", async (_req, reply) => {
    return reply.send(
      apiSuccess({
        status: "healthy",
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
      }),
    );
  });

  // Register all scraper sites modularly
  registerAllSites(app, engine);

  return { app, engine };
}
