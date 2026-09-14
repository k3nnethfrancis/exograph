const appearanceMode = "system";
const resolvedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

document.documentElement.dataset.appearanceMode = appearanceMode;
document.documentElement.dataset.theme = resolvedTheme;
document.documentElement.dataset.colorTheme = "exograph-neutral";
document.documentElement.style.colorScheme = resolvedTheme;
