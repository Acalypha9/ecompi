import type { BrowserContext } from "patchright";

export async function applyStealthScripts(context: BrowserContext): Promise<void> {
  // fingerprint-injector already handles webdriver, plugins, WebGL, etc.
  // Add WebAuthn disable as extra safety
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'credentials', {
      value: {
        create: () => Promise.reject(new Error('WebAuthn disabled')),
        get: () => Promise.reject(new Error('WebAuthn disabled')),
      },
    });
  });
}