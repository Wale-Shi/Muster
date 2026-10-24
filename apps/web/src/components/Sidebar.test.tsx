import { describe, expect, it } from "vitest";
import { connectionStatus } from "./Sidebar";

describe("sidebar connection status", () => {
  it("requires both a connected server and an online machine", () => {
    expect(connectionStatus(true, 2)).toBe("online");
    expect(connectionStatus(true, 0)).toBe("offline");
    expect(connectionStatus(false, 2)).toBe("connecting");
    expect(connectionStatus(false, 0)).toBe("connecting");
  });
  it("does not claim machines are online before their status is known", () => {
    expect(connectionStatus(true, undefined)).toBe("unknown");
    expect(connectionStatus(false, undefined)).toBe("connecting");
  });
});
