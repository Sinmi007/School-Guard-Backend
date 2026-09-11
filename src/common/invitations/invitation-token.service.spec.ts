import { InvitationTokenService } from './invitation-token.service';

describe('InvitationTokenService', () => {
  const service = new InvitationTokenService();

  it('generates a token whose stored hash matches the raw token', () => {
    const { token, hash } = service.generate();

    expect(token).toBeTruthy();
    expect(hash).toHaveLength(64);
    expect(service.hash(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('generates unique tokens', () => {
    const a = service.generate();
    const b = service.generate();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('detects expired and non-expired timestamps', () => {
    expect(service.isExpired(new Date(Date.now() - 1000))).toBe(true);
    expect(service.isExpired(new Date(Date.now() + 60_000))).toBe(false);
  });
});
