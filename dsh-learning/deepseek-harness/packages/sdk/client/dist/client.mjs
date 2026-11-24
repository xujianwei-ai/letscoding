import { disposeRuntimeProcess } from "./dispose.mjs";
import { resolveDshLaunch } from "./launch.mjs";
import { spawn } from "node:child_process";
import { JsonRpcLineTransport, JsonRpcResponseError } from "@deepseek-ai/dsh-sdk-protocol";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
//#region lib/types/client.js
/**
* Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
* {@link HarnessClient} owns the child process: it spawns the runtime, speaks
* the `@deepseek-ai/dsh-sdk-protocol` wire over the child's stdio, fans
* server notifications out to subscriptions, and tears the child down to
* quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
* twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
* same runtime protocol. This client runs OUTSIDE any harness context, so it
* spawns directly rather than through the `dsh-subprocess` service — the
* seam's documented exception for SDK-managed transports.
*
* @module @deepseek-ai/dsh-sdk-client/client
*/
/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 400;
/** Grace for the runtime's stdio streams to settle after its exit edge. */
const STREAM_SETTLE_MS = 100;
/**
* The runtime subprocess is gone or unusable: it exited, its stdio closed, or
* it was never launchable. The message carries the exit code and a stderr
* tail when available.
*/
var TransportClosedError = class extends Error {
	/** @param message - the failure description, including any stderr tail. */
	constructor(message) {
		super(message);
		this.name = "TransportClosedError";
	}
};
/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
var RequestTimeoutError = class extends Error {
	/** @param message - which method timed out. */
	constructor(message) {
		super(message);
		this.name = "RequestTimeoutError";
	}
};
/**
* The runtime answered outside its documented protocol (for example a
* `session/prompt` response without `accepted: true`).
*/
var SdkProtocolError = class extends Error {
	/** @param message - the protocol violation description. */
	constructor(message) {
		super(message);
		this.name = "SdkProtocolError";
	}
};
/** Internal producer side of a public notification subscription. */
var NotificationSubscriptionImpl = class {
	state;
	unsubscribe;
	constructor(state, unsubscribe) {
		this.state = state;
		this.unsubscribe = unsubscribe;
	}
	/**
	* Await the next matching notification.
	* @returns the notification; after the runtime died, drains what was
	* already delivered and then rejects; after {@link close}, rejects
	* immediately (the queue is dropped).
	*/
	next() {
		const queued = this.state.queue.shift();
		if (queued !== void 0) return Promise.resolve(queued);
		if (this.state.failure !== void 0) return Promise.reject(this.state.failure);
		return new Promise((resolve, reject) => {
			this.state.waiters.push({
				resolve,
				reject
			});
		});
	}
	/**
	* Drain one already-delivered notification without waiting.
	* @returns the next queued notification, or `undefined` when none is queued.
	*/
	tryNext() {
		return this.state.queue.shift();
	}
	/** Detach from the client; queued items drop and pending waiters reject. */
	close() {
		this.unsubscribe();
		this.state.queue.length = 0;
		this.fail(new TransportClosedError("notification subscription closed"));
	}
	/**
	* Reject pending and future waits (delivery stops; the first failure wins).
	* Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
	* @param error - the terminal failure delivered to waiters.
	*/
	fail(error) {
		this.state.failure ??= error;
		for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure);
	}
	/**
	* Deliver one notification to a waiter or the queue when the filter
	* matches. A throwing filter fails only THIS subscription (detached, the
	* throw becomes its terminal error) — it never disturbs sibling
	* subscriptions or the transport's read loop.
	* @param notification - the wire notification to deliver.
	*/
	push(notification) {
		let matches;
		try {
			matches = this.state.filter === void 0 || this.state.filter(notification);
		} catch (error) {
			this.unsubscribe();
			this.fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (!matches) return;
		const waiter = this.state.waiters.shift();
		if (waiter !== void 0) waiter.resolve(notification);
		else this.state.queue.push(notification);
	}
	/**
	* Iterate notifications until the subscription or runtime closes (the
	* terminating rejection propagates).
	* @returns an async iterator over {@link next} results.
	*/
	async *[Symbol.asyncIterator]() {
		for (;;) yield await this.next();
	}
};
/**
* JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
*
* The subprocess starts lazily on {@link start} and is owned by this instance
* until {@link close}, which requests protocol `shutdown` and then walks the
* shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
* wire-level cancel: a timed-out request stays running server-side until the
* runtime is closed.
*/
var HarnessClient = class {
	/** Original public dsh launch and timeout options for this client. */
	options;
	runtime;
	child;
	transport;
	stderrTail = [];
	subscriptions = /* @__PURE__ */ new Map();
	sessionParents = /* @__PURE__ */ new Map();
	subscriptionSerial = 0;
	exitCode;
	spawnError;
	streamsSettled = Promise.resolve();
	closeTask;
	userQuestions = /* @__PURE__ */ new Map();
	userQuestionHandler;
	requestHandler;
	constructor(options = {}, runtime) {
		this.options = options;
		this.runtime = runtime ?? resolveDshLaunch(options);
	}
	/**
	* Spawn the runtime subprocess and start reading frames. Idempotent while
	* the process is live; rejects reuse after {@link close}.
	*/
	start() {
		if (this.closeTask !== void 0) throw new TransportClosedError("DeepSeek Harness runtime client is closed");
		if (this.child !== void 0) return;
		this.userQuestionHandler = this.options.onUserQuestion;
		const child = spawn(this.runtime.command, this.runtime.args, {
			cwd: this.runtime.cwd,
			env: this.runtime.environment(),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		child.once("error", (error) => {
			this.spawnError = error;
			this.transport?.close();
			this.failSubscriptions(this.closedError("DeepSeek Harness runtime failed to start"));
		});
		/* v8 ignore next */
		child.stdin.on("error", () => {});
		let stderrBuffer = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderrBuffer += chunk;
			const newline = stderrBuffer.lastIndexOf("\n");
			if (newline >= 0) {
				this.appendStderr(stderrBuffer.slice(0, newline).split("\n"));
				stderrBuffer = stderrBuffer.slice(newline + 1);
			}
		});
		let signalStreamsSettled;
		this.streamsSettled = new Promise((resolve) => {
			signalStreamsSettled = resolve;
		});
		const settled = {
			stderr: false,
			exited: false
		};
		const maybeSettle = () => {
			if (settled.stderr && settled.exited) signalStreamsSettled();
		};
		child.stderr.once("close", () => {
			if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer]);
			settled.stderr = true;
			maybeSettle();
		});
		child.once("exit", (code) => {
			this.exitCode = code;
			settled.exited = true;
			maybeSettle();
			this.failSubscriptions(this.closedError("DeepSeek Harness runtime exited"));
		});
		child.once("close", () => {
			this.transport?.close();
		});
		const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
		transport.onRequest(async (method, params) => {
			if (method !== "user-question/ask") {
				if (this.requestHandler !== void 0) return this.requestHandler(method, params);
				throw new SdkProtocolError(`unknown runtime request: ${method}`);
			}
			const handler = this.userQuestionHandler;
			if (handler === void 0) throw new SdkProtocolError("user-question/ask requires an onUserQuestion callback");
			if (!isUserQuestionRequest(params)) throw new SdkProtocolError("user-question/ask requires requestId, sessionId, and questions");
			const requestId = params.requestId;
			if (this.userQuestions.has(requestId)) throw new SdkProtocolError("duplicate user-question requestId");
			const controller = new AbortController();
			this.userQuestions.set(requestId, controller);
			const cancelled = Promise.withResolvers();
			const onAbort = () => {
				cancelled.reject(controller.signal.reason);
			};
			controller.signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([Promise.resolve().then(() => {
					controller.signal.throwIfAborted();
					return handler(params, { signal: controller.signal });
				}), cancelled.promise]);
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
				this.userQuestions.delete(requestId);
			}
		});
		transport.onNotification((method, params) => {
			if (method === "user-question.cancelled" && typeof params.requestId === "string") this.userQuestions.get(params.requestId)?.abort(/* @__PURE__ */ new Error("SDK runtime cancelled the user question"));
			this.dispatchNotification({
				method,
				params
			});
		});
		transport.start();
		this.transport = transport;
	}
	/**
	* Install the additional-request handler; native questions retain their onUserQuestion callback.
	* @param handler - receives wire parameters and returns the JSON-RPC result; rejection sends an error.
	* @throws when the client has not started or has already closed.
	*/
	onRequest(handler) {
		if (this.closeTask !== void 0) throw new TransportClosedError("DeepSeek Harness runtime client is closed; create a new client to install a request handler");
		if (this.transport === void 0) throw new TransportClosedError("start the SDK client before installing a request handler");
		this.requestHandler = handler;
	}
	/**
	* Start the runtime if needed, then perform the process-wide handshake.
	* @param params - workspace cwd plus the provider/model route.
	* @returns the runtime's wire identity.
	*/
	async initialize(params) {
		this.start();
		const result = await this.request("initialize", {
			...params,
			...this.userQuestionHandler === void 0 ? {} : { capabilities: {
				...params.capabilities,
				userQuestions: true
			} }
		}, this.runtime.initializeTimeoutMs);
		if (!isRecord(result) || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`);
		return { serverInfo: {
			name: result.serverInfo.name,
			version: result.serverInfo.version
		} };
	}
	/**
	* Read the provider model catalog without creating a Session or changing the Agent route.
	* Provider failures are isolated so a temporary catalog outage does not hide other routes.
	* @returns provider groups and any isolated catalog failures.
	*/
	async listModels() {
		const result = await this.request("models/list", {}, this.runtime.initializeTimeoutMs);
		if (!isRecord(result) || !Array.isArray(result.groups) || !Array.isArray(result.failures)) throw new SdkProtocolError("models/list returned no provider groups and failures");
		return result;
	}
	/** List root Sessions created under one workspace, without opening them. */
	async listSessions(cwd, limit) {
		const result = await this.request("session/list", {
			cwd,
			...limit === void 0 ? {} : { limit }
		});
		if (!isRecord(result) || !Array.isArray(result.sessions)) throw new SdkProtocolError("session/list returned no sessions array");
		return result;
	}
	/** Fork a conversation through an inclusive durable event boundary. */
	async forkSession(sessionId, cwd, atSeq) {
		const result = await this.request("session/fork", {
			sessionId,
			cwd,
			atSeq
		});
		if (!isRecord(result) || typeof result.sessionId !== "string") throw new SdkProtocolError("session/fork returned no session id");
		return result.sessionId;
	}
	/** Read one persisted workspace Session's raw event log without claiming ownership. */
	async sessionHistory(sessionId, cwd) {
		const result = await this.request("session/history", {
			sessionId,
			cwd
		});
		if (!isRecord(result) || !isRecord(result.session) || !Array.isArray(result.events)) throw new SdkProtocolError("session/history returned no session and events");
		return result;
	}
	/**
	* Queue one prompt without native command routing and return its durable inbox identity.
	* @param sessionId - target session; an unknown id creates it.
	* @param contentBlocks - the user message, sent verbatim.
	* @returns the queued message id.
	*/
	async prompt(sessionId, contentBlocks) {
		const params = {
			sessionId,
			contentBlocks
		};
		const result = await this.request("session/prompt", { ...params });
		if (!isRecord(result) || typeof result.messageId !== "string") throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`);
		return result.messageId;
	}
	/**
	* Restore persisted history without sending a prompt; failures propagate without creating a session.
	* @param sessionId - persisted identity in this runtime's configured persistence store.
	* @returns after the session is ready for prompts.
	*/
	async resumeSession(sessionId) {
		await this.request("session/resume", { sessionId });
	}
	/** Select the model for an existing Session's next turn without restarting its Host. */
	async selectSessionModel(sessionId, provider, model) {
		const params = {
			sessionId,
			provider,
			model
		};
		await this.request("session/selectModel", params);
	}
	/** Restore an idle Session to an exclusive event prefix, retaining its identity. */
	async rewindSession(sessionId, beforeSeq) {
		await this.request("session/rewind", {
			sessionId,
			beforeSeq
		});
	}
	/**
	* Read a Session's effective working directory, recovering it if missing.
	* @param sessionId - target Session; an unknown id creates it.
	* @returns the absolute effective directory.
	*/
	getWorkingDirectory(sessionId) {
		return this.workingDirectoryRequest("session/working-directory/get", { sessionId });
	}
	/**
	* Change a Session's effective directory without changing origin or permissions.
	* @param sessionId - target Session; an unknown id creates it.
	* @param path - absolute or Session-current-directory-relative path.
	* @returns the validated absolute directory.
	*/
	setWorkingDirectory(sessionId, path) {
		return this.workingDirectoryRequest("session/working-directory/set", {
			sessionId,
			path
		});
	}
	async workingDirectoryRequest(method, params) {
		const result = await this.request(method, params);
		if (!isRecord(result) || typeof result.cwd !== "string") throw new SdkProtocolError(`${method} returned no working directory: ${JSON.stringify(result)}`);
		return result.cwd;
	}
	/**
	* Send one JSON-RPC request and await its result.
	* @param method - the wire method name.
	* @param params - the params object; omitted params send `{}`.
	* @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
	* @returns the raw result; rejects with {@link JsonRpcResponseError} on a
	* protocol error response, {@link RequestTimeoutError} on timeout, and
	* {@link TransportClosedError} when the runtime is gone.
	*/
	async request(method, params, timeoutMs) {
		this.start();
		if (this.exitCode !== void 0 || this.spawnError !== void 0) {
			await this.settleStreams();
			throw this.closedError("DeepSeek Harness runtime is not running");
		}
		const transport = this.transport;
		/* v8 ignore next -- start() either sets the transport or throws */
		if (transport === void 0) throw new TransportClosedError("DeepSeek Harness runtime is not running");
		const timeout = timeoutMs ?? this.runtime.requestTimeoutMs;
		try {
			if (timeout === void 0) return await transport.request(method, params ?? {});
			const abandon = new AbortController();
			const timer = setTimeout(() => {
				const stderr = this.stderrTail.length === 0 ? "" : `; stderr tail:\n${this.stderrTail.join("\n")}`;
				abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for ${this.runtime.description}${stderr}`));
			}, timeout);
			try {
				return await transport.request(method, params ?? {}, abandon.signal);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error;
			await this.settleStreams();
			throw this.closedError(errorMessage(error));
		}
	}
	/**
	* Subscribe to server notifications.
	* @param filter - optional predicate; omitted means every notification.
	* @returns the subscription handle; close it to stop delivery. After
	* {@link close} or runtime death the handle is born failed — there is no
	* producer left, so `next()` rejects instead of waiting forever.
	*/
	subscribe(filter) {
		const id = String(this.subscriptionSerial++);
		const subscription = new NotificationSubscriptionImpl({
			queue: [],
			waiters: [],
			filter,
			failure: void 0
		}, () => {
			this.subscriptions.delete(id);
		});
		if (this.closeTask !== void 0 || this.exitCode !== void 0 || this.spawnError !== void 0) {
			subscription.fail(this.closedError("DeepSeek Harness runtime closed"));
			return subscription;
		}
		this.subscriptions.set(id, subscription);
		return subscription;
	}
	/**
	* Subscribe to one session and the descendants discovered from
	* `subagent.started` lineage edges. The runtime notifies for every session
	* in its context, so this client applies the scope.
	* @param sessionId - the root session id.
	* @returns the filtered subscription handle.
	*/
	subscribeSessionTree(sessionId) {
		return this.subscribe((notification) => {
			const params = notification.params;
			if (notification.method === "subagent.started" || notification.method === "subagent.finished") {
				const parentId = params.parentSessionId;
				if (typeof parentId === "string" && this.isDescendantOf(parentId, sessionId)) return true;
				return params.childSessionId === sessionId;
			}
			const relatedId = params.sessionId;
			return typeof relatedId === "string" && this.isDescendantOf(relatedId, sessionId);
		});
	}
	/**
	* Shut the runtime down and reap it: a best-effort protocol `shutdown`
	* bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
	* SIGKILL ladder until the process actually exited. Idempotent.
	* @returns settlement of the complete teardown.
	*/
	close() {
		this.closeTask ??= this.performClose();
		return this.closeTask;
	}
	async performClose() {
		this.abortUserQuestions(new TransportClosedError("SDK client is closing"));
		const child = this.child;
		if (child === void 0) return;
		try {
			await this.request("shutdown", void 0, this.runtime.shutdownTimeoutMs ?? 1e3);
		} catch (error) {
			this.appendStderr([`shutdown request failed: ${errorMessage(error)}`]);
		}
		await disposeRuntimeProcess(child, {
			disposeEofGraceMs: this.runtime.disposeEofGraceMs ?? 6e3,
			disposeGraceMs: this.runtime.disposeGraceMs ?? 3e3
		});
		this.transport?.close();
		this.failSubscriptions(this.closedError("DeepSeek Harness runtime closed"));
	}
	dispatchNotification(notification) {
		this.recordSessionRelationship(notification);
		for (const subscription of this.subscriptions.values()) subscription.push(notification);
	}
	recordSessionRelationship(notification) {
		if (notification.method !== "subagent.started") return;
		const parentId = notification.params.parentSessionId;
		const childId = notification.params.childSessionId;
		if (typeof parentId === "string" && parentId !== "" && typeof childId === "string" && childId !== "" && parentId !== childId) this.sessionParents.set(childId, parentId);
	}
	isDescendantOf(sessionId, rootSessionId) {
		const visited = /* @__PURE__ */ new Set();
		let current = sessionId;
		while (!visited.has(current)) {
			if (current === rootSessionId) return true;
			visited.add(current);
			const parent = this.sessionParents.get(current);
			if (parent === void 0) return false;
			current = parent;
		}
		/* v8 ignore next */
		return false;
	}
	failSubscriptions(error) {
		this.abortUserQuestions(error);
		for (const subscription of this.subscriptions.values()) subscription.fail(error);
	}
	abortUserQuestions(error) {
		for (const controller of this.userQuestions.values()) controller.abort(error);
	}
	appendStderr(lines) {
		const kept = lines.filter((line) => line.length > 0);
		this.stderrTail.push(...kept);
		if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT);
	}
	settleStreams() {
		return Promise.race([this.streamsSettled, new Promise((resolve) => {
			setTimeout(resolve, STREAM_SETTLE_MS);
		})]);
	}
	closedError(reason) {
		const parts = [`${this.runtime.description}: ${reason}`];
		if (this.spawnError !== void 0) parts.push(`spawn error: ${this.spawnError.message}`);
		if (this.exitCode !== void 0) parts.push(`exit code: ${String(this.exitCode)}`);
		if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join("\n")}`);
		return new TransportClosedError(parts.join("\n"));
	}
};
/** Construct the transport against a generic process for package-local fake-runtime tests. */
function createProcessHarnessClient(options) {
	return new HarnessClient({}, options);
}
/**
* Send routed input for the package's high-level run API; absent from the package exports.
* @param client - client owning the initialized runtime connection.
* @param sessionId - target Session; an unknown id creates it.
* @param input - text or content blocks, without client-side command interpretation.
* @returns the validated prompt receipt or native command execution.
*/
async function queryInput(client, sessionId, input, route) {
	const params = {
		sessionId: SessionId(sessionId),
		contentBlocks: normalizeInput(input),
		...route
	};
	const value = await client.request("session/query", params);
	if (isRecord(value)) {
		if (value.kind === "prompt" && typeof value.messageId === "string" && value.messageId.length > 0) return {
			kind: "prompt",
			messageId: value.messageId
		};
		if (value.kind === "command") return {
			kind: "command",
			execution: commandExecution(value.execution)
		};
	}
	throw new SdkProtocolError(`session/query returned an invalid routing result: ${JSON.stringify(value)}`);
}
/**
* Normalize routed input: a string becomes one text block; blocks pass verbatim.
* @param input - prompt or command text, or content blocks.
* @returns the content blocks to send.
*/
function normalizeInput(input) {
	return typeof input === "string" ? [{
		type: "text",
		text: input
	}] : input;
}
/**
* Whether `value` is a plain JSON object (the wire-boundary shape probe).
* @param value - the wire value to probe.
* @returns `true` iff `value` is a non-null, non-array object.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Decode the native handler result returned by session/query. */
function commandExecution(value) {
	if (isRecord(value) && typeof value.commandId === "string" && value.commandId.length > 0 && isRecord(value.result)) {
		const commandId = value.commandId;
		const { kind, text, sourceEventSeq } = value.result;
		if (kind === "success" && (text === void 0 || typeof text === "string") && (sourceEventSeq === void 0 || typeof sourceEventSeq === "number" && Number.isSafeInteger(sourceEventSeq) && sourceEventSeq >= 0)) return {
			commandId,
			result: {
				kind,
				...text === void 0 ? {} : { text },
				...sourceEventSeq === void 0 ? {} : { sourceEventSeq: SessionSeq(sourceEventSeq) }
			}
		};
		if (kind === "error" && typeof text === "string" && text.trim().length > 0) return {
			commandId,
			result: {
				kind,
				text
			}
		};
	}
	throw new SdkProtocolError(`session/query returned an invalid command result: ${JSON.stringify(value)}`);
}
/** The message of a thrown value (the transport only throws `Error`s; `String` covers the rest). */
function errorMessage(error) {
	/* v8 ignore next -- the transport and dispose ladder reject only with Errors */
	return error instanceof Error ? error.message : String(error);
}
/** Check the question envelope before handing runtime input to application code. */
function isUserQuestionRequest(value) {
	return isRecord(value) && typeof value.requestId === "string" && value.requestId.length > 0 && typeof value.sessionId === "string" && Array.isArray(value.questions) && value.questions.length > 0 && value.questions.every((question) => isRecord(question) && typeof question.id === "string" && typeof question.question === "string");
}
//#endregion
export { HarnessClient, RequestTimeoutError, SdkProtocolError, TransportClosedError, createProcessHarnessClient, isRecord, normalizeInput, queryInput };

//# sourceMappingURL=client.mjs.map