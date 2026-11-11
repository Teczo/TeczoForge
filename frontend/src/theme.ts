import { useState } from "react";

// Light and dark mode. Light is the default. The choice is kept in this browser.
// The colours themselves are in theme.css. This file only switches between them, by setting
// data-theme="dark" on <html>. The small script in index.html does the same before the page is
// drawn, so there is no flash of the wrong theme. Keep the key below the same in both places.

export type Theme = "light" | "dark";

const THEME_KEY = "teczoforge.theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light"; // No storage (for example a private window).
  }
}

function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // No storage: the choice is kept until the page is refreshed.
  }
}

// The current theme, and a function that switches to the other one.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  return [theme, toggle];
}
