# Floorp Tab Stack Improvements 
The tab stack implementation leaves a lot to be desired. They're clunky and frustrating to use. With the help of ~~vibecoding~~ Agentic Enginnering I've created a set of userscripts (and an optional stylesheet) to make tab stacks practical. The end goal is to make tab stacks as seamless and practical as global tabs, like Vivaldi. The scripts and stylesheet are modular and self-contained, pick and choose what to add.

# Recommended
**stacktab-mouse-improvements.uc.js** - The single biggest improvement. Context-aware middle click to open a new tab. New tabs will open in the stack or global tabs depending on where you click, fixes opening on right click, as well as drag and drop support for text/images/whatever. Dragging tabs from other windows aren't yet supported, but planned.

**stacktab-hotkey-opens-in-stack.uc.js** - Makes the new tab hotkey & gesture context-aware. New tabs are opened in the currently active stack or in the global tab area, depending on which you're using.

**stacktab-inline-newtab-button.uc.js** - Moves the stack's new tab button to the right end of your tabs just like in the global area. It will snap to the window when the tabs overflow like global tabs.

**stacktab-close-confirm.uc.js** - Adds a dialog when closing a stack or group if it contains multiple tabs just like windows if "Ask before closing multiple tabs" is enabled in your settings.

**stacktab-overflow-scroll-speed.uc.js** - Scrolling overflowed tabs within a stack was frustratingly slow. This script makes it smoother and faster, similar to global tabs. It's not 1:1 but still a major improvement. WIP.

# Optional

**stacktab-newtab-expand-animation.uc.js** - Adds the opening animation to stack tabs. Purely cosmetic but adds missing polish.

**floorp-about-page-singletons.uc.js** - Makes the Floorp hub a singleton like the rest of the about: pages. This makes them open in the global tabs and the browser will prefer to switch to existing hubs instead of opening a new one. Simply adds cohesion with the rest of Firefox.

**userChrome.css** - Makes stacks a bit more compact, between the width of a group and normal tab. 

# Installation

Install fx-autoconfig https://github.com/MrOtherGuy/fx-autoconfig then copy the JS folder and optionally userChrome.css to your profile -> chrome folder (you'll know where it is after installing fx-autoconfig). Delete unwanted scripts as you wish.
