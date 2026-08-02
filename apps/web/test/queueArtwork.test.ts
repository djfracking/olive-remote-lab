import { describe, expect, it } from "vitest";
import { queueArtworkSource } from "../src/components/QueuePanel";

describe("queue artwork routing", () => {
  it("rebases a cached same-device absolute artwork URL to the current endpoint", () => {
    const source = queueArtworkSource({
      host: "192.168.0.112",
      port: 80,
      deviceId: "uuid:olive-a",
    }, "http://192.168.0.124:80/covers/abba.jpg?size=small");
    expect(source).toContain("/api/artwork?");
    const query = new URL(source, "http://localhost").searchParams;
    expect(query.get("host")).toBe("192.168.0.112");
    expect(query.get("port")).toBe("80");
    expect(query.get("path")).toBe("/covers/abba.jpg?size=small");
  });

  it("does not create a request for missing artwork", () => {
    expect(queueArtworkSource({ host: "192.168.0.112", port: 80 }, "")).toBe("");
  });
});
