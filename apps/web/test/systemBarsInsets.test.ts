import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import capacitorConfig from "../capacitor.config";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("system bar safe-area layout", () => {
  it("keeps Capacitor's Android inset bridge enabled", () => {
    expect(capacitorConfig.plugins?.SystemBars).toEqual({
      insetsHandling: "css",
      style: "DARK",
      hidden: false,
    });
  });

  it("uses Capacitor's injected insets with browser environment fallbacks", () => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(styles).toContain(
        `--app-safe-${edge}: var(--safe-area-inset-${edge}, env(safe-area-inset-${edge}, 0px))`,
      );
    }

    expect(styles.match(/env\(safe-area-inset-/g)).toHaveLength(4);
  });

  it("places the tablet player above the system bar and reserves its space", () => {
    expect(styles).toMatch(
      /\.app-shell \{ height: 100vh;[^}]*padding: calc\(8px \+ var\(--app-safe-top\)\) calc\(8px \+ var\(--app-safe-right\)\) calc\(var\(--player-height\) \+ var\(--app-safe-bottom\)\) calc\(8px \+ var\(--app-safe-left\)\);/,
    );
    expect(styles).toMatch(
      /\.mini-player \{ left: var\(--app-safe-left\); right: var\(--app-safe-right\); bottom: var\(--app-safe-bottom\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 720px\) \{[\s\S]*?\.mini-player \{[^}]*bottom: calc\(70px \+ var\(--app-safe-bottom\)\);/,
    );
  });
});
