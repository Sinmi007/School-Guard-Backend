import { withColdStartTimeouts } from './prisma.service';

describe('withColdStartTimeouts', () => {
  const base = 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb';

  it('adds pool_timeout and connect_timeout when missing', () => {
    const out = new URL(withColdStartTimeouts(`${base}?sslmode=require`)!);
    expect(out.searchParams.get('sslmode')).toBe('require');
    expect(out.searchParams.get('pool_timeout')).toBe('20');
    expect(out.searchParams.get('connect_timeout')).toBe('15');
  });

  it('keeps values that are already set', () => {
    const out = new URL(
      withColdStartTimeouts(`${base}?pool_timeout=5&connect_timeout=30`)!,
    );
    expect(out.searchParams.get('pool_timeout')).toBe('5');
    expect(out.searchParams.get('connect_timeout')).toBe('30');
  });

  it('passes through undefined and unparseable values', () => {
    expect(withColdStartTimeouts(undefined)).toBeUndefined();
    expect(withColdStartTimeouts('not a url')).toBe('not a url');
  });
});
