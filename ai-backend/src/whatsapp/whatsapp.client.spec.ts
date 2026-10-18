import { resetAppConfig } from '../config/app-config.js';
import { WhatsappApiError, WhatsappClient } from './whatsapp.client.js';

const response = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe('WhatsappClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verifica';
    process.env.WHATSAPP_APP_SECRET = 'segredo';
    resetAppConfig();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
    ]) {
      delete process.env[key];
    }
    resetAppConfig();
  });

  it('manda o texto para /{phone-number-id}/messages com o token', async () => {
    fetchMock.mockResolvedValue(response(200, { messages: [{ id: 'w' }] }));

    await new WhatsappClient().sendText('5511999999999', 'oi');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/123/messages');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5511999999999',
      type: 'text',
      text: { body: 'oi' },
    });
  });

  it('repete em 429/5xx e desiste de 4xx sem repetir', async () => {
    fetchMock
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));
    const ok = new WhatsappClient().sendText('1', 'oi');
    await vi.runAllTimersAsync();
    await ok;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      response(400, { error: { code: 131047, message: 'Re-engagement' } }),
    );
    const err = await new WhatsappClient().sendText('1', 'oi').catch((e) => e);
    expect(err).toBeInstanceOf(WhatsappApiError);
    expect(err).toMatchObject({ status: 400, code: 131047 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
