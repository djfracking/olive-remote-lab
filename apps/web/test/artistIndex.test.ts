import { describe, expect, it } from "vitest";
import { artistInitial, browsePageState } from "../src/components/LibraryView";
import { alphabetizeLibraryItems } from "../src/librarySorting";

describe("artist A-Z buckets", () => {
  it("folds diacritics into the visible Latin bucket", () => {
    expect(artistInitial("Álvaro Soler")).toBe("A");
    expect(artistInitial("Édith Piaf")).toBe("E");
  });

  it("uses the catch-all bucket for numbers and symbols", () => {
    expect(artistInitial("10cc")).toBe("#");
    expect(artistInitial("!Deladap")).toBe("#");
  });

  it("sorts track titles alphabetically instead of by artist", () => {
    const items = [
      { id: "3", title: "Waterloo", childCount: 0, userData: { type: "track", artist: "ABBA" } },
      { id: "1", title: "Dancing Queen", childCount: 0, userData: { type: "track", artist: "ABBA" } },
      { id: "2", title: "10 Years Gone", childCount: 0, userData: { type: "track", artist: "Led Zeppelin" } },
    ];
    expect(alphabetizeLibraryItems(items).map((item) => item.title)).toEqual([
      "10 Years Gone",
      "Dancing Queen",
      "Waterloo",
    ]);
  });

  it("retains the actual returned count and next cursor for capped pages", () => {
    expect(browsePageState("artists", 42, 64, 7, 100, [0, 21])).toEqual({
      requestIdentity: "artists",
      startingIndex: 42,
      requestedCount: 64,
      numberReturned: 7,
      nextStartingIndex: 49,
      totalItems: 100,
      previousStartingIndices: [0, 21],
    });
  });
});
