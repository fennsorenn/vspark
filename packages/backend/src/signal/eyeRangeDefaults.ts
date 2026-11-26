/** Default physical eye range (degrees): a tracked eye turned this far maps to
 *  the model's full eye range. (Decided by the user, 2026-10-06.)
 *
 *  Its own dependency-free module so the behavior templates (which migration
 *  047 imports from the database layer) can read it without importing the
 *  `eye_range_map` node — whose VRM lookups reach back into the database and
 *  the mesh, and would close an import cycle through the node registry. */
export const DEFAULT_EYE_INPUT_MAX_DEG = 30;
