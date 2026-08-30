import { ROLES, SESSION_STATUS, TICKET_STATUS } from "../utils/constants";

export type UserRole = (typeof ROLES)[keyof typeof ROLES];
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];
export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS];

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Movie {
  id: string;
  producerId: string;
  title: string;
  description: string;
  durationMinutes: number;
  genre: string;
  blobUrl: string;        // Azure Blob Storage URL
  thumbnailUrl: string;
  isPayPerView: boolean;
  pricePerView?: number;  // in USD cents
  createdAt: string;
  updatedAt: string;
}

export interface StreamSession {
  id: string;
  producerId: string;
  movieId: string;
  region: string;          // partition key (e.g., "europe-west", "us-east")
  scheduledStartAt: string; // ISO 8601
  scheduledEndAt: string;   // ISO 8601
  totalSeats: number;
  availableSeats: number;
  status: SessionStatus;
  streamUrl?: string;       // Populated when session goes live
  isPayPerView: boolean;
  pricePerTicket?: number;  // in USD cents
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  id: string;
  consumerId: string;
  sessionId: string;
  movieId: string;
  producerId: string;
  region: string;
  purchasedAt: string;
  status: TicketStatus;
  amountPaid: number;       // in USD cents (0 for free streams)
  streamAccessToken?: string; // Short-lived token for stream access
  createdAt: string;
  updatedAt: string;
}

// API payloads
export interface RegisterPayload {
  email: string;
  displayName: string;
  password: string;
  role: UserRole;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface CreateMoviePayload {
  title: string;
  description: string;
  durationMinutes: number;
  genre: string;
  isPayPerView: boolean;
  pricePerView?: number;
}

export interface ScheduleSessionPayload {
  movieId: string;
  region: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  totalSeats: number;
  isPayPerView: boolean;
  pricePerTicket?: number;
}

export interface PurchaseTicketPayload {
  sessionId: string;
  region: string;
}
