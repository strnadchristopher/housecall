import { describe, expect, it } from "vitest";
import { SHARE_PRESETS, SHARE_QUALITIES, applyShareQuality, captureConstraints, readShareQuality, shareStreamId, writeShareQuality } from "../src/transport/shareQuality";

function memory(): Storage {
  const data = new Map<string, string>();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k), clear: () => data.clear(), key: () => null, get length() { return data.size; } };
}

describe("share presets", () => {
  it("has Smooth, Sharp and Source with a hint, a degradation rule and a ceiling each", () => {
    expect(SHARE_QUALITIES).toEqual(["smooth", "sharp", "source"]);
    expect(SHARE_PRESETS.smooth).toMatchObject({ contentHint: "motion", degradationPreference: "maintain-framerate" });
    expect(SHARE_PRESETS.sharp).toMatchObject({ contentHint: "detail", degradationPreference: "maintain-resolution" });
    expect(SHARE_PRESETS.source).toMatchObject({ contentHint: "detail", degradationPreference: "maintain-resolution" });
    expect(SHARE_PRESETS.smooth.maxBitrate).toBeLessThan(SHARE_PRESETS.sharp.maxBitrate);
    expect(SHARE_PRESETS.sharp.maxBitrate).toBeLessThan(SHARE_PRESETS.source.maxBitrate);
  });
  it("asks the capture for the frame rate and size the preset wants, with audio", () => {
    expect(captureConstraints("smooth").frameRate).toEqual({ ideal: 60 });
    expect(captureConstraints("sharp").frameRate).toEqual({ ideal: 30 });
    expect((captureConstraints("source").width as ConstrainULongRange).ideal).toBeGreaterThan((captureConstraints("smooth").width as ConstrainULongRange).ideal!);
  });
  it("remembers the choice on this device and ignores junk", () => {
    const store = memory();
    expect(readShareQuality(store)).toBe("smooth");
    writeShareQuality("source", store);
    expect(readShareQuality(store)).toBe("source");
    store.setItem("hc.shareQuality", "ultra");
    expect(readShareQuality(store)).toBe("smooth");
  });
  it("applies the hint to the track and the rule and ceiling to every encoding", async () => {
    const track = { contentHint: "" } as MediaStreamTrack;
    let set: RTCRtpSendParameters | undefined;
    const sender = {
      getParameters: () => ({ encodings: [{}], headerExtensions: [], codecs: [], rtcp: {} }) as unknown as RTCRtpSendParameters,
      setParameters: async (parameters: RTCRtpSendParameters) => { set = parameters; },
    } as unknown as RTCRtpSender;
    await applyShareQuality(sender, track, "sharp");
    expect(track.contentHint).toBe("detail");
    expect((set as unknown as { degradationPreference: string }).degradationPreference).toBe("maintain-resolution");
    expect(set!.encodings[0]).toMatchObject({ maxBitrate: SHARE_PRESETS.sharp.maxBitrate, scaleResolutionDownBy: 1 });
  });
  it("tells share audio from voice by the stream id the server gives it", () => {
    expect(shareStreamId("12")).toEqual({ peer: "12", share: false });
    expect(shareStreamId("12-share")).toEqual({ peer: "12", share: true });
    expect(shareStreamId("")).toEqual({ peer: "", share: false });
  });
});
