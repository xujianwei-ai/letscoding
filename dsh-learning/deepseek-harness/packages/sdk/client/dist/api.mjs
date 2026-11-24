import { HarnessClient, SdkProtocolError, createProcessHarnessClient, isRecord, queryInput } from "./client.mjs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
//#region lib/types/api.js
/**
* High-level run API over {@link HarnessClient}: route text to prompts or native
* commands and collect prompt activity for text and image input.
*
* @module @deepseek-ai/dsh-sdk-client/api
*/
/**
* Reusable SDK for running DeepSeek Harness agent turns in a runtime
* subprocess. The subprocess starts lazily on first use and stays owned by
* this instance until {@link close}; always close (or `await using`) so the
* child is reaped.
*/
var DeepSeekHarness = class {
	clientInstance;
	createClient;
	cwd;
	provider;
	model;
	reasoningEffort;
	maxTokens;
	approvalRequests;
	initialized;
	closed = false;
	constructor(options = {}, clientFactory) {
		this.createClient = clientFactory ?? (() => new HarnessClient(options));
		this.clientInstance = this.createClient();
		this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd());
		this.provider = options.provider ?? "deepseek-official";
		this.model = options.model ?? "deepseek-v4-flash";
		this.reasoningEffort = options.reasoningEffort;
		this.maxTokens = options.maxTokens;
		this.approvalRequests = options.approvalRequests;
	}
	/**
	* The underlying JSON-RPC client (exposed for low-level access). A failed
	* handshake swaps in a fresh instance only after cleanup proves the runtime
	* exited; cleanup failure retains this client, so do not cache it across a
	* failed {@link start}.
	* @returns the client currently owning the runtime subprocess.
	*/
	get client() {
		return this.clientInstance;
	}
	/**
	* Start the subprocess and perform the `initialize` handshake once. On
	* failure, successful SDK-owned cleanup reaps the runtime and installs a
	* fresh client (`HarnessClient.close` is permanent), so a later call retries
	* with a new subprocess unless {@link close} already ended this harness. If
	* cleanup also fails, rejects with an `AggregateError` whose ordered errors
	* preserve both causes and retains the failed client rather than spawning
	* alongside a process whose exit was not proved.
	* @returns settlement of the (memoized) handshake.
	*/
	start() {
		this.initialized ??= (async () => {
			try {
				this.clientInstance.start();
				await this.clientInstance.initialize({
					cwd: this.cwd,
					provider: this.provider,
					model: this.model,
					...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
					...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens },
					...this.approvalRequests === void 0 ? {} : { approvalRequests: this.approvalRequests }
				});
			} catch (error) {
				this.initialized = void 0;
				try {
					await this.clientInstance.close();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "DeepSeek Harness initialization and cleanup failed");
				}
				if (!this.closed) this.clientInstance = this.createClient();
				throw error;
			}
		})();
		return this.initialized;
	}
	/**
	* Open a session handle (no wire traffic; the runtime creates the session
	* on its first prompt or working-directory operation).
	* @param sessionId - explicit id to reuse; omitted mints a fresh one.
	* @returns the session handle.
	*/
	session(sessionId) {
		return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll("-", "")}`);
	}
	/**
	* Start the runtime and restore a persisted session without sending input.
	* The configured Harness home must contain its history; missing or occupied sessions reject.
	* @param sessionId - exact persisted identity to continue.
	* @returns a handle ready to run new prompts on the restored history.
	*/
	async resumeSession(sessionId) {
		await this.start();
		await this.client.resumeSession(sessionId);
		return new HarnessSession(this, sessionId);
	}
	/** Discover advertised provider models without changing the configured Agent route. */
	async listModels() {
		await this.start();
		return this.client.listModels();
	}
	/** Read root Sessions created under this Harness workspace without resuming them. */
	async listSessions(limit) {
		await this.start();
		return this.client.listSessions(this.cwd, limit);
	}
	/** Create a real child Session containing the source through an exact event boundary. */
	async forkSession(sessionId, atSeq) {
		await this.start();
		return this.client.forkSession(sessionId, this.cwd, atSeq);
	}
	/** Read one workspace Session's persisted event log without opening it for new work. */
	async sessionHistory(sessionId) {
		await this.start();
		return this.client.sessionHistory(sessionId, this.cwd);
	}
	/**
	* Run text or content blocks on a fresh or named Session through native input routing.
	* @param input - prompt or command text, optionally accompanied by image content blocks.
	* @param options - optional Session identity and notification observer.
	* @returns the completed input's RunResult, including its Session id.
	*/
	run(input, options) {
		return this.session(options?.sessionId).run(input, options);
	}
	/**
	* Shut down and reap the runtime subprocess. Idempotent and terminal —
	* a closed harness no longer retries a failed handshake.
	* @returns settlement of the complete teardown.
	*/
	close() {
		this.closed = true;
		return this.clientInstance.close();
	}
	/**
	* `await using` support: {@link close}.
	* @returns settlement of the teardown.
	*/
	[Symbol.asyncDispose]() {
		return this.close();
	}
};
/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
function createProcessDeepSeekHarness(runtime, options = {}) {
	return new DeepSeekHarness({
		...runtime.cwd === void 0 ? {} : { processCwd: runtime.cwd },
		...options
	}, () => createProcessHarnessClient(runtime));
}
/** Collect one input's root events and Session-tree notifications from its admission. */
var RunActivity = class {
	sessionId;
	receipt;
	commandDone = false;
	received = false;
	events = [];
	notifications = [];
	constructor(sessionId, receipt) {
		this.sessionId = sessionId;
		this.receipt = receipt;
	}
	/** Ignore pre-receipt traffic; validate root events before invoking the observer. */
	record(notification, onNotification) {
		if (notification.method === "session.query.completed") return false;
		if (!this.received) {
			if (notification.method !== "session.event" || notification.params.sessionId !== this.sessionId || !this.matchesReceipt(notification.params.event)) return false;
			this.received = true;
		}
		const event = notification.method === "session.event" && notification.params.sessionId === this.sessionId ? validatedSessionEvent(notification.params.event) : void 0;
		if (event?.type === "command/done" && "commandId" in this.receipt && isRecord(event.data) && event.data.commandId === this.receipt.commandId) this.commandDone = true;
		this.notifications.push(notification);
		onNotification?.(notification);
		if (event !== void 0) this.events.push(event);
		return true;
	}
	matchesReceipt(event) {
		return "messageId" in this.receipt ? isInboxReceipt(event, this.receipt.messageId) : isRecord(event) && event.type === "command/run" && isRecord(event.data) && event.data.commandId === this.receipt.commandId;
	}
	result(completed) {
		if (completed !== void 0 && !this.commandDone) throw new SdkProtocolError("Command completion is missing matching lifecycle events");
		const terminal = this.events.findLast((event) => event.type === "turn/end");
		return {
			sessionId: this.sessionId,
			finalResponse: completed?.finalResponse ?? finalResponse(this.events),
			finishReason: completed?.finishReason ?? terminal?.data.reason.kind ?? null,
			events: this.events,
			notifications: this.notifications
		};
	}
};
/**
* One SDK session: a stable id plus owned activity intervals.
*/
var HarnessSession = class {
	harness;
	id;
	/**
	* @param harness - the owning harness (supplies the client and handshake).
	* @param id - the wire session id this handle runs on.
	*/
	constructor(harness, id) {
		this.harness = harness;
		this.id = id;
	}
	/**
	* Read the effective directory and recover a missing directory to the Session origin.
	* @returns the absolute directory used by new independent operations.
	*/
	async getWorkingDirectory() {
		await this.harness.start();
		return this.harness.client.getWorkingDirectory(this.id);
	}
	/**
	* Change the effective directory without moving existing processes or changing permissions.
	* @param path - absolute or Session-current-directory-relative directory.
	* @returns the validated absolute directory.
	*/
	async setWorkingDirectory(path) {
		await this.harness.start();
		return this.harness.client.setWorkingDirectory(this.id, path);
	}
	/**
	* Run text or content blocks through native prompt-or-command routing.
	* @param input - prompt or command text, optionally accompanied by image content blocks; image-only input is an ordinary prompt.
	* @param options - a per-notification observer.
	* @returns RunResult after prompt activity, a state-only command, or command-started model work ends.
	* Goal creation and resume include automatic rounds through goal termination and the closing reply.
	* Native handler refusals return finishReason="error".
	* @throws on routing, protocol, transport or observer failure; runtime work is not rolled back.
	*/
	async run(input, options) {
		await this.harness.start();
		const client = this.harness.client;
		const subscription = client.subscribeSessionTree(this.id);
		try {
			const response = await queryInput(client, this.id, input, options?.route);
			if (response.kind === "command") {
				const activity = new RunActivity(this.id, { commandId: response.execution.commandId });
				while (true) {
					const notification = await subscription.next();
					const params = notification.params;
					if (notification.method === "session.query.completed" && params.sessionId === this.id) {
						if (typeof params.commandId !== "string" || params.commandId.length === 0) throw new SdkProtocolError("Invalid session.query.completed command identity");
						if (params.commandId !== response.execution.commandId) continue;
						if (typeof params.finalResponse !== "string" || typeof params.finishReason !== "string" || params.finishReason.length === 0) throw new SdkProtocolError("Invalid session.query.completed result");
						while (!activity.commandDone) {
							const queued = subscription.tryNext();
							if (queued === void 0) break;
							activity.record(queued, options?.onNotification);
						}
						return activity.result({
							finalResponse: params.finalResponse,
							finishReason: params.finishReason
						});
					}
					activity.record(notification, options?.onNotification);
				}
			}
			const activity = new RunActivity(this.id, { messageId: response.messageId });
			while (true) {
				const notification = await subscription.next();
				if (!activity.record(notification, options?.onNotification)) continue;
				if (notification.method === "session.status" && notification.params.sessionId === this.id && notification.params.status === "idle") break;
			}
			return activity.result();
		} finally {
			subscription.close();
		}
	}
	/** Restore this idle Session to an exclusive event prefix, retaining its identity. */
	async rewind(beforeSeq) {
		await this.harness.start();
		await this.harness.client.rewindSession(this.id, beforeSeq);
	}
};
/** Validate the provider-read fields of one wire turn-end reason. */
function validatedTurnEndReason(value) {
	if (!isRecord(value) || typeof value.kind !== "string") throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`);
	if (value.kind === "aborted") {
		if (!isRecord(value.reason) || typeof value.reason.kind !== "string") throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`);
		switch (value.reason.kind) {
			case "user":
			case "parent":
			case "disposed":
			case "legacy": break;
			case "hook":
				if (typeof value.reason.reason !== "string") throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`);
				break;
			default: throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`);
		}
	}
	return value;
}
/**
* Validate the event envelope and assistant/turn fields consumed by SDK readers.
* @param value - the raw `session.event` event payload.
* @returns the event, or throws a protocol error for malformed consumed fields.
*/
function validatedSessionEvent(value) {
	if (!isRecord(value) || typeof value.type !== "string") throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`);
	if (value.type === "assistant/message") {
		const message = isRecord(value.data) ? value.data.message : void 0;
		const content = isRecord(message) ? message.content : void 0;
		if (!Array.isArray(content) || !content.every((block) => isRecord(block) && typeof block.type === "string")) throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`);
	}
	if (value.type === "turn/end") {
		const data = isRecord(value.data) ? value.data : void 0;
		if (data === void 0) throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`);
		validatedTurnEndReason(data.reason);
	}
	return value;
}
/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value, messageId) {
	if (!isRecord(value) || value.type !== "agent/inbox/spliced" || !isRecord(value.data)) return false;
	const inserted = value.data.inserted;
	return Array.isArray(inserted) && inserted.some((message) => isRecord(message) && message.id === messageId);
}
/**
* Extract the concatenated text of the last assistant message.
* @param events - the activity interval's `session.event` payloads in wire order.
* @returns the final response text, or `''` when no assistant message exists.
*/
function finalResponse(events) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event?.type !== "assistant/message") continue;
		return event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	}
	return "";
}
//#endregion
export { DeepSeekHarness, HarnessSession, createProcessDeepSeekHarness, finalResponse, validatedSessionEvent };

//# sourceMappingURL=api.mjs.map