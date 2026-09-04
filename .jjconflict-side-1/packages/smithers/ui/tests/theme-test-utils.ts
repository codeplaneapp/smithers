import { composeSmithersUiStyles } from "../src/styles";

const DARK_THEME_TEST_ATTR = "data-smithers-dark-theme-test";

export function installDarkThemeStyles(): void {
  if (document.querySelector(`style[${DARK_THEME_TEST_ATTR}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(DARK_THEME_TEST_ATTR, "");
  style.textContent = composeSmithersUiStyles({ withTheme: true });
  document.head.appendChild(style);
}

export function removeDarkThemeStyles(): void {
  document.querySelectorAll(`style[${DARK_THEME_TEST_ATTR}]`).forEach((element) => element.remove());
}
