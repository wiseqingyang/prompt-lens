/**
 * Shared test fixtures for PromptLens testing
 * Provides synthetic origin servers, upstream proxies, OAuth responses, Gemini/Claude SSE & JSON payloads.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function temporaryDatabase(t) {
  // StorageEngine tightens its parent directory's permissions: never put a
  // database directly under the shared OS temp root.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-db-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'lens.db');
}

const FIXTURES = {
  gemini: {
    sampleResponse: {
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello! How can I help you today?' }]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 8,
          totalTokenCount: 23,
          cachedContentTokenCount: 5,
          thoughtsTokenCount: 0
        }
      }
    },
    toolCallResponse: {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'readFile',
                    args: { path: 'package.json' }
                  }
                }
              ]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30
        }
      }
    }
  },
  anthropic: {
    sampleSse: [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":50,"cache_read_input_tokens":20}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude reply"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ]
  },
  oauth: {
    tokenResponse: {
      access_token: 'synthetic-token-do-not-log',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform'
    }
  }
};

/**
 * Creates an ephemeral mock HTTP server
 */
function createMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
    server.on('error', reject);
  });
}

module.exports = {
  FIXTURES,
  createMockServer,
  temporaryDatabase
};
