import type { AgentProvider } from './agents.js';

export type PendingInteractionKind = 'approval' | 'permission' | 'question' | 'confirmation' | 'unsupported';
export type PendingInteractionStatus = 'pending' | 'sending' | 'error' | 'resolved' | 'denied' | 'expired' | 'cancelled';

export interface PendingInteractionOption {
  /** Opaque provider-scoped choice id. Only ids advertised here are accepted back. */
  id: string;
  label: string;
  description?: string;
  intent: 'approve' | 'deny' | 'cancel' | 'choice';
  risk?: 'safe' | 'caution' | 'danger';
}

export interface PendingInteractionField {
  id: string;
  label: string;
  prompt: string;
  options?: { label: string; description?: string }[];
  multiple?: boolean;
  /** Secret answers use a password control and are never retained in the pending store or audit. */
  secret?: boolean;
  text?: boolean;
}

/** Sanitized, bounded data that is safe to send to every signed-in browser. */
export interface PendingInteraction {
  id: string;
  version: number;
  workerId: string;
  workerName: string;
  floorId: string;
  floorName: string;
  provider: AgentProvider;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  createdAt: number;
  updatedAt: number;
  /** When the provider will stop accepting an answer, when it supplied a deadline. */
  expiresAt?: number;
  title: string;
  prompt: string;
  description?: string;
  task?: string;
  resource?: string;
  impact?: string;
  risk?: string;
  options: PendingInteractionOption[];
  fields?: PendingInteractionField[];
  error?: string;
  unsupportedReason?: string;
}

export interface PendingInteractionResponse {
  optionId?: string;
  /** Answers are keyed by the field ids the request advertised, never by browser-provided labels. */
  answers?: Record<string, string[]>;
}

export type InteractionClientMsg = {
  t: 'interaction.resolve';
  id: string;
  version: number;
  response: PendingInteractionResponse;
};

export type InteractionServerMsg =
  | { t: 'interaction.upsert'; interaction: PendingInteraction }
  | { t: 'interaction.remove'; id: string; status: Extract<PendingInteractionStatus, 'resolved' | 'denied' | 'expired' | 'cancelled'> };
