import { z } from 'zod';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const brandRefSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i),
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

export const buyIntakeSchema = z
  .object({
    seller_id: z.string().min(1),
    plan_id: z.string().min(1),
    account: accountSchema,
    brand: brandRefSchema,
    product_id: z.string().min(1),
    pricing_option_id: z.string().min(1),
    budget: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217'),
    flight: z
      .object({
        start: z.string().regex(ISO_DATETIME_RE, 'start must be ISO 8601 datetime'),
        end: z.string().regex(ISO_DATETIME_RE, 'end must be ISO 8601 datetime'),
      })
      .refine((f) => f.start <= f.end, { message: 'flight.start must be <= flight.end' }),
    creative_ids: z.array(z.string().min(1)).default([]),
    accept_conditions: z.boolean().default(false),
  })
  .strict();

export type BuyIntake = z.infer<typeof buyIntakeSchema>;

export function parseBuyIntake(raw: unknown): BuyIntake {
  return buyIntakeSchema.parse(raw);
}
