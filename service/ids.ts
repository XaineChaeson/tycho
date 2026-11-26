import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BITS = 80n;

let lastTime = 0;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  // Within one millisecond (or after the clock steps back) keep counting up,
  // so ids from this process always sort in creation order.
  if (now <= lastTime) {
    lastRandom = (lastRandom + 1n) & ((1n << RANDOM_BITS) - 1n);
  } else {
    lastTime = now;
    lastRandom = BigInt(`0x${randomBytes(10).toString('hex')}`);
  }
  return encode(BigInt(lastTime), 10) + encode(lastRandom, 16);
}
