const root = document.documentElement;
const buttons = [...document.querySelectorAll("[data-theme-choice]")];

function setTheme(theme) {
  root.dataset.theme = theme;
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
}
