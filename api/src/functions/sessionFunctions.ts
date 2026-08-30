import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { v4 as uuidv4 } from "uuid";
import { getContainer } from "../services/cosmosService";
import {
  requireRole,
  isAuthResult,
  authenticate,
  badRequest,
  notFound,
  forbidden,
  internalError,
} from "../middleware/auth";
import { StreamSession, ScheduleSessionPayload } from "../models";
import { CONTAINERS, ROLES, SESSION_STATUS } from "../utils/constants";

// POST /api/sessions — producer schedules a stream session
async function createSession(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.PRODUCER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const body = (await request.json()) as ScheduleSessionPayload;
    const {
      movieId,
      region,
      scheduledStartAt,
      scheduledEndAt,
      totalSeats,
      isPayPerView,
      pricePerTicket,
    } = body;

    if (!movieId || !region || !scheduledStartAt || !scheduledEndAt || !totalSeats) {
      return badRequest(
        "movieId, region, scheduledStartAt, scheduledEndAt, and totalSeats are required"
      );
    }

    const start = new Date(scheduledStartAt);
    const end = new Date(scheduledEndAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return badRequest("Invalid scheduledStartAt or scheduledEndAt date");
    }
    if (start >= end) {
      return badRequest("scheduledStartAt must be before scheduledEndAt");
    }
    if (start <= new Date()) {
      return badRequest("scheduledStartAt must be in the future");
    }
    if (totalSeats < 1 || totalSeats > 100000) {
      return badRequest("totalSeats must be between 1 and 100,000");
    }
    if (isPayPerView && (!pricePerTicket || pricePerTicket <= 0)) {
      return badRequest("pricePerTicket (in USD cents) is required for pay-per-view sessions");
    }

    // Verify the movie belongs to this producer
    const moviesContainer = await getContainer(CONTAINERS.MOVIES);
    const { resources: movies } = await moviesContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.producerId = @producerId",
        parameters: [
          { name: "@id", value: movieId },
          { name: "@producerId", value: payload.sub },
        ],
      })
      .fetchAll();

    if (!movies[0]) return notFound("Movie not found or not owned by you");

    const now = new Date().toISOString();
    const session: StreamSession = {
      id: uuidv4(),
      producerId: payload.sub,
      movieId,
      region,
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: end.toISOString(),
      totalSeats,
      availableSeats: totalSeats,
      status: SESSION_STATUS.SCHEDULED,
      isPayPerView: !!isPayPerView,
      pricePerTicket: isPayPerView ? pricePerTicket : undefined,
      createdAt: now,
      updatedAt: now,
    };

    const container = await getContainer(CONTAINERS.STREAM_SESSIONS);
    await container.items.create(session);

    return { status: 201, jsonBody: session };
  } catch (err) {
    context.error("createSession error", err);
    return internalError();
  }
}

// GET /api/sessions — list upcoming sessions (filterable by region)
async function listSessions(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const region = request.query.get("region");
    const producerId = request.query.get("producerId");
    const container = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const now = new Date().toISOString();

    const conditions: string[] = ["c.scheduledEndAt > @now"];
    const parameters: { name: string; value: string }[] = [
      { name: "@now", value: now },
    ];

    if (region) {
      conditions.push("c.region = @region");
      parameters.push({ name: "@region", value: region });
    }
    if (producerId) {
      conditions.push("c.producerId = @producerId");
      parameters.push({ name: "@producerId", value: producerId });
    }

    const query = `SELECT * FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.scheduledStartAt ASC`;
    const { resources } = await container.items.query({ query, parameters }).fetchAll();
    return { status: 200, jsonBody: resources };
  } catch (err) {
    context.error("listSessions error", err);
    return internalError();
  }
}

// GET /api/sessions/{id} — get a single session
async function getSession(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const sessionId = request.params.id;
    const container = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: sessionId }],
      })
      .fetchAll();

    if (!resources[0]) return notFound("Session not found");
    return { status: 200, jsonBody: resources[0] };
  } catch (err) {
    context.error("getSession error", err);
    return internalError();
  }
}

// PATCH /api/sessions/{id}/cancel — producer cancels a session
async function cancelSession(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.PRODUCER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const sessionId = request.params.id;
    const container = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: sessionId }],
      })
      .fetchAll();

    const session: StreamSession | undefined = resources[0];
    if (!session) return notFound("Session not found");
    if (session.producerId !== payload.sub) return forbidden("You can only cancel your own sessions");
    if (session.status === SESSION_STATUS.ENDED || session.status === SESSION_STATUS.CANCELLED) {
      return badRequest(`Session is already ${session.status}`);
    }

    const updated: StreamSession = {
      ...session,
      status: SESSION_STATUS.CANCELLED,
      updatedAt: new Date().toISOString(),
    };
    await container.items.upsert(updated);
    return { status: 200, jsonBody: updated };
  } catch (err) {
    context.error("cancelSession error", err);
    return internalError();
  }
}

app.http("createSession", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "sessions",
  handler: createSession,
});

app.http("listSessions", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sessions",
  handler: listSessions,
});

app.http("getSession", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sessions/{id}",
  handler: getSession,
});

app.http("cancelSession", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "sessions/{id}/cancel",
  handler: cancelSession,
});
