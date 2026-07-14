'use strict';

// xoshiro128** PRNG — standard implementation, do not modify.
// https://prng.di.unimi.it/

function createRng(seed) {
    let s0 = (seed >>> 0) || 1;
    let s1 = (seed ^ 0x6D2B79F5) >>> 0 || 1;
    let s2 = Math.imul(seed, 0x9E3779B1) >>> 0 || 1;
    let s3 = (seed ^ 0x1B873593) >>> 0 || 1;

    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

    function next() {
        const result = Math.imul(rotl(Math.imul(s0, 5) >>> 0, 7), 9) >>> 0;
        const t = (s1 << 17) >>> 0;
        s2 ^= s0; s2 >>>= 0;
        s3 ^= s1; s3 >>>= 0;
        s1 ^= s2; s1 >>>= 0;
        s0 ^= s3; s0 >>>= 0;
        s2 ^= t;  s2 >>>= 0;
        s3 = rotl(s3, 45);
        return result / 4294967296;
    }
    return { next };
}

if (typeof window !== 'undefined') {
    window.createRng = createRng;
}
