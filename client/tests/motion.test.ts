import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterExit } from "../src/ui/tokens/motion";

describe("afterExit", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the thing for the whole exit and removes it at the end", () => {
    const done = vi.fn();
    afterExit(190, false, done);
    vi.advanceTimersByTime(189);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("removes it immediately when motion is reduced", () => {
    const done = vi.fn();
    afterExit(190, true, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("does not remove it when it came back before the exit finished", () => {
    const done = vi.fn();
    const cancel = afterExit(190, false, done);
    vi.advanceTimersByTime(100);
    cancel();
    vi.advanceTimersByTime(500);
    expect(done).not.toHaveBeenCalled();
  });
});
