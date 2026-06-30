import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

type Validation =
  | { check: 'http_status'; value: number; description?: string }
  | { check: 'field_present'; path: string; description?: string }
  | { check: 'field_value'; path: string; value: unknown; description?: string }
  | { check: 'field_value_min'; path: string; value: number; description?: string }
  | { check: 'not_field_present'; path: string; description?: string }
  | { check: 'error_code'; allowed_values: string[]; description?: string };

type Capture = { name: string; from: string };

type Step = {
  id: string;
  title?: string;
  http_method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  http_path: string;
  request_body?: unknown;
  validations?: Validation[];
  captures?: Capture[];
  expected?: string;
};

type Phase = { id: string; title?: string; steps: Step[] };

type Storyboard = {
  id: string;
  title?: string;
  category?: string;
  skip_live?: boolean;
  phases: Phase[];
};

export type StoryboardContext = {
  baseUrl: string;
  context: Record<string, string | number>;
};

export type ValidationResult = {
  validation: Validation;
  ok: boolean;
  detail?: string;
};

export type StepResult = {
  step_id: string;
  http_status: number;
  ok: boolean;
  validations: ValidationResult[];
};

export type StoryboardResult = {
  storyboard_id: string;
  ok: boolean;
  steps: StepResult[];
};

export type StoryboardOutcome =
  | { storyboard_name: string; storyboard_id: string; status: 'skipped'; reason: string }
  | { storyboard_name: string; storyboard_id: string; status: 'passed' | 'failed'; result: StoryboardResult };

export function loadStoryboard(path: string): Storyboard {
  const raw = readFileSync(path, 'utf8');
  return parseYaml(raw) as Storyboard;
}

export async function runStoryboard(
  storyboard: Storyboard,
  ctx: StoryboardContext,
): Promise<StoryboardResult> {
  const captures: Record<string, unknown> = {};
  const steps: StepResult[] = [];
  let ok = true;

  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      const stepResult = await runStep(step, ctx, captures);
      steps.push(stepResult);
      if (!stepResult.ok) {
        ok = false;
      }
    }
  }

  return { storyboard_id: storyboard.id, ok, steps };
}

async function runStep(
  step: Step,
  ctx: StoryboardContext,
  captures: Record<string, unknown>,
): Promise<StepResult> {
  const path = substituteString(step.http_path, ctx, captures);
  const body =
    step.request_body !== undefined
      ? deepSubstitute(step.request_body, ctx, captures)
      : undefined;

  const init: RequestInit = { method: step.http_method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }

  const response = await fetch(`${ctx.baseUrl}${path}`, init);
  let parsed: unknown = null;
  try {
    const text = await response.text();
    if (text) parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const validations = (step.validations ?? []).map((v) =>
    runValidation(deepSubstitute(v, ctx, captures) as Validation, response.status, parsed),
  );
  const ok = validations.every((v) => v.ok);

  if (ok) {
    for (const capture of step.captures ?? []) {
      captures[capture.name] = getPath(parsed, capture.from);
    }
  }

  return { step_id: step.id, http_status: response.status, ok, validations };
}

export function runValidation(
  validation: Validation,
  httpStatus: number,
  body: unknown,
): ValidationResult {
  switch (validation.check) {
    case 'http_status': {
      const ok = httpStatus === validation.value;
      return {
        validation,
        ok,
        detail: ok ? undefined : `got ${httpStatus}, want ${validation.value}`,
      };
    }
    case 'field_present': {
      const value = getPath(body, validation.path);
      const ok = value !== undefined && value !== null;
      return {
        validation,
        ok,
        detail: ok ? undefined : `path "${validation.path}" missing`,
      };
    }
    case 'field_value': {
      const value = getPath(body, validation.path);
      const ok = deepEqual(value, validation.value);
      return {
        validation,
        ok,
        detail: ok ? undefined : `path "${validation.path}" = ${JSON.stringify(value)} want ${JSON.stringify(validation.value)}`,
      };
    }
    case 'field_value_min': {
      const value = getPath(body, validation.path);
      if (typeof value !== 'number') {
        return { validation, ok: false, detail: `path "${validation.path}" not a number (${typeof value})` };
      }
      const ok = value >= validation.value;
      return {
        validation,
        ok,
        detail: ok ? undefined : `path "${validation.path}" = ${value} < ${validation.value}`,
      };
    }
    case 'not_field_present': {
      const value = getPath(body, validation.path);
      const ok = value === undefined || value === null;
      return {
        validation,
        ok,
        detail: ok ? undefined : `path "${validation.path}" unexpectedly present`,
      };
    }
    case 'error_code': {
      const code =
        getPath(body, 'code') ?? getPath(body, 'error.code') ?? getPath(body, 'adcp_error.code');
      if (typeof code !== 'string') {
        return { validation, ok: false, detail: 'no error code on response' };
      }
      const ok = validation.allowed_values.includes(code);
      return {
        validation,
        ok,
        detail: ok ? undefined : `code "${code}" not in ${JSON.stringify(validation.allowed_values)}`,
      };
    }
  }
}

export function getPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (path === '') return obj;
  const segments = parsePath(path);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (seg === 'length' && Array.isArray(current)) {
      current = current.length;
      continue;
    }
    if (Array.isArray(current) && /^\d+$/.test(seg)) {
      current = current[Number(seg)];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return current;
}

function parsePath(path: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '.') {
      if (buf) out.push(buf);
      buf = '';
    } else if (c === '[') {
      if (buf) out.push(buf);
      buf = '';
      const end = path.indexOf(']', i);
      if (end === -1) throw new Error(`unterminated [ in path: ${path}`);
      out.push(path.slice(i + 1, end));
      i = end;
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function deepSubstitute(
  value: unknown,
  ctx: StoryboardContext,
  captures: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') return substituteString(value, ctx, captures);
  if (Array.isArray(value)) return value.map((v) => deepSubstitute(v, ctx, captures));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSubstitute(v, ctx, captures);
    }
    return out;
  }
  return value;
}

const SUBSTITUTION_RE = /^\$(context|captures)\.([\w.[\]]+)$/;

function substituteString(
  value: string,
  ctx: StoryboardContext,
  captures: Record<string, unknown>,
): string | unknown {
  const fullMatch = SUBSTITUTION_RE.exec(value);
  if (fullMatch) {
    const [, scope, key] = fullMatch;
    const source = scope === 'context' ? ctx.context : captures;
    const resolved = getPath(source, key!);
    return resolved === undefined ? value : (resolved as unknown);
  }
  return value.replace(/\$(context|captures)\.([\w.[\]]+)/g, (_, scope: string, key: string) => {
    const source = scope === 'context' ? ctx.context : captures;
    const resolved = getPath(source, key);
    return resolved === undefined ? `$${scope}.${key}` : String(resolved);
  });
}

export function summarizeOutcome(outcome: StoryboardOutcome): {
  status: string;
  steps: number;
  validations: string;
} {
  if (outcome.status === 'skipped') {
    return { status: 'SKIP', steps: 0, validations: '—' };
  }
  const stepCount = outcome.result.steps.length;
  let totalValidations = 0;
  let passedValidations = 0;
  for (const step of outcome.result.steps) {
    totalValidations += step.validations.length;
    passedValidations += step.validations.filter((v) => v.ok).length;
  }
  return {
    status: outcome.result.ok ? 'PASS' : 'FAIL',
    steps: stepCount,
    validations: `${passedValidations}/${totalValidations}`,
  };
}

export function formatMatrix(outcomes: StoryboardOutcome[]): string {
  const nameWidth = Math.max(20, ...outcomes.map((o) => o.storyboard_name.length));
  const rows: string[] = [];
  const header = `${'Storyboard'.padEnd(nameWidth)}  Result  Steps  Validations`;
  rows.push(header);
  rows.push('-'.repeat(header.length));
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const o of outcomes) {
    const s = summarizeOutcome(o);
    if (s.status === 'PASS') passed++;
    else if (s.status === 'FAIL') failed++;
    else skipped++;
    rows.push(
      `${o.storyboard_name.padEnd(nameWidth)}  ${s.status.padEnd(6)}  ${String(s.steps).padStart(5)}  ${s.validations}`,
    );
  }
  rows.push('');
  rows.push(`Summary: ${passed}/${passed + failed} runnable PASS (${skipped} skipped)`);
  return rows.join('\n');
}

export function formatReport(result: StoryboardResult): string {
  const lines: string[] = [];
  lines.push(`storyboard: ${result.storyboard_id}`);
  lines.push(`overall: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const step of result.steps) {
    const passed = step.validations.filter((v) => v.ok).length;
    const total = step.validations.length;
    const tag = step.ok ? 'pass' : 'fail';
    lines.push(`  [${tag}] ${step.step_id} (HTTP ${step.http_status}, validations ${passed}/${total})`);
    for (const v of step.validations) {
      if (v.ok) continue;
      lines.push(`     ✗ ${v.validation.check} :: ${v.detail ?? '(no detail)'}`);
    }
  }
  return lines.join('\n');
}
