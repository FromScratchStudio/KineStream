import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { v4 as uuidv4 } from "uuid";
import { getContainer } from "../services/cosmosService";
import {
  hashPassword,
  verifyPassword,
  generateToken,
} from "../services/authService";
import {
  badRequest,
  conflict,
  unauthorized,
  notFound,
  internalError,
} from "../middleware/auth";
import { User, RegisterPayload, LoginPayload } from "../models";
import { CONTAINERS, ROLES } from "../utils/constants";

// POST /api/auth/register
async function register(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as RegisterPayload;
    const { email, displayName, password, role } = body;

    if (!email || !displayName || !password || !role) {
      return badRequest("email, displayName, password, and role are required");
    }
    if (!Object.values(ROLES).includes(role)) {
      return badRequest(`role must be one of: ${Object.values(ROLES).join(", ")}`);
    }
    if (password.length < 8) {
      return badRequest("password must be at least 8 characters");
    }

    const container = await getContainer(CONTAINERS.USERS);

    // Check email uniqueness
    const { resources: existing } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.email = @email",
        parameters: [{ name: "@email", value: email.toLowerCase() }],
      })
      .fetchAll();

    if (existing.length > 0) {
      return conflict("An account with this email already exists");
    }

    const now = new Date().toISOString();
    const user: User = {
      id: uuidv4(),
      email: email.toLowerCase(),
      displayName,
      role,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };

    await container.items.create(user);

    const token = generateToken(user);
    return {
      status: 201,
      jsonBody: {
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      },
    };
  } catch (err) {
    context.error("register error", err);
    return internalError();
  }
}

// POST /api/auth/login
async function login(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as LoginPayload;
    const { email, password } = body;

    if (!email || !password) {
      return badRequest("email and password are required");
    }

    const container = await getContainer(CONTAINERS.USERS);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.email = @email",
        parameters: [{ name: "@email", value: email.toLowerCase() }],
      })
      .fetchAll();

    const user: User | undefined = resources[0];
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return unauthorized("Invalid email or password");
    }

    const token = generateToken(user);
    return {
      status: 200,
      jsonBody: {
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      },
    };
  } catch (err) {
    context.error("login error", err);
    return internalError();
  }
}

app.http("register", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/register",
  handler: register,
});

app.http("login", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/login",
  handler: login,
});
