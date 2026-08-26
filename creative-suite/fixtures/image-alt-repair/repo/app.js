(() => {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll("[data-theme-choice]")];

  function setTheme(theme) {
    root.dataset.theme = theme;
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
    });
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "n") setTheme("night");
    if (event.key.toLowerCase() === "d") setTheme("dawn");
  });
})();
