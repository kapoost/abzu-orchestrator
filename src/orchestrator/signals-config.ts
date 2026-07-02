import { readFileSync } from 'node:fs';
import { z } from 'zod';

const signalsTagsSchema = z
  .object({
    specialisms: z.array(z.string().min(1)).default([]),
    categories: z.array(z.string().min(1)).default([]),
  })
  .default({ specialisms: [], categories: [] });

const signalsAgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agent_uri: z.url(),
  protocol: z.enum(['mcp', 'a2a']),
  auth_token: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tags: signalsTagsSchema,
});

const signalsFileSchema = z.object({
  signals: z.array(signalsAgentConfigSchema).min(1),
});

export type SignalsAgentConfig = z.infer<typeof signalsAgentConfigSchema>;

export function loadSignalsAgents(
  path: string,
  envSource: NodeJS.ProcessEnv = process.env,
): SignalsAgentConfig[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = signalsFileSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const s of parsed.signals) {
    if (ids.has(s.id)) throw new Error(`duplicate signals agent id: ${s.id}`);
    ids.add(s.id);
  }
  return parsed.signals.map((s) => applyEnvOverrides(s, envSource));
}

export function signalsEnvTokenKey(id: string): string {
  return `SIGNALS_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AUTH_TOKEN`;
}

function applyEnvOverrides(s: SignalsAgentConfig, env: NodeJS.ProcessEnv): SignalsAgentConfig {
  const override = env[signalsEnvTokenKey(s.id)];
  if (!override) return s;
  return { ...s, auth_token: override };
}
