import type { ITheme } from "@xterm/xterm";

// Terminal color schemes. "Patch Bay" is Tether's own: graphite like a rack,
// console-cable blue for the cursor, link-LED green and activity amber.
export const SCHEMES: Record<string, ITheme> = {
  "Patch Bay": {
    background: "#1b2026",
    foreground: "#d7dfe6",
    cursor: "#6cb4e4",
    cursorAccent: "#1b2026",
    selectionBackground: "#35506a",
    black: "#2a3139", red: "#e5735f", green: "#7bc47f", yellow: "#f2b84b",
    blue: "#6cb4e4", magenta: "#c49ae6", cyan: "#6fcfc8", white: "#c9d2da",
    brightBlack: "#5d6874", brightRed: "#f2907e", brightGreen: "#9ad79d", brightYellow: "#f7cc74",
    brightBlue: "#8fc8ee", brightMagenta: "#d6b5f0", brightCyan: "#92ddd7", brightWhite: "#f1f5f8",
  },
  "Classic black": {
    background: "#000000", foreground: "#c0c0c0", cursor: "#c0c0c0", selectionBackground: "#3a3a3a",
    black: "#000000", red: "#c00000", green: "#00c000", yellow: "#c0c000", blue: "#3b5bdb",
    magenta: "#c000c0", cyan: "#00c0c0", white: "#c0c0c0", brightBlack: "#808080", brightRed: "#ff4040",
    brightGreen: "#40ff40", brightYellow: "#ffff40", brightBlue: "#6f8cff", brightMagenta: "#ff40ff",
    brightCyan: "#40ffff", brightWhite: "#ffffff",
  },
  "Paper": {
    background: "#fbfaf7", foreground: "#26303a", cursor: "#2f7fb8", cursorAccent: "#fbfaf7",
    selectionBackground: "#cfe2f1",
    black: "#26303a", red: "#b9412f", green: "#3d7d3f", yellow: "#97680e", blue: "#2f6fa8",
    magenta: "#8048a8", cyan: "#277f7a", white: "#cfd5db", brightBlack: "#6b7680", brightRed: "#d0563f",
    brightGreen: "#4f9a52", brightYellow: "#b7821a", brightBlue: "#3d86c6", brightMagenta: "#9a5fc4",
    brightCyan: "#33a09a", brightWhite: "#ffffff",
  },
  "Solarized dark": {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2",
    magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#586e75", brightRed: "#cb4b16",
    brightGreen: "#93a1a1", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  "Solarized light": {
    background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", selectionBackground: "#eee8d5",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2",
    magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#002b36", brightRed: "#cb4b16",
    brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  "Gruvbox dark": {
    background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", selectionBackground: "#504945",
    black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588",
    magenta: "#b16286", cyan: "#689d6a", white: "#a89984", brightBlack: "#928374", brightRed: "#fb4934",
    brightGreen: "#b8bb26", brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
    brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
  },
  "Amber monitor": {
    background: "#140d02", foreground: "#ffb000", cursor: "#ffb000", selectionBackground: "#4a3200",
    black: "#140d02", red: "#ff8a00", green: "#ffb000", yellow: "#ffc540", blue: "#e09a00",
    magenta: "#ff9f40", cyan: "#ffcc66", white: "#ffb000", brightBlack: "#7a5400", brightRed: "#ffa040",
    brightGreen: "#ffc840", brightYellow: "#ffd980", brightBlue: "#ffb840", brightMagenta: "#ffb870",
    brightCyan: "#ffe0a0", brightWhite: "#fff0c8",
  },
};

export function scheme(name: string): ITheme {
  return SCHEMES[name] ?? SCHEMES["Patch Bay"];
}
