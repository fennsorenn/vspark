import { render, type RenderOptions } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import i18n from '../../src/i18n';

/**
 * Render an editor component with the providers most of them assume: the real
 * app i18n instance (so `useTranslation` returns actual EN strings) and a
 * MemoryRouter (so `useNavigate`/`useParams` work). Components that also need
 * the confirm-dialog context can wrap their subtree in `<DialogProvider>`
 * themselves.
 *
 * Re-exports the Testing Library surface + `userEvent`, so specs import
 * everything from here.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, { wrapper: Providers, ...options });
}

export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
export { i18n };
