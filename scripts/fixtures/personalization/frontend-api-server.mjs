#!/usr/bin/env node
/**
 * API-only fixture for the real bundled Svelte frontend.
 *
 * Static files and every HTML page come from the verified frontend bundle.
 * This process never substitutes application HTML.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
const port = Number(process.env.FIXTURE_PORT || 8765);
const origin = `http://127.0.0.1:${port}`;
const startedAt = Date.now();
const events = [];
const upgradedSockets = new Set();

if (!root || !statSync(root).isDirectory()) {
	console.error('Usage: node frontend-api-server.mjs <verified-frontend-directory>');
	process.exit(2);
}

const manifestBytes = await readFile(path.join(root, 'frontend-manifest.json'));
const manifest = JSON.parse(manifestBytes);
const manifestRoot = path.resolve(root);
const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
const files = new Map(manifest.files.map((file) => [file.path, file]));
const routes = manifest.pageRoutes.map((pattern) => new RegExp(pattern));

const now = Math.floor(Date.now() / 1000);
const userId = 'fixture-user';
const assistantId = 'fixture-assistant';
const conversationId = 'layout-fixture';
const socketSid = 'fixture-socket';

const longParagraph =
	'这是一段用于验证手机布局的长文本。它包含中文、English words、较长的不可拆分标识符以及足够多的内容，用来确认助手卡片会在可用宽度内换行，正文、表格和代码不会把页面整体推向右侧，同时卡片标题和操作按钮仍保持可触达。'.repeat(
		3
	);

const messages = {
	'fixture-user-message': {
		id: 'fixture-user-message',
		parentId: null,
		childrenIds: [assistantId],
		role: 'user',
		content:
			'请检查移动端长消息、代码块、表格、操作按钮和输入框是否都完整落在视口内。',
		timestamp: now - 80,
		models: ['fixture-model'],
		done: true
	},
	[assistantId]: {
		id: assistantId,
		parentId: 'fixture-user-message',
		childrenIds: [],
		role: 'assistant',
		content: `${longParagraph}\n\n| 组件 | 检查项 | 状态 |\n| --- | --- | --- |\n| 消息卡片 | 不越过右边界 | 通过 |\n| 输入框 | 固定且可操作 | 通过 |\n| 表格 | 只在自身容器内滚动 | 通过 |\n\n\`\`\`bash\nkubectl port-forward pod/mypod 18080:8080\ncurl -v http://127.0.0.1:18080/healthz\n\`\`\`\n\n${longParagraph}`,
		timestamp: now - 60,
		model: 'fixture-model',
		modelName: 'Fixture model',
		modelIdx: 0,
		done: true,
		usage: { prompt_tokens: 80, completion_tokens: 240, total_tokens: 320 }
	}
};

const chat = {
	id: conversationId,
	user_id: userId,
	title: '安卓布局专项验收',
	created_at: now - 120,
	updated_at: now - 60,
	currentId: assistantId,
	chat: {
		id: conversationId,
		user_id: userId,
		title: '安卓布局专项验收',
		models: ['fixture-model'],
		params: {},
		history: { messages, currentId: assistantId },
		tags: [],
		timestamp: now - 120,
		files: []
	},
	last_read_at: now - 60,
	active: true,
	folder_id: null,
	tags: []
};

const config = {
	status: true,
	name: 'Fixture Open WebUI',
	version: '0.12.2',
	default_locale: 'zh-CN',
	features: {
		enable_signup: false,
		enable_login_form: true,
		enable_websocket: true,
		enable_direct_connections: false,
		enable_tool_servers: false,
		enable_notes: false,
		enable_channels: false,
		enable_folders: false,
		enable_automations: false,
		enable_calendar: false,
		enable_version_update_check: false,
		enable_admin_analytics: false
	},
	oauth: { providers: {} },
	ui: { default_interface_settings: {} },
	permissions: {},
	audio: {},
	file: { max_size: 20 * 1024 * 1024, max_count: 4 },
	metadata: {}
};

const user = {
	id: userId,
	name: 'Fixture User',
	email: 'fixture@example.invalid',
	role: 'admin',
	token: 'fixture-token',
	profile_image_url: '/static/favicon.png',
	permissions: {
		features: {
			notes: false,
			channels: false,
			folders: false,
			direct_tool_servers: false
		},
		workspace: { models: true, knowledge: true, prompts: true, tools: false },
		chat: { temporary_enforced: false }
	}
};

const model = {
	id: 'fixture-model',
	name: 'Fixture model',
	object: 'model',
	owned_by: 'fixture',
	created: now,
	info: { id: 'fixture-model', meta: { capabilities: { status_updates: true } } }
};

const usage = {
	totals: {
		lifetime_tokens: 320,
		input_tokens: 80,
		output_tokens: 240,
		peak_daily_tokens: 320,
		longest_chat_seconds: 60,
		current_streak: 1,
		longest_streak: 1,
		total_chats: 1,
		active_days: 1,
		models_used: 1,
		messages: 2,
		user_messages: 1,
		assistant_messages: 1
	},
	heatmap: [],
	weekly_heatmap: [],
	cumulative_heatmap: [],
	insights: {
		most_used_model: 'fixture-model',
		average_tokens_per_chat: 320,
		average_messages_per_active_day: 2,
		user_message_share: 50,
		assistant_message_share: 50
	},
	top_models: [
		{
			model_id: 'fixture-model',
			messages: 2,
			input_tokens: 80,
			output_tokens: 240,
			total_tokens: 320
		}
	],
	top_tools: [],
	period: { start_date: now - 86_400, end_date: now, days: 1 }
};

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
	const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
	response.writeHead(status, {
		'Content-Type': contentType,
		'Content-Length': bytes.length,
		'Cache-Control': 'no-store',
		'X-Fixture-Frontend-Commit': manifest.sourceCommit
	});
	response.end(bytes);
}

function event(kind, details = {}) {
	events.push({ kind, elapsed: Date.now() - startedAt, ...details });
	if (events.length > 500) events.splice(0, events.length - 500);
}

function api(pathname) {
	if (pathname === '/api/config') return config;
	if (pathname === '/api/version') return { version: '0.12.2', deployment_id: 'fixture' };
	if (pathname === '/api/v1/auths/') return user;
	if (pathname === '/api/v1/users/user/settings') {
		return {
			ui: { theme: 'light', chatDirection: 'ltr' },
			keybindings: {}
		};
	}
	if (pathname === '/api/models') {
		return { object: 'list', data: [model] };
	}
	if (pathname === '/api/usage') return usage;
	if (pathname === '/api/v1/tools/') return [];
	if (pathname === '/api/v1/configs/banners') return [];
	if (pathname === '/api/v1/skills/') return [];
	if (pathname === '/api/v1/terminals/') return [];
	if (pathname === '/api/v1/chats/') return [chat];
	if (pathname === `/api/v1/chats/${conversationId}`) return chat;
	if (pathname === `/api/v1/chats/${conversationId}/tags`) return [];
	if (pathname === `/api/v1/chats/${conversationId}/messages/fixture-assistant`) {
		return {
			id: 'fixture-assistant',
			role: 'assistant',
			content: messages[assistantId].content,
			done: true
		};
	}
	if (pathname === '/api/v1/chats/pinned') return [];
	if (pathname === '/api/v1/folders/') return [];
	if (pathname === '/api/v1/channels/') return [];
	if (pathname === '/api/v1/notes/pinned') return [];
	if (pathname === '/api/version/updates') return { current: '0.12.2', latest: '0.12.2' };
	if (pathname === '/api/models/default') {
		return { model: 'fixture-model', params: {} };
	}
	if (pathname === '/api/v1/models/model/profile/image') return Buffer.alloc(0);
	if (pathname.startsWith('/api/v1/users/user/status')) {
		return { status: 'online', last_active_at: now };
	}
	return undefined;
}

function staticFile(pathname) {
	const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
	if (!clean || clean.includes('..') || clean.includes('\\')) return null;
	const record = files.get(clean);
	if (!record) return null;
	const filename = path.resolve(manifestRoot, clean);
	if (!filename.startsWith(`${manifestRoot}${path.sep}`)) return null;
	return { filename, record };
}

function isPage(pathname) {
	return routes.some((route) => route.test(pathname));
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', origin);
	try {
		if (request.method === 'POST' && url.pathname === '/api/v1/auths/signin') {
			send(response, 200, user);
			return;
		}
		if (
			request.method === 'POST' &&
			url.pathname === '/api/v1/users/user/settings/update'
		) {
			send(response, 200, { ui: { theme: 'light' } });
			return;
		}
		if (request.method === 'POST' && url.pathname === '/api/v1/users/user/status/update') {
			send(response, 200, { status: 'online', last_active_at: now });
			return;
		}
		if (request.method === 'POST' && url.pathname === '/__fixture_state') {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			try {
				event('page-state', JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				event('page-state-invalid');
			}
			send(response, 204, '');
			return;
		}
		if (request.method === 'GET' && url.pathname === '/__fixture_provenance') {
			send(response, 200, {
				schema: 1,
				sourceCommit: manifest.sourceCommit,
				manifestSha256Digest: manifestDigest,
				entry: manifest.entry,
				routes: manifest.pageRoutes.length,
				files: manifest.files.length,
				events
			});
			return;
		}

		const body = api(url.pathname);
		if (body !== undefined) {
			event('api', { path: url.pathname });
			send(response, 200, body);
			return;
		}

		if (url.pathname.startsWith('/static/')) {
			const file = staticFile(url.pathname);
			if (file) {
				event('static', { path: url.pathname });
				response.writeHead(200, {
					'Content-Type': file.record.mime,
					'Content-Length': file.record.size,
					'Cache-Control': 'no-store'
				});
				createReadStream(file.filename).pipe(response);
				return;
			}
		}

		if (url.pathname === '/ws/socket.io/' || url.pathname === '/ws/socket.io') {
			send(response, 404, { detail: 'Polling transport is not enabled in the fixture' });
			return;
		}

		const asset = staticFile(url.pathname);
		if (asset) {
			response.writeHead(200, {
				'Content-Type': asset.record.mime,
				'Content-Length': asset.record.size,
				'Cache-Control': 'no-store',
				'X-OWC-Frontend-Commit': manifest.sourceCommit
			});
			createReadStream(asset.filename).pipe(response);
			return;
		}

		if (isPage(url.pathname)) {
			event('page', { path: url.pathname });
			const entry = files.get(manifest.entry);
			response.writeHead(200, {
				'Content-Type': entry.mime,
				'Content-Length': entry.size,
				'Cache-Control': 'no-store',
				'X-OWC-Frontend-Commit': manifest.sourceCommit
			});
			createReadStream(path.join(manifestRoot, manifest.entry)).pipe(response);
			return;
		}
		send(response, 404, { detail: 'Not found' });
	} catch (error) {
		event('server-error', { message: String(error) });
		send(response, 500, { detail: 'Fixture failure' });
	}
});

server.on('upgrade', (request, socket) => {
	upgradedSockets.add(socket);
	const requestUrl = new URL(request.url || '/', origin);
	if (requestUrl.pathname !== '/ws/socket.io/') {
		socket.destroy();
		return;
	}
	const key = request.headers['sec-websocket-key'];
	if (typeof key !== 'string') {
		socket.destroy();
		return;
	}
	const accept = createHash('sha1')
		.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest('base64');
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
	);
	event('socket-open', { path: requestUrl.pathname });
	const sendText = (message) => {
		const payload = Buffer.from(message);
		const header =
			payload.length < 126
				? Buffer.from([0x81, payload.length])
				: Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
		socket.write(Buffer.concat([header, payload]));
	};
	sendText(
		`0${JSON.stringify({
			sid: socketSid,
			upgrades: [],
			pingInterval: 25_000,
			pingTimeout: 20_000,
			maxPayload: 1_000_000
		})}`
	);
	socket.on('data', (chunk) => {
		if (chunk[0] === 0x88) {
			socket.end(Buffer.from([0x88, 0]));
			return;
		}
		if ((chunk[0] & 0x0f) === 0x1) {
			const masked = Boolean(chunk[1] & 0x80);
			let length = chunk[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				length = chunk.readUInt16BE(offset);
				offset += 2;
			}
			const mask = masked ? chunk.subarray(offset, offset + 4) : null;
			if (masked) offset += 4;
			const payload = Buffer.from(chunk.subarray(offset, offset + length));
			if (mask) {
				for (let index = 0; index < payload.length; index += 1) {
					payload[index] ^= mask[index % 4];
				}
			}
			const frame = payload.toString('utf8');
			if (frame === '2') {
				sendText('3');
			} else if (frame === '40') {
				sendText(`40${JSON.stringify({ sid: socketSid })}`);
			}
		}
	});
	socket.on('close', () => {
		upgradedSockets.delete(socket);
		event('socket-close');
	});
	socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
	console.log(
		JSON.stringify({
			origin,
			frontendRoot: root,
			sourceCommit: manifest.sourceCommit,
			manifestSha256: manifestDigest,
			files: manifest.files.length
		})
	);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		for (const socket of upgradedSockets) socket.destroy();
		server.closeAllConnections();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 250).unref();
	});
}
