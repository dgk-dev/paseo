import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PushService } from "./push-service.js";

afterEach(() => vi.unstubAllGlobals());
for (const error of ["InvalidCredentials", "DeviceNotRegistered"]) {
  test(`Expo ${error} only revokes an actually unregistered device`, async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "error", details: { error } }] })),
        ),
    );
    const revoke = vi.fn();
    await new PushService(createTestLogger(), revoke).sendPush(["ExponentPushToken[test]"], {
      title: "Test",
      body: "Test",
    });
    expect(revoke).toHaveBeenCalledTimes(error === "DeviceNotRegistered" ? 1 : 0);
  });
}
