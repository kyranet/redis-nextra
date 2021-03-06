const EventEmitter = require('events');
const net = require('net');
const hiredis = require('hiredis');

class Connection extends EventEmitter {

	/**
	 * @param {RedisClient} client The client in which Redis-nextra got initialized.
	 * @param {Host} host The host object to connect with.
	 * @param {ServerConnectionOptions} options The options for the server connection.
	 */
	constructor(client, host, options = {}) {
		super();

		/**
		 * The client in which Redis-nextra got initialized with.
		 * @type {RedisClient}
		 */
		this.client = client;

		/**
		 * @type {Host}
		 */
		this.host = host;

		/**
		 * @type {number}
		 */
		this.retryDelay = options.retryDelay || 2000;

		/**
		 * @type {boolean}
		 */
		this.socketNoDelay = typeof options.socketNoDelay === 'undefined' ? true : !!options.socketNoDelay;

		/**
		 * @type {boolean}
		 */
		this.socketKeepAlive = typeof options.socketKeepAlive === 'undefined' ? true : !!options.socketKeepAlive;
		this.stream = net.createConnection(this.host.port, this.host.host);
		if (this.socketNoDelay) this.stream.setNoDelay(true);
		this.stream.setKeepAlive(this.socketKeepAlive);
		this.stream.setTimeout(0);

		this.reader = new hiredis.Reader();

		/**
		 * @type {Array<Object|Function>}
		 */
		this.handlers = [];
		this._attachEvents();
	}

	/**
	 * Write data into the connection stream.
	 * @param {string} cmd The name of the command to execute.
	 * @param {(Buffer[]|string[])} pack An array of packages to write.
	 * @param {Object|Function} handler A function of an object containing both Resolve and Reject parameters.
	 */
	write(cmd, pack, handler) {
		this.handlers.push(handler);

		let command = `*${pack.length + 1}\r\n$${cmd.length}\r\n${cmd}\r\n`;

		for (let i = 0; i < pack.length; i++) {
			let item = pack[i];

			if (Buffer.isBuffer(item)) {
				if (command) {
					this.stream.write(command);
					command = '';
				}

				this.stream.write(`$${item.length}\r\n`);
				this.stream.write(item);
				this.stream.write('\r\n');
			} else {
				item = String(item);
				command += `$${Buffer.byteLength(item)}\r\n${item}\r\n`;
			}
		}

		if (command) { this.stream.write(command); }
	}

	/**
	 * Terminate this connection.
	 * @returns {void}
	 */
	end() {
		if (this.ended) { return; }

		this.stream.end();
		this.ended = true;
		this.connected = false;
		this.emit('end');

		clearTimeout(this._retryTimer);
	}

	/**
	 * Attach events to the stream.
	 * @returns {void}
	 * @private
	 */
	_attachEvents() {
		this.stream.on('connect', () => {
			this.connected = true;
			this.emit('connect');
			this.reader = new hiredis.Reader();
		});

		this.stream.on('close', this._connectionLost.bind(this, 'close'));
		this.stream.on('end', this._connectionLost.bind(this, 'end'));
		this.stream.on('error', (msg) => {
			this.client.emit('error', new Error(`redis-nextra connection to ${this.host.string} failed: ${msg}`));
			this._connectionLost('error');
		});

		this.stream.on('data', (data) => {
			this.reader.feed(data);

			let response;
			try {
				response = this.reader.get();
			} catch (err) {
				this.emit('error', `Parser error: ${err.message}`);
				return this.stream.destroy();
			}

			if (response === undefined) { return undefined; }

			const handler = this.handlers.shift();

			if (response && response instanceof Error) return handler.reject(response);
			if (typeof handler === 'function') return handler(null, response);
			return handler.resolve(response);
		});
	}

	/**
	 * Handle the connection losts.
	 * @param {string} reason The reason of why the connection got lost.
	 * @returns {void}
	 * @private
	 */
	_connectionLost(reason) {
		if (this.ended || this.reconnecting) { return; }

		this.connected = false;
		this.reconnecting = true;

		for (const handler of this.handlers) {
			if (typeof handler === 'function') handler(new Error(`Server connection lost to ${this.host.string}`));
			handler.reject(new Error(`Server connection lost to ${this.host.string}`));
		}
		this.handlers = [];

		this.emit('reconnect');
		this.emit('debug', reason);

		this._retryTimer = setTimeout(() => {
			this.reconnecting = false;
			this.stream.connect(this.host.port, this.host.host);
		}, this.retryDelay);
	}

}

module.exports = Connection;
