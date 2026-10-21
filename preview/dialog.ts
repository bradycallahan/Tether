export async function open(o: { directory?: boolean; multiple?: boolean; title?: string }): Promise<string | string[] | null> {
  // The Files pane's pickers say where they upload or download.
  if (o.title?.startsWith("Upload")) return o.directory ? "/home/admin/Downloads/branch-configs" : ["/home/admin/Downloads/core-sw1-confg.txt", "/home/admin/Downloads/acl-update.txt"];
  if (o.title?.startsWith("Download")) return "/home/admin/Downloads";
  return o.directory ? "/home/admin/VanDyke/Config/Sessions" : "/home/admin/.ssh/id_ed25519";
}

export async function save(o: { defaultPath?: string }): Promise<string | null> {
  return `/home/admin/Downloads/${o.defaultPath ?? "download"}`;
}
