import { describe, expect, it } from "vitest";
import { capabilitiesForModel, detectOliveModel } from "../src/models.js";

describe("model capability registry", () => {
  it("detects the verified 4HD firmware marker before shared exclusion markers", () => {
    expect(detectOliveModel("OPUS4HD_CODE_START_NOT_O6HD")).toBe("o4hd");
  });

  it("keeps unverified models disabled", () => {
    expect(capabilitiesForModel("o6hd").maestroLibrary).toBe("unverified");
    expect(capabilitiesForModel("o4hd").maestroLibrary).toBe("verified");
  });

  it("covers the early, Maestro, HD and ONE protocol families", () => {
    expect(capabilitiesForModel("musica").protocolFamily).toBe("early");
    expect(capabilitiesForModel("opus-4").protocolFamily).toBe("maestro");
    expect(capabilitiesForModel("olive-2").protocolFamily).toBe("hd");
    expect(capabilitiesForModel("olive-one").protocolFamily).toBe("one");
  });

  it("distinguishes marketed model names without assuming capability", () => {
    expect(detectOliveModel("Olive 2 Hi-Fi Player")).toBe("olive-2");
    expect(detectOliveModel("Symphony No. 2")).toBe("symphony-2");
    expect(detectOliveModel("OPUS music server")).toBe("opus");
  });
});
