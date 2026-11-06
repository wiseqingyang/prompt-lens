export function isSuccessfulCapture(statusCode: number | undefined, captureStatus?: string): boolean {
  return captureStatus !== 'error' &&
    (statusCode === 101 && captureStatus === 'complete' || (statusCode !== undefined && statusCode >= 200 && statusCode < 300));
}
