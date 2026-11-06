export interface RelatedHistoryRecord {
  record_id: number;
  response_id: string;
  messages: { role: string; text: string }[];
}
export interface RelatedHistory {
  records: RelatedHistoryRecord[];
  status: 'none' | 'complete' | 'missing' | 'expired' | 'ambiguous' | 'cycle' | 'budget' | 'untrusted' | 'error';
  messageCount: number;
}
