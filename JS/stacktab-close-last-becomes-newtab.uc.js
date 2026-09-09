// ==UserScript==
// @name           Stack: closing the LAST tab becomes a new-tab page (not stack close)
// @include        main
// ==/UserScript==

// Mirrors Floorp's window-level behavior — closing the last tab in a window
// just loads about:newtab instead of closing the window — for STACKS: trying to
// close the last remaining tab in a `tab-group[data-floorp-stack]` navigates
// that tab to about:newtab (keeping the stack alive) instead of removing it and
// dissolving the stack. Closing the WHOLE stack (its X button, or middle-click
// on the stack) is deliberately left alone.
//
// CHOKEPOINT — wrap gBrowser.removeTab. Every single-tab close funnels through
// it (this project's middle-click handler, Ctrl+W, a per-tab close button, the
// context-menu "Close Tab"), so one wrap covers them all. No other script in
// this profile touches removeTab (the others wrap addTab), so this is collision-
// free and load-order-independent.
//
// THE TRAP this guards against — whole-stack close ALSO reaches removeTab:
//   removeTabGroup(group) -> removeTabs(group.tabs) -> removeTab(tab) per tab.
// So a naive "never remove the last stack tab" guard would redirect the FINAL
// tab of a closing stack to about:newtab and leave a stray one-tab stack behind.
// A `bulk` re-entry guard (set while removeTabGroup/removeTabs run, plus a call-
// stack check) suppresses the redirect for any bulk removal, so only a genuine
// lone close of the last stack tab is redirected.

(function () {
  const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();

  // The stack group a tab belongs to, or null. STACKS ONLY — plain Firefox tab
  // groups (the user's tier-2 fixed groups) are intentionally excluded, so
  // closing the last tab in one still dissolves it natively.
  const stackOf = (tab) => tab?.closest?.("tab-group[data-floorp-stack]") || null;

  // Would `tab` be the last surviving tab in `group`? (Ignore tabs already
  // animating closed; `tab` itself isn't marked closing yet at intercept time.)
  function isLastInStack(tab, group) {
    let list = null;
    try {
      if (group.tabs && group.tabs.length != null) list = Array.from(group.tabs);
    } catch (e) { /* fall through to DOM scan */ }
    if (!list) {
      list = gBrowser.tabs.filter(
        t => t.closest?.("tab-group[data-floorp-stack]") === group
      );
    }
    return list.filter(t => t !== tab && !t.closing).length === 0;
  }

  // Focus the address bar after the redirect, but only if the affected tab is
  // the one you're looking at — matches native new-tab, without yanking focus
  // when you close the last tab of a background stack.
  function maybeFocusUrlbar(tab) {
    if (gBrowser.selectedTab !== tab) return;
    setTimeout(() => {
      try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
    }, 0);
  }

  // Navigate the last stack tab to about:newtab IN PLACE (same tab, so the stack
  // structure never churns and no group animation replays).
  function blankInPlace(tab) {
    const browser = gBrowser.getBrowserForTab(tab);
    try {
      browser.loadURI(Services.io.newURI("about:newtab"), { triggeringPrincipal: SYS() });
    } catch (e) {
      // Older/newer signature fallback.
      try { browser.fixupAndLoadURIString("about:newtab", { triggeringPrincipal: SYS() }); }
      catch (e2) { console.warn("[stack-lasttab] could not load about:newtab", e2); return false; }
    }
    maybeFocusUrlbar(tab);
    return true;
  }

  function init() {
    // ---- bulk guard: don't redirect while a group/multi-tab removal runs ----
    let bulk = 0;
    const guardBulk = (name) => {
      const orig = gBrowser[name];
      if (typeof orig !== "function") return false;
      gBrowser[name] = function (...args) {
        bulk++;
        try { return orig.apply(this, args); }
        finally { bulk--; }
      };
      return true;
    };
    // removeTabGroup -> removeTabs -> removeTab is the whole-stack close path;
    // removeTabs also backs "close other/​to-the-right" batches. Wrapping both
    // means the last stack tab in ANY multi-close is removed, not redirected.
    const wrappedGroup = guardBulk("removeTabGroup");
    const wrappedTabs  = guardBulk("removeTabs");

    // Backup discriminator, in case a build's minification hides the wrapper
    // above (same call-stack trick as the gesture script's executeGestureAction
    // check): if a bulk-removal frame is on the stack, treat it as bulk.
    const inBulkStack = () => {
      try {
        const s = new Error().stack || "";
        return /removeTabGroup|removeTabs|removeAllTabs/.test(s);
      } catch (e) { return false; }
    };

    // ---- the intercept ----
    const origRemoveTab = gBrowser.removeTab;
    gBrowser.removeTab = function (tab, options) {
      try {
        if (bulk === 0 && tab && !tab.pinned && !tab.closing) {
          const group = stackOf(tab);
          if (group && isLastInStack(tab, group) && !inBulkStack()) {
            if (blankInPlace(tab)) {
              console.log("[stack-lasttab] last tab in stack → about:newtab (stack kept)");
              return; // suppress the removal
            }
            // If the redirect somehow failed, fall through and remove normally
            // (fail safe: never leave the close silently doing nothing).
          }
        }
      } catch (e) {
        console.warn("[stack-lasttab] guard error, removing normally", e);
      }
      return origRemoveTab.call(this, tab, options);
    };

    console.log(
      "[stack-lasttab] loaded (removeTab wrap; bulk guard: " +
      (wrappedGroup ? "removeTabGroup " : "") +
      (wrappedTabs ? "removeTabs " : "") + "+ stack-scan)"
    );
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
