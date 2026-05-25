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
import { jobStore } from "../../core/job-store.js";

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

  app.get<{ Params: { '*': string } }>(
    "/products/*",
    async (req, reply) => {
      const slug = req.params['*'];
      
      if (!slug) {
        return reply
          .status(400)
          .send(apiError("Product identifier is required", "BAD_REQUEST", 400));
      }

      const product = await productService.getDetail(slug);

      if (!product.name) {
        return reply
          .status(404)
          .send(apiError("Product not found", "NOT_FOUND", 404));
      }

      return reply.send(apiSuccess(product));
    },
  );

  app.post<{ Body: { slug: string } }>("/scrape-detail", async (req, reply) => {
    const { slug } = req.body;
    
    if (!slug || !/(?:^|\/)(ps|is)--[A-Za-z0-9-]+$/.test(slug)) {
      return reply.status(400).send(apiError("Invalid slug format. Must contain a valid SKU segment (ps--XXX or is--XXX)", "BAD_REQUEST", 400));
    }
    
    const job = jobStore.createJob(slug);
    
    setImmediate(async () => {
      jobStore.updateJob(job.id, { status: 'processing' });
      try {
        const product = await productService.getDetail(slug);
        if (!product.name) {
          jobStore.updateJob(job.id, { status: 'failed', error: 'Product not found' });
        } else {
          jobStore.updateJob(job.id, { status: 'completed', result: product });
        }
      } catch (err) {
        jobStore.updateJob(job.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error'
        });
      }
    });

    return reply.status(202).send(apiSuccess({ jobId: job.id, status: 'pending' }));
  });

  app.get<{ Params: { id: string } }>("/scrape-detail/jobs/:id", async (req, reply) => {
    const job = jobStore.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send(apiError("Job not found", "NOT_FOUND", 404));
    }

    if (job.status === 'completed') {
      return reply.send(apiSuccess({ job: { id: job.id, status: job.status, result: job.result } }));
    }
    if (job.status === 'failed') {
      return reply.status(502).send(apiError(job.error || 'Scrape failed', 'SCRAPE_FAILED', 502));
    }

    return reply.status(200).send(apiSuccess({ job: { id: job.id, status: job.status } }));
  });

  app.get("/categories", async (_req, reply) => {
    const categories = await categoryService.getCategories();
    return reply.send(apiSuccess(categories));
  });
}
