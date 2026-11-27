import { EventEmitter } from 'node:events';

/** Project lifecycle for plugins (`ctx.projects`). Emitted by the project
 *  routes; plugins learn about projects created / deleted while running. */
export const projectEvents = new EventEmitter();
projectEvents.setMaxListeners(0);

export const emitProjectCreated = (id: string) => projectEvents.emit('created', id);
export const emitProjectDeleted = (id: string) => projectEvents.emit('deleted', id);
