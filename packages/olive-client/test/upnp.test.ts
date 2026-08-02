import { describe, expect, it } from "vitest";
import {
  buildOliveUpnpSearchCriteria,
  buildReadOnlyUpnpSoapRequest,
  classifyUpnpAction,
  deriveStableUpnpIdentity,
  findUpnpService,
  OliveUpnpClient,
  parseDidlLite,
  parseUpnpDeviceDescription,
  parseUpnpDuration,
  parseUpnpScpd,
  parseUpnpSoapResponse,
  resolveUpnpServiceUrl,
  UpnpSoapFault,
  upnpScpdSupportsAction,
  type UpnpServiceDescription,
} from "../src/upnp.js";
import type { OliveTransport, TransportRequest, TransportResponse } from "../src/types.js";

const DESCRIPTION_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://192.168.0.112:49154/base/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>Olive O4HD &amp; Living Room</friendlyName>
    <manufacturer>Olive Media Products</manufacturer>
    <manufacturerURL>https://example.invalid/olive</manufacturerURL>
    <modelDescription>Network Music Server</modelDescription>
    <modelName>O4HD</modelName>
    <modelNumber>4</modelNumber>
    <modelURL>https://example.invalid/o4hd</modelURL>
    <serialNumber>serial-001</serialNumber>
    <UDN>uuid:AABBCCDD-0011-2233-4455-66778899AABB</UDN>
    <UPC>123456789</UPC>
    <presentationURL>/index.php</presentationURL>
    <iconList>
      <icon>
        <mimetype>image/png</mimetype><width>120</width><height>120</height><depth>24</depth>
        <url>icons/server.png</url>
      </icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>ContentDirectory.xml</SCPDURL>
        <controlURL>/ctl/ContentDir</controlURL>
        <eventSubURL>http://192.168.0.112:49154/events/content</eventSubURL>
      </service>
      <service>
        <serviceType>urn:olive-com:service:UnsafeVendor:1</serviceType>
        <serviceId>urn:olive-com:serviceId:UnsafeVendor</serviceId>
        <SCPDURL>http://203.0.113.8/vendor.xml</SCPDURL>
        <controlURL>//evil.example/control</controlURL>
        <eventSubURL></eventSubURL>
      </service>
    </serviceList>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <friendlyName>Olive Renderer</friendlyName>
        <manufacturer>Olive</manufacturer>
        <modelName>O4HD Renderer</modelName>
        <UDN>uuid:AABBCCDD-0011-2233-4455-66778899AABB-renderer</UDN>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
            <SCPDURL>/AVTransport1.xml</SCPDURL>
            <controlURL>/MediaRenderer/AVTransport/Control</controlURL>
            <eventSubURL>/MediaRenderer/AVTransport/Event</eventSubURL>
          </service>
          <service>
            <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
            <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
            <SCPDURL>/RenderingControl1.xml</SCPDURL>
            <controlURL>/MediaRenderer/RenderingControl/Control</controlURL>
            <eventSubURL>/MediaRenderer/RenderingControl/Event</eventSubURL>
          </service>
        </serviceList>
      </device>
    </deviceList>
  </device>
</root>`;

const SCPD_XML = `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument>
          <name>ObjectID</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable>
        </argument>
        <argument>
          <name>Result</name><direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable><retval/>
        </argument>
      </argumentList>
    </action>
    <action><name>Search</name></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes">
      <name>SystemUpdateID</name><dataType>ui4</dataType><defaultValue>0</defaultValue>
      <allowedValueRange><minimum>0</minimum><maximum>4294967295</maximum><step>1</step></allowedValueRange>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>TransportState</name><dataType>string</dataType>
      <allowedValueList><allowedValue>STOPPED</allowedValue><allowedValue>PLAYING</allowedValue></allowedValueList>
    </stateVariable>
  </serviceStateTable>
</scpd>`;

const DIDL_XML = `<DIDL-Lite
  xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <container id="artist:ABBA:01" parentID="artists-root" restricted="1" searchable="true" childCount="8">
    <dc:title>ABBA &amp; Friends</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
    <upnp:artist>ABBA</upnp:artist>
  </container>
  <item id="upnp-track/42?exact=yes" refID="catalog-ref:42" parentID="album:arrival" restricted="0">
    <dc:title>Knowing Me &amp; Knowing You</dc:title>
    <dc:creator>Benny Andersson</dc:creator>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <upnp:artist role="AlbumArtist">ABBA</upnp:artist>
    <upnp:artist role="Composer">Benny Andersson</upnp:artist>
    <upnp:album>Arrival</upnp:album>
    <upnp:genre>Pop</upnp:genre>
    <upnp:genre>Disco</upnp:genre>
    <upnp:albumArtURI>/artwork/album%3Aarrival.jpg</upnp:albumArtURI>
    <res protocolInfo="http-get:*:audio/mpeg:*" duration="00:04:02.500" size="9876543"
      bitrate="320000" sampleFrequency="44100" bitsPerSample="16" nrAudioChannels="2">
      http://192.168.0.112:49154/audio/track-42.mp3
    </res>
  </item>
</DIDL-Lite>`;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function soapResponse(action: string, fields: Readonly<Record<string, string>>): string {
  return `<?xml version="1.0"?>
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body><u:${action}Response xmlns:u="urn:test">
      ${Object.entries(fields).map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`).join("")}
    </u:${action}Response></s:Body>
  </s:Envelope>`;
}

function response(request: TransportRequest, body: string, status = 200, statusText = "OK"): TransportResponse {
  return { url: request.url, status, statusText, headers: {}, body, durationMs: 2 };
}

const CONTENT_DIRECTORY: UpnpServiceDescription = {
  serviceType: "urn:schemas-upnp-org:service:ContentDirectory:1",
  serviceId: "urn:upnp-org:serviceId:ContentDirectory",
  rawScpdUrl: "/ContentDirectory1.xml",
  rawControlUrl: "/MediaServer/ContentDirectory/Control",
  rawEventSubUrl: "/MediaServer/ContentDirectory/Event",
  scpdUrl: "http://192.168.0.112:49154/ContentDirectory1.xml",
  controlUrl: "http://192.168.0.112:49154/MediaServer/ContentDirectory/Control",
  eventSubUrl: "http://192.168.0.112:49154/MediaServer/ContentDirectory/Event",
  deviceUdn: "uuid:olive-device",
};

const AV_TRANSPORT: UpnpServiceDescription = {
  ...CONTENT_DIRECTORY,
  serviceType: "urn:schemas-upnp-org:service:AVTransport:1",
  serviceId: "urn:upnp-org:serviceId:AVTransport",
  rawControlUrl: "/MediaRenderer/AVTransport/Control",
  controlUrl: "http://192.168.0.112:49154/MediaRenderer/AVTransport/Control",
};

const RENDERING_CONTROL: UpnpServiceDescription = {
  ...CONTENT_DIRECTORY,
  serviceType: "urn:schemas-upnp-org:service:RenderingControl:1",
  serviceId: "urn:upnp-org:serviceId:RenderingControl",
  rawControlUrl: "/MediaRenderer/RenderingControl/Control",
  controlUrl: "http://192.168.0.112:49154/MediaRenderer/RenderingControl/Control",
};

describe("UPnP discovery parsing and identity", () => {
  it("parses the root and embedded devices, preserving every service URL", () => {
    const description = parseUpnpDeviceDescription(DESCRIPTION_XML, {
      descriptionUrl: "http://192.168.0.112:49154/MediaServer1.xml",
      ssdpUsn: "uuid:AABBCCDD-0011-2233-4455-66778899AABB::upnp:rootdevice",
    });

    expect(description).toMatchObject({
      specVersion: { major: 1, minor: 0 },
      urlBase: "http://192.168.0.112:49154/base/",
      udn: "uuid:AABBCCDD-0011-2233-4455-66778899AABB",
      stableIdentity: "upnp:uuid:aabbccdd-0011-2233-4455-66778899aabb",
      rootDevice: {
        friendlyName: "Olive O4HD & Living Room",
        modelName: "O4HD",
        presentationUrl: "http://192.168.0.112:49154/index.php",
      },
    });
    expect(description.services).toHaveLength(4);
    expect(findUpnpService(description, "ContentDirectory")).toMatchObject({
      serviceId: "urn:upnp-org:serviceId:ContentDirectory",
      scpdUrl: "http://192.168.0.112:49154/base/ContentDirectory.xml",
      controlUrl: "http://192.168.0.112:49154/ctl/ContentDir",
      eventSubUrl: "http://192.168.0.112:49154/events/content",
      deviceUdn: "uuid:AABBCCDD-0011-2233-4455-66778899AABB",
    });
    expect(findUpnpService(description, "AVTransport")?.deviceUdn).toBe(
      "uuid:AABBCCDD-0011-2233-4455-66778899AABB-renderer",
    );
    expect(description.rootDevice.icons[0]).toMatchObject({
      width: 120,
      url: "http://192.168.0.112:49154/base/icons/server.png",
    });
  });

  it("retains unsafe raw URLs while refusing to make them callable", () => {
    const description = parseUpnpDeviceDescription(DESCRIPTION_XML, {
      descriptionUrl: "http://192.168.0.112:49154/MediaServer1.xml",
    });
    const unsafe = description.services.find(({ serviceId }) => serviceId.includes("UnsafeVendor"));
    expect(unsafe).toMatchObject({
      rawScpdUrl: "http://203.0.113.8/vendor.xml",
      rawControlUrl: "//evil.example/control",
      scpdUrl: null,
      controlUrl: null,
      eventSubUrl: null,
    });
  });

  it("derives the same stable identity from UDN or the typed SSDP USN", () => {
    expect(deriveStableUpnpIdentity({ udn: "UUID:ABC-123" })).toBe("upnp:uuid:abc-123");
    expect(deriveStableUpnpIdentity({ usn: "uuid:ABC-123::urn:schemas-upnp-org:device:MediaServer:1" }))
      .toBe("upnp:uuid:abc-123");
    expect(deriveStableUpnpIdentity({})).toBeNull();
  });

  it("resolves only private, same-host HTTP service URLs", () => {
    expect(resolveUpnpServiceUrl("http://192.168.0.112:49154/device.xml", "../control"))
      .toBe("http://192.168.0.112:49154/control");
    expect(() => resolveUpnpServiceUrl("https://public.example/device.xml", "/control"))
      .toThrow(/private HTTP host/);
    expect(() => resolveUpnpServiceUrl("https://192.168.0.112/device.xml", "/control"))
      .toThrow(/private HTTP host/);
    expect(() => resolveUpnpServiceUrl("http://10.attacker.example/device.xml", "/control"))
      .toThrow(/private HTTP host/);
    expect(() => resolveUpnpServiceUrl("http://192.168.attacker.example/device.xml", "/control"))
      .toThrow(/private HTTP host/);
    expect(() => resolveUpnpServiceUrl("http://olive/device.xml", "/control"))
      .toThrow(/private HTTP host/);
    expect(() => resolveUpnpServiceUrl("http://192.168.0.112/device.xml", "http://192.168.0.113/control"))
      .toThrow(/leave the discovered device host/);
    expect(() => resolveUpnpServiceUrl("http://192.168.0.112/device.xml", "file:///etc/passwd"))
      .toThrow(/leave the discovered device host/);
  });
});

describe("UPnP service descriptions and policy", () => {
  it("builds one escaped, case-tolerant exact-title Olive predicate from plain text", () => {
    const criteria = buildOliveUpnpSearchCriteria(' abba "gold" ');
    expect(criteria).toContain('dc:title = "abba \\"gold\\""');
    expect(criteria).toContain('dc:title = "ABBA \\"GOLD\\""');
    expect(criteria).toContain(" or ");
    expect(() => buildOliveUpnpSearchCriteria(" ")).toThrow(/between 1 and 200/);
    expect(buildOliveUpnpSearchCriteria("ABBA", ["upnp:class", "dc:title"]))
      .toBe('dc:title = "ABBA" or dc:title = "Abba"');
    expect(() => buildOliveUpnpSearchCriteria("ABBA", []))
      .toThrow("does not advertise title search");
    expect(() => buildOliveUpnpSearchCriteria("ABBA", ["upnp:artist"]))
      .toThrow("does not advertise title search");
  });

  it("parses actions, arguments, state variables and availability", () => {
    const scpd = parseUpnpScpd(SCPD_XML);
    expect(scpd.specVersion).toEqual({ major: 1, minor: 0 });
    expect(scpd.actions[0]).toEqual({
      name: "Browse",
      arguments: [
        { name: "ObjectID", direction: "in", relatedStateVariable: "A_ARG_TYPE_ObjectID", isReturnValue: false },
        { name: "Result", direction: "out", relatedStateVariable: "A_ARG_TYPE_Result", isReturnValue: true },
      ],
    });
    expect(upnpScpdSupportsAction(scpd, "Search")).toBe(true);
    expect(upnpScpdSupportsAction(scpd, "DestroyLibrary")).toBe(false);
    expect(scpd.stateVariables).toEqual([
      {
        name: "SystemUpdateID",
        dataType: "ui4",
        sendEvents: true,
        multicast: null,
        defaultValue: "0",
        allowedValues: [],
        allowedValueRange: { minimum: "0", maximum: "4294967295", step: "1" },
      },
      {
        name: "TransportState",
        dataType: "string",
        sendEvents: false,
        multicast: null,
        defaultValue: null,
        allowedValues: ["STOPPED", "PLAYING"],
        allowedValueRange: null,
      },
    ]);
  });

  it("allow-lists getters while quarantining setters and unknown vendor actions", () => {
    expect(classifyUpnpAction(CONTENT_DIRECTORY.serviceType, "Browse")).toBe("read-only");
    expect(classifyUpnpAction(AV_TRANSPORT.serviceType, "GetPositionInfo")).toBe("read-only");
    expect(classifyUpnpAction(AV_TRANSPORT.serviceType, "Seek")).toBe("playback-mutation");
    expect(classifyUpnpAction(RENDERING_CONTROL.serviceType, "SetVolume")).toBe("rendering-mutation");
    expect(classifyUpnpAction("urn:olive-com:service:ZQService:1", "FactoryReset")).toBe("quarantined");
    expect(classifyUpnpAction(CONTENT_DIRECTORY.serviceType, "DestroyObject")).toBe("quarantined");
  });
});

describe("SOAP and DIDL parsing", () => {
  it("escapes SOAP arguments and parses namespace-qualified action responses", () => {
    const request = buildReadOnlyUpnpSoapRequest(CONTENT_DIRECTORY.serviceType, "Search", {
      ContainerID: "0",
      SearchCriteria: 'dc:title contains "ABBA & Friends"',
    });
    expect(request).toContain("<ContainerID>0</ContainerID>");
    expect(request).toContain("ABBA &amp; Friends&quot;");
    expect(() => buildReadOnlyUpnpSoapRequest(AV_TRANSPORT.serviceType, "Search", {}))
      .toThrow(/not allowed for this service/);
    expect(() => buildReadOnlyUpnpSoapRequest(CONTENT_DIRECTORY.serviceType, "Search", {
      "ContainerID></ContainerID><SetVolume": "1",
    })).toThrow(/argument name/);

    expect(parseUpnpSoapResponse(soapResponse("GetSystemUpdateID", { Id: "20001" }), "GetSystemUpdateID"))
      .toEqual({ Id: "20001" });
  });

  it("turns SOAP faults into a typed error with the device code", () => {
    const fault = `<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
        <s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
          <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
            <errorCode>701</errorCode><errorDescription>No Such Object</errorDescription>
          </UPnPError>
        </detail></s:Fault>
      </s:Body></s:Envelope>`;
    expect(() => parseUpnpSoapResponse(fault, "Browse", 500)).toThrow(UpnpSoapFault);
    try {
      parseUpnpSoapResponse(fault, "Browse", 500);
    } catch (error) {
      expect(error).toMatchObject({
        upnpErrorCode: "701",
        upnpErrorDescription: "No Such Object",
        httpStatus: 500,
      });
    }
  });

  it("preserves exact UPnP IDs separately from the unset Maestro mapping", () => {
    const objects = parseDidlLite(DIDL_XML);
    expect(objects[0]).toMatchObject({
      kind: "container",
      id: "artist:ABBA:01",
      parentId: "artists-root",
      childCount: 8,
      title: "ABBA & Friends",
      identifiers: {
        maestroId: null,
        upnpId: "artist:ABBA:01",
        upnpRefId: null,
        upnpParentId: "artists-root",
      },
    });
    expect(objects[1]).toMatchObject({
      kind: "item",
      id: "upnp-track/42?exact=yes",
      refId: "catalog-ref:42",
      parentId: "album:arrival",
      title: "Knowing Me & Knowing You",
      artist: "ABBA",
      artists: ["ABBA", "Benny Andersson"],
      album: "Arrival",
      genre: "Pop",
      genres: ["Pop", "Disco"],
      creator: "Benny Andersson",
      albumArtUri: "/artwork/album%3Aarrival.jpg",
      resourceUri: "http://192.168.0.112:49154/audio/track-42.mp3",
      resourceProtocolInfo: "http-get:*:audio/mpeg:*",
      duration: "00:04:02.500",
      durationSeconds: 242.5,
      identifiers: {
        maestroId: null,
        upnpId: "upnp-track/42?exact=yes",
        upnpRefId: "catalog-ref:42",
        upnpParentId: "album:arrival",
      },
    });
    expect(objects[1]?.resources[0]).toMatchObject({
      size: 9876543,
      bitrate: 320000,
      sampleFrequency: 44100,
      bitsPerSample: 16,
      nrAudioChannels: 2,
    });
    expect(parseUpnpDuration("100:00:00.250")).toBe(360000.25);
    expect(parseUpnpDuration("NOT_IMPLEMENTED")).toBeNull();
  });
});

describe("read-only UPnP client", () => {
  it("fetches and parses descriptors without following an unsafe host", async () => {
    const requests: TransportRequest[] = [];
    const transport: OliveTransport = { request: async (request) => {
      requests.push(request);
      return response(request, request.url.endsWith(".xml") && request.url.includes("ContentDirectory")
        ? SCPD_XML
        : DESCRIPTION_XML);
    } };
    const client = new OliveUpnpClient(transport);
    const description = await client.getDeviceDescription(
      "http://192.168.0.112:49154/MediaServer1.xml",
      { ssdpUsn: "uuid:AABB::upnp:rootdevice" },
    );
    const service = findUpnpService(description, "ContentDirectory");
    expect(service).toBeDefined();
    await expect(client.getScpd(service!)).resolves.toMatchObject({
      actions: [{ name: "Browse" }, { name: "Search" }],
    });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  it("reads revision, capabilities, Browse and Search with exact pagination", async () => {
    const requests: TransportRequest[] = [];
    const transport: OliveTransport = { request: async (request) => {
      requests.push(request);
      const action = request.headers?.soapaction?.match(/#([^"]+)/)?.[1];
      if (action === "GetSystemUpdateID") return response(request, soapResponse(action, { SystemUpdateID: "20001" }));
      if (action === "GetSearchCapabilities") {
        return response(request, soapResponse(action, { SearchCaps: "dc:title, upnp:artist,upnp:album" }));
      }
      if (action === "GetSortCapabilities") return response(request, soapResponse(action, { SortCaps: "" }));
      if (action === "Browse" || action === "Search") {
        return response(request, soapResponse(action, {
          Result: DIDL_XML,
          NumberReturned: "2",
          TotalMatches: action === "Browse" ? "45683" : "2",
          UpdateID: "20001",
        }));
      }
      throw new Error(`Unexpected action: ${action}`);
    } };
    const client = new OliveUpnpClient(transport);

    await expect(client.getSystemUpdateId(CONTENT_DIRECTORY)).resolves.toBe("20001");
    await expect(client.getSearchCapabilities(CONTENT_DIRECTORY)).resolves.toEqual({
      raw: "dc:title, upnp:artist,upnp:album",
      values: ["dc:title", "upnp:artist", "upnp:album"],
    });
    await expect(client.getSortCapabilities(CONTENT_DIRECTORY)).resolves.toEqual({ raw: "", values: [] });
    await expect(client.browse(CONTENT_DIRECTORY, {
      objectId: "tracks-root",
      startingIndex: 128,
      requestedCount: 64,
      timeoutMs: 12_000,
    })).resolves.toMatchObject({
      numberReturned: 2,
      totalMatches: 45683,
      updateId: "20001",
      objects: [{ id: "artist:ABBA:01" }, { id: "upnp-track/42?exact=yes" }],
    });
    await expect(client.search(CONTENT_DIRECTORY, {
      containerId: "0",
      searchCriteria: 'upnp:artist contains "ABBA"',
      requestedCount: 25,
    })).resolves.toMatchObject({ numberReturned: 2, totalMatches: 2 });

    const browseRequest = requests.find(({ headers }) => headers?.soapaction?.includes("#Browse"));
    expect(browseRequest).toMatchObject({
      method: "POST",
      url: CONTENT_DIRECTORY.controlUrl,
      timeoutMs: 12_000,
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${CONTENT_DIRECTORY.serviceType}#Browse"`,
      },
    });
    expect(browseRequest?.body).toContain("<StartingIndex>128</StartingIndex><RequestedCount>64</RequestedCount>");
    const searchRequest = requests.find(({ headers }) => headers?.soapaction?.includes("#Search"));
    expect(searchRequest?.body).toContain("upnp:artist contains &quot;ABBA&quot;");
  });

  it("rejects invalid paging before sending anything", async () => {
    let requests = 0;
    const client = new OliveUpnpClient({ request: async (request) => {
      requests += 1;
      return response(request, "");
    } });
    await expect(client.browse(CONTENT_DIRECTORY, { objectId: "0", startingIndex: -1 }))
      .rejects.toThrow(/StartingIndex/);
    await expect(client.search(CONTENT_DIRECTORY, {
      containerId: "0",
      searchCriteria: "*",
      requestedCount: 1.5,
    })).rejects.toThrow(/RequestedCount/);
    await expect(client.browse(CONTENT_DIRECTORY, { objectId: "0", requestedCount: 0 }))
      .rejects.toThrow(/between 1 and 64/);
    await expect(client.browse(CONTENT_DIRECTORY, { objectId: "0", requestedCount: 65 }))
      .rejects.toThrow(/between 1 and 64/);
    await expect(client.browse(CONTENT_DIRECTORY, { objectId: "0", timeoutMs: 999 }))
      .rejects.toThrow(/timeout must be between 1000 and 15000/);
    expect(requests).toBe(0);
  });

  it("propagates a SOAP fault even when the HTTP status is 500", async () => {
    const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
      <faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
      <UPnPError><errorCode>402</errorCode><errorDescription>Invalid Args</errorDescription></UPnPError>
      </detail></s:Fault></s:Body></s:Envelope>`;
    const client = new OliveUpnpClient({ request: async (request) => response(request, fault, 500, "Internal Server Error") });
    await expect(client.browse(CONTENT_DIRECTORY, { objectId: "0" }))
      .rejects.toMatchObject({ name: "UpnpSoapFault", upnpErrorCode: "402", httpStatus: 500 });
  });

  it("reads transport position, transport state and media without mutation", async () => {
    const actions: string[] = [];
    const transport: OliveTransport = { request: async (request) => {
      const action = request.headers?.soapaction?.match(/#([^"]+)/)?.[1] ?? "";
      actions.push(action);
      if (action === "GetPositionInfo") return response(request, soapResponse(action, {
        Track: "7",
        TrackDuration: "00:04:02.500",
        TrackMetaData: DIDL_XML,
        TrackURI: "http://192.168.0.112/audio/42.mp3",
        RelTime: "00:01:05",
        AbsTime: "NOT_IMPLEMENTED",
        RelCount: "12",
        AbsCount: "NOT_IMPLEMENTED",
      }));
      if (action === "GetTransportInfo") return response(request, soapResponse(action, {
        CurrentTransportState: "PLAYING",
        CurrentTransportStatus: "OK",
        CurrentSpeed: "1",
      }));
      if (action === "GetMediaInfo") return response(request, soapResponse(action, {
        NrTracks: "1",
        MediaDuration: "00:04:02.500",
        CurrentURI: "http://192.168.0.112/audio/42.mp3",
        CurrentURIMetaData: DIDL_XML,
        NextURI: "",
        NextURIMetaData: "",
        PlayMedium: "NETWORK",
        RecordMedium: "NOT_IMPLEMENTED",
        WriteStatus: "NOT_IMPLEMENTED",
      }));
      throw new Error("Unexpected action");
    } };
    const client = new OliveUpnpClient(transport);

    await expect(client.getPositionInfo(AV_TRANSPORT)).resolves.toMatchObject({
      track: 7,
      trackDurationSeconds: 242.5,
      relativeTimeSeconds: 65,
      absoluteTimeSeconds: null,
      relativeCount: 12,
      absoluteCount: null,
      trackMetadata: [{ id: "artist:ABBA:01" }, { id: "upnp-track/42?exact=yes" }],
    });
    await expect(client.getTransportInfo(AV_TRANSPORT)).resolves.toEqual({
      currentTransportState: "PLAYING",
      currentTransportStatus: "OK",
      currentSpeed: "1",
    });
    await expect(client.getMediaInfo(AV_TRANSPORT)).resolves.toMatchObject({
      numberOfTracks: 1,
      mediaDurationSeconds: 242.5,
      currentUriMetadata: [{ id: "artist:ABBA:01" }, { id: "upnp-track/42?exact=yes" }],
      nextUriMetadata: [],
      playMedium: "NETWORK",
      recordMedium: null,
      writeStatus: null,
    });
    expect(actions).toEqual(["GetPositionInfo", "GetTransportInfo", "GetMediaInfo"]);
  });

  it("reads and sets truthful absolute volume and mute through the verified typed surface", async () => {
    const requests: TransportRequest[] = [];
    let confirmedVolume = 51;
    let confirmedMute = false;
    const transport: OliveTransport = { request: async (request) => {
      requests.push(request);
      const action = request.headers?.soapaction?.match(/#([^"]+)/)?.[1] ?? "";
      if (action === "SetVolume") {
        confirmedVolume = Number(request.body?.match(/<DesiredVolume>(\d+)<\/DesiredVolume>/)?.[1]);
        return response(request, soapResponse(action, {}));
      }
      if (action === "SetMute") {
        confirmedMute = request.body?.includes("<DesiredMute>1</DesiredMute>") ?? false;
        return response(request, soapResponse(action, {}));
      }
      return response(request, soapResponse(action, action === "GetVolume"
        ? { CurrentVolume: String(confirmedVolume) }
        : { CurrentMute: confirmedMute ? "1" : "0" }));
    } };
    const client = new OliveUpnpClient(transport);

    await expect(client.getVolume(RENDERING_CONTROL)).resolves.toEqual({ channel: "Master", value: 51 });
    await expect(client.getMute(RENDERING_CONTROL)).resolves.toEqual({ channel: "Master", value: false });
    await expect(client.setVolume(RENDERING_CONTROL, 50)).resolves.toEqual({ channel: "Master", value: 50 });
    await expect(client.setMute(RENDERING_CONTROL, false)).resolves.toEqual({ channel: "Master", value: false });
    expect(requests.map(({ headers }) => headers?.soapaction)).toEqual([
      `"${RENDERING_CONTROL.serviceType}#GetVolume"`,
      `"${RENDERING_CONTROL.serviceType}#GetMute"`,
      `"${RENDERING_CONTROL.serviceType}#SetVolume"`,
      `"${RENDERING_CONTROL.serviceType}#GetVolume"`,
      `"${RENDERING_CONTROL.serviceType}#SetMute"`,
      `"${RENDERING_CONTROL.serviceType}#GetMute"`,
    ]);
    expect(requests.every(({ body }) =>
      body?.includes("<InstanceID>0</InstanceID><Channel>Master</Channel>"))).toBe(true);
    expect(requests[2]?.body).toContain("<DesiredVolume>50</DesiredVolume>");
    expect(requests[4]?.body).toContain("<DesiredMute>0</DesiredMute>");
    await expect(client.setVolume(RENDERING_CONTROL, 101)).rejects.toThrow("between 0 and 100");
  });
});
