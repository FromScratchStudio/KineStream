// Cosmos DB containers
export const CONTAINERS = {
  USERS: "users",
  MOVIES: "movies",
  STREAM_SESSIONS: "streamSessions",
  TICKETS: "tickets",
} as const;

// Cosmos DB partition key paths
export const PARTITION_KEYS = {
  USERS: "/id",
  MOVIES: "/producerId",
  STREAM_SESSIONS: "/region",
  TICKETS: "/consumerId",
} as const;

// User roles
export const ROLES = {
  PRODUCER: "producer",
  CONSUMER: "consumer",
} as const;

// Stream session status
export const SESSION_STATUS = {
  SCHEDULED: "scheduled",
  LIVE: "live",
  ENDED: "ended",
  CANCELLED: "cancelled",
} as const;

// Ticket status
export const TICKET_STATUS = {
  ACTIVE: "active",
  USED: "used",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
} as const;
