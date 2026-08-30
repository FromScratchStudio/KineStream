import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateStreamAccessToken,
  verifyStreamToken,
} from "../../api/src/services/authService";
import { ROLES } from "../../api/src/utils/constants";

describe("authService", () => {
  describe("hashPassword / verifyPassword", () => {
    it("hashes and verifies a correct password", () => {
      const hash = hashPassword("SecurePass123");
      expect(verifyPassword("SecurePass123", hash)).toBe(true);
    });

    it("rejects an incorrect password", () => {
      const hash = hashPassword("SecurePass123");
      expect(verifyPassword("WrongPassword", hash)).toBe(false);
    });

    it("produces different hashes for same password (salt randomness)", () => {
      const h1 = hashPassword("SamePassword");
      const h2 = hashPassword("SamePassword");
      expect(h1).not.toBe(h2);
    });
  });

  describe("generateToken / verifyToken", () => {
    it("generates a verifiable JWT for a user", () => {
      const user = { id: "user-1", email: "test@test.com", role: ROLES.CONSUMER };
      const token = generateToken(user);
      const payload = verifyToken(token);
      expect(payload.sub).toBe("user-1");
      expect(payload.email).toBe("test@test.com");
      expect(payload.role).toBe("consumer");
    });

    it("throws on an invalid token", () => {
      expect(() => verifyToken("invalid.token.here")).toThrow();
    });
  });

  describe("generateStreamAccessToken / verifyStreamToken", () => {
    it("generates a verifiable stream access token", () => {
      const token = generateStreamAccessToken("ticket-1", "session-1");
      const result = verifyStreamToken(token);
      expect(result.ticketId).toBe("ticket-1");
      expect(result.sessionId).toBe("session-1");
    });

    it("rejects a regular JWT as a stream token", () => {
      const user = { id: "user-1", email: "test@test.com", role: ROLES.CONSUMER };
      const regularToken = generateToken(user);
      expect(() => verifyStreamToken(regularToken)).toThrow("Invalid stream token");
    });
  });
});
