import { authenticate, requireRole, isAuthResult } from "../../api/src/middleware/auth";
import { generateToken } from "../../api/src/services/authService";
import { ROLES } from "../../api/src/utils/constants";

// Minimal HttpRequest mock that matches what our middleware uses
function makeRequest(authHeader?: string) {
  const headers = new Headers();
  if (authHeader) headers.set("authorization", authHeader);
  return { headers } as any;
}

describe("auth middleware", () => {
  const producerToken = generateToken({ id: "p-1", email: "p@test.com", role: ROLES.PRODUCER });
  const consumerToken = generateToken({ id: "c-1", email: "c@test.com", role: ROLES.CONSUMER });

  describe("authenticate", () => {
    it("returns null when no authorization header", () => {
      expect(authenticate(makeRequest())).toBeNull();
    });

    it("returns null for invalid token", () => {
      expect(authenticate(makeRequest("******"))).toBeNull();
    });

    it("returns payload for valid producer token", () => {
      const result = authenticate(makeRequest("Bearer " + producerToken));
      expect(result?.sub).toBe("p-1");
      expect(result?.role).toBe("producer");
    });
  });

  describe("requireRole", () => {
    it("returns 401 when no auth header", () => {
      const result = requireRole(makeRequest(), "producer");
      expect("status" in result && result.status).toBe(401);
    });

    it("returns 403 when wrong role (consumer token, requires producer)", () => {
      const result = requireRole(makeRequest("Bearer " + consumerToken), "producer");
      expect("status" in result && result.status).toBe(403);
    });

    it("returns payload when correct role", () => {
      const result = requireRole(makeRequest("Bearer " + producerToken), "producer");
      expect(isAuthResult(result) && result.payload.sub).toBe("p-1");
    });
  });
});
