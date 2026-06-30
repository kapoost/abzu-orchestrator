import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envTokenKey, loadSellers, parseSellers } from '../src/orchestrator/sellers.ts';

function withTempFile(contents: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'abzu-sellers-'));
  const path = join(dir, 'sellers.json');
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseSellers', () => {
  test('accepts minimal MCP seller', () => {
    const sellers = parseSellers({
      sellers: [
        {
          id: 'a',
          name: 'A',
          agent_uri: 'https://a.example.com/mcp',
          protocol: 'mcp',
        },
      ],
    });
    expect(sellers).toHaveLength(1);
    expect(sellers[0]!.id).toBe('a');
  });

  test('rejects empty seller list', () => {
    expect(() => parseSellers({ sellers: [] })).toThrow();
  });

  test('rejects bad URL', () => {
    expect(() =>
      parseSellers({
        sellers: [{ id: 'a', name: 'A', agent_uri: 'not-a-url', protocol: 'mcp' }],
      }),
    ).toThrow();
  });

  test('rejects unknown protocol', () => {
    expect(() =>
      parseSellers({
        sellers: [
          { id: 'a', name: 'A', agent_uri: 'https://a.example.com/mcp', protocol: 'rest' },
        ],
      }),
    ).toThrow();
  });

  test('accepts optional headers and auth_token', () => {
    const sellers = parseSellers({
      sellers: [
        {
          id: 'a',
          name: 'A',
          agent_uri: 'https://a.example.com/mcp',
          protocol: 'mcp',
          auth_token: 'tok',
          headers: { 'x-org-id': 'org-1' },
        },
      ],
    });
    expect(sellers[0]!.auth_token).toBe('tok');
    expect(sellers[0]!.headers).toEqual({ 'x-org-id': 'org-1' });
  });
});

describe('loadSellers', () => {
  test('reads and validates a file', () => {
    withTempFile(
      JSON.stringify({
        sellers: [
          { id: 'a', name: 'A', agent_uri: 'https://a.example.com/mcp', protocol: 'mcp' },
        ],
      }),
      (path) => {
        const sellers = loadSellers(path);
        expect(sellers).toHaveLength(1);
      },
    );
  });

  test('rejects duplicate seller ids', () => {
    withTempFile(
      JSON.stringify({
        sellers: [
          { id: 'a', name: 'A', agent_uri: 'https://a.example.com/mcp', protocol: 'mcp' },
          { id: 'a', name: 'B', agent_uri: 'https://b.example.com/mcp', protocol: 'mcp' },
        ],
      }),
      (path) => {
        expect(() => loadSellers(path)).toThrow(/duplicate seller id/);
      },
    );
  });

  test('env override injects auth_token by seller id', () => {
    withTempFile(
      JSON.stringify({
        sellers: [
          {
            id: 'purrsonality-seller',
            name: 'P',
            agent_uri: 'https://p.example.com/mcp',
            protocol: 'mcp',
          },
        ],
      }),
      (path) => {
        const sellers = loadSellers(path, {
          SELLER_PURRSONALITY_SELLER_AUTH_TOKEN: 'tok-123',
        } as unknown as NodeJS.ProcessEnv);
        expect(sellers[0]!.auth_token).toBe('tok-123');
      },
    );
  });
});

describe('tags', () => {
  test('applies empty default tags when absent', () => {
    const sellers = parseSellers({
      sellers: [{ id: 'a', name: 'A', agent_uri: 'https://a.example.com/mcp', protocol: 'mcp' }],
    });
    expect(sellers[0]!.tags).toEqual({ countries: [], categories: [], languages: [] });
  });

  test('accepts ISO country codes and category strings', () => {
    const sellers = parseSellers({
      sellers: [
        {
          id: 'a',
          name: 'A',
          agent_uri: 'https://a.example.com/mcp',
          protocol: 'mcp',
          tags: { countries: ['US', 'PL'], categories: ['ctv'], languages: ['en'] },
        },
      ],
    });
    expect(sellers[0]!.tags.countries).toEqual(['US', 'PL']);
  });

  test('rejects non-ISO country code', () => {
    expect(() =>
      parseSellers({
        sellers: [
          {
            id: 'a',
            name: 'A',
            agent_uri: 'https://a.example.com/mcp',
            protocol: 'mcp',
            tags: { countries: ['usa'] },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('envTokenKey', () => {
  test('uppercases and replaces non-alphanumerics', () => {
    expect(envTokenKey('purrsonality-seller')).toBe('SELLER_PURRSONALITY_SELLER_AUTH_TOKEN');
    expect(envTokenKey('a.b')).toBe('SELLER_A_B_AUTH_TOKEN');
  });
});
