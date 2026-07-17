import { describe, expect, it } from "vitest";
import { assertLocalUrl, isPrivateIpv4 } from "../src/security.js";

describe("local network request boundary", () => {
  it.each([
    "10.0.0.4",
    "127.0.0.1",
    "169.254.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.123",
  ])("accepts private IPv4 address %s", (address) => {
    expect(isPrivateIpv4(address)).toBe(true);
  });

  it.each(["0.0.0.0", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.0.2.1", "192.168.0.999"])(
    "rejects non-private IPv4 address %s",
    (address) => expect(isPrivateIpv4(address)).toBe(false),
  );

  it("accepts credential-free HTTP on the private LAN", async () => {
    await expect(assertLocalUrl("http://192.168.0.123:8163/index.php")).resolves.toMatchObject({
      hostname: "192.168.0.123",
      port: "8163",
      pathname: "/index.php",
    });
  });

  it.each([
    "https://192.168.0.123/",
    "http://user:secret@192.168.0.123/",
    "http://8.8.8.8/",
  ])("rejects target %s", async (target) => {
    await expect(assertLocalUrl(target)).rejects.toThrow();
  });
});
