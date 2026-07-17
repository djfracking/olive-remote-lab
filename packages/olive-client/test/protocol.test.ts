import { describe, expect, it } from "vitest";
import {
  isVerifiedReadOnlySurface,
  OLIVE_4HD_MAESTRO_PAGE_SIZE,
  OLIVE_4HD_OBSERVED_SURFACES,
} from "../src/protocol.js";

describe("observed 4HD protocol inventory", () => {
  it("only marks verified read-only evidence as safe to probe", () => {
    const safe = OLIVE_4HD_OBSERVED_SURFACES.filter(isVerifiedReadOnlySurface);
    expect(safe.map(({ id }) => id)).toEqual([
      "maestro.navigation-root",
      "maestro.sub-navigation",
      "maestro.current-playing",
      "maestro.item-information",
      "front-panel.language-maestro",
      "front-panel.music-library-menu",
      "maestro.library-children",
      "maestro.search",
    ]);
  });

  it("keeps destructive actions quarantined", () => {
    const destructive = OLIVE_4HD_OBSERVED_SURFACES.filter(({ risk }) => risk.endsWith("mutation"));
    expect(destructive.every(({ evidence }) => evidence === "static-reference")).toBe(true);
  });

  it("records the observed Maestro pagination size", () => {
    expect(OLIVE_4HD_MAESTRO_PAGE_SIZE).toBe(21);
  });
});
