let fullscreen = false;
const closeHandlers: ((e: { preventDefault(): void }) => unknown)[] = [];

export function getCurrentWindow() {
  return {
    setTitle: async (t: string) => {
      document.title = t;
    },
    isFullscreen: async () => fullscreen,
    setFullscreen: async (on: boolean) => {
      fullscreen = on;
      if (on) await document.documentElement.requestFullscreen().catch(() => {});
      else if (document.fullscreenElement) await document.exitFullscreen();
    },
    onCloseRequested: async (fn: (e: { preventDefault(): void }) => unknown) => {
      closeHandlers.push(fn);
      return () => {};
    },
    close: async () => {
      let prevented = false;
      for (const fn of closeHandlers) await fn({ preventDefault: () => (prevented = true) });
      if (!prevented) document.body.textContent = "Tether closed (preview).";
    },
    destroy: async () => {
      document.body.textContent = "Tether closed (preview).";
    },
  };
}
