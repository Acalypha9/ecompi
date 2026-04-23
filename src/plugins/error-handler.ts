import type { FastifyInstance, FastifyError } from "fastify";
import { ZodError } from "zod";
import { RetryError } from "../utils/retry.js";
import { logger } from "../utils/logger.js";
import { apiError } from "../shared/api-response.js";

export const errorHandler = (error: FastifyError, _request: any, reply: any) => {
  logger.error({ err: error }, "Request error");

  if (error instanceof ZodError) {
    return reply.status(400).send(
      apiError(
        "Validation error",
        "VALIDATION_ERROR",
        400,
        error.flatten().fieldErrors,
      ),
    );
  }

  if (error instanceof RetryError) {
    const inner = error.lastError;
    const innerMsg = inner instanceof Error ? inner.message : String(inner);

    if (innerMsg.includes("blocked") || innerMsg.includes("403")) {
      return reply.status(503).send(
        apiError(
          "Target site blocked the request. Try again later or configure a proxy.",
          "BLOCKED",
          503,
        ),
      );
    }

    return reply.status(502).send(
      apiError(
        `Scraping failed after ${error.attempts} attempts: ${innerMsg}`,
        "SCRAPE_FAILED",
        502,
      ),
    );
  }

  if (error.statusCode === 429) {
    return reply.status(429).send(
      apiError("Rate limit exceeded", "RATE_LIMITED", 429),
    );
  }

  const statusCode = error.statusCode ?? 500;
  return reply.status(statusCode).send(
    apiError(
      error.message || "Internal server error",
      "INTERNAL_ERROR",
      statusCode,
    ),
  );
};
