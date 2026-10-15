import { createFofSessionHost, type HostIn } from './session-host';

// The Force-on-Force Lab's simulation worker (docs/behavior-lab/force-on-force/05):
// the session host, on its own thread, so the page keeps drawing whatever
// the simulation costs.

const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<HostIn>) => void) | null;
};

const host = createFofSessionHost((batch, transfer) => {
  scope.postMessage(batch, transfer);
});
scope.onmessage = (e) => {
  host.receive(e.data);
};
