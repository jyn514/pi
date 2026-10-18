import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../test.sh", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/test-runner-env.mjs", import.meta.url));

test("test runner retains the ripgrep backend without inheriting credentials", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-test-runner-env-"));
	try {
		const bin = join(root, "bin");
		const home = join(root, "home");
		mkdirSync(bin);
		mkdirSync(home);
		const npm = join(bin, "npm");
		copyFileSync(fixture, npm);
		assert.deepEqual(readFileSync(npm), readFileSync(fixture));
		chmodSync(npm, 0o755);
		const result = spawnSync("bash", [runner], {
			encoding: "utf8",
			env: {
				PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
				HOME: home,
				TMPDIR: root,
				RG_REAL: process.execPath,
				ANTHROPIC_API_KEY: "test-only-key",
				TEST_RUNNER_SECRET: "test-only-secret",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.equal(output.env.RG_REAL, process.execPath);
		assert.equal(output.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(output.env.TEST_RUNNER_SECRET, undefined);
		assert.notEqual(output.env.HOME, home);
		assert.equal(existsSync(output.env.HOME), false, "isolated home is removed after the runner exits");
		assert.equal(existsSync(home), true, "caller home remains untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Exercise the real shell entrypoint; only the selected child command is a fixture.
function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-test-runner-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "caller-home");
	const cwd = join(root, "package with spaces");
	const bin = join(root, "bin");
	for (const directory of [home, cwd, bin]) mkdirSync(directory);
	for (const file of [".pi/agent/auth.json", ".aws/credentials", ".config/gcloud/application_default_credentials.json"]) {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), "caller credential");
	}
	const probe = join(bin, "probe");
	copyFileSync(fixture, probe);
	assert.deepEqual(readFileSync(probe), readFileSync(fixture));
	chmodSync(probe, 0o755);
	copyFileSync(probe, join(bin, "npm"));
	assert.deepEqual(readFileSync(join(bin, "npm")), readFileSync(probe));
	chmodSync(join(bin, "npm"), 0o755);
	const env = {
		PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
		HOME: home,
		USERPROFILE: home,
		TMPDIR: root,
		PWD: cwd,
		RG_REAL: process.execPath,
		NODE_EXTRA_CA_CERTS: join(root, "proxy.pem"),
		CI: "true",
		GITHUB_ACTIONS: "true",
		ANTHROPIC_API_KEY: "test-only-key",
		AWS_ACCESS_KEY_ID: "test-only-aws-key",
		GOOGLE_APPLICATION_CREDENTIALS: join(home, ".config/gcloud/application_default_credentials.json"),
		PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
		NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		NODE_OPTIONS: "--no-warnings",
		TEST_RUNNER_SECRET: "test-only-secret",
	};
	writeFileSync(env.NODE_EXTRA_CA_CERTS, "");
	return {
		root,
		home,
		cwd,
		env,
		run: (args) => spawnSync(relative(cwd, runner), args, { cwd, env, encoding: "utf8" }),
	};
}

function outputOf(result) {
	assert.equal(result.error, undefined);
	return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

function assertCleaned(context, output) {
	assert.equal(existsSync(dirname(output.env.HOME)), false, "entire isolation root is removed");
	assert.equal(existsSync(context.home), true, "caller home remains untouched");
	assert.equal(readFileSync(join(context.home, ".pi/agent/auth.json"), "utf8"), "caller credential");
	assert.deepEqual(
		readdirSync(context.root).filter((name) => name.startsWith("pi-test.")),
		[],
		"no isolation roots leak",
	);
}

const unixOnly = { skip: process.platform === "win32" };

test("explicit commands preserve argv and package CWD while isolating environment and credentials", unixOnly, (t) => {
	const context = setup(t);
	const args = ["0", "two words", "", "--run", "*.test.ts", "$(not-a-shell-command)", "quote'\"\\"];
	const result = context.run(["--", "probe", ...args]);
	assert.equal(result.status, 0, result.stderr);
	const output = outputOf(result);
	assert.deepEqual(output.argv, args);
	assert.equal(output.cwd, context.cwd);
	assert.equal(output.env.PWD, context.cwd);
	assert.equal(output.env.PATH, [join(dirname(output.env.HOME), "bin"), context.env.PATH].join(delimiter));
	assert.equal(output.env.TEST_KEYCHAIN_DIRECTORY, join(dirname(output.env.HOME), "keychain"));
	for (const name of ["RG_REAL", "NODE_EXTRA_CA_CERTS", "CI", "GITHUB_ACTIONS"]) {
		assert.equal(output.env[name], context.env[name]);
	}
	for (const name of [
		"ANTHROPIC_API_KEY",
		"AWS_ACCESS_KEY_ID",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"PI_CODING_AGENT_DIR",
		"NODE_OPTIONS",
		"TEST_RUNNER_SECRET",
	]) {
		assert.equal(output.env[name], undefined, `${name} must not reach the child`);
	}
	const isolated = dirname(output.env.HOME);
	assert.notEqual(output.env.HOME, context.home);
	assert.equal(output.env.USERPROFILE, output.env.HOME);
	for (const name of ["TMPDIR", "TMP", "TEMP"]) assert.equal(output.env[name], join(isolated, "tmp"));
	assert.equal(output.env.XDG_CONFIG_HOME, join(output.env.HOME, ".config"));
	assert.equal(output.env.XDG_CACHE_HOME, join(isolated, "cache"));
	assert.equal(output.env.NPM_CONFIG_CACHE, join(isolated, "cache/npm"));
	assert.equal(output.env.NPM_CONFIG_USERCONFIG, join(isolated, "npm-userconfig"));
	assert.equal(output.env.NPM_CONFIG_GLOBALCONFIG, join(isolated, "npm-globalconfig"));
	assert.deepEqual(output.configs, ["", ""]);
	assert.deepEqual(output.credentials, []);
	assert.equal(output.env.GIT_CONFIG_GLOBAL, "/dev/null");
	assert.equal(output.env.GIT_CONFIG_NOSYSTEM, "1");
	assert.equal(output.env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(spawnSync(output.env.GIT_ASKPASS).status, 1);
	assert.equal(output.env.PI_NO_LOCAL_LLM, "1");
	assert.equal(output.env.AWS_EC2_METADATA_DISABLED, "true");
	assert.equal(output.env.LANG, "C");
	assert.equal(output.env.LC_ALL, "C");
	assert.equal(output.env.TZ, "UTC");
	assertCleaned(context, output);
});

test("no arguments still select npm test", unixOnly, (t) => {
	const context = setup(t);
	const result = context.run([]);
	assert.equal(result.status, 0, result.stderr);
	// The npm fixture reports argv instead of running the repository suite.
	const output = outputOf(result);
	assert.deepEqual(output.argv, ["test"]);
	assert.equal(output.cwd, context.cwd);
	assertCleaned(context, output);
});

test("command exit status survives cleanup", unixOnly, (t) => {
	const context = setup(t);
	const result = context.run(["--", "probe", "37"]);
	assert.equal(result.status, 37, result.stderr);
	assertCleaned(context, outputOf(result));
});

test("a missing command fails and cleans up", unixOnly, (t) => {
	const context = setup(t);
	const result = context.run(["--", "./missing-command"]);
	assert.equal(result.status, 127);
	assert.match(result.stderr, /missing-command/);
	assert.deepEqual(readdirSync(context.root).filter((name) => name.startsWith("pi-test.")), []);
	assert.equal(existsSync(context.home), true);
});

test("help and invalid invocations do not launch tests or create isolation roots", unixOnly, (t) => {
	const context = setup(t);
	for (const args of [["--help"], ["-h"], ["--"], ["--", ""], ["probe"], ["--help", "probe"], ["--unknown"]]) {
		const result = context.run(args);
		const help = args.length === 1 && ["--help", "-h"].includes(args[0]);
		assert.equal(result.status, help ? 0 : 2, JSON.stringify(args));
		assert.match(help ? result.stdout : result.stderr, /Usage: .*\[-- <command> <args\.\.\.>\]/);
		assert.doesNotMatch(result.stdout, /Running tests/);
		assert.deepEqual(readdirSync(context.root).filter((name) => name.startsWith("pi-test.")), []);
	}
});
