// The preview has one page and no other windows, so events go nowhere.

export async function emitTo(_target: string, _event: string, _payload?: unknown) {}

export async function listen<T>(_event: string, _handler: (e: { payload: T }) => void) {
  return () => {};
}
