// The preview has one page and no other windows. Events the fake backend
// raises (core.ts) are delivered here; everything else goes nowhere.

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitLocal(event: string, payload: unknown) {
  handlers.get(event)?.forEach((h) => h({ payload }));
}

export async function emitTo(_target: string, _event: string, _payload?: unknown) {}

export async function listen<T>(event: string, handler: (e: { payload: T }) => void) {
  const h = handler as Handler;
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(h);
  return () => void handlers.get(event)?.delete(h);
}
