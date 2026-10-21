import { describe, expect, it } from "vitest";
import { baseName, formatSize, joinPath, localJoin, nameProblem, parentPath, safeLocalName, sortEntries } from "../src/sftp";
import type { RemoteEntry } from "../src/types";

describe("remote paths", () => {
  it("join, split and climb", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/netops", "configs")).toBe("/home/netops/configs");
    expect(parentPath("/home/netops/configs")).toBe("/home/netops");
    expect(parentPath("/etc")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/home/netops/")).toBe("/home");
    expect(baseName("/home/netops/")).toBe("netops");
    expect(baseName("/")).toBe("/");
  });

  it("joins local paths with the picker's separator", () => {
    expect(localJoin("C:\\Users\\brady\\Downloads", "a.bin")).toBe("C:\\Users\\brady\\Downloads\\a.bin");
    expect(localJoin("D:\\", "a.bin")).toBe("D:\\a.bin");
    expect(localJoin("/home/admin", "a.bin")).toBe("/home/admin/a.bin");
  });
});

describe("names", () => {
  it("never lets a remote name climb out of the download folder", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "..\\x", "a\\b", "..."]) expect(safeLocalName(bad)).toBeNull();
    expect(safeLocalName("cat9k.bin")).toBe("cat9k.bin");
    expect(safeLocalName("run: 10-20?.txt")).toBe("run_ 10-20_.txt");
    expect(safeLocalName("con.txt")).toBe("_con.txt");
    expect(safeLocalName("COM1")).toBe("_COM1");
    expect(safeLocalName("console.log")).toBe("console.log");
    expect(safeLocalName("notes. ")).toBe("notes");
  });

  it("checks typed names", () => {
    expect(nameProblem("backups")).toBeNull();
    expect(nameProblem("  ")).toBe("Enter a name.");
    expect(nameProblem("a/b")).toBe("Names can't contain /.");
    expect(nameProblem("..")).toBe("That name is reserved.");
  });
});

describe("listing", () => {
  const e = (name: string, kind: RemoteEntry["kind"], size = 0, modified = 0): RemoteEntry => ({ name, kind, link: false, size, modified, permissions: "" });

  it("sorts folders first and numbers naturally", () => {
    const list = [e("file10", "file", 5), e("b", "dir"), e("file2", "file", 50), e("A", "dir")];
    expect(sortEntries(list, "name", 1).map((x) => x.name)).toEqual(["A", "b", "file2", "file10"]);
    expect(sortEntries(list, "name", -1).map((x) => x.name)).toEqual(["b", "A", "file10", "file2"]);
    expect(sortEntries(list, "size", -1).map((x) => x.name)).toEqual(["b", "A", "file2", "file10"]);
  });

  it("formats sizes like a file manager", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(9_842_113)).toBe("9.4 MB");
    expect(formatSize(1_262_034_944)).toBe("1.2 GB");
    expect(formatSize(300 * 1024 * 1024)).toBe("300 MB");
  });
});
