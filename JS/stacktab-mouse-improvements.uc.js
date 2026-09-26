// ==UserScript==
// @name           Stack tab improvements: middle-click new tab + drag-text-to-search
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

  // ---- where an external drop lands on a stack strip ----
  // Same rules as the global tab strip (tabbrowser drag-and-drop.js): over the
  // middle half of a tab, the drop replaces that tab; anywhere else it opens
  // a new tab in the gap nearest the pointer, marked by the drop caret. A
  // split view counts as one item, so nothing lands between its panes.
  //   → { replace: tab } | { before: tab, x } | { after: tab, x } | { end: true }
  // `x` is the gap's client x, for the caret.

  // Proxies grouped into drop items: a split's panes form one item.
  function dropItems(proxies) {
    const items = [];
    for (const p of proxies) {
      const pos = p.getAttribute("data-split-position");
      const prev = items.at(-1)?.at(-1);
      if ((pos === "middle" || pos === "last") && prev?.hasAttribute("data-split-position")) {
        items.at(-1).push(p);
      } else {
        items.push([p]);
      }
    }
    return items;
  }

  function itemRect(item) {
    const a = item[0].getBoundingClientRect();
    const b = item.at(-1).getBoundingClientRect();
    return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
  }

  function stackDropSpot(e, strip) {
    const items = dropItems(strip.querySelectorAll(".floorp-stack-tab"));
    if (!items.length) return { end: true };
    const rtl = window.RTL_UI;
    const x = e.clientX;

    const overProxy = e.target.closest?.(".floorp-stack-tab");
    if (overProxy) {
      const r = itemRect(items.find(item => item.includes(overProxy)));
      const w = r.right - r.left;
      if (x >= r.left + w * 0.25 && x <= r.left + w * 0.75) {
        const tab = realTabForVisual(overProxy);
        if (tab) return { replace: tab };
      }
    }

    for (const item of items) {
      const r = itemRect(item);
      if (rtl ? x > (r.left + r.right) / 2 : x < (r.left + r.right) / 2) {
        const tab = realTabForVisual(item[0]);
        if (tab) return { before: tab, x: rtl ? r.right : r.left };
      }
    }
    const last = items.at(-1);
    const r = itemRect(last);
    const tab = realTabForVisual(last.at(-1));
    return tab ? { after: tab, x: rtl ? r.left : r.right } : { end: true };
  }

  // The drop caret: Firefox's own tab-drag-indicator image, positioned over
  // the stack bar (Floorp gives #floorp-stack-bar position: relative) and
  // clamped to the visible strip. Dragover fires continuously while over a
  // target, so a short watchdog hides it once dragovers stop — including
  // when an OS file drag leaves the window, which fires no dragend here.
  const CARET_ID = "uc-stack-drop-caret";
  const CARET_CSS = `
    #${CARET_ID} {
      position: absolute;
      inset-block: 0;
      width: 12px;
      background: url(chrome://browser/skin/tabbrowser/tab-drag-indicator.svg) no-repeat center;
      pointer-events: none;
      z-index: 3;
    }
  `;
  let caretWatchdog = null;

  function hideCaret() {
    clearTimeout(caretWatchdog);
    const caret = document.getElementById(CARET_ID);
    if (caret) caret.hidden = true;
  }

  function showCaret(x) {
    const bar = document.getElementById("floorp-stack-bar");
    const scroller = document.getElementById("floorp-stack-scroller");
    if (!bar || x == null) return hideCaret();
    let caret = document.getElementById(CARET_ID);
    if (!caret || caret.parentNode !== bar) {
      caret?.remove();
      caret = document.createXULElement("hbox");
      caret.id = CARET_ID;
      bar.append(caret);
    }
    const view = (scroller ?? bar).getBoundingClientRect();
    const clamped = Math.min(Math.max(x, view.left), view.right);
    caret.style.left = `${Math.round(clamped - bar.getBoundingClientRect().left - 6)}px`;
    caret.hidden = false;
    clearTimeout(caretWatchdog);
    caretWatchdog = setTimeout(hideCaret, 250);
  }

  // Handle an external text/link/file drop on a stack strip at `spot` (from
  // stackDropSpot): the first item replaces the target tab for a replace
  // drop, and the rest open as new tabs after it; otherwise every item opens
  // as a new tab in the chosen gap, in order.
  // The dataTransfer is only valid synchronously, so extract everything
  // (links, principal, csp) before the first await.
  async function handleStackDrop(event, group, spot) {
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
    let previous = null; // last tab placed, so later items follow it in order
    for (const url of urls) {
      const data = await resolveDropText(url);
      if (!data || !data.url) continue;

      if (!previous && spot.replace) {
        loadInExistingTab(spot.replace, data, triggeringPrincipal, csp);
        selectAfter = previous = spot.replace;
        console.log("[stack-mc] drop replaced existing tab");
        continue;
      }
      const tab = gBrowser.addTab(data.url, {
        postData: data.postData,
        triggeringPrincipal,
        csp,
      });
      const how = placeInStack(tab, group, previous ? { after: previous } : spot);
      selectAfter = previous = tab;
      console.log("[stack-mc] drop opened in-stack tab via", how);
    }
    if (selectAfter) gBrowser.selectedTab = selectAfter;
  }

  // Move a new tab into `group` at `spot`. moveTabBefore/After insert next to
  // the target at the DOM level, so the tab joins the target's stack (a split
  // target resolves to its whole split view).
  function placeInStack(tab, group, spot) {
    try {
      if (spot.before?.group === group) {
        gBrowser.moveTabBefore(tab, spot.before);
        return "moveTabBefore";
      }
      if (spot.after?.group === group) {
        gBrowser.moveTabAfter(tab, spot.after);
        return "moveTabAfter";
      }
    } catch (err) {
      console.warn("[stack-mc] place error", err);
    }
    return adoptToStackEnd(tab, group);
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
    // ---- click: middle-click on the blank global tab-bar area ----
    // (Floorp itself handles middle-click-to-close and right-click on stack
    // tabs.)
    window.addEventListener("click", function (e) {
      const stackTab = e.target.closest?.(".floorp-stack-tab");

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
      if (e.target.closest?.(".floorp-stack-tab")) return; // Floorp closes it
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

    // ---- drag text/link/file onto a stack's tab area ----
    //   • onto the middle of a stack tab → replace that tab (search text /
    //     load link)
    //   • anywhere else → open a new in-stack tab in the gap under the drop
    //     caret
    // …exactly like dropping onto the global tab bar. Floorp doesn't accept
    // these drops on its stack strip, so we add them. We track whether the
    // drag started on a visual stack tab (Floorp's own reorder) and stay out
    // of the way for those.
    const caretStyle = document.createElement("style");
    caretStyle.textContent = CARET_CSS;
    document.head.appendChild(caretStyle);

    window.addEventListener("dragstart", function (e) {
      internalStackDrag = !!e.target?.closest?.(".floorp-stack-tab");
    }, true);
    const clearDrag = () => { internalStackDrag = false; hideCaret(); };
    window.addEventListener("dragend", clearDrag, true);

    // dragover must preventDefault for the strip to become a valid drop target.
    // Done manually (no browserDragAndDrop dependency) so the drop cursor shows.
    window.addEventListener("dragover", function (e) {
      const strip = e.target.closest?.("#floorp-stack-items");
      if (!strip || !isExternalLinkDrop(e)) { // reorder / real-tab drag → leave it
        hideCaret();
        return;
      }
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "link"; } catch (err) {}
      e.stopImmediatePropagation();
      const spot = stackDropSpot(e, strip);
      if (spot.replace) hideCaret();
      else showCaret(spot.x);
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

      const spot = stackDropSpot(e, strip);
      e.preventDefault();
      e.stopImmediatePropagation();
      clearDrag();
      handleStackDrop(e, group, spot);
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