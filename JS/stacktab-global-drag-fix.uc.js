// ==UserScript==
// @name           Global strip: stack-aware dragging
// @include        main
// ==/UserScript==

// Makes reordering in the global tab strip treat each stack as one solid item:
//   • a tab slides past a stack in either direction instead of merging into it
//   • a dragged stack swaps with its neighbours at the same point both ways,
//     and can be dragged to the very end of the strip
//   • hovering a dragged tab on a stack for a moment highlights the stack and
//     dropping then adds the tab to it (Firefox's collapsed-group gesture)
// Everything else is Firefox's own drag and drop, untouched: the animation,
// pinning/unpinning, tear-off, cross-window drops, creating groups, and
// dragging into ordinary tab groups.
//
// Why stacks confuse the drag engine: Floorp builds a stack as an EXPANDED
// tab-group whose member tabs are CSS-squashed to zero width behind the chip.
// Firefox's TabDragAndDrop (drag-and-drop.js) takes that literally:
//   - every member is a strip item — a run of zero-width items at the chip's
//     right edge. Overlap with a zero-width item always computes as 100%, so a
//     stack dragged left swaps the instant it touches the previous stack, while
//     dragging right can never overlap them, so it can't get past the last one.
//   - an expanded group's label marks "the start of the group": a tab moved
//     past it lands INSIDE the group, and a dragged group always lands before it.
//   - Floorp workspaces hide other workspaces' groups with display:none, but
//     their labels stay in the item list at screen x = 0, which scrambles the
//     engine's position search.
// A COLLAPSED group is exactly the atomic shape a stack has on screen, and the
// engine already handles those correctly. So for the length of a drag started
// in this strip, the engine is shown stacks as collapsed groups:
//   1. dragAndDropElements (the engine's list of strip items) drops stack
//      members and labels of display:none groups, and is re-indexed.
//   2. while _animateTabMove decides the drop spot, stacks report
//      collapsed = true and hasActiveTab = false — only for that synchronous
//      call, because Floorp keeps stacks expanded and re-expands any real
//      collapse through its TabGroupCollapse listener.
//   3. at drop, a position next to a stack's label is resolved to the stack
//      element itself; Tabbrowser reads "after an expanded group's label" as
//      "into the group".
// Dragging a stack also skips Firefox's collapse-the-group-while-dragging step
// (_dragData.expandGroupOnDrop): the stack already looks collapsed, and
// Floorp's re-expand would flip it back on every dragover.
//
// Floorp's own chip listeners treat any tab over a chip as "join this stack"
// and stop the dragover there, which keeps the engine from ever animating past
// a stack. Stack chips ignore the pointer while one of these drags runs, so
// those listeners stay idle and joining goes through the hover gesture above.
// Drags that start in the stack bar (row 2) or in another window never enable
// any of this.
//
// Stack-bar drags into this strip are Floorp's own: over a stack chip means
// "move the tab into that stack", anywhere else shows Floorp's insert caret.
// Stack chips sit edge to edge, so between two stacks the pointer is always on
// a chip and the caret never shows. While a stack-bar tab is dragged, only the
// middle half of each chip is a hit target (its ::before); near the edges the
// pointer reaches the strip, and Floorp places the tab on that side of the chip.
// Floorp also treats an expanded tab group as one block, so a stack-bar tab
// could only land before or after it. Over a group, the caret moves to the
// in-group spot a global tab would get, and after Floorp's drop the tab is
// moved there.

(function () {
  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const STACK_ATTR = "data-floorp-stack";
  const ACTIVE_ATTR = "stackdrag-active";
  const PROXY_ATTR = "stackproxy-drag";
  const PROXY_DRAG_END_EVENT = "floorp-stack-proxy-dragend"; // Floorp's lost-dragend recovery
  const SETTLE_TIMEOUT_MS = 2000; // cap on waiting for the drop animation

  const CSS = `
    #tabbrowser-tabs[${ACTIVE_ATTR}] tab-group[${STACK_ATTR}] > .tab-group-label-container,
    #tabbrowser-tabs[${ACTIVE_ATTR}] tab-group[${STACK_ATTR}] > .tab-group-label-container * {
      pointer-events: none !important;
    }
    #tabbrowser-tabs[${PROXY_ATTR}] tab-group[${STACK_ATTR}] > .tab-group-label-container,
    #tabbrowser-tabs[${PROXY_ATTR}] tab-group[${STACK_ATTR}] > .tab-group-label-container * {
      pointer-events: none !important;
    }
    /* The container is position:relative (tabs.css). */
    #tabbrowser-tabs[${PROXY_ATTR}] tab-group[${STACK_ATTR}] > .tab-group-label-container::before {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline: 25%;
      pointer-events: auto !important;
    }
    /* Hover-to-join cue: the same look as Floorp's drop-into-stack highlight. */
    #tabbrowser-tabs[movingtab-group] tab-group[${STACK_ATTR}] .tab-group-label[dragover-groupTarget] {
      background-color: color-mix(in srgb, var(--focus-outline-color, #0a84ff) 35%, transparent) !important;
      border-color: var(--focus-outline-color, #0a84ff) !important;
    }
  `;

  const isStack = (group) => group?.getAttribute?.(STACK_ATTR) === "true";

  function findDescriptor(obj, name) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }

  function init() {
    const tabs = gBrowser.tabContainer;
    const dnd = tabs?.tabDragAndDrop;
    const groupProto = customElements.get("tab-group")?.prototype;
    const itemsDesc = findDescriptor(tabs, "dragAndDropElements");
    const collapsedDesc = groupProto && findDescriptor(groupProto, "collapsed");
    const activeTabDesc = groupProto && findDescriptor(groupProto, "hasActiveTab");
    if (!dnd?._animateTabMove || !dnd.handle_drop || !dnd.startTabDrag ||
        !itemsDesc?.get || !collapsedDesc?.set || !activeTabDesc?.set) {
      console.error("[stack-global-drag] drag engine not as expected; not patching");
      return;
    }

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const dragService = Cc["@mozilla.org/widget/dragservice;1"]
      .getService(Ci.nsIDragService);

    // ---- drag lifecycle ----------------------------------------------------
    let active = false;     // engine sees stacks as collapsed
    let dragged = null;     // the tab / split view / group label being dragged
    let keep = new Set();   // moving items, never filtered out
    let activatedAt = 0;
    let settleGen = 0;
    let settling = false;
    let lastBase = null;    // engine's own item list the filtered one came from
    let lastItems = null;

    const isStackMember = (el) =>
      (gBrowser.isTab(el) || gBrowser.isSplitViewWrapper(el)) && isStack(el.group);

    function activate(item) {
      settleGen++;
      settling = false;
      activatedAt = performance.now();
      active = true;
      dragged = item;
      keep = new Set(item.multiselected ? gBrowser.selectedElements : [item]);
      lastBase = lastItems = null;
      tabs.setAttribute(ACTIVE_ATTR, "");
    }

    // Chips take the pointer back right away. The filtered item list stays
    // until the drop animation has finished: the engine's deferred move still
    // reads it.
    function endDrag() {
      tabs.removeAttribute(ACTIVE_ATTR);
      if (!active || settling) return;
      settling = true;
      const gen = settleGen;
      const deadline = performance.now() + SETTLE_TIMEOUT_MS;
      const settle = () => {
        if (gen !== settleGen) return;
        if (tabs.querySelector("[tabdrop-samewindow]") && performance.now() < deadline) {
          requestAnimationFrame(settle);
          return;
        }
        active = false;
        settling = false;
        dragged = null;
        keep = new Set();
        lastBase = lastItems = null;
        // Rebuild the engine's list so every item gets its real elementIndex back.
        tabs._invalidateCachedVisibleTabs();
      };
      requestAnimationFrame(settle);
    }

    // ---- 1. item list: one item per stack ----------------------------------
    Object.defineProperty(tabs, "dragAndDropElements", {
      configurable: true,
      get() {
        const base = itemsDesc.get.call(this);
        if (!active) return base;
        if (base === lastBase) return lastItems;
        const items = [];
        for (const el of base) {
          if (!keep.has(el)) {
            if (gBrowser.isTabGroupLabel(el)) {
              if (el.group?.style.display === "none") continue; // other workspace
            } else if (isStack(el.group)) {
              continue;
            }
          }
          el.elementIndex = items.length;
          items.push(el);
        }
        lastBase = base;
        lastItems = items;
        return items;
      },
    });

    // ---- 2. drop-spot decision: stacks read as collapsed -------------------
    const origAnimate = dnd._animateTabMove;
    dnd._animateTabMove = function (event) {
      if (!active) return origAnimate.call(this, event);
      const stacks = gBrowser.tabGroups.filter(isStack);
      for (const g of stacks) {
        Object.defineProperty(g, "collapsed", {
          configurable: true,
          get: () => true,
          set(v) { collapsedDesc.set.call(this, v); },
        });
        Object.defineProperty(g, "hasActiveTab", {
          configurable: true,
          get: () => false,
          set(v) { activeTabDesc.set.call(this, v); },
        });
      }
      try {
        return origAnimate.call(this, event);
      } finally {
        for (const g of stacks) {
          delete g.collapsed;
          delete g.hasActiveTab;
        }
      }
    };

    // ---- 3. drop: "next to the label" means next to the stack --------------
    const origDrop = dnd.handle_drop;
    dnd.handle_drop = function (event) {
      if (active) {
        try {
          const src = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
          const data = src && src === dragged ? src._dragData : null;
          const target = data?.dropElement;
          // A hover-join keeps the label: the engine adds the tabs to its group.
          if (target && !data.shouldDropIntoCollapsedTabGroup &&
              !keep.has(target) && isStack(target.group)) {
            data.dropElement = target.group;
          }
        } catch (e) {
          console.error("[stack-global-drag] drop:", e);
        }
      }
      return origDrop.call(this, event);
    };

    // ---- drag start --------------------------------------------------------
    const origStart = dnd.startTabDrag;
    dnd.startTabDrag = function (event, tab, options) {
      // Floorp starts stack-bar drags here with fromTabList (so does the
      // all-tabs menu, from inside its panel).
      if (options?.fromTabList && isStackMember(tab) &&
          tab.ownerDocument === document && !event?.target?.closest?.("panel")) {
        beginProxyDrag(tab);
      }
      const eligible = !options?.fromTabList && !tabs.verticalMode &&
        tab?.ownerDocument === document && !isStackMember(tab);
      if (!eligible) return origStart.apply(this, arguments);

      // Before the original: multi-select drags index the item list at start.
      activate(tab);
      let result;
      try {
        result = origStart.apply(this, arguments);
      } catch (e) {
        endDrag();
        throw e;
      }
      if (!tab._dragData) {
        endDrag();
      } else if (gBrowser.isTabGroupLabel(tab) && isStack(tab.group)) {
        tab._dragData.expandGroupOnDrop = false;
      }
      return result;
    };

    window.addEventListener("dragend", () => {
      if (active || tabs.hasAttribute(ACTIVE_ATTR)) endDrag();
    }, true);

    // ---- stack-bar drags ----------------------------------------------------
    // Started from the startTabDrag hook: a drag from a proxy the stack bar has
    // just re-rendered away never reaches window dragstart listeners.
    let proxyDrag = null;   // { tab, into, fixQueued }
    let proxyDragAt = 0;

    function beginProxyDrag(tab) {
      proxyDrag = { tab, into: null, fixQueued: false };
      proxyDragAt = performance.now();
      tabs.setAttribute(PROXY_ATTR, ""); // chip edges belong to the strip
    }
    const endProxyDrag = () => {
      tabs.removeAttribute(PROXY_ATTR);
      proxyDrag = null;
    };
    window.addEventListener("dragend", endProxyDrag, true);
    window.addEventListener(PROXY_DRAG_END_EVENT, endProxyDrag);

    // Into an expanded group: the spot Firefox would use for a tab under the
    // pointer. Over a member, its near side; over the label's trailing half,
    // the group's start. The label's leading half is "before the group", which
    // Floorp already handles. Returns { ref, before, x } or null.
    function spotInGroup(x) {
      for (const g of gBrowser.tabGroups) {
        if (isStack(g) || g.collapsed || g.style.display === "none") continue;
        const members = g.tabsAndSplitViews.filter(el => el.visible);
        const labelBox = g.labelElement?.closest(".tab-group-label-container");
        if (!members.length || !labelBox) continue;
        const lr = labelBox.getBoundingClientRect();
        const lastRect = members.at(-1).getBoundingClientRect();
        if (x < lr.left || x > lastRect.right) continue;
        if (x < lr.left + lr.width / 2) return null;
        for (const el of members) {
          const r = el.getBoundingClientRect();
          if (x < r.left + r.width / 2) return { ref: el, before: true, x: r.left };
        }
        return { ref: members.at(-1), before: false, x: lastRect.right };
      }
      return null;
    }

    // Floorp's strip caret (showStripDropLine), moved to the in-group spot.
    // Drawn in a frame callback so it lands after Floorp's own dragover
    // listener, whichever order the two were registered in.
    function drawGroupCaret() {
      const into = proxyDrag?.into;
      const ind = tabs.querySelector(".tab-drop-indicator");
      if (!into || !ind) return;
      const rect = tabs.arrowScrollbox.getBoundingClientRect();
      ind.hidden = false;
      ind.style.transform = `translateX(${Math.round(into.x - rect.left + ind.clientWidth / 2)}px)`;
    }

    window.addEventListener("dragover", (event) => {
      if (!proxyDrag) return;
      const inStrip = !!event.target?.closest?.("#TabsToolbar");
      proxyDrag.into = inStrip ? spotInGroup(event.clientX) : null;
      if (proxyDrag.into) requestAnimationFrame(drawGroupCaret);
    }, true);

    // Floorp's strip drop ungroups the tab and places it before/after the whole
    // group, inside its drop listener. The first move it makes queues the
    // correction, which runs once that listener returns — before repaint,
    // dragend, or anything timer-based (e.g. the multiselect gather).
    function onProxyTabMoved(tab) {
      const d = proxyDrag;
      if (!d || tab !== d.tab || !d.into || d.fixQueued) return;
      d.fixQueued = true;
      const { ref, before } = d.into;
      queueMicrotask(() => {
        try {
          if (!ref.isConnected || !tab.isConnected || ref === tab) return;
          if (before) gBrowser.moveTabBefore(tab, ref);
          else gBrowser.moveTabAfter(tab, ref);
        } catch (e) {
          console.error("[stack-global-drag] drop into group:", e);
        }
      });
    }
    tabs.addEventListener("TabMove", (e) => onProxyTabMoved(e.target));
    // Dispatched on the group it left, with the tab as detail.
    window.addEventListener("TabUngrouped", (e) => onProxyTabMoved(e.detail));

    // A drag that ends without a dragend (a stack-bar drag's source node can be
    // re-rendered away mid-drag) must not leave chips unclickable. The platform
    // session starts just after dragstart, hence the grace period.
    const endIfNoSession = () => {
      if (!active && !tabs.hasAttribute(ACTIVE_ATTR) && !tabs.hasAttribute(PROXY_ATTR)) return;
      if (performance.now() - Math.max(activatedAt, proxyDragAt) < 500) return;
      let session = null;
      try {
        session = dragService.getCurrentSession(window);
      } catch {
        return;
      }
      if (!session) {
        endDrag();
        endProxyDrag();
      }
    };
    window.addEventListener("mousemove", endIfNoSession, true);
    window.addEventListener("mousedown", endIfNoSession, true);

    console.log("[stack-global-drag] loaded");
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
