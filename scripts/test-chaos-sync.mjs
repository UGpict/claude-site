// Requires a running Astro dev server and Playwright + Chromium.
// CHAOS_TEST_PLAYWRIGHT may point to a Playwright installation outside the checkout.
// Example: CHAOS_TEST_PLAYWRIGHT=/workspace/.cloud-tools/node_modules/playwright/index.mjs node scripts/test-chaos-sync.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CHAOS_TEST_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
	const page = await browser.newPage();
	await page.goto(process.env.CHAOS_TEST_URL || 'http://127.0.0.1:4321/');
	const clock = await page.evaluate(async () => {
		const { createAudio } = await import('/src/scripts/games/audio.ts');
		const { BURNING_HEART_SONG } = await import('/src/scripts/games/song.ts');
		const Native = window.AudioContext;
		let ctx, invalid = false;
		window.AudioContext = class extends Native {
			constructor() { super(); ctx = this; }
			getOutputTimestamp() {
				if (invalid) throw new Error('unavailable output timestamp');
				return { contextTime: this.currentTime - 0.24, performanceTime: performance.now() };
			}
			get baseLatency() { return 0.01; }
			get outputLatency() { return 0.23; }
		};
		const audio = createAudio();
		const results = [];
		try {
			for (const retry of [false, true]) {
				await audio.startTransport(4, BURNING_HEART_SONG);
				await new Promise(r => setTimeout(r, 350));
				const raw = ctx.currentTime - audio.getTransport().startTime;
				const visual = audio.now();
				const event = audio.eventTimeToTransport(performance.now());
				const delayed = audio.eventTimeToTransport(performance.now() - 30);
				results.push({ retry, mode: audio.audioMode(), skew: raw - visual, agreement: visual - event.t, queue: event.t - delayed.t });
			}
			invalid = true;
			const visual = audio.now();
			const fallback = audio.eventTimeToTransport(performance.now());
			results.push({ fallback: fallback.mode, agreement: visual - fallback.t });
			await ctx.suspend();
			// Exercise input before now(): switching origins must not mix audio and performance clocks.
			const silent = audio.eventTimeToTransport(performance.now());
			results.push({ silent: silent.mode, agreement: audio.now() - silent.t, clock: audio.getTransport().clock });
		} finally {
			await ctx.close();
			audio.now(); // stop scheduler through the silent fallback
			window.AudioContext = Native;
		}
		return results;
	});
	for (const result of clock) {
		assert.ok(Math.abs(result.agreement) < 0.01, JSON.stringify(result));
		if ('retry' in result) {
			assert.equal(result.mode, 'external');
			assert.ok(Math.abs(result.skew - 0.24) < 0.01, JSON.stringify(result));
			assert.ok(Math.abs(result.queue - 0.03) < 0.01, JSON.stringify(result));
		}
		if (result.fallback) assert.equal(result.fallback, 'audioClock');
		if (result.silent) { assert.equal(result.silent, 'performance'); assert.equal(result.clock, 'performance'); }
	}
	console.log('PASS: FULL audio, 240ms output latency, retry, queued input, timestamp fallback, interruption');
	const physics = await page.evaluate(async () => {
		const { initGame } = await import('/src/scripts/games/chaos-pendulum.ts');
		const { DEFAULT_SONG, BURNING_HEART_SONG } = await import('/src/scripts/games/song.ts');
		const original = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
		function run(song, stall) {
			let t = 0, frame, hitTime, hitResult;
			window.requestAnimationFrame = callback => { frame = callback; return 1; };
			window.cancelAnimationFrame = () => {};
			const canvas = document.createElement('canvas');
			canvas.style.cssText = 'width:500px;height:500px';
			document.body.append(canvas);
			const el = () => document.createElement('div');
			const handle = initGame({ canvas, song, now: () => t, elements: { score: el(), combo: el(), time: el(), msg: el() }, onEvent(name, data) {
				if (name === 'rhythm_pattern' && hitTime == null) hitTime = data.hitTime;
				if (name === 'hit') hitResult = data;
			} });
			try {
				// FULL starts with rests: advance until the first real target appears.
				while (hitTime == null && t < 30) { t += 1 / 60; frame(); }
				if (hitTime == null) throw Error('no notes scheduled');
				const stop = hitTime - (stall ? 0.45 : 0);
				while (t + 1 / 60 < stop) { t += 1 / 60; frame(); }
				t = hitTime;
				frame();
				// Deliberately use handler time to isolate physics catch-up from the audio conversion.
				const event = new PointerEvent('pointerdown', { bubbles: true });
				Object.defineProperty(event, 'timeStamp', { value: NaN });
				canvas.dispatchEvent(event);
				return hitResult;
			} finally { handle.destroy(); canvas.remove(); }
		}
		try { return [DEFAULT_SONG, BURNING_HEART_SONG].map(song => ({ song: song.id, normal: run(song, false), stalled: run(song, true) })); }
		finally { window.requestAnimationFrame = original.request; window.cancelAnimationFrame = original.cancel; }
	});
	for (const result of physics) {
		assert.ok(result.normal && result.stalled, JSON.stringify(result));
		for (const key of ['kind', 'distancePx', 'timingOffsetMs', 'pts']) assert.equal(result.stalled[key], result.normal[key], `${result.song}: ${key}`);
	}
	console.log('PASS: QUICK/FULL 450ms frame stall preserves note distance, judgment and timing');
} finally {
	await browser.close();
}
