/**
 * First-activation non-modal notice (user order 2026-11-06): once hot reload
 * is on by default, the first activation pops a one-time notice: "saving a
 * .py automatically sends a request to 127.0.0.1:8090/hotfix; one-click off
 * lives in the status bar / commands".
 *
 * - Non-modal: goes through showInformationMessage (non-modal by default) and
 *   never blocks the editor;
 * - Permanently dismissible: the flag is recorded (workspaceState) as soon as
 *   it pops, so it never nags again;
 * - Choosing "Turn off now" writes the config back and turns hot reload off
 *   (the user is not left hunting for the switch).
 */

import { l10nText } from '../nlsRuntime';

export const HOT_RELOAD_NOTICE_KEY = 'kbengine.hotReload.firstRunNotice';

// Word lookup happens at call time (when the notice pops): the default English locale yields the English source string, the zh-cn bundle yields Chinese
export const HOT_RELOAD_NOTICE_MESSAGE = l10nText(
  'Auto hot reload is on by default: saving a .py sends a hot-reload request to http://127.0.0.1:8090/hotfix?module_name=<module name> (both query and body carry module_name, compatible with different server sides; duplicate values are harmless); failures are shown honestly when the engine is not running. To turn it off: click the hot-reload item in the status bar, or run the kbengine.hotReload.toggle command.'
);

export interface HotReloadNoticeDeps {
  /** Whether the notice has already been shown (flag lives in workspace state) */
  isShown(): boolean;
  /** Record "already shown" so it only ever pops once */
  markShown(): PromiseLike<void> | void;
  /** Non-modal notice; returns the button the user clicked (undefined if dismissed/closed) */
  show(message: string, ...items: string[]): PromiseLike<string | undefined>;
  /** User clicked "Turn off now": write the config back and turn hot reload off */
  turnOff(): Promise<void> | void;
}

/**
 * First-activation notice. If already shown, returns false immediately
 * (zero disturbance); otherwise records the flag and pops, returning whether
 * it actually popped. Any thrown error never affects the activation chain
 * (the caller is fire-and-forget).
 */
export async function showHotReloadFirstRunNotice(deps: HotReloadNoticeDeps): Promise<boolean> {
  if (deps.isShown()) {
    return false;
  }
  await deps.markShown();
  const choice = await deps.show(HOT_RELOAD_NOTICE_MESSAGE, l10nText('Open logs'), l10nText('Turn off now'));
  if (choice === l10nText('Turn off now')) {
    await deps.turnOff();
  }
  return true;
}
