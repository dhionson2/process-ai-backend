import { AsyncLocalStorage } from 'node:async_hooks';

/** Identity of the caller for the current request; asynchronous turns keep it while they continue in background. */
export type RequestPrincipal = { tenantId: string; subject: string; roles: string[] };

const storage = new AsyncLocalStorage<RequestPrincipal>();

export const requestContext = {
  enter(principal: RequestPrincipal): void { storage.enterWith(principal); },
  run<T>(principal: RequestPrincipal, work: () => T): T { return storage.run(principal, work); },
  current(): RequestPrincipal | undefined { return storage.getStore(); },
};
