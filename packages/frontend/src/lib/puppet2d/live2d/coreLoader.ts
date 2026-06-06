// ---------------------------------------------------------------------------
// Lazy runtime loader for the proprietary Live2D Cubism Core.
//
// IMPORTANT (licensing): vspark deliberately does NOT bundle
// `live2dcubismcore.min.js` in its release artifacts — the Core is proprietary
// (free under Live2D's revenue threshold, paid Publication License above it).
// Instead it is fetched at runtime, on explicit user opt-in, the first time a
// Live2D node is used. Callers MUST have obtained the user's license
// acknowledgment (the opt-in dialog) before invoking `ensureCubismCore`; this
// module only performs the script injection. See
// dev-notes/plans/live2d-integration.md → "Licensing & distribution".
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    // The Core attaches itself here as a global once the script runs. Typed as
    // unknown — the framework adapter narrows it; nothing else should touch it.
    Live2DCubismCore?: unknown;
  }
}

// Live2D's official CDN copy of the Core. Confirm/override during integration;
// users may also point at a self-hosted copy via `CubismCoreLoadOptions.url`.
const DEFAULT_CORE_URL =
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

let corePromise: Promise<void> | null = null;

// Interim opt-in gate. The Core is proprietary and must not be fetched without
// the user accepting the Live2D license. A persistent server-side flag
// (AppConfig.live2dLicenseAccepted) + an acceptance dialog land in Phase 5;
// until then consent is a client-only localStorage flag (set it from a console
// during in-browser verification: localStorage.setItem('vspark.live2d.accepted','1')).
const CONSENT_KEY = 'vspark.live2d.accepted';

export function hasLive2dConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLive2dConsent(accepted: boolean): void {
  try {
    if (accepted) localStorage.setItem(CONSENT_KEY, '1');
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function isCubismCoreLoaded(): boolean {
  return typeof window !== 'undefined' && window.Live2DCubismCore != null;
}

export interface CubismCoreLoadOptions {
  /** Override the script URL (e.g. a user-provided local copy of the Core). */
  url?: string;
}

/**
 * Inject the Cubism Core script and resolve once `window.Live2DCubismCore` is
 * available. Idempotent: an already-loaded Core resolves immediately, and
 * concurrent/repeat calls share a single in-flight load. A failed load clears
 * the cached promise so a later call can retry.
 */
export function ensureCubismCore(
  opts: CubismCoreLoadOptions = {}
): Promise<void> {
  if (isCubismCoreLoaded()) return Promise.resolve();
  if (!hasLive2dConsent())
    return Promise.reject(
      new Error(
        'Live2D Cubism Core not loaded: the Live2D license has not been accepted.'
      )
    );
  if (corePromise) return corePromise;

  const url = opts.url ?? DEFAULT_CORE_URL;
  corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (window.Live2DCubismCore != null) {
        resolve();
      } else {
        corePromise = null;
        reject(
          new Error(
            'Live2D Cubism Core script loaded but window.Live2DCubismCore is undefined'
          )
        );
      }
    };
    script.onerror = () => {
      corePromise = null; // allow a later retry
      reject(new Error(`Failed to load Live2D Cubism Core from ${url}`));
    };
    document.head.appendChild(script);
  });
  return corePromise;
}
