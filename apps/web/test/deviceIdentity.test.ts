import { describe, expect, it } from "vitest";
import {
  canAdoptDeviceCache,
  deviceCacheNamespace,
  deviceEndpointKey,
  deviceRequestKey,
  devicesReferToSameOlive,
  mergeStableOliveTarget,
  normalizeDeviceIdentity,
  stableDeviceIdentity,
  upsertSavedDevice,
  type StableOliveTarget,
} from "../src/deviceIdentity";

describe("stable Olive identity", () => {
  it.each([
    [" UUID:ABCDEF01-2345-6789-ABCD-EF0123456789 ", "uuid:abcdef01-2345-6789-abcd-ef0123456789"],
    ["uuid:ABC::urn:schemas-upnp-org:device:MediaServer:1", "uuid:abc"],
    ["urn:uuid:ABC", "uuid:abc"],
    ["upnp:uuid:ABC", "uuid:abc"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeDeviceIdentity(input)).toBe(expected);
  });

  it.each(["", "Olive 4HD", "urn:schemas-upnp-org:device:MediaServer:1", "192.168.0.112"])(
    "rejects non-device identity %s",
    (input) => expect(normalizeDeviceIdentity(input)).toBeNull(),
  );

  it("uses UDN first and safely falls back through USN and endpoint", () => {
    expect(stableDeviceIdentity({
      host: "192.168.0.112",
      port: 80,
      udn: "uuid:MEDIA",
      usn: "uuid:OTHER::urn:schemas-upnp-org:device:MediaServer:1",
    })).toBe("uuid:media");
    expect(deviceCacheNamespace({
      host: "192.168.0.112",
      port: 80,
      usn: "uuid:MEDIA::urn:schemas-upnp-org:device:MediaServer:1",
    })).toBe("upnp:uuid:media");
    expect(deviceCacheNamespace({ host: " Olive.Local ", port: 8163 })).toBe("olive.local:8163");
    expect(deviceEndpointKey({ host: " Olive.Local ", port: 8163 })).toBe("olive.local:8163");
  });

  it("matches a known Olive after a DHCP address change", () => {
    const prior = { host: "192.168.0.124", port: 80, deviceId: "uuid:olive-a" };
    const discovered = { host: "192.168.0.112", port: 80, udn: "UUID:OLIVE-A" };
    expect(devicesReferToSameOlive(prior, discovered)).toBe(true);
    expect(canAdoptDeviceCache(prior, discovered)).toBe(true);
  });

  it("keeps cache identity stable while request identity follows DHCP and service ports", () => {
    const prior: StableOliveTarget = {
      host: "192.168.0.112",
      port: 80,
      deviceId: "uuid:olive-a",
      services: [{
        serviceType: "urn:schemas-upnp-org:service:ContentDirectory:1",
        serviceId: "urn:upnp-org:serviceId:ContentDirectory",
        rawScpdUrl: "/ContentDirectory1.xml",
        rawControlUrl: "/control",
        rawEventSubUrl: "/event",
        scpdUrl: "http://192.168.0.112:49152/ContentDirectory1.xml",
        controlUrl: "http://192.168.0.112:49152/control",
        eventSubUrl: "http://192.168.0.112:49152/event",
        deviceUdn: "uuid:olive-a",
      }],
    };
    const moved = {
      ...prior,
      host: "192.168.0.119",
      services: prior.services?.map((service) => ({
        ...service,
        scpdUrl: "http://192.168.0.119:49154/ContentDirectory1.xml",
        controlUrl: "http://192.168.0.119:49154/control",
        eventSubUrl: "http://192.168.0.119:49154/event",
      })),
    };
    expect(deviceCacheNamespace(moved)).toBe(deviceCacheNamespace(prior));
    expect(deviceRequestKey(moved)).not.toBe(deviceRequestKey(prior));
  });

  it("never merges distinct stable identities even at the same endpoint", () => {
    const prior = { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" };
    const replacement = { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-b" };
    expect(devicesReferToSameOlive(prior, replacement)).toBe(false);
    expect(canAdoptDeviceCache(prior, replacement)).toBe(false);
  });

  it("does not move an unidentified legacy cache across IP addresses", () => {
    const legacy = { host: "192.168.0.124", port: 80 };
    const discovered = { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" };
    expect(devicesReferToSameOlive(legacy, discovered)).toBe(false);
    expect(canAdoptDeviceCache(legacy, discovered)).toBe(false);
    expect(canAdoptDeviceCache({ ...legacy, host: discovered.host }, discovered)).toBe(true);
  });

  it("upgrades and relocates one saved Olive without touching another", () => {
    interface NamedTarget extends StableOliveTarget { name: string }
    const existing: NamedTarget[] = [
      { host: "192.168.0.124", port: 80, deviceId: "uuid:olive-a", name: "Living Room" },
      { host: "192.168.0.113", port: 80, deviceId: "uuid:olive-b", name: "Office" },
    ];
    const next = upsertSavedDevice(existing, {
      host: "192.168.0.112",
      port: 80,
      deviceId: "uuid:olive-a",
      name: "Living Room",
    });
    expect(next).toEqual([
      { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a", name: "Living Room" },
      existing[1],
    ]);
  });

  it("never carries stale SOAP endpoints across a DHCP move", () => {
    const prior: StableOliveTarget = {
      host: "192.168.0.124",
      port: 80,
      deviceId: "uuid:olive-a",
      descriptionUrl: "http://192.168.0.124:49152/MediaServer1.xml",
      descriptionUrls: ["http://192.168.0.124:49152/MediaServer1.xml"],
      serviceTypes: ["urn:schemas-upnp-org:service:ContentDirectory:1"],
      services: [{
        serviceType: "urn:schemas-upnp-org:service:ContentDirectory:1",
        serviceId: "urn:upnp-org:serviceId:ContentDirectory",
        rawScpdUrl: "/ContentDirectory1.xml",
        rawControlUrl: "/upnp/server/control/ContentDirectory1",
        rawEventSubUrl: "/upnp/server/event/ContentDirectory1",
        scpdUrl: "http://192.168.0.124:49152/ContentDirectory1.xml",
        controlUrl: "http://192.168.0.124:49152/upnp/server/control/ContentDirectory1",
        eventSubUrl: "http://192.168.0.124:49152/upnp/server/event/ContentDirectory1",
        deviceUdn: "uuid:olive-a",
      }],
    };
    const moved: StableOliveTarget = {
      host: "192.168.0.112",
      port: 80,
      deviceId: "uuid:olive-a",
      descriptionUrl: "http://192.168.0.112:49152/MediaServer1.xml",
    };
    const merged = mergeStableOliveTarget(prior, moved);
    expect(merged.host).toBe("192.168.0.112");
    expect(merged.descriptionUrl).toBe(moved.descriptionUrl);
    expect(merged.services).toBeUndefined();
    expect(merged.serviceTypes).toBeUndefined();
    expect(merged.descriptionUrls).toBeUndefined();
  });

  it("retains services at the same endpoint and accepts fresh services after a move", () => {
    const prior: StableOliveTarget = {
      host: "192.168.0.124",
      port: 80,
      deviceId: "uuid:olive-a",
      services: [{
        serviceType: "urn:schemas-upnp-org:service:ContentDirectory:1",
        serviceId: "urn:upnp-org:serviceId:ContentDirectory",
        rawScpdUrl: "/old.xml",
        rawControlUrl: "/old",
        rawEventSubUrl: "/old-event",
        scpdUrl: "http://192.168.0.124/old.xml",
        controlUrl: "http://192.168.0.124/old",
        eventSubUrl: "http://192.168.0.124/old-event",
        deviceUdn: "uuid:olive-a",
      }],
    };
    expect(mergeStableOliveTarget(prior, { ...prior, descriptionUrl: "http://192.168.0.124/new.xml" }).services)
      .toEqual(prior.services);

    const freshServices = prior.services?.map((service) => ({
      ...service,
      controlUrl: "http://192.168.0.112/new",
    }));
    expect(mergeStableOliveTarget(prior, {
      ...prior,
      host: "192.168.0.112",
      services: freshServices,
    }).services).toEqual(freshServices);
  });
});
