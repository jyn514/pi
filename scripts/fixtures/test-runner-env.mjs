#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

console.log(
	JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		env: process.env,
		credentials: [".pi/agent/auth.json", ".aws/credentials", ".config/gcloud/application_default_credentials.json"].filter(
			(file) => existsSync(join(process.env.HOME, file)),
		),
		configs: [process.env.NPM_CONFIG_USERCONFIG, process.env.NPM_CONFIG_GLOBALCONFIG].map((file) =>
			readFileSync(file, "utf8"),
		),
	}),
);
process.exitCode = /^\d+$/.test(process.argv[2] ?? "") ? Number(process.argv[2]) : 0;
