/**
 * Light and dark theme. The choice ("system", "light" or "dark") is kept in this browser's
 * localStorage only; it is a display preference and holds no imported data. The page's
 * <html> element gets `data-theme="light"` or `"dark"`, which the `dark:` variant in
 * globals.css follows. Without JavaScript there is no attribute, and the theme follows the
 * system setting.
 */

export const THEME_STORAGE_KEY = "threadatlas-theme";
export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/**
 * Runs in <head> before the page is painted, so a dark page never flashes light. Re-applies
 * when the system setting changes or another tab changes the choice. Kept in step with
 * `applyTheme` in the theme switch.
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");function apply(){var c=null;try{c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}d.setAttribute("data-theme",c==="light"||c==="dark"?c:m.matches?"dark":"light")}apply();m.addEventListener("change",apply);window.addEventListener("storage",function(e){if(e.key===${JSON.stringify(THEME_STORAGE_KEY)})apply()})})();`;
