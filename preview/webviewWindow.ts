// Never constructed in the preview: dialogs run in the page (isTauri() is false).

export class WebviewWindow {
  constructor(_label: string, _options: unknown) {
    throw new Error("The preview can't open windows.");
  }

  once(_event: string, _fn: () => void) {}
  async show() {}
}
