/** The tower, six rows of five cells, gold on the lamp: the mark the operator console shares. */
const TOWER = ["..#..", ".#.#.", "..#..", "..#..", ".###.", "#####"];
export function towerSvg(size = 24): string {
  const cell = size / TOWER.length;
  const rects = TOWER.flatMap((row, y) =>
    [...row].flatMap((c, x) =>
      c === "#"
        ? [
            `<rect x="${x * cell + cell / 2}" y="${y * cell}" width="${cell - 1}" height="${cell - 1}" fill="${y === 0 ? "#f5b942" : "#ececef"}"/>`,
          ]
        : [],
    ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${rects.join("")}</svg>`;
}

/** The tower on the page colour, as the favicon. */
export function faviconSvg(): string {
  const rects = TOWER.flatMap((row, y) =>
    [...row].flatMap((c, x) =>
      c === "#"
        ? [
            `<rect x="${x * 5 + 3.5}" y="${y * 5 + 1}" width="4" height="4" fill="${y === 0 ? "#f5b942" : "#ececef"}"/>`,
          ]
        : [],
    ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#08080a"/>${rects.join("")}</svg>`;
}
