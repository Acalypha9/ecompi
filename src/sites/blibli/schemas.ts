import { z } from "zod";

export const BlibliProductSchema = z.object({
  id: z.string().catch(""),
  sku: z.string().catch(""),
  name: z.string(),
  brand: z.string().catch(""),
  url: z.string().catch(""),
  price: z
    .object({
      listed: z.number().catch(0),
      offered: z.number().catch(0),
      discount: z.number().catch(0),
      currency: z.string().catch("IDR"),
    })
    .catch({ listed: 0, offered: 0, discount: 0, currency: "IDR" }),
  images: z.array(z.string()).catch([]),
  rating: z.number().catch(0),
  reviewCount: z.number().catch(0),
  soldCount: z.number().catch(0),
  location: z.string().catch(""),
  merchant: z
    .object({
      name: z.string().catch(""),
      id: z.string().catch(""),
    })
    .catch({ name: "", id: "" }),
  badges: z.array(z.string()).catch([]),
});

export type BlibliProduct = z.infer<typeof BlibliProductSchema>;

export const BlibliProductDetailSchema = BlibliProductSchema.extend({
  description: z.string().catch(""),
  features: z.array(z.string()).catch([]),
  topSection: z.string().catch(""),
  specifications: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      }),
    )
    .catch([]),
  variants: z
    .array(
      z.object({
        name: z.string().catch(""),
        sku: z.string().catch(""),
        price: z.number().catch(0),
        stock: z.number().catch(0),
        attributes: z.record(z.string(), z.string()).catch({}),
      }),
    )
    .catch([]),
  stock: z.number().catch(0),
  weight: z.string().catch(""),
  category: z
    .object({
      id: z.string().catch(""),
      name: z.string().catch(""),
      path: z.array(z.string()).catch([]),
    })
    .catch({ id: "", name: "", path: [] }),
});

export type BlibliProductDetail = z.infer<typeof BlibliProductDetailSchema>;

export interface BlibliCategory {
  id: string;
  name: string;
  url: string;
  children: BlibliCategory[];
}

const baseCategorySchema = z.object({
  id: z.string().default(""),
  name: z.string().default(""),
  url: z.string().default(""),
});

export const BlibliCategorySchema: z.ZodType<BlibliCategory> = baseCategorySchema.extend({
  children: z.lazy(() => z.array(BlibliCategorySchema)).default([]),
}) as z.ZodType<BlibliCategory>;

export const SearchResultSchema = z.object({
  products: z.array(BlibliProductSchema),
  pagination: z.object({
    currentPage: z.number(),
    totalPages: z.number(),
    totalItems: z.number(),
    itemsPerPage: z.number(),
  }),
  keyword: z.string(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;
