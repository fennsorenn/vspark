import { beforeAll, describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  NumInput,
  VecInput,
  SliderInput,
} from '../src/components/editor/numericInputs';

/**
 * The runtime half of the targeting-layer contract for reusable interactive
 * components (see dev-notes/plans/automated-testing-strategy.md): a `vs-` handle
 * passed at the call site must land on the component's root DOM element, so the
 * control-coverage recorder — which walks UP from the interacted element to the
 * nearest `vs-`-classed ancestor — attributes the interaction to *this* usage.
 *
 * Renders to static markup (no DOM/effects needed — the class is applied on the
 * initial render) and asserts the handle is present.
 */
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { misc: {} } },
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
  });
});

describe('numeric primitives forward a vs- targeting handle', () => {
  test('NumInput → wrapper', () => {
    const html = renderToStaticMarkup(
      <NumInput value={1} className="vs-test-num" />
    );
    expect(html).toContain('vs-test-num');
  });

  test('VecInput → row container', () => {
    const html = renderToStaticMarkup(
      <VecInput values={[0, 0, 0]} className="vs-test-vec" />
    );
    expect(html).toContain('vs-test-vec');
  });

  test('SliderInput → outer container', () => {
    const html = renderToStaticMarkup(
      <SliderInput value={1} min={0} max={10} className="vs-test-slider" />
    );
    expect(html).toContain('vs-test-slider');
  });
});
