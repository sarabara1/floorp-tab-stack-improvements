// ==UserScript==
// @name           New-tab HOTKEY (Ctrl+T) opens inside the current stack
// @include        main
// ==/UserScript==

// Makes the new-tab KEYBOARD shortcut open INSIDE the current stack when the
// selected tab is in one, like the stack-blank middle-click. This covers ONLY
// the hotkey. The `+` button and the right-click "New Tab" menu are left at
// their default (global) behavior on purpose — each stack has its own inline `+`
// (stacktab-inline-newtab-button.uc.js), so the global-area triggers open global
// tabs. (To make them in-stack again, add a sibling script matching the OTHER
// command id, `cmd_newNavigatorTab`.)
//
// HOW IT HOOKS (and why): Ctrl+T does NOT call `BrowserCommands.openTab`; it
// fires the `cmd_newNavigatorTabNoEvent` COMMAND (Firefox's keyboard-only
// variant — the `+`/menus use `cmd_newNavigatorTab` instead), whose handler
// calls Floorp's bundled `openTab`. Bundled line numbers shift every build, so
// we intercept the DOM `command` event in capture phase, before Floorp's
// handler runs. Key-agnostic: whatever hotkey is bound still triggers
// `cmd_newNavigatorTabNoEvent`, so the shortcut stays changeable in Settings —
// the key binding is never touched.
//
// Respects the tab-opening-behavior pref:
//   - insert next to current → let it run natively (already inserts after the
//                              current tab, inside the stack).
//   - default / open at end   → would append at the GLOBAL end (out of the
//                              stack); cancel it and adopt a fresh tab into the
//                              current stack at its end.
// When the selected tab is NOT in a Floorp stack, nothing changes.

(function () {
  const CMD_IDS = new Set(["cmd_newNavigatorTabNoEvent"]);
  const LOG = "[newtab-hotkey]";

  const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();

  // Native new-tab focuses the address bar so you can type immediately; our
  // explicit addTab + adopt path doesn't, so restore it (deferred to run after
  // the tab switch settles).
  const focusUrlbar = () => {
    try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
  };

  // Only Floorp STACKS (tab-group[data-floorp-stack]); plain Firefox tab groups
  // are intentionally excluded so their new-tab behavior is left native.
  const stackOf = (tab) =>
    tab?.closest?.("tab-group[data-floorp-stack]") || null;

  // Move an open tab into `group` at the stack's end. Group-adoption API is
  // version-specific — try known shapes and report which worked (or none).
  function adoptToStackEnd(tab, group) {
    try {
      if (typeof group.addTabs === "function") { group.addTabs([tab]); return "group.addTabs"; }
      if (typeof gBrowser.moveTabToGroup === "function") { gBrowser.moveTabToGroup(tab, group); return "gBrowser.moveTabToGroup"; }
      if (typeof gBrowser.addTabToGroup === "function") { gBrowser.addTabToGroup(group, tab); return "gBrowser.addTabToGroup"; }
    } catch (err) { console.warn(LOG, "adopt error", err); return "error"; }
    console.warn(LOG, "no group-adopt API found; tab left outside stack");
    return "none";
  }

  function isNewTabCommand(t) {
    if (!t) return false;
    const ref = t.getAttribute?.("command") || t.getAttribute?.("observes");
    return CMD_IDS.has(t.id) || CMD_IDS.has(ref);
  }

  function init() {
    let handledThisTick = false;

    function tryOpenInStack() {
      const group = stackOf(gBrowser.selectedTab);
      const afterCurrent =
        Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent", false);
      if (!(group && !afterCurrent)) return false; // native handles the rest

      if (handledThisTick) return true; // duplicate within the same action
      handledThisTick = true;
      setTimeout(() => { handledThisTick = false; }, 0);

      const newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: SYS() });
      const how = adoptToStackEnd(newTab, group);
      gBrowser.selectedTab = newTab; // foreground, like the native command
      setTimeout(focusUrlbar, 0);    // focus the address bar, like native new-tab
      console.log(LOG, "opened in current stack via", how);
      return true;
    }

    window.addEventListener("command", function (e) {
      if (!isNewTabCommand(e.target)) return;
      if (tryOpenInStack()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    console.log(LOG, "loaded (intercepting cmd_newNavigatorTabNoEvent)");
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
