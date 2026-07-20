// Minimal fake AWS SDK v3 module used to drive the real-import branch of
// resolveAwsSdkClient without installing an @aws-sdk/* package. It exports a
// Client with a `.send()` surface and Command constructors named exactly like
// the SDK convention (`<Method>Command`).

export class Client {
	/** @param {Record<string, unknown>} [options] */
	constructor(options) {
		this.options = options;
		/** @type {unknown[]} */
		this.sent = [];
	}
	/** @param {{ name?: string; input?: unknown }} command */
	async send(command) {
		this.sent.push(command);
		return { echoed: command.input, commandName: command.name, viaClient: true };
	}
}

export class PutObjectCommand {
	/** @param {unknown} input */
	constructor(input) {
		this.input = input;
		this.name = "PutObjectCommand";
	}
}

export class GetObjectCommand {
	/** @param {unknown} input */
	constructor(input) {
		this.input = input;
		this.name = "GetObjectCommand";
	}
}
