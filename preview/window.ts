let fullscreen = false;
const closeHandlers: ((e: { preventDefault(): void }) => unknown)[] = [];

export enum UserAttentionType {
  Critical = 1,
  Informational = 2,
}

export function getCurrentWindow() {
  return {
    setAlwaysOnTop: async (_on: boolean) => {},
    setTheme: async (_theme: "light" | "dark" | null) => {},
    requestUserAttention: async (_type: UserAttentionType | null) => {},
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
    // Enough for a dialog window (#dialog=… in the URL) to lay itself out.
    setEnabled: async (_on: boolean) => {},
    setFocus: async () => {},
    show: async () => {},
    setSize: async (s: LogicalSize) => console.debug("preview: window size", s.width, s.height),
    setMinSize: async (_s: LogicalSize) => {},
    setPosition: async (_p: LogicalPosition) => {},
  };
}

export class LogicalSize {
  constructor(public width: number, public height: number) {}
}

export class LogicalPosition {
  constructor(public x: number, public y: number) {}
}

export type ScrollBarStyle = "default" | "fluentOverlay";
