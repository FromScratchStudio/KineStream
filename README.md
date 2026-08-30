# KineStream

KineStream is an **Azure-native digital theater** application for scheduled movie streaming. It enables:

- **Content Producers** to upload movies, schedule streaming sessions with limited seats, and optionally enable pay-per-view pricing.
- **Content Consumers** to browse upcoming streams by region, purchase tickets, and access the live stream during the scheduled window.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Applications                     │
│              (Web / Mobile / 3rd-party integrations)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               Azure Functions (Node.js v4 HTTP)             │
│  /api/auth/*  /api/movies/*  /api/sessions/*  /api/tickets/*│
└──────┬─────────────────────┬───────────────────────┬────────┘
       │                     │                       │
       ▼                     ▼                       ▼
┌─────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Cosmos DB  │   │  Azure Blob      │   │  App Insights    │
│  (NoSQL)    │   │  Storage         │   │  (Monitoring)    │
│  Serverless │   │  (Movie files)   │   │                  │
└─────────────┘   └──────────────────┘   └──────────────────┘
```

### Azure Services Used

| Service | Purpose |
|---------|---------|
| **Azure Functions** (Consumption plan) | Serverless API — auto-scales, pay-per-execution |
| **Azure Cosmos DB** (Serverless) | NoSQL database — users, movies, sessions, tickets |
| **Azure Blob Storage** | Movie file & thumbnail storage with SAS URL uploads |
| **Azure Application Insights** | Telemetry and logging |

## Cosmos DB Data Model

| Container | Partition Key | Records |
|-----------|--------------|---------|
| `users` | `/id` | Producers and consumers |
| `movies` | `/producerId` | Movie metadata + blob references |
| `streamSessions` | `/region` | Scheduled streaming sessions |
| `tickets` | `/consumerId` | Consumer ticket purchases |

## API Reference

### Authentication (`/api/auth`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Register a new user (producer or consumer) |
| `POST` | `/api/auth/login` | Login and receive a JWT |

### Movies (`/api/movies`) — Producer only for write operations

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/movies` | Optional | List movies |
| `POST` | `/api/movies` | Producer | Create a movie entry |
| `GET` | `/api/movies/{id}` | Optional | Get movie details |
| `PATCH` | `/api/movies/{id}` | Producer | Update movie metadata |
| `POST` | `/api/movies/{id}/upload-url` | Producer | Get SAS URL to upload movie file |

### Stream Sessions (`/api/sessions`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/sessions?region=&producerId=` | None | List upcoming sessions |
| `POST` | `/api/sessions` | Producer | Schedule a new streaming session |
| `GET` | `/api/sessions/{id}` | None | Get session details |
| `PATCH` | `/api/sessions/{id}/cancel` | Producer | Cancel a session |

### Tickets (`/api/tickets`) — Consumer only

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/tickets` | Consumer | List my tickets |
| `POST` | `/api/tickets` | Consumer | Purchase a ticket for a session |
| `POST` | `/api/tickets/{id}/access` | Consumer | Get stream access token (session must be live) |
| `DELETE` | `/api/tickets/{id}` | Consumer | Cancel a ticket (before session starts) |

## Stream Access Flow

```
1. Consumer registers → receives JWT
2. Consumer browses sessions (by region, date)
3. Consumer purchases ticket → ticket created, seat decremented
4. At session start time, consumer calls POST /api/tickets/{id}/access
   → receives a short-lived streamAccessToken + streamUrl
5. Consumer uses streamUrl to watch the live stream
6. Stream access is only possible during the scheduled window
```

## Project Structure

```
KineStream/
├── api/                        # Azure Functions backend
│   ├── src/
│   │   ├── functions/          # HTTP function handlers
│   │   │   ├── authFunctions.ts     # register, login
│   │   │   ├── movieFunctions.ts    # CRUD + upload URL
│   │   │   ├── sessionFunctions.ts  # schedule, list, cancel
│   │   │   └── ticketFunctions.ts   # purchase, access, cancel
│   │   ├── middleware/
│   │   │   └── auth.ts         # JWT auth helpers & response helpers
│   │   ├── models/
│   │   │   └── index.ts        # TypeScript interfaces & types
│   │   ├── services/
│   │   │   ├── authService.ts  # JWT + password hashing
│   │   │   └── cosmosService.ts # Cosmos DB client
│   │   ├── utils/
│   │   │   └── constants.ts    # Shared constants
│   │   └── index.ts            # Entry point (imports all functions)
│   ├── host.json               # Azure Functions configuration
│   ├── local.settings.json     # Local dev environment variables (gitignored)
│   ├── package.json
│   └── tsconfig.json
├── infra/                      # Infrastructure as Code (Bicep)
│   ├── main.bicep              # All Azure resources
│   └── main.bicepparam         # Parameter file
└── tests/
    └── unit/
        ├── authService.test.ts
        └── authMiddleware.test.ts
```

## Getting Started

### Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- An Azure subscription

### Local Development

1. **Install dependencies**
   ```bash
   cd api
   npm install
   ```

2. **Configure local settings**

   Copy `api/local.settings.json` and fill in your Cosmos DB and JWT values:
   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "FUNCTIONS_WORKER_RUNTIME": "node",
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "COSMOS_ENDPOINT": "https://<your-account>.documents.azure.com:443/",
       "COSMOS_KEY": "<your-primary-key>",
       "COSMOS_DATABASE": "kinestream",
       "JWT_SECRET": "<random-long-secret>",
       "STORAGE_ACCOUNT": "<your-storage-account>"
     }
   }
   ```

3. **Build and start**
   ```bash
   npm run build
   npm start
   ```

4. **Run tests**
   ```bash
   npm test
   ```

### Deploy to Azure

```bash
# Deploy infrastructure (Bicep)
az login
az group create --name kinestream-dev-rg --location westeurope
JWT_SECRET="$(openssl rand -base64 32)" \
  az deployment group create \
  --resource-group kinestream-dev-rg \
  --template-file infra/main.bicep \
  --parameters infra/main.bicepparam \
  --parameters jwtSecret="$JWT_SECRET"

# Build and deploy Functions
cd api
npm run build
func azure functionapp publish kinestream-dev-api
```

## Pay-Per-View

Pay-per-view is disabled by default. A producer can enable it per-movie and per-session:

- Set `isPayPerView: true` and `pricePerView` (in USD cents) when creating a movie.
- Set `isPayPerView: true` and `pricePerTicket` (in USD cents) when scheduling a session.

Payment processing integration (Stripe, Azure Payment Services) can be plugged in to the `purchaseTicket` function before the ticket is created.
