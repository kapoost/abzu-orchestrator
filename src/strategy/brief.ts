import { z } from 'zod';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const advertiserSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  domain: z.string().min(1).optional(),
});

const budgetSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217'),
  period: z.enum(['flight', 'daily']).default('flight'),
});

const flightSchema = z
  .object({
    start: z.string().regex(ISO_DATE_RE, 'start must be YYYY-MM-DD'),
    end: z.string().regex(ISO_DATE_RE, 'end must be YYYY-MM-DD'),
  })
  .refine((f) => f.start <= f.end, { message: 'flight.start must be <= flight.end' });

export const briefIntakeSchema = z.object({
  advertiser: advertiserSchema,
  brief: z.string().min(10),
  budget: budgetSchema,
  flight: flightSchema,
  channels: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  audience: z.string().default(''),
  kpis: z.array(z.string()).default([]),
  preferred_delivery_types: z.array(z.enum(['guaranteed', 'non_guaranteed'])).default([]),
  top_n: z.number().int().positive().max(100).default(10),
  time_budget_seconds: z.number().int().positive().max(120).default(30),
});

export type BriefIntake = z.infer<typeof briefIntakeSchema>;

export function parseBrief(raw: unknown): BriefIntake {
  return briefIntakeSchema.parse(raw);
}

export function composeBriefString(intake: BriefIntake): string {
  const parts: string[] = [intake.brief.trim()];
  parts.push(`Advertiser: ${intake.advertiser.name}.`);
  if (intake.audience) parts.push(`Audience: ${intake.audience}.`);
  parts.push(
    `Budget: ${intake.budget.amount} ${intake.budget.currency} (${intake.budget.period}).`,
  );
  parts.push(`Flight: ${intake.flight.start} to ${intake.flight.end}.`);
  if (intake.channels.length > 0) parts.push(`Preferred channels: ${intake.channels.join(', ')}.`);
  if (intake.formats.length > 0) parts.push(`Preferred formats: ${intake.formats.join(', ')}.`);
  if (intake.kpis.length > 0) parts.push(`KPIs: ${intake.kpis.join(', ')}.`);
  return parts.join(' ');
}
