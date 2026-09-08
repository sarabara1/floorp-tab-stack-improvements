// ==UserScript==
// @name           Stack tab improvements: middle-click close + new-tab placement + drag-text-to-search
// @include        main
// ==/UserScript==

(function () {
  // The `tab-group[data-floorp-stack]` a stack strip belongs to. The strip's
  // visual tabs carry `data-floorp-drag-id`; the matching real <tab> carries
  // `data-floorp-tab-id` with the same value — resolve one and climb to its
  // group. Robust even if the selected tab is in a different stack.
  function stackGroupFromStrip(strip) {
    const vTab = strip.querySelector?.(".floorp-stack-tab[data-floorp-drag-id]");
    if (!vTab) return null;
    const id = vTab.getAttribute("data-floorp-drag-id");
    const real = gBrowser.tabs.find(
      t => t.getAttribute("data-floorp-tab-id") === id
    );
    return real?.closest?.("tab-group[data-floorp-stack]") || real?.group || null;
  }

  const groupOf = (tab) =>
    tab?.closest?.("tab-group[data-floorp-stack]") || tab?.group || null;

  // True while Floorp's own visual-tab reorder drag is in flight (a drag that
  // started on a `.floorp-stack-tab`). We must NOT treat that as a text/link
  // drop, or we'd hijack in-stack reordering. Set on dragstart, cleared on
  // dragend/drop. This is more reliable than sniffing dataTransfer types,
  // since Floorp's reorder payload shape isn't something we control.
  let internalStackDrag = false;

  // dataTransfer.types is a DOMStringList in some events and a frozen array in
  // others — probe both shapes.
  const dtHasType = (dt, t) => {
    const types = dt?.types;
    if (!types) return false;
    if (typeof types.includes === "function") return types.includes(t);
    if (typeof types.contains === "function") return types.contains(t);
    return Array.prototype.indexOf.call(types, t) >= 0;
  };

  // The dropped-link service (extracts URLs/text from a drop, resolves the
  // triggering principal/CSP, and rejects unsafe schemes). Accessed directly
  // rather than via the browser.js `browserDragAndDrop` wrapper, which isn't
  // reliably present in every build/scope.
  const dlh = () => Services.droppedLinkHandler;

  // Is this a drop we should act on? Only external link/text drags — never
  // Floorp's visual-tab reorder, and never a real browser <tab> being dragged
  // in (let Floorp/Firefox own that).
  function isExternalLinkDrop(e) {
    if (internalStackDrag) return false;
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dtHasType(dt, "application/x-moz-tabbrowser-tab")) return false;
    try {
      if (dlh().canDropLink(e, true)) return true;
    } catch (err) {}
    // Fall back to a plain type check (canDropLink can't read data on dragover
    // in some builds).
    return dtHasType(dt, "text/plain")
      || dtHasType(dt, "text/x-moz-url")
      || dtHasType(dt, "text/uri-list")
      || dtHasType(dt, "text/html");
  }

  // The real <tab> a visual stack tab maps to (drag-id ↔ tab-id mirror).
  function realTabForVisual(vTab) {
    const id = vTab?.getAttribute?.("data-floorp-drag-id");
    if (!id) return null;
    return gBrowser.tabs.find(
      t => t.getAttribute("data-floorp-tab-id") === id
    ) || null;
  }

  // Turn a dropped token (a URL, or free text) into a loadable URL + optional
  // postData — the same resolution the address bar and native tab-bar drops
  // use: real URLs pass through, keyword shortcuts expand, and bare text
  // becomes a default-engine search. Falls back to URIFixup if the browser.js
  // helper isn't in scope.
  async function resolveDropText(text) {
    if (typeof getShortcutOrURIAndPostData === "function") {
      try {
        const d = await getShortcutOrURIAndPostData(text);
        if (d && d.url) return d;
      } catch (err) {
        console.warn("[stack-mc] getShortcutOrURIAndPostData failed", err);
      }
    }
    try {
      const fixup = Services.uriFixup;
      const flags =
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
        Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = fixup.getFixupURIInfo(text, flags);
      const uri = info.preferredURI || info.fixedURI;
      if (uri) return { url: uri.spec, postData: null };
    } catch (err) {
      console.warn("[stack-mc] URIFixup fallback failed", err);
    }
    return null;
  }

  // Load a resolved URL into an existing tab (the "replace this tab" case).
  function loadInExistingTab(tab, data, triggeringPrincipal, csp) {
    const b = tab.linkedBrowser;
    const opts = { triggeringPrincipal, csp, postData: data.postData || null };
    try {
      if (typeof b.fixupAndLoadURIString === "function") {
        b.fixupAndLoadURIString(data.url, opts);
        return true;
      }
      if (typeof b.loadURI === "function") {
        b.loadURI(Services.io.newURI(data.url), opts);
        return true;
      }
    } catch (err) {
      console.warn("[stack-mc] load-in-tab failed", err);
    }
    return false;
  }

  // Handle an external text/link drop on a stack strip. If `targetTab` is set
  // (dropped onto an existing tab), the first item replaces that tab; anything
  // else — and drops on blank strip area — opens new tab(s) at the stack's end.
  // The dataTransfer is only valid synchronously, so extract everything
  // (links, principal, csp) before the first await.
  async function handleStackDrop(event, group, targetTab) {
    // Extract everything off the (soon-invalid) dataTransfer synchronously.
    let urls = [];
    try {
      const links = dlh().dropLinks(event, true); // true → reject javascript:/data:
      for (const l of links || []) if (l && l.url) urls.push(l.url);
    } catch (err) {
      console.warn("[stack-mc] dropLinks failed", err);
      return;
    }
    if (!urls.length) return;

    let triggeringPrincipal, csp;
    try {
      triggeringPrincipal = dlh().getTriggeringPrincipal(event);
      csp = dlh().getCsp(event);
    } catch (err) {
      triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
      csp = null;
    }

    let selectAfter = null;
    let first = true;
    for (const url of urls) {
      const data = await resolveDropText(url);
      if (!data || !data.url) continue;

      if (first && targetTab) {
        loadInExistingTab(targetTab, data, triggeringPrincipal, csp);
        selectAfter = targetTab;
        console.log("[stack-mc] drop replaced existing tab");
      } else {
        const tab = gBrowser.addTab(data.url, {
          postData: data.postData,
          triggeringPrincipal,
          csp,
        });
        const how = adoptToStackEnd(tab, group);
        selectAfter = tab;
        console.log("[stack-mc] drop opened in-stack tab via", how);
      }
      first = false;
    }
    if (selectAfter) gBrowser.selectedTab = selectAfter;
  }

  // Focus the address bar after opening a blank tab, like native new-tab does
  // (our explicit opens / Floorp's in-stack open don't). Deferred so it runs
  // after the tab switch settles.
  const focusUrlbar = () => {
    try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
  };

  // Move an already-open tab into `group`, landing at the stack's end. The
  // group-adoption API is version-specific, so try known shapes and report
  // which one worked (or none, so breakage is easy to localize).
  function adoptToStackEnd(tab, group) {
    try {
      if (typeof group.addTabs === "function") {
        group.addTabs([tab]); return "group.addTabs";
      }
      if (typeof gBrowser.moveTabToGroup === "function") {
        gBrowser.moveTabToGroup(tab, group); return "gBrowser.moveTabToGroup";
      }
      if (typeof gBrowser.addTabToGroup === "function") {
        gBrowser.addTabToGroup(group, tab); return "gBrowser.addTabToGroup";
      }
    } catch (err) {
      console.warn("[stack-mc] adopt error", err);
      return "error";
    }
    console.warn("[stack-mc] no group-adopt API found; tab left outside stack");
    return "none";
  }

  function init() {
    // ---- click: handle stack-tab middle/right BEFORE the stack selects ----
    // The stack selects a tab on `click` (confirmed via probe: TabSelect
    // fires after click). So we intercept click in capture phase and stop
    // the select for middle/right, eliminating the flicker.
    window.addEventListener("click", function (e) {
      const stackTab = e.target.closest?.(".floorp-stack-tab");

      // --- stack tab: middle-click closes, no flicker ---
      if (stackTab && e.button === 1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const dragId = stackTab.getAttribute("data-floorp-drag-id");
        const tab = dragId && gBrowser.tabs.find(
          t => t.getAttribute("data-floorp-tab-id") === dragId
        );
        if (tab) gBrowser.removeTab(tab, { animate: true });
        else console.warn("[stack-mc] no tab for", dragId);
        return;
      }

      // --- stack tab: right-click should NOT switch to the tab ---
      if (stackTab && e.button === 2) {
        // block only the select; contextmenu event still fires separately
        e.stopImmediatePropagation();
        return;
      }

      // --- regular blank tab-bar area: new tab at GLOBAL END + focus it ---
      if (e.button === 1
          && !e.target.closest?.("#floorp-stack-items")
          && !stackTab
          && !e.target.closest?.(".tabbrowser-tab")) {
        const isScrollbox =
          e.target.classList?.contains("tabbrowser-arrowscrollbox") ||
          e.target.localName === "arrowscrollbox" ||
          e.target.id === "tabbrowser-arrowscrollbox" ||
          e.target.getAttribute?.("anonid") === "arrowscrollbox";
        if (!isScrollbox) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const newTab = gBrowser.addTab("about:newtab", {
          index: gBrowser.tabs.length,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        gBrowser.selectedTab = newTab;
        setTimeout(focusUrlbar, 0);
        return;
      }
    }, true);

    // ---- auxclick: stack strip blank area → new tab INSIDE the clicked stack,
    //      respecting the tab-opening-behavior pref ----
    // `cmd_newNavigatorTab` (Ctrl+T / +) only keeps the new tab in the stack
    // when the pref is "insert next to current"; with "default"/"at the end"
    // Firefox appends it at the GLOBAL end, outside the group. So we use the
    // native command only for the next-to-current case (where it lands right),
    // and otherwise open a tab explicitly and adopt it into the clicked stack's
    // group at the stack's end.
    window.addEventListener("auxclick", function (e) {
      if (e.button !== 1) return;
      if (e.target.closest?.(".floorp-stack-tab")) return; // handled on click now
      const stackBlank = e.target.closest?.("#floorp-stack-items");
      if (!stackBlank) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const nativeNewTab = () => {
        document.getElementById("cmd_newNavigatorTab").doCommand();
        setTimeout(focusUrlbar, 0);
      };

      const group = stackGroupFromStrip(stackBlank);
      const afterCurrent =
        Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent", false);

      // Next-to-current pref AND the selected tab is in the clicked stack →
      // the native command already inserts after current, inside the stack.
      if (afterCurrent && group && groupOf(gBrowser.selectedTab) === group) {
        nativeNewTab();
        return;
      }

      // Couldn't resolve the clicked stack → fall back to native behavior.
      if (!group) {
        nativeNewTab();
        return;
      }

      // Default / at-the-end (or selection is in a different stack): open a tab
      // and adopt it into the clicked stack, at the stack's end.
      const newTab = gBrowser.addTab("about:newtab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      const how = adoptToStackEnd(newTab, group);
      gBrowser.selectedTab = newTab; // foreground, like Ctrl+T / the + button
      setTimeout(focusUrlbar, 0);    // focus the address bar, like native new-tab
      console.log("[stack-mc] new in-stack tab via", how);
    }, true);

    // ---- drag text/link onto a stack's tab area ----
    //   • onto an existing stack tab → replace that tab (search text / load link)
    //   • onto blank strip area      → open a new in-stack tab, same behavior
    // …exactly like dropping onto the global tab bar. Floorp doesn't accept text
    // drops on its stack strip, so we add it. We track whether the drag started
    // on a visual stack tab (Floorp's own reorder) and stay out of the way for
    // those.
    window.addEventListener("dragstart", function (e) {
      internalStackDrag = !!e.target?.closest?.(".floorp-stack-tab");
    }, true);
    const clearDrag = () => { internalStackDrag = false; };
    window.addEventListener("dragend", clearDrag, true);

    // dragover must preventDefault for the strip to become a valid drop target.
    // Done manually (no browserDragAndDrop dependency) so the drop cursor shows.
    window.addEventListener("dragover", function (e) {
      if (!e.target.closest?.("#floorp-stack-items")) return;
      if (!isExternalLinkDrop(e)) return; // reorder / real-tab drag → leave it
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "link"; } catch (err) {}
      e.stopImmediatePropagation();
    }, true);

    window.addEventListener("drop", function (e) {
      const strip = e.target.closest?.("#floorp-stack-items");
      if (!strip) { clearDrag(); return; }
      if (!isExternalLinkDrop(e)) { clearDrag(); return; }

      const group = stackGroupFromStrip(strip);
      if (!group) {
        // Can't resolve the clicked stack → don't swallow the drop.
        console.warn("[stack-mc] drop: couldn't resolve stack; ignoring");
        clearDrag();
        return;
      }

      // Dropped onto an existing tab? Replace it; otherwise open a new tab.
      const overVisual = e.target.closest?.(".floorp-stack-tab");
      const targetTab = overVisual ? realTabForVisual(overVisual) : null;

      e.preventDefault();
      e.stopImmediatePropagation();
      clearDrag();
      handleStackDrop(e, group, targetTab);
    }, true);

    console.log("[stack-mc] loaded");
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