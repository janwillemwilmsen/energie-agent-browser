# Device profiles

A scenario's **mobile** viewport, and a screenshot step's **Mobile viewport** option, emulate a phone or tablet through agent-browser's `set device <name>`. The default is **iPhone 14**; a screenshot step can pick any other profile from the **Device** dropdown in its edit dialog (✎ on the step), which overrides the default for that step only.

Each profile sets the viewport size, the device scale factor and a matching user agent. These are agent-browser's built-in profiles (v0.38.1) — the list lives in its binary, not its docs, so it is reproduced here with measured values.

## The profiles

| Device | CSS viewport (w × h) | Scale | Screenshot pixels (viewport) | User agent |
| --- | --- | --- | --- | --- |
| iPhone 17 | **402 × 874** | 3× | 1206 × 2622 | iOS 19 |
| iPhone 16 Pro | **402 × 874** | 3× | 1206 × 2622 | iOS 18 |
| iPhone 16 | **393 × 852** | 3× | 1179 × 2556 | iOS 18 |
| iPhone 15 | **393 × 852** | 3× | 1179 × 2556 | iOS 17 |
| iPhone 14 *(default)* | **390 × 844** | 3× | 1170 × 2532 | iOS 16 |
| iPhone 12 | **390 × 844** | 3× | 1170 × 2532 | iOS 14 |
| iPad Pro | **1024 × 1366** | 2× | 2048 × 2732 | iPadOS 18 |
| iPad Air | **820 × 1180** | 2× | 1640 × 2360 | iPadOS 18 |
| iPad | **820 × 1180** | 2× | 1640 × 2360 | iPadOS 18 |
| Pixel 9 | **412 × 923** | 2.625× | 1082 × 2423 | Android 15 |
| Pixel 7 | **412 × 915** | 2.625× | 1082 × 2402 | Android 13 |
| Pixel 5 | **393 × 851** | 2.75× | 1081 × 2340 | Android 11 |
| Galaxy S25 | **360 × 800** | 3× | 1080 × 2400 | Android 15 |
| Galaxy S21 | **360 × 800** | 3× | 1080 × 2400 | Android 11 |

Names are matched case-insensitively and spaces are optional (`iphone16pro` works in the terminal).

## What the numbers mean

- **CSS viewport** is what the page's responsive breakpoints see. Three effective width classes: **360** (Galaxy), **390–412** (iPhones and Pixels), **820–1024** (iPads). An iPad shot usually lands on a tablet or desktop breakpoint, so it is a different layout, not a bigger phone.
- **Screenshot pixels** is the viewport capture size (CSS size × scale). A full-page capture is as tall as the page.
- **User agent** is the profile's own, and it replaces the stealth user agent from Admin → Browser while the device is active. The older profiles carry dated Chrome/iOS versions, which a WAF may treat as suspicious — prefer a current one when stealth matters.
- Pages **without** a `<meta name="viewport">` tag render at Chrome's 980 px desktop-site width on every device; the widths above apply to pages that declare `width=device-width`, which is nearly every production site.
- These profiles do **not** emulate touch (`navigator.maxTouchPoints` stays 0); a site that branches on touch capability still sees a mouse.

## Browser zoom (accessibility)

Many users run with browser or display zoom — Windows "125 %" scaling, Chrome's accessibility zoom, or Ctrl + on a site with small text. Chrome zooms by making a CSS pixel bigger, so at 200 % a 1440-px window is a **720 CSS px** viewport at scale 2: the page's breakpoints fire as they would for that user (a desktop site usually shows its tablet or phone layout), and the screenshot keeps its pixel size but shows everything larger and taller.

A screenshot step's **Browser zoom** dropdown emulates exactly that, on top of the desktop viewport or the step's mobile device:

| Zoom | Desktop 1440 × 900 becomes | iPhone 14 becomes | Typical use |
| --- | --- | --- | --- |
| 125 % | 1152 × 720 @ 1.25× | 312 × 675 @ 3.75× | Windows default scaling on many laptops |
| 150 % | 960 × 600 @ 1.5× | 260 × 563 @ 4.5× | "Larger" display setting |
| 200 % | 720 × 450 @ 2× | 195 × 422 @ 6× | WCAG 1.4.4 resize text |
| 300 % | 480 × 300 @ 3× | 130 × 281 @ 9× | Low-vision users |
| 400 % | 360 × 225 @ 4× | 98 × 211 @ 12× | WCAG 1.4.10 reflow (must work without horizontal scrolling) |

A zoomed capture is its own slot — `home-zoom200` — so the timeline and diffs pair it with other runs' zoomed shots, never with the unzoomed one. After the capture the run's viewport is restored, so following steps are unaffected.

What it does **not** emulate: text-only scaling (iOS Larger Text, Android font size, Chrome's font-size setting). That changes type size without changing the viewport, affects only sites that size text in `rem`/`em`, and is not exposed by the browser automation protocol.

## Where it applies

- **Scenario viewport = mobile (or both):** every step of the mobile pass runs on the default device.
- **Screenshot step → Mobile viewport:** the runner switches to the step's device (or the default), captures, and switches back to the run's viewport. The file gets the `-mobile` suffix so it pairs with other runs' mobile shots in the timeline and diffs.
- **Terminal:** `agent-browser set device "iPhone 16"` applies to the live session until you `set viewport` or restart it.
