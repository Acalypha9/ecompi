import type { FastifyInstance } from "fastify";
import { ScraperEngine } from "../core/engine.js";
import { registerBlibliRoutes } from "./blibli/routes.js";

export function registerAllSites(
  app: FastifyInstance,
  engine: ScraperEngine,
): void {
  // Register Blibli module with prefix
  app.register(
    async (instance) => {
      registerBlibliRoutes(instance, engine);
    },
    { prefix: "/api/blibli" },
  );

  // Future modules can be registered here:
  // app.register(async (instance) => {
  //   registerTokopediaRoutes(instance, engine);
  // }, { prefix: "/api/tokopedia" });
}
