import { describe, expect, it } from "vitest";
import { parseUpnpXml } from "../src/upnpXml.js";

describe("bounded UPnP XML parsing", () => {
  it("rejects excessive nesting before recursive consumers can overflow", () => {
    const depth = 65;
    const xml = `${"<n>".repeat(depth)}${"</n>".repeat(depth)}`;
    expect(() => parseUpnpXml(xml)).toThrow("nesting exceeded");
  });

  it("rejects oversized XML before tokenization", () => {
    expect(() => parseUpnpXml(`<root>${"x".repeat(8 * 1024 * 1024)}</root>`))
      .toThrow("8 MiB safety limit");
  });
});
