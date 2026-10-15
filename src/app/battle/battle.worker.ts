import { createBattleHost, type HostIn } from './battle-host';

// The battle worker (docs/constructive-simulation/04): the battle host on its
// own thread, so the page keeps drawing whatever the battle costs.

const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<HostIn>) => void) | null;
};

const host = createBattleHost((batch, transfer) => {
  scope.postMessage(batch, transfer);
});
scope.onmessage = (e) => {
  host.receive(e.data);
};
