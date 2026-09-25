// ==UserScript==
// @name           Stack tabs: container color line
// @include        main
// ==/UserScript==

// Container tabs in the global strip get a colored line along the bottom.
// Floorp's stack strip tabs are proxies that don't carry the container, so
// stack tabs show no color. This copies each real tab's container onto its
// proxy and draws the same line.
//
// Firefox colors the line from `--identity-*` custom properties, set by the
// `identity-color-<name>` class a container tab carries (usercontext.css —
// those rules match any element). We copy that class plus `usercontextid`
// onto the proxy, so the color follows Firefox's own palette and theme.
//
// The line is the proxy's `::before`; Floorp uses `::after` for the
// separators between stack tabs.

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const COLOR_CLASS_RE = /^identity-color-/;

  const CSS = `
    .floorp-stack-tab[usercontextid]::before {
      content: "";
      position: absolute;
      inset-inline: 6px;
      inset-block-end: 2px;
      height: 2px;
      border-radius: 1px;
      background: var(--identity-stroke-color, var(--identity-icon-color));
      pointer-events: none;
    }
  `;

  const realTabOf = (proxy) => {
    const id = proxy.getAttribute("data-floorp-drag-id");
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };

  function syncProxy(proxy) {
    const tab = realTabOf(proxy);
    const ctx = tab?.getAttribute("usercontextid");
    const color = ctx && Array.from(tab.classList).find(c => COLOR_CLASS_RE.test(c));

    for (const c of Array.from(proxy.classList)) {
      if (COLOR_CLASS_RE.test(c) && c !== color) proxy.classList.remove(c);
    }
    if (ctx && color) {
      if (proxy.getAttribute("usercontextid") !== ctx) proxy.setAttribute("usercontextid", ctx);
      proxy.classList.add(color);
    } else if (proxy.hasAttribute("usercontextid")) {
      proxy.removeAttribute("usercontextid");
    }
  }

  function syncAll() {
    for (const proxy of document.querySelectorAll(PROXY_SEL)) syncProxy(proxy);
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncAll(); });
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // Proxies are (re)built when you switch stacks or tabs join/leave one.
    gBrowser.tabContainer.addEventListener("TabSelect", scheduleSync);
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );
    // A container's color can be edited in settings.
    Services.obs.addObserver(scheduleSync, "contextual-identity-updated");
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(scheduleSync, "contextual-identity-updated");
    }, { once: true });

    syncAll();
    console.log("[stack-container-line] loaded");
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
