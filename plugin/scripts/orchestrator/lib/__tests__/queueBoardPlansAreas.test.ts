/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansAreas.test.ts: the area cards on the Plans overview (board step B32, finding PL1).
//
// What the tests prove:
//   - each segment of the priority and maturity bars carries its own text (symbol and count), with the word in a
//     tooltip, and the card's accessible name names every group with its count, so color is never alone,
//   - one shared legend above the cards explains the symbols and colors once, instead of a legend under every bar,
//   - priority is never red: the overview's priority segments use the primary, warn and neutral tones, and red
//     (error, danger) stays for errors; every segment's text holds 4.5:1 and its edge 3:1 in light and dark,
//   - the card face is a short summary, and the full breakdown sits in a "Details" disclosure after the card button
//     (its own tab stop, never inside the button), so all the numbers stay reachable.
// The overview is the repo's own plans/overview.js, run in jsdom with the real QueuePlanView (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const V = require("../queuePlanView.js");
const { PALETTE } = require("../queueBoard.js") as {
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
};
const U = require("../../queue-board/a11y.js") as {
  contrast: (a: string, b: string) => number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, "..", "..", "queue-board");
const overviewJs = readFileSync(join(CLIENT, "plans", "overview.js"), "utf8");
const css = readFileSync(join(CLIENT, "plans", "plans.css"), "utf8");

type Post = Record<string, unknown>;

function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    project: "export",
    module: "alpha",
    priority: "later",
    now_category: [],
    maturity: "idea",
    size: "M",
    ownerQuestions: [],
    legal_open: 0,
    stale: false,
    tasks: [],
    finished: 0,
    total: 0,
    ...extra,
  };
}

const DATA = {
  exists: true,
  modules: [
    { oid: "alpha", title: "Alpha" },
    { oid: "beta", title: "Beta" },
  ],
  entries: [
    entry("PL-A", { priority: "now", maturity: "planned" }),
    entry("PL-B", { priority: "now", maturity: "ready" }),
    entry("PL-C", { priority: "owner", maturity: "idea" }),
    entry("PL-D", { priority: "later", maturity: "built" }),
    entry("PL-E", {
      module: "beta",
      priority: "later",
      maturity: "investigated",
    }),
  ],
  decisions: { openOnes: [] },
  recent: { changed: [], registered: [] },
};

/** The same small element helper as plans.js (attributes, text, events, CSS variables). */
function el(
  tag: string,
  attr: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (k.startsWith("on"))
      e.addEventListener(k.slice(2), v as EventListener);
    else if (k.startsWith("--")) e.style.setProperty(k, String(v));
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const b of (children as unknown[]).flat())
    if (b != null && b !== false) e.append(b as Node);
  return e;
}

let page: HTMLElement;
beforeAll(() => {
  const w: any = { QueuePlanView: V };
  new Function("window", overviewJs)(w);
  const h = {
    el,
    goToList: () => {},
    goToEntry: () => {},
    use: () => {},
    date: (x: string) => x,
  };
  page = w.QueuePlanOverview.side(h, DATA);
  document.body.append(page);
});

const cards = () =>
  [...page.querySelectorAll(".overview-summary-space")] as HTMLElement[];
const alpha = () => cards()[0];

describe("labelled segments", () => {
  it("the maturity groups have their own symbols, different from the priority symbols", () => {
    const k = V.moduleSummary(DATA)[0];
    const pri = k.priority.map((x: Post) => x.symbol);
    const mod = k.maturity.map((x: Post) => x.symbol);
    expect(
      mod.every((s: unknown) => typeof s === "string" && s.length > 0),
    ).toBe(true);
    expect(new Set([...pri, ...mod]).size).toBe(pri.length + mod.length);
  });

  it("each segment shows its symbol and count as text, with the word in the tooltip; a 0 draws no segment", () => {
    const segs = [
      ...alpha().querySelectorAll(".overview-del"),
    ] as HTMLElement[];
    // Alpha: Now 2, Owner 1 (Later 1 too), maturity early 1, planned 2, built 1.
    const texts = segs.map((s) => s.textContent?.replace(/\s+/g, " ").trim());
    expect(texts).toContain("● 2");
    expect(texts).toContain("◆ 1");
    expect(texts).toContain("○ 1");
    const titles = segs.map((s) => s.getAttribute("title"));
    expect(titles).toContain("Now: 2");
    expect(titles).toContain("Planned and ready: 2");
    expect(
      titles.some((t) => t?.startsWith("In queue and partially built")),
    ).toBe(false);
  });

  it("the card button's accessible name names every priority and maturity group with its count", () => {
    const name =
      alpha()
        .querySelector("button.overview-summary")
        ?.getAttribute("aria-label") ?? "";
    expect(name).toMatch(/^Alpha: 4 entries\./);
    for (const part of [
      "Now 2",
      "Owner 1",
      "Later 1",
      "Idea and investigated 1",
      "Planned and ready 2",
      "In queue and partially built 0",
      "Built and verified 1",
      "Built 1 of 4",
    ])
      expect(name).toContain(part);
    expect(name).toMatch(/Open the list filtered on the area\.$/);
  });
});

describe("one shared legend", () => {
  it("stands once, above the cards, and names every symbol with its word", () => {
    const legends = page.querySelectorAll(".overview-legend");
    expect(legends).toHaveLength(1);
    const legend = legends[0] as HTMLElement;
    const list = page.querySelector(".overview-shortlist") as HTMLElement;
    expect(
      legend.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const text = legend.textContent ?? "";
    for (const g of [...V.AREA_LEGEND.priority, ...V.AREA_LEGEND.maturity]) {
      expect(text).toContain(g.symbol);
      expect(text).toContain(g.text);
    }
  });

  it("no card repeats a legend under its bars", () => {
    expect(page.querySelectorAll(".overview-explanation")).toHaveLength(0);
  });
});

/** The declarations of one CSS rule with exactly this selector (comments stripped). */
function rule(selector: string): Record<string, string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`(^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`no rule ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[2].split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}
const token = (v: string | undefined) =>
  v?.match(/var\(--color-([a-z0-9-]+)\)/)?.[1];

describe("priority without red, and contrast", () => {
  const SEGMENTS = [
    "pri-now",
    "pri-owner",
    "pri-later",
    "mod-early",
    "mod-planned",
    "mod-work",
    "mod-built",
  ];

  it("no overview priority rule uses an error or danger token", () => {
    for (const id of ["pri-now", "pri-owner", "pri-later"]) {
      const r = rule(`.overview-del.${id}`);
      expect(Object.values(r).join(" ")).not.toMatch(/error|danger/);
    }
    // And no other rule on the overview colors a priority red.
    const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(
      /([^{}]*\.overview[^{}]*\.pri-[a-z]+[^{}]*)\{([^}]*)\}/g,
    ))
      expect(m[2]).not.toMatch(/error|danger/);
  });

  it("every segment: text 4.5:1 on its fill, edge 3:1 against the card and its hover surface, light and dark", () => {
    for (const mode of ["light", "dark"] as const) {
      const p = PALETTE[mode];
      for (const id of SEGMENTS) {
        const r = rule(`.overview-del.${id}`);
        const fill = token(r.background) ?? "surface-container-lowest";
        const text = token(r.color);
        const edge = token(r["border-color"]);
        expect(text, `${mode} ${id} color`).toBeTruthy();
        expect(edge, `${mode} ${id} border-color`).toBeTruthy();
        expect(
          U.contrast(p[text!], p[fill]),
          `${mode} ${id} text`,
        ).toBeGreaterThanOrEqual(4.5);
        for (const behind of [
          "surface-container-lowest",
          "surface-container-high",
          "surface-container-low",
        ])
          expect(
            U.contrast(p[edge!], p[behind]),
            `${mode} ${id} edge on ${behind}`,
          ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("the card face is a summary, the details hold the rest", () => {
  it("the card face has no long maturity words and no running legend text", () => {
    const face = alpha().querySelector(
      "button.overview-summary",
    ) as HTMLElement;
    const text = face.textContent ?? "";
    expect(text).not.toContain("Idea and investigated");
    expect(text).not.toContain("In queue and partially built");
    expect(text).toContain("Built 1 of 4");
  });

  it("a Details disclosure follows the button (its own tab stop) and holds every group with its count", () => {
    const card = alpha();
    const button = card.querySelector("button.overview-summary") as HTMLElement;
    const details = card.querySelector(
      "details.overview-card-details",
    ) as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(button.contains(details)).toBe(false);
    expect(
      button.querySelector("a,button,summary,input,[tabindex]"),
    ).toBeNull();
    expect(
      button.compareDocumentPosition(details) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const summary = details.querySelector("summary") as HTMLElement;
    expect(summary.textContent).toContain("Details");
    expect(summary.textContent).toContain("Alpha");
    const text = details.textContent ?? "";
    for (const part of [
      "Now 2",
      "Owner 1",
      "Later 1",
      "Idea and investigated 1",
      "Planned and ready 2",
      "In queue and partially built 0",
      "Built and verified 1",
    ])
      expect(text).toContain(part);
  });

  it("the CSS has no hex and no pill radius for the new parts", () => {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const sel of [".overview-del", ".overview-legend-swatch"])
      expect(rule(sel)["border-radius"] ?? "").not.toMatch(/9999|50%/);
  });
});
