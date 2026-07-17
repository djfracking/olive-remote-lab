import { describe, expect, it } from "vitest";
import { parseResponseBody } from "../src/parser.js";

describe("response parsing", () => {
  it("pretty prints JSON", () => {
    expect(parseResponseBody('{"ok":true}', "application/json")).toEqual({
      kind: "json",
      formatted: '{\n  "ok": true\n}',
    });
  });

  it("identifies HTML", () => {
    const result = parseResponseBody("<html><body>Ready</body></html>", "text/html");
    expect(result.kind).toBe("html");
    expect(result.formatted).toContain("  <body>");
  });

  it("falls back to text for malformed JSON", () => {
    expect(parseResponseBody("{broken", "application/json").kind).toBe("text");
  });
});
