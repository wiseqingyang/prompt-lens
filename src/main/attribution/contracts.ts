import type { ProtocolCapture, ProtocolEvidence } from '../../shared/captureProtocol';
import type { AttributionDecision, AttributionReason, Resolution } from '../../shared/attribution';

export interface CaptureInput extends ProtocolCapture {
  agentName: string;
  body: unknown;
  capturedAt: string;
  attribution?: string;
  contentExpired?: boolean;
  responseEvidence?: { body: string; complete: boolean };
  connection?: {
    requestBodyEmpty: boolean;
    captureStatus?: string;
    truncatedReason?: string;
    response: unknown;
  };
}

/** Protocol facts and bounded, evidenced display text; authentication and tool arguments are excluded. */
export interface CaptureFacts {
  workbuddy?: { format: 'workbuddy-capture-v1'; protocol: ProtocolEvidence; turn: Resolution<string>; title?: { text: string; evidence: string[] }; continueTurn: boolean };
  pi?: { format: 'pi-capture-v1'; protocol: ProtocolEvidence; responseId: Resolution<string>; api?: PiApi };
  antigravitySearch?: import('./adapters/antigravitySearch').SearchFacts;
  session: Resolution<string>;
  purpose?: import('../../shared/attribution').RequestPurpose;
  connectionIssue?: import('../../shared/attribution').ConnectionIssue;
  codex?: { format: 'codex-capture-v2'; turn: Resolution<string>; requestKind: Resolution<string>; protocol: ProtocolEvidence;
    title?: { text: string; evidence: string[] } };
  fields: Record<string, string | number | null>;
  locator?: AntigravityLocator | PiLocator;
  positionConflict?: boolean;
  parentSessionId?: string;
}

export interface AntigravityLocator { kind?: 'antigravity'; conversationId: string; trajectoryId: string; throughStep: number }
export type PiApi = 'responses' | 'anthropic' | 'chat-completions';
export interface PiLocator { kind: 'pi'; responseId: string; api: PiApi }
export type EvidenceRoots = string | { antigravityDataDir: string; piSessionsDir: string };

export interface NativeStep {
  index: number;
  source: string;
  type: string;
  createdAt: string;
  // Parsed rule facts only: other event bodies remain in the raw archive.
  input?: string;
}

/** Exact relevant source records, independent of the current rule/parser version. */
export interface AntigravityArchive {
  format: 'antigravity-jsonl-v1';
  sourceId: string;
  metadata: { cascade_id: string; trajectory_id: string };
  transcript: string;
}

export interface AntigravityNativeEvidence {
  kind?: 'antigravity';
  raw?: AntigravityArchive;
  status: 'available';
  sourceId: string;
  trajectoryId: string;
  steps: NativeStep[];
  conflict?: { previousSteps: NativeStep[] };
}

export interface PiArchive {
  format: 'pi-jsonl-v3';
  sourceId: string;
  locator: PiLocator;
  // Exact matching entries and necessary ancestors, with their original headers.
  records: { path: string; header: string; entry: string }[];
  // Each path belongs to one observation; never reconstruct a chain from separate partial observations.
  ancestry?: { path: string; entryIds: string[]; limited?: true }[];
}
export type NativeArchive = AntigravityArchive | PiArchive;
export interface PiNativeEvidence {
  kind: 'pi'; status: 'available'; sourceId: string; raw: PiArchive;
  candidates: { sessionId: string; entryId: string; path: string; turn: import('../../shared/attribution').Resolution<import('../../shared/attribution').TurnIdentity> }[];
  conflict?: { reason: 'source_changed' };
}
export type AvailableNativeEvidence = AntigravityNativeEvidence | PiNativeEvidence;

export type NativeEvidence = { status: 'not_required'; raw?: never; previous?: never } | AvailableNativeEvidence
  | { status: 'unavailable'; reason: AttributionReason; previous?: AvailableNativeEvidence; raw?: NativeArchive };

export interface DecisionSnapshot {
  capturedAt: string;
  facts: CaptureFacts;
  native: NativeEvidence;
}

export interface RelationItem {
  recordId: number;
  contentExpired: boolean;
  facts: CaptureFacts;
  decision: AttributionDecision;
}

export interface AgentAdapter {
  relate?(items: RelationItem[]): Map<number, import('../../shared/attribution').ToolLink>;
  readonly id: string;
  readonly version: string;
  readonly identityIndex?: { category: import('../../shared/agent').AgentCategory; source: 'codex_metadata' | 'pi_native' | 'workbuddy_metadata' };
  readonly evidenceMode?: 'capture' | 'native';
  /** Continue observing native evidence after resolution to detect later ambiguity or rewrites. */
  readonly monitorEvidence?: boolean;
  matches(input: CaptureInput): boolean;
  extract(input: CaptureInput): CaptureFacts;
  reconcile?(facts: CaptureFacts, current: NativeEvidence, previous?: DecisionSnapshot & { decision: AttributionDecision }): NativeEvidence;
  decodeEvidence?(evidence: NativeEvidence): NativeEvidence;
  resolve(snapshot: DecisionSnapshot): AttributionDecision;
}

export interface EvidenceSource {
  /** Reusable sources reset batch snapshots while retaining their bounded file cache. */
  beginBatch?(): void;
  read(locator: NonNullable<CaptureFacts['locator']>, previous?: NativeEvidence): Promise<NativeEvidence>;
}

export const unresolved = (reason: AttributionReason, evidence: string[] = []): Resolution<never> =>
  ({ status: 'unresolved', reason, evidence });

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
