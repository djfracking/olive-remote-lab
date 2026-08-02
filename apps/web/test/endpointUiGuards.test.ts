import { describe, expect, it } from "vitest";
import type { StableOliveTarget } from "../src/deviceIdentity";
import {
  artworkRequestIdentity,
  shouldApplyArtworkResult,
} from "../src/components/LibraryArtwork";
import { shouldApplyPlaylistOperation } from "../src/components/PlaylistsView";

describe("endpoint-bound UI work", () => {
  it("does not share pending artwork work across a DHCP endpoint change", () => {
    const prior: StableOliveTarget = {
      host: "192.168.0.112",
      port: 80,
      deviceId: "uuid:olive-a",
    };
    const moved: StableOliveTarget = {
      ...prior,
      host: "192.168.0.119",
    };

    expect(artworkRequestIdentity(prior, "album-1"))
      .not.toBe(artworkRequestIdentity(moved, "album-1"));
  });

  it("rejects stale artwork results after either endpoint or operation changes", () => {
    expect(shouldApplyArtworkResult(2, 2, "endpoint-a:item", "endpoint-a:item")).toBe(true);
    expect(shouldApplyArtworkResult(2, 3, "endpoint-a:item", "endpoint-a:item")).toBe(false);
    expect(shouldApplyArtworkResult(2, 2, "endpoint-a:item", "endpoint-b:item")).toBe(false);
  });

  it("rejects an older playlist selection even on the same endpoint", () => {
    expect(shouldApplyPlaylistOperation(4, 4, "endpoint-a", "endpoint-a")).toBe(true);
    expect(shouldApplyPlaylistOperation(4, 5, "endpoint-a", "endpoint-a")).toBe(false);
    expect(shouldApplyPlaylistOperation(4, 4, "endpoint-a", "endpoint-b")).toBe(false);
  });
});
