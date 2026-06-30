import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatMatrix,
  formatReport,
  loadStoryboard,
  runStoryboard,
  type StoryboardOutcome,
} from './runner.ts';

const STORYBOARDS_DIR = import.meta.dir;
const BASE_URL = process.env.ABZU_BASE_URL ?? 'http://localhost:8787';

function usage(): never {
  console.error('usage:');
  console.error('  bun run storyboard <name>   — run a single storyboard');
  console.error('  bun run storyboard all      — run every *.yaml in parallel, matrix summary');
  process.exit(2);
}

function discoverNames(): string[] {
  return readdirSync(STORYBOARDS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

function planIdFor(name: string): string {
  return `storyboard_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runOne(name: string): Promise<StoryboardOutcome> {
  const path = resolve(STORYBOARDS_DIR, `${name}.yaml`);
  const storyboard = loadStoryboard(path);
  if (storyboard.skip_live) {
    return {
      storyboard_name: name,
      storyboard_id: storyboard.id,
      status: 'skipped',
      reason: 'skip_live=true',
    };
  }
  const result = await runStoryboard(storyboard, {
    baseUrl: BASE_URL,
    context: { plan_id: planIdFor(name), abzu_base_url: BASE_URL },
  });
  return {
    storyboard_name: name,
    storyboard_id: storyboard.id,
    status: result.ok ? 'passed' : 'failed',
    result,
  };
}

const target = process.argv[2];
if (!target) usage();

if (target === 'all') {
  const names = discoverNames();
  const outcomes = await Promise.all(names.map(runOne));
  console.log(formatMatrix(outcomes));
  for (const o of outcomes) {
    if (o.status === 'failed') {
      console.log();
      console.log(formatReport(o.result));
    }
  }
  const anyFailed = outcomes.some((o) => o.status === 'failed');
  process.exit(anyFailed ? 1 : 0);
} else {
  const outcome = await runOne(target);
  if (outcome.status === 'skipped') {
    console.log(`storyboard: ${outcome.storyboard_id}`);
    console.log(`SKIPPED (${outcome.reason})`);
    process.exit(0);
  }
  console.log(formatReport(outcome.result));
  process.exit(outcome.result.ok ? 0 : 1);
}
