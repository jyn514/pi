// Injects parse and cleanup failures without leaking the checker's native child.
import { API } from "typescript/unstable/sync";

const close = API.prototype.close;
API.prototype.close = function () {
	close.call(this);
	throw new Error("simulated cleanup EPIPE");
};

if (process.env.CHECK_TS_TEST_FAILURE === "parse") {
	API.prototype.updateSnapshot = function () {
		throw new Error("simulated parse failure");
	};
}
