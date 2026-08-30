# KineStream — Technical Overview

> This document is the single authoritative reference for any developer joining the project. It covers what the application does, how it is designed, what technologies were chosen and **why**, how the code is organised, and how to operate it.

---

## Table of Contents

1. [Product Purpose](#1-product-purpose)
2. [User Roles & Core Flows](#2-user-roles--core-flows)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Technology Stack & Rationale](#4-technology-stack--rationale)
5. [Azure Services Used & Why](#5-azure-services-used--why)
6. [Data Model](#6-data-model)
7. [API Design](#7-api-design)
8. [Security Model](#8-security-model)
9. [Source Code Structure](#9-source-code-structure)
10. [Infrastructure as Code](#10-infrastructure-as-code)
11. [Testing Strategy](#11-testing-strategy)
12. [Environment Variables & Configuration](#12-environment-variables--configuration)
13. [Developer Quick-Start](#13-developer-quick-start)
14. [Deployment](#14-deployment)
15. [Key Design Decisions & Trade-offs](#15-key-design-decisions--trade-offs)
16. [Roadmap / Future Work](#16-roadmap--future-work)

---

## 1. Product Purpose

KineStream is a **digital theater** platform for scheduled, region-specific movie streaming. It mirrors the experience of a physical cinema but operates entirely in the cloud:

- A **movie screen** has a finite number of seats and shows a film at a fixed time.
- Attendees must hold a **ticket** to enter and can only watch during the scheduled window.
- **Producers** (studios, independent filmmakers, distributors) publish films and schedule showings.
- **Consumers** (viewers) browse the schedule, purchase tickets, and access the stream when it starts.

Unlike on-demand streaming platforms (Netflix, Prime), KineStream enforces **scarcity** (limited seats) and **time windows** (the stream is only accessible between `scheduledStartAt` and `scheduledEndAt`). This creates urgency and a shared viewing experience closer to a live event than a library rental.

An optional **pay-per-view** mode can be toggled on per-session, enabling monetisation for producers. Free screenings are equally supported.

---

## 2. User Roles & Core Flows

### 2.1 Content Producer

```
Register (role=producer)
  └─▶ Create movie record (title, description, duration, genre, PPV flag)
        └─▶ Upload video file via SAS URL → Azure Blob Storage
              └─▶ Schedule stream session
                    (movieId, region, scheduledStart, scheduledEnd, totalSeats, PPV price)
                          └─▶ Optionally cancel session before it starts
```

A producer can schedule **multiple sessions** for the same movie in **different regions** and at **different times**, similar to a film release schedule across cinemas.

### 2.2 Content Consumer

```
Register (role=consumer)
  └─▶ Browse upcoming sessions (filter by region)
        └─▶ Purchase ticket (before session starts, while seats remain)
              └─▶ At session start time → POST /tickets/{id}/access
                    └─▶ Receive short-lived streamAccessToken + streamUrl
                          └─▶ Watch the live stream
                                └─▶ Ticket marked "used"; access expires at scheduledEndAt
```

Consumers can cancel a ticket before the session starts, which restores the seat to the pool.

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Client Applications                             │
│               (Web SPA / Mobile App / Third-party integrations)         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS / JSON REST
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Azure Functions  (Node.js v4, HTTP trigger)           │
│                                                                         │
│  /api/auth/*          /api/movies/*        /api/sessions/*              │
│  register, login      create, list,        schedule, list,              │
│                        get, update,         get, cancel                 │
│                        upload-url                                       │
│                                            /api/tickets/*               │
│                                            purchase, list,              │
│                                            access, cancel               │
└──────────┬──────────────────────┬──────────────────────┬────────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────────┐  ┌────────────────────────┐
│  Azure Cosmos DB │  │  Azure Blob Storage   │  │  Azure App Insights    │
│  (NoSQL,         │  │  movies/  container   │  │  (telemetry, logging,  │
│   Serverless)    │  │  thumbnails/ container│  │   live metrics)        │
│                  │  │                       │  │                        │
│  users           │  │  Uploads via SAS URL  │  │  Logs forwarded from   │
│  movies          │  │  (producer uploads    │  │  Azure Functions       │
│  streamSessions  │  │   directly; no proxy) │  │  automatically         │
│  tickets         │  │                       │  │                        │
└──────────────────┘  └──────────────────────┘  └────────────────────────┘
```

All components are **serverless**. There are no always-on virtual machines or containers to manage. The system scales automatically with demand and costs zero at rest.

---

## 4. Technology Stack & Rationale

### 4.1 Runtime: Node.js 20 LTS

**Chosen because:**
- First-class support in Azure Functions with minimal cold-start overhead.
- The I/O-heavy workload (database reads/writes, token verification) is a natural fit for Node.js's non-blocking event loop; CPU-bound work is minimal.
- The Azure SDK for JavaScript (`@azure/cosmos`, `@azure/storage-blob`, `@azure/identity`) is mature and actively maintained.
- Large ecosystem; most streaming and media tooling has Node.js SDKs.

### 4.2 Language: TypeScript 5.x (strict mode)

**Chosen because:**
- Static typing catches entire classes of bugs (wrong field names, missing null checks, incorrect API payloads) at compile time rather than in production.
- The data model (User, Movie, StreamSession, Ticket) maps cleanly to TypeScript interfaces, making intent self-documenting.
- `strict: true` enforces no implicit `any`, strict null checks, and exhaustive property access — all important for a financial-grade feature like ticketing.
- TypeScript 5.x was pinned (not 7.x) because `ts-jest`, the test transformer, requires the stable JavaScript compiler API that TypeScript 7's native port does not yet expose.

### 4.3 API Framework: Azure Functions v4 (programmatic model)

**Chosen because:**
- **v4 programmatic model** (`app.http(...)`) allows functions to be registered in plain TypeScript files rather than requiring a `function.json` per route. This reduces boilerplate significantly and keeps routing co-located with handler logic.
- Consumption plan (serverless) means zero cost when idle — appropriate for a startup or initial launch where traffic is unpredictable.
- No server to provision, patch, or scale; Azure handles all orchestration.
- Built-in integration with Application Insights for telemetry.

### 4.4 Password Hashing: PBKDF2 (Node.js built-in `crypto`)

**Chosen because:**
- PBKDF2 is a NIST-recommended key derivation function (NIST SP 800-132) that applies 100,000 iterations of HMAC-SHA-512, making brute-force attacks computationally expensive.
- Uses a random 16-byte salt per password, preventing rainbow-table attacks.
- No additional dependencies: uses Node.js's native `crypto` module, reducing the attack surface.
- Alternatives (bcrypt, argon2) require native addons which complicate Lambda/Function cold starts and deployment packages. PBKDF2 with high iteration count achieves equivalent security without compilation dependencies.

### 4.5 Authentication Tokens: JWT (jsonwebtoken)

**Chosen because:**
- **Stateless**: the server does not need to store session state; every function instance can independently verify any token by checking the signature. This is critical for serverless where each invocation may run on a different instance.
- Standard, widely understood format (RFC 7519) with mature tooling.
- Claims-based: `role`, `sub`, and `email` are embedded in the token, so the API does not need a database round-trip to determine who is calling and what they are allowed to do.
- Two token types are issued: a long-lived **auth token** (8 h) and a short-lived **stream access token** (4 h), the latter carrying a `purpose: "stream"` claim so the two cannot be interchanged.

### 4.6 Data Validation: Inline (TypeScript interfaces + manual guards)

The codebase uses TypeScript interfaces + explicit guard conditions (missing field checks, range checks, date validation) rather than a schema validation library for request payloads. `zod` is installed as a dependency to be used for deeper validation as the API matures.

### 4.7 Testing: Jest + ts-jest

**Chosen because:**
- Jest is the de-facto standard test runner in the Node.js/TypeScript ecosystem with an excellent assertion library, coverage reporter, and mock system.
- `ts-jest` transpiles TypeScript on the fly, avoiding a separate build step for tests.
- A `globalSetup` file injects required environment variables (e.g., `JWT_SECRET`) before the test suite loads any modules, preventing startup errors in unit tests.

---

## 5. Azure Services Used & Why

### 5.1 Azure Functions (Consumption Plan)

| Property | Value |
|----------|-------|
| Trigger type | HTTP |
| Runtime | Node.js 20 |
| Pricing | Pay-per-execution (Consumption plan) |
| Scaling | 0 → N instances automatically |

**Why Consumption plan and not Premium or Dedicated?**
The Consumption plan has ~1 s cold start for Node.js functions, which is acceptable for an API where requests are not latency-critical at the millisecond level. It costs nothing at rest. For a live-streaming platform that has unpredictable traffic spikes (session starts) and long quiet periods (between sessions), the Consumption plan is economically ideal. A Premium plan can be introduced later if cold-start latency becomes a problem.

### 5.2 Azure Cosmos DB (Serverless)

| Property | Value |
|----------|-------|
| API | SQL (Core) |
| Capacity mode | Serverless |
| Consistency | Session |
| Partition strategy | Per-container, see §6 |

**Why Cosmos DB instead of Azure SQL / PostgreSQL?**
- The domain objects (User, Movie, StreamSession, Ticket) have different shapes and read/write patterns. A document model maps them naturally without JOIN complexity.
- **Serverless mode** means zero cost at rest — RU/s are consumed on demand. For a platform with irregular load, this is more cost-efficient than provisioned throughput.
- **Session consistency** guarantees that a consumer who just purchased a ticket immediately sees their own ticket in subsequent reads (their session's read-your-writes guarantee), without the cost of Strong consistency.
- Global distribution and multi-region replication can be enabled later by adding locations in Bicep — a critical feature for a streaming platform serving users across continents.

**Why not Azure Table Storage (cheaper)?**
Table Storage has limited query capabilities (no secondary indexes, no cross-partition queries). Cosmos DB SQL API allows arbitrary parameterised queries, necessary for lookups like "all sessions in region X starting after now".

### 5.3 Azure Blob Storage

| Property | Value |
|----------|-------|
| Tier | Standard LRS |
| Public access | Disabled |
| Containers | `movies/`, `thumbnails/` |

**Why Blob Storage for video files?**
- Video files are large binary objects — the right primitive is object storage, not a database. Blob Storage handles files of any size efficiently.
- **SAS (Shared Access Signature) URLs**: producers upload directly from the client to Blob Storage without routing gigabytes of video through the API server. The API generates a time-limited, scope-limited SAS URL that authorises the upload, then the client's browser uploads directly. This avoids bandwidth costs and execution time on the Function.
- Public blob access is **disabled**. All access is mediated by SAS tokens or private blob URLs, preventing unauthenticated downloads.

### 5.4 Azure Application Insights

All Function invocations are automatically instrumented with Application Insights via the `APPINSIGHTS_INSTRUMENTATIONKEY` setting. This provides:
- Request/response telemetry (duration, status code, operation ID)
- Exception tracking (stack traces surfaced in the portal)
- Live metrics streaming
- Dependency tracking (Cosmos DB and Blob calls)
- 90-day log retention

---

## 6. Data Model

The database is named `kinestream`. It contains four Cosmos DB containers.

### 6.1 Partition Key Design

Partition key choice directly controls query performance and cost in Cosmos DB. A query that targets a single partition is dramatically cheaper and faster than a cross-partition fan-out.

| Container | Partition Key | Reasoning |
|-----------|--------------|-----------|
| `users` | `/id` | Users are looked up by ID after login (JWT sub). Queries by email during login are cross-partition but rare. |
| `movies` | `/producerId` | The dominant query is "list my movies" (producer dashboard). Partitioning by producer ensures that a producer's full catalogue is on one partition. |
| `streamSessions` | `/region` | The dominant consumer query is "upcoming sessions in my region". Partitioning by region makes this query single-partition. |
| `tickets` | `/consumerId` | The dominant query is "my tickets". Partitioning by consumer keeps all tickets for one user on one partition. |

### 6.2 Document Schemas

#### User
```typescript
{
  id: string          // UUID, Cosmos document id and partition key
  email: string       // lowercase, unique
  displayName: string
  role: "producer" | "consumer"
  passwordHash: string  // "salt:pbkdf2hash" — never returned in API responses
  createdAt: string   // ISO 8601
  updatedAt: string
}
```

#### Movie
```typescript
{
  id: string
  producerId: string  // partition key; FK to users.id
  title: string
  description: string
  durationMinutes: number
  genre: string
  blobUrl: string     // Azure Blob Storage URL (set after upload)
  thumbnailUrl: string
  isPayPerView: boolean
  pricePerView?: number  // USD cents; only set when isPayPerView = true
  createdAt: string
  updatedAt: string
}
```

#### StreamSession
```typescript
{
  id: string
  producerId: string
  movieId: string
  region: string          // partition key (e.g., "europe-west", "us-east")
  scheduledStartAt: string  // ISO 8601
  scheduledEndAt: string
  totalSeats: number
  availableSeats: number  // decremented on ticket purchase; incremented on cancellation
  status: "scheduled" | "live" | "ended" | "cancelled"
  streamUrl?: string      // populated when session goes live
  isPayPerView: boolean
  pricePerTicket?: number // USD cents
  createdAt: string
  updatedAt: string
}
```

#### Ticket
```typescript
{
  id: string
  consumerId: string  // partition key
  sessionId: string
  movieId: string
  producerId: string
  region: string
  purchasedAt: string
  status: "active" | "used" | "cancelled" | "refunded"
  amountPaid: number         // USD cents (0 for free streams)
  streamAccessToken?: string // short-lived JWT; set when consumer accesses stream
  createdAt: string
  updatedAt: string
}
```

---

## 7. API Design

All endpoints are prefixed with `/api/`. Requests and responses use `application/json`. Authentication uses the `Authorization: ****** header.

### 7.1 Authentication

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/auth/register` | None | Register a new user. Body: `{email, displayName, password, role}`. Returns `{token, user}`. |
| `POST` | `/api/auth/login` | None | Login. Body: `{email, password}`. Returns `{token, user}`. |

### 7.2 Movies

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/movies` | Producer | Create a movie record. |
| `GET` | `/api/movies` | Optional | List movies. Producers see only their own; others see all. |
| `GET` | `/api/movies/{id}` | Optional | Get a single movie. |
| `PATCH` | `/api/movies/{id}` | Producer (owner) | Update movie metadata. |
| `POST` | `/api/movies/{id}/upload-url` | Producer (owner) | Get a SAS URL for uploading the video file directly to Blob Storage. |

### 7.3 Stream Sessions

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/sessions` | Producer | Schedule a new session. Body: `{movieId, region, scheduledStartAt, scheduledEndAt, totalSeats, isPayPerView, pricePerTicket?}`. |
| `GET` | `/api/sessions?region=&producerId=` | None | List upcoming sessions. Both query params are optional filters. |
| `GET` | `/api/sessions/{id}` | None | Get a single session. |
| `PATCH` | `/api/sessions/{id}/cancel` | Producer (owner) | Cancel a session. |

### 7.4 Tickets

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/tickets` | Consumer | Purchase a ticket. Body: `{sessionId, region}`. |
| `GET` | `/api/tickets` | Consumer | List the caller's tickets. |
| `POST` | `/api/tickets/{id}/access` | Consumer | Request a stream access token. Only succeeds during the scheduled window. Returns `{streamAccessToken, streamUrl, sessionId, scheduledEndAt}`. |
| `DELETE` | `/api/tickets/{id}` | Consumer | Cancel a ticket (only before session starts; restores available seat). |

### 7.5 HTTP Status Codes

| Code | Meaning in this API |
|------|---------------------|
| 200 | Success (GET, PATCH, DELETE) |
| 201 | Created (POST) |
| 400 | Bad Request — validation error |
| 401 | Unauthorized — missing or invalid JWT |
| 403 | Forbidden — authenticated but wrong role or not the owner |
| 404 | Not Found |
| 409 | Conflict — duplicate ticket, no seats, ETag mismatch retry |
| 500 | Internal Server Error |

---

## 8. Security Model

### 8.1 Authentication & Authorisation

1. **Passwords** are never stored in plaintext. PBKDF2-SHA512 with 100,000 iterations and a random 128-bit salt is applied. The stored format is `<salt_hex>:<hash_hex>`.
2. **JWTs** are signed with HS256 using a secret loaded from the `JWT_SECRET` environment variable. The application refuses to start if this variable is absent.
3. **Role enforcement** is done at the function level. `requireRole(request, "producer")` returns a `403` response object if the caller's role does not match; the handler returns it immediately. There is no way to reach producer-only logic as a consumer.
4. **Stream access tokens** are a separate JWT type with `purpose: "stream"` in the payload and a 4-hour expiry. `verifyStreamToken` explicitly rejects tokens without this claim, preventing a consumer from using their login token to forge stream access.

### 8.2 Seat Reservation Concurrency

The `availableSeats` decrement during ticket purchase uses **ETag-based optimistic concurrency control** (Cosmos DB `_etag` with `If-Match` condition). If two requests read the same session document simultaneously, only one write succeeds; the other receives HTTP 412 (Precondition Failed) and the API returns a `409 Conflict` response telling the client to retry. This prevents overbooking without requiring a distributed lock or stored procedure.

### 8.3 Transport Security

- All endpoints are HTTPS-only (enforced at the Function App level: `httpsOnly: true` in Bicep).
- TLS 1.2 minimum is enforced on the Storage Account.
- Blob containers have public access disabled; all file access requires a SAS token.

### 8.4 CORS

CORS `allowedOrigins` is set to `['*']` only in `dev`. In `staging` and `prod` it defaults to an empty list, requiring explicit origin configuration so that only the known frontend domain(s) are permitted.

---

## 9. Source Code Structure

```
KineStream/
├── .gitignore                  # Excludes node_modules, dist, local.settings.json
├── README.md                   # Quick-start guide and API reference
├── technical-overview.md       # This document
│
├── api/                        # Azure Functions application
│   ├── host.json               # Functions host config (extension bundle v4)
│   ├── local.settings.json     # Local dev env vars (gitignored — never committed)
│   ├── package.json            # Dependencies and npm scripts
│   ├── tsconfig.json           # TypeScript compiler config (strict, ES2020, commonjs)
│   ├── jest.config.json        # Jest configuration (ts-jest, globalSetup)
│   ├── jest.setup.ts           # Injects test environment variables (JWT_SECRET etc.)
│   │
│   └── src/
│       ├── index.ts            # Entry point — imports all function modules
│       │
│       ├── functions/          # One file per domain; each registers its HTTP functions
│       │   ├── authFunctions.ts     # POST /auth/register, POST /auth/login
│       │   ├── movieFunctions.ts    # CRUD + upload-url for /movies
│       │   ├── sessionFunctions.ts  # Schedule, list, cancel for /sessions
│       │   └── ticketFunctions.ts   # Purchase, access, cancel for /tickets
│       │
│       ├── middleware/
│       │   └── auth.ts         # JWT extraction, authenticate(), requireRole(),
│       │                       # isAuthResult() type guard, HTTP response helpers
│       │
│       ├── models/
│       │   └── index.ts        # TypeScript interfaces: User, Movie, StreamSession,
│       │                       # Ticket, and all request payload types
│       │
│       ├── services/
│       │   ├── authService.ts  # hashPassword, verifyPassword, generateToken,
│       │   │                   # generateStreamAccessToken, verifyToken, verifyStreamToken
│       │   └── cosmosService.ts # Lazy CosmosClient singleton, getContainer()
│       │
│       └── utils/
│           └── constants.ts    # CONTAINERS, PARTITION_KEYS, ROLES, SESSION_STATUS,
│                               # TICKET_STATUS — single source of truth for all enums
│
├── infra/
│   ├── main.bicep              # All Azure resources as Infrastructure as Code
│   └── main.bicepparam         # Parameter file (reads JWT_SECRET from env)
│
└── tests/
    └── unit/
        ├── authService.test.ts      # 8 tests: password hashing, JWT generation/verification,
        │                            # stream token generation/rejection
        └── authMiddleware.test.ts   # 5 tests: authenticate(), requireRole()
```

### Module Dependency Graph

```
index.ts
  ├── authFunctions.ts    → services/authService, services/cosmosService, middleware/auth, models
  ├── movieFunctions.ts   → services/cosmosService, middleware/auth, models
  ├── sessionFunctions.ts → services/cosmosService, middleware/auth, models
  └── ticketFunctions.ts  → services/cosmosService, services/authService, middleware/auth, models

middleware/auth.ts        → services/authService
services/authService.ts   → models (User type only)
services/cosmosService.ts → utils/constants
models/index.ts           → utils/constants
```

No circular dependencies. Services have no knowledge of HTTP concerns; all HTTP response construction lives in `middleware/auth.ts`.

---

## 10. Infrastructure as Code

All Azure resources are defined in `infra/main.bicep`. A single `az deployment group create` command provisions the complete environment.

### Resources Created

| Resource | Name Template | Notes |
|----------|--------------|-------|
| Storage Account | `kinestream{env}stor` | LRS, TLS 1.2 min, no public blob access |
| Blob Containers | `movies`, `thumbnails` | Private access only |
| Cosmos DB Account | `kinestream-{env}-cosmos` | Serverless, Session consistency |
| Cosmos DB Database | `kinestream` | Contains 4 containers |
| Cosmos DB Containers | (4) | Partition keys as per §6.1 |
| App Service Plan | `kinestream-{env}-plan` | Y1 (Consumption / Dynamic) |
| Function App | `kinestream-{env}-api` | Node 20, HTTPS only |
| Application Insights | `kinestream-{env}-insights` | 90-day retention |

### Environment Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `location` | string | resource group location | Azure region |
| `appName` | string | `kinestream` | Prefix for all resource names |
| `environment` | `dev`/`staging`/`prod` | `dev` | Controls CORS and naming |
| `jwtSecret` | securestring | (required) | Injected from env var; stored as Function App setting |

The `jwtSecret` is marked `@secure()` in Bicep so it is never logged in deployment output or stored in deployment history in plaintext.

---

## 11. Testing Strategy

### 11.1 Current Tests

| Test File | Tests | What Is Covered |
|-----------|-------|----------------|
| `authService.test.ts` | 8 | Password hashing (correct/incorrect/salt uniqueness), JWT generation and verification, stream token generation and purpose-claim rejection |
| `authMiddleware.test.ts` | 5 | `authenticate()` with no header / invalid token / valid token; `requireRole()` with 401 / 403 / success paths |
| **Total** | **13** | |

### 11.2 Test Isolation

- Tests do **not** hit any real Azure services. The `jest.setup.ts` global setup file injects stub environment variables (`COSMOS_ENDPOINT`, `COSMOS_KEY`, `JWT_SECRET`) before any module is loaded, satisfying fail-fast guards without requiring a live Cosmos instance.
- The Cosmos service is not exercised in unit tests. Integration tests against a real Cosmos emulator or test database would be a natural next step.

### 11.3 Running Tests

```bash
cd api
npm test            # run all tests
npm run lint        # TypeScript type check (tsc --noEmit)
```

---

## 12. Environment Variables & Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | **Yes** | Signing key for all JWTs. Must be a random secret ≥ 32 characters. Application throws at startup if absent. |
| `COSMOS_ENDPOINT` | **Yes** | Cosmos DB account endpoint URL. |
| `COSMOS_KEY` | **Yes** | Cosmos DB primary master key. |
| `COSMOS_DATABASE` | No | Database name (default: `kinestream`). |
| `STORAGE_ACCOUNT` | No | Storage account name used when constructing SAS upload URLs. |
| `BLOB_SAS_TOKEN` | No | Pre-generated SAS token (placeholder; in production, generate per-request with the SDK). |
| `FUNCTIONS_WORKER_RUNTIME` | **Yes** | Must be `node` (set by Azure automatically in cloud; set in `local.settings.json` locally). |
| `AzureWebJobsStorage` | **Yes** | Connection string for the Functions internal storage (checkpointing, lease management). |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | No | Application Insights key. Omit to disable telemetry (local dev). |

`local.settings.json` is gitignored. A template is included in the repository with empty values.

---

## 13. Developer Quick-Start

### Prerequisites

- Node.js 20 LTS
- Azure Functions Core Tools v4 (`npm install -g azure-functions-core-tools@4`)
- A running Cosmos DB instance (Azure portal, or [Cosmos DB Emulator](https://learn.microsoft.com/en-us/azure/cosmos-db/local-emulator))

### Steps

```bash
# 1. Install dependencies
cd api
npm install

# 2. Configure local settings (fill in COSMOS_ENDPOINT, COSMOS_KEY, JWT_SECRET)
#    Copy and edit api/local.settings.json

# 3. Type-check
npm run lint

# 4. Run unit tests
npm test

# 5. Build TypeScript
npm run build

# 6. Start the Functions host locally
npm start
# → Functions available at http://localhost:7071/api/...
```

### Example: Register a producer

```bash
curl -X POST http://localhost:7071/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"studio@example.com","displayName":"Example Studio","password":"secret123","role":"producer"}'
```

### Example: Schedule a session

```bash
TOKEN="<jwt from register response>"
curl -X POST http://localhost:7071/api/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: ******" \
  -d '{
    "movieId": "<movie-id>",
    "region": "europe-west",
    "scheduledStartAt": "2026-09-15T20:00:00Z",
    "scheduledEndAt": "2026-09-15T22:00:00Z",
    "totalSeats": 500,
    "isPayPerView": false
  }'
```

---

## 14. Deployment

```bash
# 1. Login to Azure
az login

# 2. Create resource group
az group create --name kinestream-prod-rg --location westeurope

# 3. Deploy infrastructure
JWT_SECRET="$(openssl rand -base64 48)"
az deployment group create \
  --resource-group kinestream-prod-rg \
  --template-file infra/main.bicep \
  --parameters environment=prod jwtSecret="$JWT_SECRET"

# 4. Build API
cd api && npm run build

# 5. Deploy Functions
func azure functionapp publish kinestream-prod-api
```

Deployment outputs `functionAppUrl` (the base API URL) and `storageAccountName`.

---

## 15. Key Design Decisions & Trade-offs

### Stateless serverless over stateful services

**Decision:** Use Azure Functions (Consumption) + Cosmos DB Serverless rather than a containerised API with a relational database.

**Rationale:** A ticketing platform has highly irregular load — spikes when sessions open for booking and when streams begin, then near-zero traffic between. Serverless billing aligns cost with actual usage. The trade-off is cold starts (~1 s for Node.js) which is acceptable for this use case. If sub-100 ms latency becomes a requirement, migrating to Azure Functions Premium plan or Azure Container Apps would address it.

### NoSQL document store over relational database

**Decision:** Cosmos DB SQL API.

**Rationale:** The domain entities have clearly defined access patterns (see §6.1 partition key design). Cosmos DB's partition-key model allows those patterns to be expressed natively. The trade-off is that cross-entity queries (e.g., "all sessions for movies by producer X") require application-level joins or cross-partition queries. Given the current query patterns, this is not a concern.

### Optimistic concurrency for seat reservation

**Decision:** Use Cosmos DB `_etag` + `If-Match` rather than a Cosmos stored procedure or distributed lock.

**Rationale:** A Cosmos stored procedure would be the most robust solution (transactional within a partition) but requires JavaScript bundled into the stored procedure, a separate deployment step, and is harder to test locally. ETag-based optimistic concurrency handles the common case (low contention) efficiently and surfaces 412 errors cleanly to the client as a `409 Conflict` with a "retry" message. For very high-demand sessions, a stored procedure or Azure Durable Functions approach would be appropriate.

### JWT over Azure AD B2C

**Decision:** Custom JWT implementation rather than Azure AD B2C.

**Rationale:** Azure AD B2C is a fully managed identity provider, but it introduces dependency on an external Microsoft service, B2C tenant provisioning, and policy configuration overhead. For the initial version, a self-managed JWT approach keeps the system self-contained and easier to reason about. Azure AD B2C can be integrated later by replacing the `authService.ts` token generation with B2C-issued tokens and validating them against the B2C JWKS endpoint.

### SAS URL for video upload

**Decision:** Producers receive a SAS URL and upload video files directly from their client to Azure Blob Storage, bypassing the API.

**Rationale:** Routing multi-gigabyte video files through an Azure Function would consume significant execution time and memory, driving up costs and potentially hitting the 230-second default timeout. Direct-to-blob upload with a SAS URL is the standard Azure pattern for large file ingestion. The SAS URL is scoped to a specific blob path with a short expiry, limiting its blast radius if leaked.

---

## 16. Roadmap / Future Work

The following features are architecturally prepared but not yet implemented:

| Feature | Notes |
|---------|-------|
| **Payment processing** | `amountPaid` field and `isPayPerView` flag are in place. Integrate Stripe or Azure Payment Services in the `purchaseTicket` function before ticket creation. |
| **Live stream delivery** | The `streamUrl` field on `StreamSession` is a placeholder. Integration with Azure Media Services or a CDN-based streaming origin is needed to populate it and deliver HLS/DASH streams. |
| **Session status automation** | A Cosmos DB change-feed trigger or Azure Timer Function should transition sessions from `scheduled → live → ended` automatically based on `scheduledStartAt`/`scheduledEndAt`. |
| **Per-request SAS generation** | The `upload-url` endpoint currently uses a pre-generated `BLOB_SAS_TOKEN`. It should use `generateBlobSASQueryParameters` from `@azure/storage-blob` to generate a time-limited, blob-scoped SAS on demand. |
| **Refund flow** | `TICKET_STATUS.REFUNDED` exists in constants but the refund endpoint is not yet implemented. |
| **Azure AD B2C integration** | Replace self-managed JWTs with B2C-issued tokens for enterprise SSO, social login, and MFA. |
| **Integration tests** | Unit tests cover auth logic. Integration tests against the Cosmos DB Emulator would cover the ticketing flow end-to-end. |
| **Producer analytics** | View ticket sales, seat utilisation, and revenue per session. |
