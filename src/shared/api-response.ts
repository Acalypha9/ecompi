import { z } from "zod";

export function apiSuccess<T>(data: T, meta?: Record<string, unknown>) {
  return {
    success: true as const,
    data,
    meta: meta ?? null,
    timestamp: new Date().toISOString(),
  };
}

export function apiError(
  message: string,
  code: string,
  statusCode: number,
  details?: unknown,
) {
  return {
    success: false as const,
    error: { message, code, details: details ?? null },
    statusCode,
    timestamp: new Date().toISOString(),
  };
}

export const PaginationQuerySchema = z.object({
  q: z.string().min(1, "Search query is required"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const ProductParamsSchema = z.object({
  slug: z.string().min(1, "Product slug is required"),
});
