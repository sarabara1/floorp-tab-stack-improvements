// ==UserScript==
// @name           Stack tabs: general improvements
// @include        main
// ==/UserScript==

// Makes stack tabs and stack chips look like global tabs: the indicators
// global tabs show, and the same button layout. Floorp's stack strip tabs
// are proxies that don't carry the real tab's state, so this mirrors it onto
// them, and onto the stack chip where it makes sense.
//
// Container line: container tabs in the global strip get a colored line
// along the bottom. Firefox colors it from `--identity-*` custom properties,
// set by the `identity-color-<name>` class a container tab carries
// (usercontext.css — those rules match any element). We copy that class plus
// `usercontextid` onto the proxy, so the color follows Firefox's own palette
// and theme. The line is the proxy's `::before`; Floorp uses `::after` for
// the separators between stack tabs.
//
// Audio button: a stack tab gets the speaker button a global tab shows next
// to its favicon — playing, muted, or autoplay-blocked. It is the same
// element a global tab uses (a `moz-button.tab-audio-button`) carrying the
// real tab's `soundplaying` / `muted` / `activemedia-blocked`, so whatever
// styles global tabs' audio buttons — Firefox's tabs.css, Floorp's Lepton
// theme and its options — styles it too. Two gaps are filled in:
//   • tabs.css only shows the button and draws its icon inside
//     #tabbrowser-tabs; the stack bar is outside it, so those rules are
//     repeated for the stack bar.
//   • the theme positions the button and title through custom properties
//     it sets on `.tabbrowser-tab` and `.tab-label-container`, which a proxy
//     isn't, so their computed values are copied from the real tab.
// Clicking it does what tab.js on_click does for `.tab-audio-button`: resume
// blocked media, otherwise toggle mute (on every selected tab when the tab is
// multiselected). Ctrl/Shift-clicks fall through, so they multiselect like on
// a global tab.
//
// The stack chip gets one too while any member is playing (or, failing that,
// muted): clicking it mutes every playing member, or unmutes every muted one.
// Autoplay-blocked media shows only on its own stack tab.
//
// Clicks on the buttons are caught on `windowRoot` in the capture phase —
// the first stop of every chrome event, ahead of Floorp's window-level
// capture listener that turns any chip click into "activate this stack" and
// the proxy's own click-to-select.
//
// Close button: Floorp's stack tabs and chips swap their icon for a close
// button on hover. Here it sits at the right end instead and the icon stays,
// so it never collides with the audio button. On stack tabs, Floorp's
// hover-reload button moves in front of it, matching the global tab order:
// title, reload, close. The title (and the chip's tab count) gives up that
// space on hover so it never runs under the buttons. The chip also keeps the
// arrow cursor, like a global tab, instead of Floorp's pointer.

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const STACK_ATTR = "data-floorp-stack";
  const COLOR_CLASS_RE = /^identity-color-/;
  const AUDIO_BTN = "uc-stack-audio-button";
  const AUDIO_ATTRS = ["soundplaying", "soundplaying-scheduledremoval", "muted", "activemedia-blocked"];
  const SYNC_ATTRS = [...AUDIO_ATTRS, "crashed"];

  // Theme custom properties that position the button and title, and the
  // element of a real tab they're set on.
  const THEME_VARS = [
    [tab => tab, [
      "--tab-icon-end-margin",
      "--tab-min-width-extra-icons",
      "--uc-sound-tab-icon-position-x",
      "--uc-sound-tab-icon-position-y",
    ]],
    [tab => tab.querySelector(".tab-label-container"), [
      "--uc-sound-tab-label-position-x",
    ]],
  ];

  const PROXY_TOOLTIPS = { playing: "Mute tab", muted: "Unmute tab", blocked: "Play tab" };
  const CHIP_TOOLTIPS = { playing: "Mute stack", muted: "Unmute stack" };

  const ICON = "chrome://browser/skin/tabbrowser/";

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

    /* tabs.css's own rules, which only match inside #tabbrowser-tabs. */
    #floorp-stack-bar .tab-audio-button:not([crashed]) {
      &:is([soundplaying], [muted], [activemedia-blocked]) {
        display: flex;
      }
      &[soundplaying]::part(button) {
        background-image: url("${ICON}tab-audio-playing-small.svg");
      }
      &[muted]::part(button) {
        background-image: url("${ICON}tab-audio-muted-small.svg");
      }
      &[activemedia-blocked]::part(button) {
        background-image: url("${ICON}tab-audio-blocked-circle-12.svg");
      }
    }

    /* A global tab with the button grows its min-width and changes the
       favicon's end margin; the theme may also shift the title. */
    .floorp-stack-tab[uc-audio] {
      min-width: calc(var(--tab-min-width, 76px) + var(--tab-min-width-extra-icons, 0px)) !important;
    }
    .floorp-stack-tab[uc-audio] > .floorp-stack-tab-iconbox {
      margin-inline-end: var(--tab-icon-end-margin, 6px);
    }
    .floorp-stack-tab[uc-audio] > .floorp-stack-tab-label {
      transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
    }

    /* Chip: the title is the label's ::before; sit in front of it, just
       past the (absolutely placed) stack icon. */
    tab-group[${STACK_ATTR}] .tab-group-label > .${AUDIO_BTN} {
      order: -1;
    }
    tab-group[${STACK_ATTR}] .tab-group-label[uc-audio]::before {
      transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
    }

    /* ---- Close button on the right ---- */
    .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close {
      position: absolute !important;
      inset-inline-end: 6px !important;
      inset-block-start: 50% !important;
      transform: translateY(-50%) !important;
    }

    /* Floorp paints a solid backdrop so the X can cover the favicon; at the
       end of the tab it only needs the hover highlight. */
    .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close:not(:hover) {
      background-color: transparent !important;
    }

    .floorp-stack-tab:hover > .floorp-stack-tab-iconbox > .floorp-stack-tab-icon {
      display: revert-layer !important;
    }

    .floorp-stack-tab > .floorp-stack-tab-refresh {
      inset-inline-end: 24px !important;
    }

    .floorp-stack-tab:hover > .floorp-stack-tab-label {
      margin-inline-end: 14px !important;
    }

    :root[floorp-hover-reload] .floorp-stack-tab:hover > .floorp-stack-tab-label {
      margin-inline-end: 32px !important;
    }

    /* Chip: Floorp positions its close button absolutely inside the label,
       so only the side changes. */
    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
      inset-inline-start: auto !important;
      inset-inline-end: 6px !important;
    }

    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close:not(:hover) {
      background-color: transparent !important;
    }

    tab-group[${STACK_ATTR}] .tab-group-label-container:hover .floorp-stack-icon {
      display: revert-layer !important;
    }

    /* The tab count is the label's ::after, flush with its end padding. */
    tab-group[${STACK_ATTR}] .tab-group-label-container:hover .tab-group-label {
      padding-inline-end: 24px !important;
    }

    /* Global tabs keep the arrow cursor; Floorp gives the chip a pointer. */
    tab-group[${STACK_ATTR}] .tab-group-label,
    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
      cursor: default !important;
    }
  `;

  const tabIdOf = (proxy) => proxy.getAttribute("data-floorp-drag-id");
  const realTabOf = (proxy) => {
    const id = tabIdOf(proxy);
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };

  // Precedence matches tabs.css, where the later rule wins:
  // activemedia-blocked > muted > soundplaying. Crashed tabs show no button.
  function tabAudioState(tab) {
    if (!tab || tab.hasAttribute("crashed")) return null;
    if (tab.hasAttribute("activemedia-blocked")) return "blocked";
    if (tab.hasAttribute("muted")) return "muted";
    if (tab.hasAttribute("soundplaying")) return "playing";
    return null;
  }

  function stackAudioState(group) {
    const states = group.tabs.map(tabAudioState);
    if (states.includes("playing")) return "playing";
    if (states.includes("muted")) return "muted";
    return null;
  }

  const setAttr = (el, name, value) => {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  };

  function copyThemeVars(tab, target) {
    for (const [elementOf, names] of THEME_VARS) {
      const el = tab && elementOf(tab);
      const style = el && getComputedStyle(el);
      for (const name of names) {
        const value = style?.getPropertyValue(name).trim();
        if (value) {
          if (target.style.getPropertyValue(name) !== value) target.style.setProperty(name, value);
        } else {
          target.style.removeProperty(name);
        }
      }
    }
  }

  // Keeps `parent`'s audio button showing `attrs` (audio attribute → value),
  // creating it with `place` or removing it when `attrs` is null.
  function syncAudioButton(parent, attrs, tooltip, place) {
    let btn = parent.querySelector(`:scope > .${AUDIO_BTN}`);
    if (!attrs) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-button");
      btn.className = `tab-audio-button ${AUDIO_BTN}`;
      btn.setAttribute("type", "icon ghost");
      btn.setAttribute("size", "small");
      btn.setAttribute("tabindex", "-1");
      place(btn);
    }
    for (const name of AUDIO_ATTRS) setAttr(btn, name, attrs[name] ?? null);
    setAttr(btn, "title", tooltip);
  }

  function syncContainer(proxy, tab) {
    const ctx = tab?.getAttribute("usercontextid");
    const color = ctx && Array.from(tab.classList).find(c => COLOR_CLASS_RE.test(c));

    for (const c of Array.from(proxy.classList)) {
      if (COLOR_CLASS_RE.test(c) && c !== color) proxy.classList.remove(c);
    }
    if (ctx && color) {
      setAttr(proxy, "usercontextid", ctx);
      proxy.classList.add(color);
    } else {
      setAttr(proxy, "usercontextid", null);
    }
  }

  function syncProxyAudio(proxy, tab) {
    const state = tabAudioState(tab);
    const attrs = state && Object.fromEntries(
      AUDIO_ATTRS.filter(a => tab.hasAttribute(a)).map(a => [a, tab.getAttribute(a)])
    );
    const iconbox = proxy.querySelector(":scope > .floorp-stack-tab-iconbox");
    setAttr(proxy, "uc-audio", state);
    copyThemeVars(state && tab, proxy);
    syncAudioButton(proxy, attrs, PROXY_TOOLTIPS[state],
      btn => iconbox ? iconbox.after(btn) : proxy.prepend(btn));
  }

  function syncChipAudio(group) {
    const label = group.querySelector(".tab-group-label");
    if (!label) return;
    // Groups Floorp doesn't present as stacks (plain groups, vertical mode)
    // keep their native look.
    const state = group.hasAttribute(STACK_ATTR) ? stackAudioState(group) : null;
    const attrs = state && { [state === "playing" ? "soundplaying" : "muted"]: "" };
    setAttr(label, "uc-audio", state);
    copyThemeVars(state && group.tabs.find(t => tabAudioState(t) === state), label);
    syncAudioButton(label, attrs, CHIP_TOOLTIPS[state], btn => label.append(btn));
  }

  function syncAll() {
    const tabsById = new Map(gBrowser.tabs.map(t => [t.getAttribute("data-floorp-tab-id"), t]));
    for (const proxy of document.querySelectorAll(PROXY_SEL)) {
      const tab = tabsById.get(tabIdOf(proxy)) ?? null;
      syncContainer(proxy, tab);
      syncProxyAudio(proxy, tab);
    }
    for (const group of gBrowser.tabGroups) syncChipAudio(group);
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncAll(); });
  }

  function onAudioButtonClick(btn) {
    const proxy = btn.closest(PROXY_SEL);
    if (proxy) {
      const tab = realTabOf(proxy);
      if (!tab) return;
      if (tabAudioState(tab) === "blocked") {
        if (tab.multiselected) gBrowser.resumeDelayedMediaOnMultiSelectedTabs(tab);
        else tab.resumeDelayedMedia();
      } else if (tab.multiselected) {
        gBrowser.toggleMuteAudioOnMultiSelectedTabs(tab);
      } else {
        tab.toggleMuteAudio();
      }
      return;
    }
    const group = btn.closest(`tab-group[${STACK_ATTR}]`);
    if (!group) return;
    const state = stackAudioState(group);
    for (const tab of group.tabs) {
      if (tabAudioState(tab) === state) tab.toggleMuteAudio();
    }
  }

  // Plain left presses on a button stop here, before Floorp or the proxy see
  // them; mousedown's default is cancelled so it can't start a drag. The
  // moz-button's inner <button> is in its shadow tree, so events arrive
  // retargeted to the moz-button itself.
  function onPress(e) {
    if (e.button !== 0 || e.shiftKey || e.getModifierState("Accel")) return;
    const btn = e.target?.closest?.(`.${AUDIO_BTN}`);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "click") onAudioButtonClick(btn);
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // Proxies are (re)built when you switch stacks or tabs join/leave one,
    // and a chip's label children are replaced when the stack is renamed.
    gBrowser.tabContainer.addEventListener("TabSelect", scheduleSync);
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );
    // Audio state lives in tab attributes.
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => {
      if (e.detail?.changed?.some(a => SYNC_ATTRS.includes(a))) scheduleSync();
    });
    // A container's color can be edited in settings.
    Services.obs.addObserver(scheduleSync, "contextual-identity-updated");
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(scheduleSync, "contextual-identity-updated");
    }, { once: true });

    for (const type of ["mousedown", "click", "dblclick"]) {
      window.windowRoot.addEventListener(type, onPress, true);
    }

    syncAll();
    console.log("[stack-general-improvements] loaded");
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
