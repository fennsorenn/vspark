import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiUrl, chatCompletion, fetchFirstModel } from '../src/assistant/llm.js';

describe('apiUrl', () => {
  it.each([
    ['https://host', 'https://host/v1/models'],
    ['https://host/', 'https://host/v1/models'],
    ['https://host/v1', 'https://host/v1/models'],
    ['https://host/v1/', 'https://host/v1/models'],
    ['  https://host/proxy/v1  ', 'https://host/proxy/v1/models'],
  ])('%s → %s', (base, expected) => {
    expect(apiUrl(base, 'models')).toBe(expected);
  });

  it('only strips a final /v1 path segment', () => {
    expect(apiUrl('https://host/v10', 'models')).toBe('https://host/v10/v1/models');
  });
});

describe('LLM requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never doubles /v1 when the configured base URL includes it', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.endsWith('/models')
          ? { data: [{ id: 'm' }] }
          : { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );

    await fetchFirstModel('https://host/v1');
    await chatCompletion({ baseUrl: 'https://host/v1/', model: 'm' }, [], []);

    expect(urls).toEqual([
      'https://host/v1/models',
      'https://host/v1/chat/completions',
    ]);
  });
});
