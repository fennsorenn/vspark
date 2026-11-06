import { createContext, useContext, type ReactNode } from 'react';

/** Is this node — and every node above it — visible? A hidden node skips its
 *  per-frame work (animation, Live2D, particles, material passes), not only
 *  its drawing: hidden, a Live2D model still redrew every frame and filled the
 *  main thread (2026-10-04). Provided per node by `NodeActive`. */
const NodeActiveContext = createContext(true);

export function NodeActive({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const parent = useContext(NodeActiveContext);
  return (
    <NodeActiveContext.Provider value={parent && visible}>
      {children}
    </NodeActiveContext.Provider>
  );
}

export const useNodeActive = (): boolean => useContext(NodeActiveContext);
