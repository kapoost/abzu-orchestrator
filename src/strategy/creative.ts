import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const brandRefSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i),
  brand_id: z.string().min(1).optional(),
});

const accountSchema = z.union([
  z.object({ account_id: z.string().min(1) }).strict(),
  z
    .object({
      brand: brandRefSchema,
      operator: z
        .string()
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i),
      sandbox: z.boolean().default(false),
    })
    .strict(),
]);

const creativeAssetPassthroughSchema = z
  .object({
    creative_id: z.string().min(1),
    name: z.string().min(1),
  })
  .passthrough();

export const creativeSyncSchema = z
  .object({
    seller_id: z.string().min(1),
    account: accountSchema,
    creatives: z.array(creativeAssetPassthroughSchema).min(1),
    dry_run: z.boolean().default(false),
    idempotency_key: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{16,255}$/)
      .optional(),
  })
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < val.creatives.length; i++) {
      const id = val.creatives[i]!.creative_id;
      if (ids.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['creatives', i, 'creative_id'],
          message: `duplicate creative_id: ${id}`,
        });
      }
      ids.add(id);
    }
  });

export type CreativeSyncInput = z.infer<typeof creativeSyncSchema>;

export function parseCreativeSync(raw: unknown): CreativeSyncInput {
  return creativeSyncSchema.parse(raw);
}

export function ensureIdempotencyKey(input: CreativeSyncInput): CreativeSyncInput {
  if (input.idempotency_key) return input;
  return { ...input, idempotency_key: `abzu_${randomUUID().replace(/-/g, '')}` };
}

const creativeStatusQuerySchema = z
  .object({
    seller_id: z.string().min(1),
    creative_ids: z
      .array(z.string().min(1))
      .max(200)
      .default([]),
    statuses: z
      .array(
        z.enum([
          'processing',
          'pending_review',
          'approved',
          'suspended',
          'rejected',
          'archived',
        ]),
      )
      .default([]),
  })
  .strict();

export type CreativeStatusQuery = z.infer<typeof creativeStatusQuerySchema>;

export function parseStatusQuery(raw: unknown): CreativeStatusQuery {
  return creativeStatusQuerySchema.parse(raw);
}
