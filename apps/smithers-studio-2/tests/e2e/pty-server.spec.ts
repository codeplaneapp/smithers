import { test, expect } from '@playwright/test';

test.describe('PTY Server', () => {
  test('PTY server health endpoint responds', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:7401/health');
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  test('PTY WebSocket can create session', async () => {
    const ws = new WebSocket('ws://127.0.0.1:7401/terminal/ws');

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
      setTimeout(reject, 5000);
    });

    // Send session.create request
    const createMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'session.create',
      params: { cols: 80, rows: 24 }
    };

    ws.send(JSON.stringify(createMessage));

    const response = await new Promise((resolve, reject) => {
      ws.onmessage = (event) => {
        try {
          resolve(JSON.parse(event.data));
        } catch (e) {
          reject(e);
        }
      };
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    console.log('PTY server response:', response);

    if ('error' in response) {
      throw new Error(`PTY server error: ${response.error.message}`);
    }

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        sessionId: expect.any(String),
        pid: expect.any(Number),
      }
    });

    ws.close();
  });
});