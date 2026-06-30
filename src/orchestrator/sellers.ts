import { readFileSync } from 'node:fs';
import { z } from 'zod';

const sellerTagsSchema = z
  .object({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')).default([]),
    categories: z.array(z.string().min(1)).default([]),
    languages: z.array(z.string().min(1)).default([]),
  })
  .default({ countries: [], categories: [], languages: [] });

const sellerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agent_uri: z.url(),
  protocol: z.enum(['mcp', 'a2a']),
  auth_token: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tags: sellerTagsSchema,
});

export type SellerTags = z.infer<typeof sellerTagsSchema>;

const sellersFileSchema = z.object({
  sellers: z.array(sellerConfigSchema).min(1),
});

export type SellerConfig = z.infer<typeof sellerConfigSchema>;

export function loadSellers(
  path: string,
  envSource: NodeJS.ProcessEnv = process.env,
): SellerConfig[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = sellersFileSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const seller of parsed.sellers) {
    if (ids.has(seller.id)) {
      throw new Error(`duplicate seller id: ${seller.id}`);
    }
    ids.add(seller.id);
  }
  return parsed.sellers.map((seller) => applyEnvOverrides(seller, envSource));
}

export function parseSellers(raw: unknown): SellerConfig[] {
  return sellersFileSchema.parse(raw).sellers;
}

export function envTokenKey(id: string): string {
  return `SELLER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AUTH_TOKEN`;
}

function applyEnvOverrides(seller: SellerConfig, env: NodeJS.ProcessEnv): SellerConfig {
  const override = env[envTokenKey(seller.id)];
  if (!override) return seller;
  return { ...seller, auth_token: override };
}
