import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { buildApp } from "./app.js";

async function main() {
  const { app, engine } = await buildApp();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received signal, shutting down gracefully");
    await app.close();
    await engine.browserPool.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(
    { port: env.PORT, host: env.HOST, env: env.NODE_ENV },
    `Blibli Scraper API running at http://${env.HOST}:${env.PORT}`,
  );
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
