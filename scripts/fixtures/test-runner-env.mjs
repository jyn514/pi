#!/usr/bin/env node

console.log(
	JSON.stringify({
		rgReal: process.env.RG_REAL,
		home: process.env.HOME,
		anthropicKey: process.env.ANTHROPIC_API_KEY,
		unlistedSecret: process.env.TEST_RUNNER_SECRET,
	}),
);
