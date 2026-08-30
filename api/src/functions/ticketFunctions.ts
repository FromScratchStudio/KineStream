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
  conflict,
  unauthorized,
  internalError,
} from "../middleware/auth";
import { generateStreamAccessToken, verifyStreamToken } from "../services/authService";
import { Ticket, StreamSession, PurchaseTicketPayload } from "../models";
import { CONTAINERS, ROLES, SESSION_STATUS, TICKET_STATUS } from "../utils/constants";

// POST /api/tickets — consumer purchases a ticket for a session
async function purchaseTicket(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.CONSUMER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const body = (await request.json()) as PurchaseTicketPayload;
    const { sessionId, region } = body;

    if (!sessionId || !region) {
      return badRequest("sessionId and region are required");
    }

    const sessionsContainer = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const { resources: sessions } = await sessionsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.region = @region",
        parameters: [
          { name: "@id", value: sessionId },
          { name: "@region", value: region },
        ],
      })
      .fetchAll();

    const session: StreamSession | undefined = sessions[0];
    if (!session) return notFound("Stream session not found");
    if (session.status === SESSION_STATUS.CANCELLED || session.status === SESSION_STATUS.ENDED) {
      return badRequest(`Session is ${session.status} and no longer accepting tickets`);
    }
    if (session.availableSeats <= 0) {
      return conflict("No seats available for this session");
    }
    if (new Date(session.scheduledStartAt) < new Date()) {
      return badRequest("This session has already started; tickets are no longer available");
    }

    // Check if consumer already has a ticket for this session
    const ticketsContainer = await getContainer(CONTAINERS.TICKETS);
    const { resources: existing } = await ticketsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.consumerId = @consumerId AND c.sessionId = @sessionId AND c.status != @cancelled",
        parameters: [
          { name: "@consumerId", value: payload.sub },
          { name: "@sessionId", value: sessionId },
          { name: "@cancelled", value: TICKET_STATUS.CANCELLED },
        ],
      })
      .fetchAll();

    if (existing.length > 0) {
      return conflict("You already have a ticket for this session");
    }

    // Decrement available seats using ETag-based optimistic concurrency to prevent overbooking
    const updatedSession: StreamSession = {
      ...session,
      availableSeats: session.availableSeats - 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      await sessionsContainer.items.upsert(updatedSession, {
        accessCondition: {
          type: "IfMatch",
          condition: (session as unknown as Record<string, unknown>)["_etag"] as string,
        },
      });
    } catch (concurrencyErr: unknown) {
      const err = concurrencyErr as { code?: number };
      if (err.code === 412) {
        // Pre-condition failed: another request modified the session concurrently
        return conflict("Could not reserve seat due to a concurrent request — please try again");
      }
      throw concurrencyErr;
    }

    const now = new Date().toISOString();
    const ticket: Ticket = {
      id: uuidv4(),
      consumerId: payload.sub,
      sessionId,
      movieId: session.movieId,
      producerId: session.producerId,
      region,
      purchasedAt: now,
      status: TICKET_STATUS.ACTIVE,
      amountPaid: session.isPayPerView ? (session.pricePerTicket ?? 0) : 0,
      createdAt: now,
      updatedAt: now,
    };

    await ticketsContainer.items.create(ticket);
    return { status: 201, jsonBody: ticket };
  } catch (err) {
    context.error("purchaseTicket error", err);
    return internalError();
  }
}

// GET /api/tickets — consumer lists their tickets
async function listMyTickets(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const payload = authenticate(request);
    if (!payload) return unauthorized();

    const container = await getContainer(CONTAINERS.TICKETS);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.consumerId = @consumerId ORDER BY c.createdAt DESC",
        parameters: [{ name: "@consumerId", value: payload.sub }],
      })
      .fetchAll();

    return { status: 200, jsonBody: resources };
  } catch (err) {
    context.error("listMyTickets error", err);
    return internalError();
  }
}

// POST /api/tickets/{id}/access — consumer requests a stream access token
// This verifies the session is currently live and the ticket is valid
async function accessStream(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.CONSUMER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const ticketId = request.params.id;
    const ticketsContainer = await getContainer(CONTAINERS.TICKETS);
    const { resources: tickets } = await ticketsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.consumerId = @consumerId",
        parameters: [
          { name: "@id", value: ticketId },
          { name: "@consumerId", value: payload.sub },
        ],
      })
      .fetchAll();

    const ticket: Ticket | undefined = tickets[0];
    if (!ticket) return notFound("Ticket not found");
    if (ticket.status !== TICKET_STATUS.ACTIVE) {
      return badRequest(`Ticket is ${ticket.status}`);
    }

    // Check the session is currently live
    const sessionsContainer = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const { resources: sessions } = await sessionsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: ticket.sessionId }],
      })
      .fetchAll();

    const session: StreamSession | undefined = sessions[0];
    if (!session) return notFound("Stream session not found");

    const now = new Date();
    const start = new Date(session.scheduledStartAt);
    const end = new Date(session.scheduledEndAt);

    if (now < start) {
      return badRequest(
        `Stream has not started yet. It begins at ${session.scheduledStartAt}`
      );
    }
    if (now > end) {
      return badRequest("Stream has ended");
    }

    // Generate a short-lived stream access token
    const streamAccessToken = generateStreamAccessToken(ticket.id, session.id);

    // Mark ticket as used
    const updatedTicket: Ticket = {
      ...ticket,
      status: TICKET_STATUS.USED,
      streamAccessToken,
      updatedAt: new Date().toISOString(),
    };
    await ticketsContainer.items.upsert(updatedTicket);

    return {
      status: 200,
      jsonBody: {
        streamAccessToken,
        streamUrl: session.streamUrl ?? `https://stream.kinestream.io/live/${session.id}`,
        sessionId: session.id,
        scheduledEndAt: session.scheduledEndAt,
      },
    };
  } catch (err) {
    context.error("accessStream error", err);
    return internalError();
  }
}

// DELETE /api/tickets/{id} — consumer cancels a ticket (before session starts)
async function cancelTicket(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.CONSUMER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const ticketId = request.params.id;
    const ticketsContainer = await getContainer(CONTAINERS.TICKETS);
    const { resources: tickets } = await ticketsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.consumerId = @consumerId",
        parameters: [
          { name: "@id", value: ticketId },
          { name: "@consumerId", value: payload.sub },
        ],
      })
      .fetchAll();

    const ticket: Ticket | undefined = tickets[0];
    if (!ticket) return notFound("Ticket not found");
    if (ticket.status !== TICKET_STATUS.ACTIVE) {
      return badRequest(`Ticket is already ${ticket.status}`);
    }

    // Verify session hasn't started yet
    const sessionsContainer = await getContainer(CONTAINERS.STREAM_SESSIONS);
    const { resources: sessions } = await sessionsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: ticket.sessionId }],
      })
      .fetchAll();

    const session: StreamSession | undefined = sessions[0];
    if (session && new Date(session.scheduledStartAt) <= new Date()) {
      return badRequest("Cannot cancel a ticket for a session that has already started");
    }

    // Cancel ticket and restore seat
    const updatedTicket: Ticket = {
      ...ticket,
      status: TICKET_STATUS.CANCELLED,
      updatedAt: new Date().toISOString(),
    };
    await ticketsContainer.items.upsert(updatedTicket);

    if (session) {
      const updatedSession: StreamSession = {
        ...session,
        availableSeats: session.availableSeats + 1,
        updatedAt: new Date().toISOString(),
      };
      await sessionsContainer.items.upsert(updatedSession);
    }

    return { status: 200, jsonBody: updatedTicket };
  } catch (err) {
    context.error("cancelTicket error", err);
    return internalError();
  }
}

app.http("purchaseTicket", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "tickets",
  handler: purchaseTicket,
});

app.http("listMyTickets", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "tickets",
  handler: listMyTickets,
});

app.http("accessStream", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "tickets/{id}/access",
  handler: accessStream,
});

app.http("cancelTicket", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "tickets/{id}",
  handler: cancelTicket,
});
