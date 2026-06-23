import type { APIRequestContext } from '@playwright/test';

/**
 * Editor seeding helpers — create backing data via the REST API so editor-flow
 * specs can navigate straight to a populated editor (the backend persists
 * through the mesh store, same as the UI).
 */
export async function seedProjectScene(
  request: APIRequestContext,
  opts: { projectName?: string } = {}
): Promise<{ projectId: string; sceneId: string }> {
  const proj = await request.post('/api/projects', {
    data: { name: opts.projectName ?? `E2E ${Date.now()}` },
  });
  const projectId = (await proj.json()).data.id as string;
  // Un-populated scene → predictable node list.
  await request.post(`/api/projects/${projectId}/scenes`, {
    data: { name: 'Scene', populate: false },
  });
  const scenes = await (
    await request.get(`/api/projects/${projectId}/scenes`)
  ).json();
  return { projectId, sceneId: scenes.data.scenes[0].id as string };
}

export async function seedNode(
  request: APIRequestContext,
  sceneId: string,
  name: string,
  kind = 'group'
): Promise<string> {
  const res = await request.post(`/api/scenes/${sceneId}/nodes`, {
    data: { name, kind },
  });
  return (await res.json()).data.id as string;
}

/** The non-scene nodes of a scene (REST read-back for assertions). */
export async function listNodes(
  request: APIRequestContext,
  sceneId: string
): Promise<{ id: string; name: string; kind: string }[]> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  return (await res.json()).data;
}
