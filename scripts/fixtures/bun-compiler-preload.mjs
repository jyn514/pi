import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

childProcess.spawnSync = () => ({
	status: Number(process.env.PI_COMPILER_STATUS ?? 0),
	stdout: "",
	stderr: process.env.PI_COMPILER_DIAGNOSTIC ?? "",
});
syncBuiltinESMExports();
