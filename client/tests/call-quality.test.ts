import { describe, expect, it } from "vitest";
import { cardState, lossFraction, signalBars, signalTip } from "../src/state/callQuality";

describe("call quality", () => {
  it("lights three bars under 80 ms and 2% loss", () => {
    expect(signalBars({ phase: "live", rttMs: 32, loss: 0 })).toBe(3);
    expect(signalBars({ phase: "live", rttMs: 79, loss: 0.019 })).toBe(3);
  });
  it("lights two bars under 200 ms and 6% loss", () => {
    expect(signalBars({ phase: "live", rttMs: 80, loss: 0 })).toBe(2);
    expect(signalBars({ phase: "live", rttMs: 40, loss: 0.02 })).toBe(2);
    expect(signalBars({ phase: "live", rttMs: 199, loss: 0.059 })).toBe(2);
  });
  it("lights one bar for anything worse while connected", () => {
    expect(signalBars({ phase: "live", rttMs: 200, loss: 0 })).toBe(1);
    expect(signalBars({ phase: "live", rttMs: 30, loss: 0.06 })).toBe(1);
  });
  it("shows no bars before a measurement, while connecting, and when failed", () => {
    expect(signalBars({ phase: "live" })).toBe(0);
    expect(signalBars({ phase: "connecting", rttMs: 20, loss: 0 })).toBe(0);
    expect(signalBars({ phase: "failed", rttMs: 20, loss: 0 })).toBe(0);
  });
  it("never invents a latency number", () => {
    expect(signalTip({ phase: "live", rttMs: 32.4 })).toBe("32 ms to server");
    expect(signalTip({ phase: "live" })).toBe("Measuring");
    expect(signalTip({ phase: "connecting" })).toBe("Measuring");
    expect(signalTip({ phase: "failed", rttMs: 10 })).toBe("No connection");
  });
  it("maps the call to a card state", () => {
    expect(cardState({ phase: "connecting" })).toBe("connecting");
    expect(cardState({ phase: "failed" })).toBe("failed");
    expect(cardState({ phase: "live", rttMs: 20, loss: 0 })).toBe("connected");
    expect(cardState({ phase: "live", rttMs: 500, loss: 0 })).toBe("weak");
    expect(cardState({ phase: "live" })).toBe("connected");
  });
  it("computes loss from packet counters", () => {
    expect(lossFraction(2, 98)).toBeCloseTo(0.02);
    expect(lossFraction(0, 0)).toBe(0);
    expect(lossFraction(-5, 100)).toBe(0);
  });
});
