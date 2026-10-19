// Barbell artwork used for every icon size. `size` is the full canvas; the art sits in the
// central 2/3 so adaptive-icon masks (circle, squircle) never clip it.
export function barbellSvg({ size, background = null, plate = "#ef4e3f", bar = "#eef0f3", scale = 0.62 }) {
  const s = size, c = s / 2, w = s * scale; // artwork width
  const u = w / 320; // artwork drawn on a 320-unit grid
  const x0 = c - w / 2;
  const rect = (x, y, wd, h, r, fill) => `<rect x="${x0 + x * u}" y="${c + y * u}" width="${wd * u}" height="${h * u}" rx="${r * u}" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    ${background ? `<rect width="${s}" height="${s}" fill="${background}"/>` : ""}
    ${rect(0, -12, 320, 24, 6, bar)}
    ${rect(30, -90, 40, 180, 10, plate)}
    ${rect(250, -90, 40, 180, 10, plate)}
    ${rect(80, -60, 26, 120, 8, bar)}
    ${rect(214, -60, 26, 120, 8, bar)}
  </svg>`;
}
