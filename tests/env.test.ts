import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../src/env.ts';

describe('loadEnv', () => {
  test('applies defaults when env is empty', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe(8787);
    expect(env.NODE_ENV).toBe('development');
  });

  test('coerces PORT from string', () => {
    const env = loadEnv({ PORT: '9090' } as unknown as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(9090);
  });

  test('rejects invalid NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});
