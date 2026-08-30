import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { verifyToken, JwtPayload } from "../services/authService";

export function unauthorized(message = "Unauthorized"): HttpResponseInit {
  return { status: 401, jsonBody: { error: message } };
}

export function forbidden(message = "Forbidden"): HttpResponseInit {
  return { status: 403, jsonBody: { error: message } };
}

export function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

export function notFound(message = "Not found"): HttpResponseInit {
  return { status: 404, jsonBody: { error: message } };
}

export function conflict(message: string): HttpResponseInit {
  return { status: 409, jsonBody: { error: message } };
}

export function internalError(message = "Internal server error"): HttpResponseInit {
  return { status: 500, jsonBody: { error: message } };
}

export function extractBearer(request: HttpRequest): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function authenticate(request: HttpRequest): JwtPayload | null {
  const token = extractBearer(request);
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

export function isAuthResult(
  result: { payload: JwtPayload } | HttpResponseInit
): result is { payload: JwtPayload } {
  return "payload" in result;
}

export function requireRole(
  request: HttpRequest,
  role: string
): { payload: JwtPayload } | HttpResponseInit {
  const payload = authenticate(request);
  if (!payload) return unauthorized();
  if (payload.role !== role) return forbidden(`Only ${role}s can perform this action`);
  return { payload };
}
