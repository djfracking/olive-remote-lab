import { describe, expect, it } from "vitest";
import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";
import { queueFromNode, queuedTrackNode } from "../src/playbackQueue";

function upnpTrack(maestroId = ""): MaestroTreeNode {
  return {
    id: "upnp-object-1",
    title: "Song",
    childCount: 0,
    userData: {
      type: "track",
      source: "upnp",
      upnpId: "upnp-object-1",
      upnpRefId: "upnp-track-1",
      upnpParentId: "upnp-album-1",
      artist: "Artist",
      album: "Album",
      albumart: "/art/song.jpg",
      resourceUri: "http://192.168.0.112/media/song.flac",
      ...(maestroId ? { maestroId } : {}),
    },
  };
}

describe("app-managed play queue identities", () => {
  it("preserves an unresolved UPnP identity without pretending it is playable by Maestro", () => {
    const queued = queueFromNode(upnpTrack());
    expect(queued).toMatchObject({
      source: "upnp",
      itemId: "upnp-object-1",
      upnpId: "upnp-object-1",
      upnpRefId: "upnp-track-1",
    });
    expect(queued.maestroId).toBeUndefined();
    expect(queuedTrackNode(queued)).toMatchObject({
      id: "upnp-object-1",
      userData: {
        source: "upnp",
        upnpId: "upnp-object-1",
        upnpRefId: "upnp-track-1",
      },
    });
  });

  it("uses only an explicit Maestro mapping as the queued playback ID", () => {
    const queued = queueFromNode(upnpTrack("maestro-track-9"));
    expect(queued).toMatchObject({
      source: "upnp",
      itemId: "maestro-track-9",
      upnpId: "upnp-object-1",
      maestroId: "maestro-track-9",
    });
    expect(queuedTrackNode(queued)).toMatchObject({
      id: "upnp-object-1",
      userData: {
        source: "upnp",
        upnpId: "upnp-object-1",
        maestroId: "maestro-track-9",
      },
    });
  });

  it("leaves legacy Maestro queue entries unchanged", () => {
    const queued = queueFromNode({
      id: "maestro-track-1",
      title: "Legacy song",
      childCount: 0,
      userData: { type: "track", artist: "Artist" },
    });
    expect(queued).toMatchObject({
      itemId: "maestro-track-1",
      title: "Legacy song",
    });
    expect(queued.source).toBeUndefined();
    expect(queuedTrackNode(queued).id).toBe("maestro-track-1");
  });
});
