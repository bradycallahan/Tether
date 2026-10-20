export async function open(o: { directory?: boolean; title?: string }): Promise<string | null> {
  return o.directory ? "/home/admin/VanDyke/Config/Sessions" : "/home/admin/.ssh/id_ed25519";
}
