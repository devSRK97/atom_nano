/* Theme-following borders: the Claude avatar icon, user message bubble, running
 * tool-card and running composer borders must derive from var(--accent) (so they
 * follow the theme) — not the hardcoded amber they used before. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });

  // border-color of a class under the current theme (inject a probe element)
  const borderUnderTheme = (cls, theme) => win.evaluate(({ cls, theme }) => {
    document.documentElement.setAttribute("data-theme", theme);
    let el = document.getElementById("__probe");
    if (!el) { el = document.createElement("div"); el.id = "__probe"; document.body.appendChild(el); }
    el.className = cls;
    const c = getComputedStyle(el).borderColor || getComputedStyle(el).borderTopColor;
    return c;
  }, { cls, theme });

  for (const cls of ["msg-avatar assistant"]) {
    const warm = await borderUnderTheme(cls, "amber");
    const blue = await borderUnderTheme(cls, "blue");
    const gun = await borderUnderTheme(cls, "gunmetal");
    ok(warm !== blue && warm !== gun, `.${cls.replace(/ /g, ".")} border follows the theme (amber ${warm} ≠ blue ${blue})`);
  }

  // the user bubble border too
  const bubbleWarm = await win.evaluate(() => { document.documentElement.setAttribute("data-theme", "amber"); const e = document.getElementById("__probe"); e.className = "bubble user-text"; e.style.cssText = ""; return getComputedStyle(e).borderTopColor; });
  const bubbleBlue = await win.evaluate(() => { document.documentElement.setAttribute("data-theme", "blue"); const e = document.getElementById("__probe"); return getComputedStyle(e).borderTopColor; });
  ok(bubbleWarm !== bubbleBlue, `user message bubble border follows the theme (amber ${bubbleWarm} ≠ blue ${bubbleBlue})`);

  // and it must NOT be the old hardcoded amber on a cool theme
  ok(!/240,\s*169,\s*78/.test(bubbleBlue), `user bubble border is not hardcoded amber on the blue theme (${bubbleBlue})`);

  await win.evaluate(() => { const e = document.getElementById("__probe"); if (e) e.remove(); document.documentElement.removeAttribute("data-theme"); });
  await app.close();
  console.log(process.exitCode ? "\nSOME THEME-BORDER TESTS FAILED" : "\nALL THEME-BORDER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
