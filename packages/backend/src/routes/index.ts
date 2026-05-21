import { Router } from 'express';
import projects from './projects.js';
import scenes from './scenes.js';
import sceneNodes from './scene-nodes.js';
import assets from './assets.js';
import nodeComponents from './node-components.js';
import apiController from './api-controller.js';
import expressions from './expressions.js';
import cameraEffects from './camera-effects.js';
import signal from './signal.js';
import meta from './meta.js';

const router: ReturnType<typeof Router> = Router();
router.use(projects);
router.use(scenes);
router.use(sceneNodes);
router.use(assets);
router.use(nodeComponents);
router.use(apiController);
router.use(expressions);
router.use(cameraEffects);
router.use(signal);
router.use(meta);

export { router as apiRoutes };
export {
  setVmcManager,
  setBreathingManager,
  setLipsyncManager,
  setTrackingManager,
  setApiControllerManager,
  setWsSync,
} from './shared.js';
