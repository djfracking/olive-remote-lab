import { describe, expect, it } from "vitest";
import { buildOliveUrl, endpointProbeUrls } from "../src/url.js";

describe("URL construction", () => {
  it("constructs an encoded device URL", () => {
    expect(buildOliveUrl({ host: "192.168.1.42", port: 80 }, "maestro.php", { q: "Miles Davis" }))
      .toBe("http://192.168.1.42/maestro.php?q=Miles+Davis");
  });

  it("constructs all six documented probe surfaces", () => {
    const urls = endpointProbeUrls({ host: "olive.local", port: 80 });
    expect(urls).toHaveLength(6);
    expect(urls[4]).toBe("http://olive.local:8163/maestro.php");
  });

  it("rejects a host containing a path", () => {
    expect(() => buildOliveUrl({ host: "192.168.1.5/admin", port: 80 })).toThrow(/without a path/);
  });
});
