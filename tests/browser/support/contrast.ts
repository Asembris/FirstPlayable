import type { Page } from "@playwright/test";

/**
 * A WCAG 1.4.3 audit of the visible text on a Rehearsal Table page.
 *
 * Every visible text node inside `.rt` is checked against the colour it
 * actually sits on: the nearest ancestor with a painted background, or the
 * revision stock a changed cell sweeps in underneath its text. Text at 24px,
 * or 18.66px and bold, is large and needs 3:1; everything else needs 4.5:1.
 *
 * Stricter than WCAG on purpose: a locked action's name and the gutter's line
 * numbers are exempt there (a disabled control; text hidden from assistive
 * technology), but sighted visitors read both, and the causal note refers to
 * rows by number. Only text that is not rendered, and one-glyph ornaments
 * (an asterisk, a dash, an arrow) that sit beside real text, are skipped.
 */
export type ContrastFailure = {
  readonly text: string;
  readonly ratio: number;
  readonly needed: number;
  readonly color: string;
  readonly background: string;
};

export async function auditContrast(page: Page): Promise<ContrastFailure[]> {
  // Text behind a disclosure is read once opened, so it is audited open.
  await page.evaluate(() => {
    for (const details of document.querySelectorAll(".rt details")) details.setAttribute("open", "");
  });
  return page.evaluate(() => {
    type Rgb = [number, number, number];
    const parse = (value: string): [number, number, number, number] | null => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (match === null) return null;
      const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const luminance = ([r, g, b]: Rgb): number => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: Rgb, b: Rgb): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const backgroundOf = (element: Element): Rgb => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (node.classList.contains("rt-cell--with")) {
          const stock = getComputedStyle(node, "::before");
          const painted = parse(stock.backgroundColor);
          if (painted !== null && painted[3] > 0 && stock.transform !== "matrix(0, 0, 0, 1, 0, 0)") {
            return [painted[0], painted[1], painted[2]];
          }
        }
        const painted = parse(getComputedStyle(node).backgroundColor);
        if (painted !== null && painted[3] > 0.5) return [painted[0], painted[1], painted[2]];
      }
      return [244, 244, 240];
    };
    const visible = (element: Element): boolean => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.5) {
          return false;
        }
        if (node.classList.contains("rt-sr-only")) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    };

    const failures: {
      text: string;
      ratio: number;
      needed: number;
      color: string;
      background: string;
    }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const element = node.parentElement;
      if (text.length === 0 || element === null || element.closest(".rt") === null) continue;
      if (element.closest("dialog:not([open])") !== null || !visible(element)) continue;
      if ([...text].length <= 1) continue;
      const style = getComputedStyle(element);
      const fg = parse(style.color);
      if (fg === null) continue;
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const needed = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const bg = backgroundOf(element);
      const value = ratio([fg[0], fg[1], fg[2]], bg);
      if (value + 0.005 < needed) {
        failures.push({
          text: text.slice(0, 60),
          ratio: Math.round(value * 100) / 100,
          needed,
          color: style.color,
          background: `rgb(${bg.join(", ")})`,
        });
      }
    }
    return failures;
  });
}
