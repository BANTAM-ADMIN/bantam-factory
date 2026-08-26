const toggle = document.querySelector("#theme-toggle");

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const dawn = theme === "dawn";
  toggle.setAttribute("aria-pressed", String(dawn));
  toggle.textContent = dawn ? "Night" : "Dawn";
}

applyTheme("night");

toggle.addEventListener("click", () => {
  applyTheme(document.body.dataset.theme === "night" ? "dawn" : "night");
});
