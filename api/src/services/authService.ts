import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import { User } from "../models";

const _jwtSecretRaw = process.env.JWT_SECRET;
if (!_jwtSecretRaw) {
  throw new Error("JWT_SECRET environment variable must be set");
}
const JWT_SECRET: string = _jwtSecretRaw;
const JWT_EXPIRES_IN = "8h";
const STREAM_TOKEN_EXPIRES_IN = "4h";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, storedHash] = stored.split(":");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");
  return hash === storedHash;
}

export function generateToken(user: Pick<User, "id" | "email" | "role">): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function generateStreamAccessToken(ticketId: string, sessionId: string): string {
  return jwt.sign(
    { ticketId, sessionId, purpose: "stream" },
    JWT_SECRET,
    { expiresIn: STREAM_TOKEN_EXPIRES_IN }
  );
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function verifyStreamToken(token: string): { ticketId: string; sessionId: string } {
  const payload = jwt.verify(token, JWT_SECRET) as {
    ticketId: string;
    sessionId: string;
    purpose: string;
  };
  if (payload.purpose !== "stream") throw new Error("Invalid stream token");
  return { ticketId: payload.ticketId, sessionId: payload.sessionId };
}
