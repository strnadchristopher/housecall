import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_CARDS, CALL_CARDS, EXTRA_CARDS, INTEGRATIONS } from "../src/ui/setup/steps";

const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
// Active and commented-out assignments both count as documented.
const known = new Set([...env.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));

describe("integration steps", () => {
  it("name only variables that exist in .env.example", () => {
    const used = Object.values(INTEGRATIONS).flatMap(card => card.steps)
      .flatMap(step => (typeof step === "string" || !("code" in step) ? [] : [...step.code.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1])));
    expect(used.length).toBeGreaterThan(8);
    for (const name of used) expect(known, name).toContain(name);
  });

  it("carry no secret-looking values", () => {
    for (const card of Object.values(INTEGRATIONS)) {
      for (const step of card.steps) {
        if (typeof step === "string" || !("code" in step)) continue;
        for (const line of step.code.split("\n")) {
          const value = line.slice(line.indexOf("=") + 1);
          expect(value, line).not.toMatch(/key|token|secret|password/i);
        }
      }
    }
  });

  it("link every card to an existing local integration guide", () => {
    for (const card of Object.values(INTEGRATIONS)) {
      const links = card.steps.filter(step => typeof step !== "string" && "href" in step);
      expect(links.length).toBe(1);
      for (const step of links) {
        if (typeof step === "string" || !("href" in step)) continue;
        const path = step.href.split("/blob/housecall/")[1];
        expect(path).toMatch(/^docs\/(SELF-HOSTING|apps\/(VM|GIMME|PLEX|DJ|GIFS))\.md$/);
        expect(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").length).toBeGreaterThan(100);
      }
    }
  });

  it("cover every card the server reports, and the wizard cards exist", () => {
    expect(Object.keys(INTEGRATIONS).sort()).toEqual([...ALL_CARDS].sort());
    for (const id of [...CALL_CARDS, ...EXTRA_CARDS]) expect(INTEGRATIONS[id].steps.length).toBeGreaterThan(0);
  });
});
