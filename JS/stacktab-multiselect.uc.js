// ==UserScript==
// @name           Stack tabs: Ctrl/Shift-click to multi-select
// @include        main
// ==/UserScript==

// Ctrl-click (Cmd on macOS) and Shift-click select multiple stack tabs, like
// global tabs. The selection is Firefox's real multiselection, so everything
// that acts on selected tabs — the tab context menu (close, move, add to
// group, unload…), dragging from the global strip, Ctrl+W — covers all of them.
//
// Floorp's stack strip tabs are proxies: its own click handler just selects
// the proxy's real tab, which wipes any multiselection. So on a modified
// left mousedown we run Firefox's own tab mousedown logic (tab.js
// on_mousedown) against the real tab, then swallow the click so Floorp
// doesn't select it:
//   • Shift         → range from the last multiselected tab to this one
//                     (Shift alone resets the selection first; Ctrl+Shift adds)
//   • Ctrl          → toggle this tab in/out of the selection
// A plain click clears the selection, like tab.js on_click.
//
// Floorp only styles the selected proxy, so we mirror each real tab's
// `multiselected` state onto its proxy as `uc-multiselected` and style it
// like a multiselected global tab (selected background + focus outline).

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const BUTTON_SEL = ".floorp-stack-tab-close, .floorp-stack-tab-refresh";
  const MS_ATTR = "uc-multiselected";

  const CSS = `
    .floorp-stack-tab[${MS_ATTR}] {
      background: var(
        --tab-selected-bgcolor,
        var(--toolbarbutton-active-background, rgba(128, 128, 128, 0.3))
      );
      outline: 1px solid var(--focus-outline-color, AccentColor);
      outline-offset: -1px;
    }
  `;

  const realTabOf = (proxy) => {
    const id = proxy?.getAttribute("data-floorp-drag-id");
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };

  // Proxy under a left-button event, ignoring its close/reload buttons.
  const proxyFor = (e) =>
    e.button === 0 && !e.target.closest?.(BUTTON_SEL) ? e.target.closest?.(PROXY_SEL) : null;

  const isModified = (e) => e.shiftKey || e.getModifierState("Accel");

  // Mirrors tab.js on_mousedown's Shift / Accel branches.
  function multiSelect(tab, e) {
    if (e.shiftKey) {
      const last = gBrowser.lastMultiSelectedTab;
      if (!e.getModifierState("Accel")) {
        gBrowser.selectedTab = last;
        gBrowser.clearMultiSelectedTabs();
      }
      gBrowser.addRangeToMultiSelectedTabs(last, tab);
    } else if (tab.multiselected) {
      gBrowser.removeFromMultiSelectedTabs(tab);
    } else if (tab !== gBrowser.selectedTab) {
      gBrowser.addToMultiSelectedTabs(tab);
      gBrowser.lastMultiSelectedTab = tab;
    }
  }

  function syncProxies() {
    for (const proxy of document.querySelectorAll(PROXY_SEL)) {
      proxy.toggleAttribute(MS_ATTR, !!realTabOf(proxy)?.multiselected);
    }
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncProxies(); });
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    window.addEventListener("mousedown", (e) => {
      const proxy = proxyFor(e);
      if (!proxy || !isModified(e)) return;
      const tab = realTabOf(proxy);
      if (!tab) return;
      e.preventDefault(); // no focus/drag side effects from the modified press
      multiSelect(tab, e);
    }, true);

    window.addEventListener("click", (e) => {
      const proxy = proxyFor(e);
      if (!proxy) return;
      if (isModified(e)) {
        // Floorp's handler would select the tab and drop the selection.
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (gBrowser.multiSelectedTabsCount > 0) {
        gBrowser.clearMultiSelectedTabs();
      }
    }, true);

    window.addEventListener("TabMultiSelect", scheduleSync);
    gBrowser.tabContainer.addEventListener("TabSelect", scheduleSync);

    // The stack bar lives in the toolbox and re-renders its proxies when you
    // switch stacks or tabs join/leave one; new proxies need the attribute too.
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );

    syncProxies();
    console.log("[stack-multiselect] loaded");
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) init();
  else {
    const obs = (s) => {
      if (s === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
