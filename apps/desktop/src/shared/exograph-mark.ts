export const EXOGRAPH_MARK_VIEW_BOX = "0 0 64 64";

export const EXOGRAPH_MARK_ARMS = [
  "M32 32C34 27 31 23 31.2 16.3",
  "M32 32C38 29 42 25 47 22",
  "M32 32C37 36 42 39 48 41.8",
  "M32 32C35 39 33 43 31.3 48",
  "M32 32C25 34 22 38 16.5 41",
  "M32 32C26 31 22 27 17 23",
] as const;

export const EXOGRAPH_MARK_NODES = [
  { cx: 31, cy: 10, r: 5 },
  { cx: 52, cy: 20, r: 5.6 },
  { cx: 53, cy: 44, r: 5 },
  { cx: 30, cy: 54, r: 5 },
  { cx: 11, cy: 43, r: 5 },
  { cx: 12, cy: 21, r: 5.6 },
] as const;

// macOS menu-bar template images must be raster-backed. Electron 41 returns an
// empty NativeImage for SVG data URLs, so keep this 18 px PNG derivative beside
// the canonical vector geometry rather than making AppLifecycle know about the
// platform-specific representation.
const EXOGRAPH_TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAABpklEQVQ4EZ3TyyuEURzGcfckue1EKRspsrCSXEqykCIL/4BYyMZGyQIlEkUWpljYKsqlLJTGzgYbt6IYcosidxq376Nz3kbMq96nPn4/5z3zvueceSc6wj1RXM5FEC/uU8NfjeHSMj5xh1J4SjmfekMOpjCLsNHSbdJpypBoBs6pkWhDAU5hU0TThwY7YGsVzRM+cIwMKE14xy7SoOgmWukKHtEOJ366cSTgAINQ4qAzmtY/Jtrikem7qKum/y4L/F1EMbSqe5RACUArSobOSjfWnG7sYwxO8ugOoUlb0JKD0GQ9QNsLQNfn0AOtRDdJwq/oqUo+tmGfrqozbMGfCf3WNOHWzLqhXpjelgcanZ9rCrm6Du15BNfQKiahbajXdlXnUY1R9CIFTjboZjABTb5CHZROaKwWmqNeh72JPfx4UbWSITRCB5sFGz/NK/RqKBXQzSrRjBM4qafT0nWTDjMaSx02YztmzJYlGv3+9EMesIO2xtOEfpWt/H8JH55RAxu9qHq4VvVv+pmxhkxo+dqGp2TzqTPoPPRmp8JzdMB667UV13wBV1drBcZVPvgAAAAASUVORK5CYII=";

export function exographMarkSvgDataUrl(size = 18): string {
  const arms = EXOGRAPH_MARK_ARMS.map((d) => `<path d="${d}"/>`).join("");
  const nodes = EXOGRAPH_MARK_NODES
    .map(({ cx, cy, r }) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${EXOGRAPH_MARK_VIEW_BOX}"><g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="6">${arms}</g><g fill="none" stroke="#000" stroke-width="4.5">${nodes}</g></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function exographTrayIconDataUrl(): string {
  return `data:image/png;base64,${EXOGRAPH_TRAY_ICON_PNG_BASE64}`;
}
