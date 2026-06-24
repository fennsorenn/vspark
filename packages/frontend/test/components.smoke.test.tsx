import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, userEvent } from './helpers/render';
import { LanguageSwitcher } from '../src/components/LanguageSwitcher';
import { i18n } from './helpers/render';

/** Smoke test proving the shared render helper (i18n + router providers) works. */
describe('LanguageSwitcher', () => {
  it('renders the supported languages and switches the active language', async () => {
    renderWithProviders(<LanguageSwitcher />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Deutsch' })).toBeTruthy();

    await userEvent.selectOptions(select, 'de');
    expect(i18n.language.split('-')[0]).toBe('de');
    await i18n.changeLanguage('en'); // reset
  });
});
