import { describe, expect, it } from 'vitest';
import { DECELERATION_PER_MS, flingStep, releaseVelocity } from './fling';

describe('releaseVelocity', () => {
	it('is the speed over the last moves before the lift', () => {
		const samples = [
			{ time: 0, position: 0 },
			{ time: 200, position: 100 },
			{ time: 250, position: 150 },
			{ time: 300, position: 250 },
		];
		// The sample at 0 is outside the window; 200 to 300 covers 150 px.
		expect(releaseVelocity(samples, 300)).toBeCloseTo(1.5, 6);
	});

	it('is zero when the finger had stopped before lifting', () => {
		expect(releaseVelocity([{ time: 0, position: 0 }, { time: 10, position: 40 }], 500)).toBe(0);
	});

	it('is zero with a single sample', () => {
		expect(releaseVelocity([{ time: 0, position: 5 }], 0)).toBe(0);
	});
});

describe('flingStep', () => {
	it('slows at iOS\'s rate', () => {
		expect(flingStep(2, 1).velocity).toBeCloseTo(2 * DECELERATION_PER_MS, 9);
	});

	it('covers the same ground in one step as in many', () => {
		const whole = flingStep(3, 160).distance;
		let velocity = 3;
		let distance = 0;
		for (let i = 0; i < 10; i++) {
			const step = flingStep(velocity, 16);
			distance += step.distance;
			velocity = step.velocity;
		}
		expect(distance).toBeCloseTo(whole, 6);
	});

	it('glides the way it was flung, and never past where it would stop', () => {
		const up = flingStep(-2, 16).distance;
		expect(up).toBeLessThan(0);
		// The whole glide from 2 px/ms comes to 2 / -ln(0.998), about 1 km of px.
		expect(flingStep(2, 1e6).distance).toBeCloseTo(-2 / Math.log(DECELERATION_PER_MS), 3);
	});
});
