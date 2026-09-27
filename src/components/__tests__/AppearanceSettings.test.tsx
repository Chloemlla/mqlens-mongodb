import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-with-providers';
import { AppearanceSettings } from '../theme/AppearanceSettings';

describe('AppearanceSettings theme export', () => {
  // jsdom implements neither, so they are installed per test and put back after.
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const events: string[] = [];
  let clicked: HTMLAnchorElement | undefined;
  let blob: Blob | undefined;

  beforeEach(() => {
    events.length = 0;
    clicked = undefined;
    blob = undefined;
    URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
      blob = obj as Blob;
      events.push('create');
      return 'blob:mqlens/theme';
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      events.push(`revoke ${url}`);
    });
    // Record the click instead of letting jsdom attempt a navigation.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      events.push('click');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('does not revoke the blob URL in the same tick as the download click', () => {
    renderWithProviders(<AppearanceSettings />);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Export theme' }));

    // `a.click()` only starts the download, so the URL has to outlive this tick.
    expect(events).toEqual(['create', 'click']);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(clicked?.getAttribute('href')).toBe('blob:mqlens/theme');
    expect(clicked?.download).toBe('mqlens-theme.json');
    expect(blob?.type).toBe('application/json');

    // Still released eventually, so each export does not leak its blob.
    vi.runAllTimers();
    expect(events).toEqual(['create', 'click', 'revoke blob:mqlens/theme']);
  });
});
