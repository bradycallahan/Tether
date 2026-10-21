// The optional master passphrase (SecureCRT calls it the configuration
// passphrase): offered once at first run, asked for at startup when set, and
// managed from Settings > Security. The encryption itself is in Rust
// (vault.rs); the passphrase only passes through here on its way there.

import { api } from "./api";
import { h } from "./dom";
import { button, confirmDialog, modal, toast } from "./dialogs";
import { platform } from "./platform";
import { store } from "./state";

const MIN_LENGTH = 8;

/** Where saved passwords live when there's no master passphrase. */
function osStore(): string {
  return platform === "windows" ? "Windows Credential Manager" : platform === "mac" ? "the macOS Keychain" : "your system keyring";
}

function message(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e);
}

/** Ask for the passphrase when saved passwords are locked. Skipping is allowed: Tether then asks for each password. */
export async function unlockAtStartup(): Promise<void> {
  const st = await api.vaultStatus().catch(() => ({ enabled: false, unlocked: false }));
  if (!st.enabled || st.unlocked) return;
  await unlockDialog();
}

/** Returns true once unlocked. */
export async function unlockDialog(): Promise<boolean> {
  const pass = h("input", { type: "password", autocomplete: "off", "aria-label": "Master passphrase" });
  const error = h("span", { class: "err", role: "alert" });
  const row = h("label", { class: "field" }, h("span", {}, "Master passphrase"), pass, error);
  const unlock = button("Unlock", { kind: "primary", submit: true });
  const result = await modal<"unlocked" | "forgot">((done) => ({
    title: "Unlock saved passwords",
    intro: "Your saved passwords are encrypted with your master passphrase.",
    body: row,
    footLeft: [button("Forgot it?", { kind: "ghost", onclick: () => done("forgot") })],
    foot: [button("Skip", { onclick: () => done(undefined) }), unlock],
    focus: pass,
    onSubmit: async () => {
      if (!pass.value) return;
      unlock.disabled = true;
      error.textContent = "";
      try {
        await api.vaultUnlock(pass.value);
        done("unlocked");
      } catch (e) {
        row.classList.add("error");
        error.textContent = (e as { code?: string }).code === "BAD_PASSPHRASE" ? "That isn't the master passphrase. Check Caps Lock and try again." : message(e);
        pass.select();
      } finally {
        unlock.disabled = false;
      }
    },
  }));
  if (result === "forgot") return forgot();
  if (!result) toast("Saved passwords are locked. Tether will ask for passwords as you connect.");
  return result === "unlocked";
}

async function forgot(): Promise<boolean> {
  const ok = await confirmDialog({
    title: "Remove the master passphrase?",
    message: "There's no way to recover a forgotten passphrase. Removing it deletes the passwords it protects. Your sessions stay, and Tether will ask for each password the next time you connect.",
    confirm: "Remove passphrase and saved passwords",
    cancel: "Try again",
    danger: true,
  });
  if (!ok) return unlockDialog();
  await api.vaultReset();
  toast("Master passphrase removed.");
  return false;
}

/**
 * Ask for a new passphrase twice. `intro` explains why; `skip` is the
 * cancel button's label.
 */
async function newPassphrase(o: { title: string; intro: string; confirm: string; skip: string; apply: (pass: string) => Promise<void> }): Promise<boolean> {
  const pass = h("input", { type: "password", autocomplete: "new-password" });
  const again = h("input", { type: "password", autocomplete: "new-password" });
  const error = h("div", { class: "form-error", role: "alert" });
  const go = button(o.confirm, { kind: "primary", submit: true });
  const ok = await modal<boolean>((done) => ({
    title: o.title,
    intro: o.intro,
    body: [
      h("label", { class: "field" }, h("span", {}, "Passphrase"), pass, h("span", { class: "hint" }, `At least ${MIN_LENGTH} characters. A few unrelated words are easy to remember and hard to guess.`)),
      h("label", { class: "field" }, h("span", {}, "Type it again"), again),
      h("div", { class: "callout" }, "If you forget it, the passwords it protects can't be recovered. Your sessions are not affected."),
    ],
    footLeft: [error],
    foot: [button(o.skip, { onclick: () => done(false) }), go],
    focus: pass,
    onSubmit: async () => {
      error.textContent = "";
      if (pass.value.length < MIN_LENGTH) {
        error.textContent = `Use at least ${MIN_LENGTH} characters.`;
        return pass.focus();
      }
      if (pass.value !== again.value) {
        error.textContent = "The two passphrases don't match.";
        return again.select();
      }
      go.disabled = true;
      try {
        await o.apply(pass.value);
        done(true);
      } catch (e) {
        error.textContent = message(e);
      } finally {
        go.disabled = false;
      }
    },
  }));
  return !!ok;
}

/** First run: offer the passphrase once, like SecureCRT's setup does. */
export async function offerAtFirstRun(): Promise<void> {
  if (store.settings.vaultOffered) return;
  const st = await api.vaultStatus().catch(() => undefined);
  if (!st) return;
  await store.patchSettings({ vaultOffered: true });
  if (st.enabled) return;
  const set = await newPassphrase({
    title: "Protect saved passwords with a master passphrase?",
    intro: `Without one, saved passwords are kept in ${osStore()}, protected by your sign-in. With one, they're also encrypted with a passphrase only you know, and Tether asks for it when it starts. You can change this later in Settings > Security.`,
    confirm: "Set passphrase",
    skip: "Not now",
    apply: (p) => api.vaultEnable(p),
  });
  if (set) toast("Master passphrase set. Saved passwords are encrypted with it.");
}

/** Settings > Security. Changes apply at once; they aren't part of the dialog's Save. */
export function securityPanel(): HTMLElement {
  const status = h("p", { class: "hint" });
  const actions = h("div", { class: "inline wrap" });
  const el = h("div", { class: "panel" },
    h("div", { class: "field" }, h("span", {}, "Master passphrase"), status, actions),
  );
  const render = async () => {
    const st = await api.vaultStatus().catch(() => ({ enabled: false, unlocked: false }));
    actions.replaceChildren();
    if (!st.enabled) {
      status.textContent = `Saved passwords are kept in ${osStore()}, protected by your sign-in. A master passphrase also encrypts them with a passphrase only you know; Tether asks for it when it starts.`;
      actions.append(button("Set master passphrase…", { kind: "primary", onclick: async () => {
        if (await newPassphrase({ title: "Set a master passphrase", intro: "Saved passwords move into an encrypted vault in Tether's data folder.", confirm: "Set passphrase", skip: "Cancel", apply: (p) => api.vaultEnable(p) })) {
          toast("Master passphrase set.");
          render();
        }
      } }));
    } else if (!st.unlocked) {
      status.textContent = "Saved passwords are encrypted with your master passphrase and are locked right now.";
      actions.append(button("Unlock…", { kind: "primary", onclick: async () => {
        await unlockDialog();
        render();
      } }));
    } else {
      status.textContent = "Saved passwords are encrypted with your master passphrase. Tether asks for it when it starts.";
      actions.append(
        button("Change passphrase…", { onclick: async () => {
          if (await newPassphrase({ title: "Change the master passphrase", intro: "Saved passwords are re-encrypted with the new passphrase.", confirm: "Change passphrase", skip: "Cancel", apply: (p) => api.vaultChange(p) })) toast("Master passphrase changed.");
        } }),
        button("Remove passphrase…", { kind: "danger", onclick: async () => {
          const ok = await confirmDialog({
            title: "Remove the master passphrase?",
            message: `Saved passwords move back to ${osStore()} and Tether stops asking for a passphrase at startup.`,
            confirm: "Remove passphrase",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.vaultDisable();
            toast("Master passphrase removed.");
          } catch (e) {
            toast(message(e));
          }
          render();
        } }),
      );
    }
  };
  render();
  return el;
}
