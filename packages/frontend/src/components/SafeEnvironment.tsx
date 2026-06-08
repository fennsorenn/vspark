import { Suspense, Component, type ReactNode } from 'react';
import { Environment } from '@react-three/drei';

/**
 * Image-based lighting that can never white-screen the app.
 *
 * drei's `<Environment preset>` fetches the HDR from a remote CDN, so an
 * offline / firewalled / CDN-down load throws — and because it suspends, that
 * throw propagates to the nearest error boundary, which for a bare `<Canvas>`
 * means the whole React tree unmounts to a blank page. We isolate it behind its
 * own Suspense + error boundary and degrade to a hemisphere light, so the scene
 * stays lit and the editor/viewer stays usable when the map can't load.
 *
 * Use this in place of drei's `<Environment>` everywhere inside a `<Canvas>`.
 */
class EnvironmentBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function SafeEnvironment(
  props: React.ComponentProps<typeof Environment>
) {
  const fallback = <hemisphereLight args={[0xffffff, 0x444444, 0.6]} />;
  return (
    <EnvironmentBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <Environment {...props} />
      </Suspense>
    </EnvironmentBoundary>
  );
}
