// ==UserScript==
// @name           Stack auto-title: unnamed stacks show their active tab's title
// @include        main
// ==/UserScript==

// A stack that was never named ("New Stack", or a numbered "New Stack 2")
// displays the title of its active tab instead, like Vivaldi. Naming the stack
// (right-click → Manage Stack…) turns this off for that stack; clearing the
// name back to a default or empty turns it on again.
//
// Creating a stack also skips the name/color popup, since an unnamed stack
// now has a useful title on its own. Native Firefox groups still get the
// popup, and Manage Stack… still opens the editor normally.
//
// Display-only: we rewrite the header's visible text, never the group's
// `label`. The real name stays "New Stack", so session restore, the rename
// panel and Floorp's own stack data are untouched, and the moment the stack is
// renamed Firefox writes the new label into the header itself.
//
// "Active tab" = the selected tab if it's in the stack, otherwise the stack's
// most recently used tab (lastAccessed) — i.e. the tab you'd land on.
//
// The header element is Firefox's `.tab-group-label`, but a stack renders it
// differently from a native group:
//   • group → the label's text content is the visible name.
//   • stack → the name is drawn by `::before` from the label's
//     `data-floorp-title` attribute, and the label's children are Floorp's
//     stack icon + close button. So for stacks we only rewrite that attribute
//     and never touch the children.
//
// Popup: the editor panel (#tab-group-editor) has separate entry points for a
// new group (openCreateModal) and an existing one (openEditModal). We wrap
// only openCreateModal. The stack marker (data-floorp-stack) may be applied
// just after the group is created, so if the group isn't a stack yet when the
// popup is requested we re-check one tick later before deciding.

(function () {
  const DEFAULT_NAME = "New Stack";
  const OVERRIDE_ATTR = "uc-auto-title"; // marks a header we're overriding
  const FLOORP_TITLE_ATTR = "data-floorp-title"; // what a stack header renders

  const logged = new WeakSet(); // stacks already described in the console

  const isStack = (group) => !!group?.hasAttribute?.("data-floorp-stack");
  const nameOf = (group) =>
    (group.label ?? group.getAttribute("label") ?? "").trim();
  // Floorp keeps stack names unique, so later default names get a number
  // appended ("New Stack 2", "New Stack (2)"); those count as unnamed too.
  const DEFAULT_NAME_RE = /^New Stack(?:[\s\-_#]*\(?\d+\)?)?$/;
  const isUnnamed = (group) => {
    const name = nameOf(group);
    return !name || DEFAULT_NAME_RE.test(name);
  };

  // ---------------------------------------------------------------- title --

  function activeTabOf(group) {
    const tabs = Array.from(group.tabs || []).filter(t => !t.closing);
    if (!tabs.length) return null;
    if (tabs.includes(gBrowser.selectedTab)) return gBrowser.selectedTab;
    return tabs.reduce((a, b) => ((b.lastAccessed || 0) > (a.lastAccessed || 0) ? b : a));
  }

  const labelElementOf = (group) =>
    group.labelElement || group.querySelector(".tab-group-label") || null;

  function describe(group, el) {
    if (logged.has(group)) return;
    logged.add(group);
    console.log("[stack-auto-title] stack",
      "label:", JSON.stringify(group.getAttribute("label")),
      "| header el:", el ? `<${el.localName} class="${el.className}">` : "NOT FOUND",
      "| data-floorp-title:", JSON.stringify(el?.getAttribute(FLOORP_TITLE_ATTR)),
      "| tabs:", group.tabs?.length);
  }

  // Stack → write `data-floorp-title` (children are icon/close, leave them).
  // Group → write the label's text content (it has no element children).
  function setText(el, text) {
    if (el.hasAttribute(FLOORP_TITLE_ATTR)) {
      if (el.getAttribute(FLOORP_TITLE_ATTR) !== text) el.setAttribute(FLOORP_TITLE_ATTR, text);
    } else if (el.childElementCount === 0 && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function refreshGroup(group) {
    const el = labelElementOf(group);
    describe(group, el);
    if (!el) return;

    if (!isUnnamed(group)) {
      // Named (or just renamed) → hand the header back to the real name.
      if (el.hasAttribute(OVERRIDE_ATTR)) {
        el.removeAttribute(OVERRIDE_ATTR);
        setText(el, nameOf(group));
      }
      return;
    }

    const title = activeTabOf(group)?.label || DEFAULT_NAME;
    setText(el, title);
    if (el.getAttribute("tooltiptext") !== title) el.setAttribute("tooltiptext", title);
    el.setAttribute(OVERRIDE_ATTR, "true");
  }

  function refreshAll() {
    for (const group of document.querySelectorAll("tab-group[data-floorp-stack]")) {
      try { refreshGroup(group); }
      catch (e) { console.warn("[stack-auto-title] refresh failed", e); }
    }
  }

  // Coalesce bursts (tab switch fires select + attr-modified + mutations) into
  // one pass per frame. Our own writes re-trigger the observer, but the second
  // pass finds nothing to change, so it settles.
  let queued = false;
  function scheduleRefresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshAll(); });
  }

  // ---------------------------------------------------------------- popup --

  function wrapCreateModal(target) {
    if (!target || typeof target.openCreateModal !== "function") return false;
    if (target.__ucNoCreatePopup) return true;
    const orig = target.openCreateModal;

    target.openCreateModal = function (group, ...rest) {
      if (isStack(group)) return undefined;
      setTimeout(() => {
        if (!isStack(group)) orig.call(this, group, ...rest);
      }, 0);
      return undefined;
    };

    target.__ucNoCreatePopup = true;
    return true;
  }

  // Prefer the class prototype (covers a panel that's created lazily); fall
  // back to the live panel instance's prototype.
  function hookCreatePopup() {
    if (wrapCreateModal(customElements.get("tabgroup-menu")?.prototype)) return true;
    const panel = gBrowser.tabGroupMenu || document.getElementById("tab-group-editor");
    return !!panel && wrapCreateModal(Object.getPrototypeOf(panel));
  }

  // ----------------------------------------------------------------- init --

  function init() {
    const container = gBrowser.tabContainer;
    for (const type of [
      "TabSelect", "TabAttrModified", "TabOpen", "TabClose", "TabMove",
      "TabGrouped", "TabUngrouped", "TabGroupCreate", "TabGroupRemoved",
      "TabGroupExpand", "TabGroupCollapse",
    ]) {
      container.addEventListener(type, scheduleRefresh);
    }

    // Catches renames (tab-group `label` attr), stacks being built/restored,
    // and Floorp re-rendering the header title behind our back.
    new MutationObserver(scheduleRefresh).observe(container, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["label", FLOORP_TITLE_ATTR],
    });

    refreshAll();

    const hooked = hookCreatePopup();
    console.log("[stack-auto-title] loaded; create popup",
      hooked ? "suppressed for stacks" : "NOT hooked (openCreateModal not found)");
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
