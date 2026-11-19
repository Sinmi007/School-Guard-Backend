import { clientIp } from './client-ip-throttler.guard';

describe('clientIp', () => {
  it('uses the visitor address Cloudflare passes, not the proxy address', () => {
    expect(
      clientIp({
        ip: '10.0.0.1',
        headers: { 'cf-connecting-ip': '102.89.1.2' },
      }),
    ).toBe('102.89.1.2');
  });

  it('falls back to the socket address locally', () => {
    expect(clientIp({ ip: '::1', headers: {} })).toBe('::1');
    expect(
      clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
    ).toBe('127.0.0.1');
  });
});
