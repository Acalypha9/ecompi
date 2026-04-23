import type { FastifyInstance } from "fastify";
import {
  PaginationQuerySchema,
  ProductParamsSchema,
  apiSuccess,
  apiError,
} from "../../shared/api-response.js";
import { SearchService } from "./services/search.js";
import { ProductService } from "./services/product.js";
import { CategoryService } from "./services/category.js";
import { ScraperEngine } from "../../core/engine.js";

export function registerBlibliRoutes(
  app: FastifyInstance,
  engine: ScraperEngine,
): void {
  const searchService = new SearchService(engine.browserPool, engine.cache);
  const productService = new ProductService(engine.browserPool, engine.cache);
  const categoryService = new CategoryService(engine.browserPool, engine.cache);

  app.get("/search", async (req, reply) => {
    const query = PaginationQuerySchema.parse(req.query);
    const result = await searchService.search(query.q, query.page, query.limit);
    return reply.send(apiSuccess(result));
  });

  app.get<{ Params: { slug: string } }>(
    "/products/:slug",
    async (req, reply) => {
      const params = ProductParamsSchema.parse(req.params);
      const product = await productService.getDetail(params.slug);

      if (!product.name) {
        return reply
          .status(404)
          .send(apiError("Product not found", "NOT_FOUND", 404));
      }

      return reply.send(apiSuccess(product));
    },
  );

  app.get("/categories", async (_req, reply) => {
    const categories = await categoryService.getCategories();
    return reply.send(apiSuccess(categories));
  });
}
