/**
 * Feed consumers see GLOBAL ∪ their PROJECT's ∪ their OWN data fields; a
 * project's fields (e.g. a plugin's) never reach another project's feeds.
 */
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from './helpers/render';
import { testPeer } from './helpers/mesh';
import { projectDataScope, useFeedFields } from '../src/mesh/runtime';

const put = (scope: string, field: string, value: unknown, n: number) =>
  testPeer()
    .collection<Record<string, unknown>>('data_field')
    .put({ id: `${scope}:${field}`, scope, scopeKind: null, field, value }, { v: { t: n, c: 0, n: 'seed' } });

function Show({ projectId, own }: { projectId: string; own: string }) {
  return <pre>{JSON.stringify(useFeedFields(projectId, own))}</pre>;
}

describe('feed field scopes', () => {
  it('merges global < project < own and isolates projects', () => {
    put('', 'title', 'global', 1);
    put('', 'shared', 'g', 2);
    put(projectDataScope('A'), 'title', 'project A', 3);
    put(projectDataScope('B'), 'secret', 'project B only', 4);
    put('layer-1', 'shared', 'own', 5);
    const a = renderWithProviders(<Show projectId="A" own="layer-1" />);
    expect(JSON.parse(a.container.textContent!)).toEqual({ title: 'project A', shared: 'own' });
    const b = renderWithProviders(<Show projectId="B" own="layer-2" />);
    expect(JSON.parse(b.container.textContent!)).toEqual({ title: 'global', shared: 'g', secret: 'project B only' });
  });
});
