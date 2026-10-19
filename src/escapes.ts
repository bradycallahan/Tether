// Send-string escapes used by buttons, login scripts and the command bar.
//   \r carriage return   \n line feed   \t tab   \e escape   \b backspace
//   \\ backslash   \xHH any byte   \p pause 500 ms   \P pause 2 s
//   ^X  control characters, e.g. ^C ^Z ^]  (write ^^ for a literal caret)

export type Segment = { text: string } | { pause: number };

export function parseSendString(input: string): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf });
    buf = "";
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "^" && i + 1 < input.length) {
      const n = input[i + 1];
      if (n === "^") {
        buf += "^";
        i++;
        continue;
      }
      const code = n.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        buf += String.fromCharCode(code - 64);
        i++;
        continue;
      }
      buf += c;
      continue;
    }
    if (c !== "\\" || i + 1 >= input.length) {
      buf += c;
      continue;
    }
    const n = input[++i];
    switch (n) {
      case "r": buf += "\r"; break;
      case "n": buf += "\n"; break;
      case "t": buf += "\t"; break;
      case "e": buf += "\x1b"; break;
      case "b": buf += "\x7f"; break;
      case "\\": buf += "\\"; break;
      case "p": flush(); out.push({ pause: 500 }); break;
      case "P": flush(); out.push({ pause: 2000 }); break;
      case "x": {
        const hex = input.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          buf += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          buf += "\\x";
        }
        break;
      }
      default:
        buf += "\\" + n;
    }
  }
  flush();
  return out;
}

/** Play a send string through `write`, honouring pauses. */
export async function playSendString(input: string, write: (s: string) => void | Promise<unknown>): Promise<void> {
  for (const seg of parseSendString(input)) {
    if ("pause" in seg) await new Promise((r) => setTimeout(r, seg.pause));
    else await write(seg.text);
  }
}
