/**
 * The `Progress` feed-template helper: a bar that advances on the page from a
 * published { startedAt, durationMs, isPlaying } (no per-second publishes).
 */
import { describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { compileTemplate, FeedContent, progressFraction } from '../src/lib/feedTemplate';
import { renderWithProviders } from './helpers/render';
import { validateFeedTemplate } from '@vspark/shared/feedValidation';

describe('Progress', () => {
  it('computes the fraction while playing, paused, and without data', () => {
    expect(progressFraction({ startedAt: 1000, durationMs: 10_000, isPlaying: true }, 6000)).toBe(0.5);
    expect(progressFraction({ startedAt: 0, durationMs: 10_000, isPlaying: false, progressMs: 2500 }, 99_999)).toBe(0.25);
    expect(progressFraction({ startedAt: 0, durationMs: 10_000, isPlaying: true }, 50_000)).toBe(1);
    expect(progressFraction(null, 0)).toBe(0);
    expect(progressFraction({ durationMs: 0 }, 0)).toBe(0);
  });

  it('is in scope in templates (renderer and server-side validation) and advances by itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const src = '<${Progress} state=${np} className="bar" />';
    expect(validateFeedTemplate(src)).toBeNull();
    const { render } = compileTemplate(src);
    const np = { startedAt: 0, durationMs: 40_000, isPlaying: true };
    const { container } = renderWithProviders(<FeedContent render={render!} channels={{ np }} />);
    const inner = () => (container.querySelector('.bar > div') as HTMLElement).style.width;
    expect(inner()).toBe('25%');
    act(() => {
      vi.setSystemTime(20_000);
      vi.advanceTimersByTime(300);
    });
    expect(parseFloat(inner())).toBeCloseTo(50.75, 1); // 20 s + the 300 ms advanced
    vi.useRealTimers();
  });
});
