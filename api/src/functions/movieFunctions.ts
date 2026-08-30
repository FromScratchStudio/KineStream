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
import { Movie, CreateMoviePayload } from "../models";
import { CONTAINERS, ROLES } from "../utils/constants";

// POST /api/movies — producer creates a movie entry
async function createMovie(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.PRODUCER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const body = (await request.json()) as CreateMoviePayload;
    const { title, description, durationMinutes, genre, isPayPerView, pricePerView } = body;

    if (!title || !description || !durationMinutes || !genre) {
      return badRequest("title, description, durationMinutes, and genre are required");
    }
    if (isPayPerView && (!pricePerView || pricePerView <= 0)) {
      return badRequest("pricePerView (in USD cents) is required for pay-per-view movies");
    }

    const now = new Date().toISOString();
    const movie: Movie = {
      id: uuidv4(),
      producerId: payload.sub,
      title,
      description,
      durationMinutes,
      genre,
      blobUrl: "",       // Set after the producer uploads the actual file
      thumbnailUrl: "",
      isPayPerView: !!isPayPerView,
      pricePerView: isPayPerView ? pricePerView : undefined,
      createdAt: now,
      updatedAt: now,
    };

    const container = await getContainer(CONTAINERS.MOVIES);
    await container.items.create(movie);

    return { status: 201, jsonBody: movie };
  } catch (err) {
    context.error("createMovie error", err);
    return internalError();
  }
}

// GET /api/movies — list movies (producers see their own; consumers see all)
async function listMovies(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const payload = authenticate(request);
    const container = await getContainer(CONTAINERS.MOVIES);

    let query: string;
    const parameters: { name: string; value: string }[] = [];

    if (payload?.role === ROLES.PRODUCER) {
      query = "SELECT * FROM c WHERE c.producerId = @producerId ORDER BY c.createdAt DESC";
      parameters.push({ name: "@producerId", value: payload.sub });
    } else {
      query = "SELECT * FROM c ORDER BY c.createdAt DESC";
    }

    const { resources } = await container.items
      .query({ query, parameters })
      .fetchAll();

    return { status: 200, jsonBody: resources };
  } catch (err) {
    context.error("listMovies error", err);
    return internalError();
  }
}

// GET /api/movies/{id} — get a single movie
async function getMovie(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const movieId = request.params.id;
    const container = await getContainer(CONTAINERS.MOVIES);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: movieId }],
      })
      .fetchAll();

    if (!resources[0]) return notFound("Movie not found");
    return { status: 200, jsonBody: resources[0] };
  } catch (err) {
    context.error("getMovie error", err);
    return internalError();
  }
}

// PATCH /api/movies/{id} — producer updates movie metadata
async function updateMovie(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.PRODUCER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const movieId = request.params.id;
    const container = await getContainer(CONTAINERS.MOVIES);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: movieId }],
      })
      .fetchAll();

    const movie: Movie | undefined = resources[0];
    if (!movie) return notFound("Movie not found");
    if (movie.producerId !== payload.sub) return forbidden("You can only edit your own movies");

    const updates = (await request.json()) as Partial<CreateMoviePayload>;
    const updated: Movie = {
      ...movie,
      ...updates,
      id: movie.id,
      producerId: movie.producerId,
      updatedAt: new Date().toISOString(),
    };

    await container.items.upsert(updated);
    return { status: 200, jsonBody: updated };
  } catch (err) {
    context.error("updateMovie error", err);
    return internalError();
  }
}

// POST /api/movies/{id}/upload-url — get a SAS URL to upload movie blob
async function getMovieUploadUrl(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const auth = requireRole(request, ROLES.PRODUCER);
    if (!isAuthResult(auth)) return auth;
    const { payload } = auth;

    const movieId = request.params.id;
    const container = await getContainer(CONTAINERS.MOVIES);
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: movieId }],
      })
      .fetchAll();

    const movie: Movie | undefined = resources[0];
    if (!movie) return notFound("Movie not found");
    if (movie.producerId !== payload.sub) return forbidden("You can only upload to your own movies");

    // In production this would generate an Azure Blob SAS URL
    // For now we return the expected blob path
    const storageAccount = process.env.STORAGE_ACCOUNT || "kinestreamstorage";
    const containerName = "movies";
    const blobName = `${payload.sub}/${movieId}/video.mp4`;
    const blobUrl = `https://${storageAccount}.blob.core.windows.net/${containerName}/${blobName}`;

    // Update the movie's blobUrl
    const updated: Movie = { ...movie, blobUrl, updatedAt: new Date().toISOString() };
    await container.items.upsert(updated);

    return {
      status: 200,
      jsonBody: {
        uploadUrl: `${blobUrl}?${process.env.BLOB_SAS_TOKEN || "sv=2021-06-08&placeholder=true"}`,
        blobUrl,
      },
    };
  } catch (err) {
    context.error("getMovieUploadUrl error", err);
    return internalError();
  }
}

app.http("createMovie", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "movies",
  handler: createMovie,
});

app.http("listMovies", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "movies",
  handler: listMovies,
});

app.http("getMovie", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "movies/{id}",
  handler: getMovie,
});

app.http("updateMovie", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "movies/{id}",
  handler: updateMovie,
});

app.http("getMovieUploadUrl", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "movies/{id}/upload-url",
  handler: getMovieUploadUrl,
});
