// TODO: I don't know what the payload looks like, so I'm just going to assume it's a Railway payload
interface RailwayPayload {
	type: string;
	timestamp: string;
	project: {
		id: string;
		name: string;
	};
}

// TODO: What shall we send to the worker from Payload?
interface PayloadCMSPayload {
	collection: string;
	docId: string;
	timestamp: string;
}

const DEBOUNCE_DELAY = 30_000; // 30 seconds
const DEBOUNCE_KEY = 'content_update_debounce';

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		const url = new URL(request.url);

		switch (url.pathname) {
			case '/railway-webhook':
				return await handleRailwayWebhook(request, env);
			case '/payload-webhook':
				return await handlePayloadWebhook(request, env);
			case '/cron-rebuild':
				return await handleScheduledRebuilds(env);
			default:
				return new Response('Not found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRailwayWebhook(request: Request, env: Env) {
	try {
		const payload = await request.json();

		if (!validateRailwayWebhook(env, payload)) {
			return new Response('Unauthorized', { status: 401 });
		}

		await dispatchGitHubAction({
			env,
			eventType: 'railway_deploy',
			clientPayload: {
				projectId: payload.project.id,
			},
		});

		return Response.json({
			success: true,
			message: 'Railway deployment rebuild triggered',
		});
	} catch (_error) {
		return new Response('Internal Server Error', { status: 500 });
	}
}

async function handlePayloadWebhook(request: Request, env: Env) {
	try {
		const payload = await request.json();

		if (!validatePayloadWebhook(env, payload, request.headers)) {
			return new Response('Unauthorized', { status: 401 });
		}

		const shouldTrigger = await handleContentUpdateDebounce(env, payload);

		if (shouldTrigger) {
			await dispatchGitHubAction({
				env,
				eventType: 'content_update',
				clientPayload: {
					collection: payload.collection,
					docId: payload.docId,
					timestamp: new Date().toISOString(),
				},
			});

			return Response.json({
				success: true,
				message: 'Content update rebuild triggered',
			});
		}

		return Response.json({
			success: true,
			message: 'Content update queued (debounced)',
		});
	} catch (_error) {
		return new Response('Internal Server Error', { status: 500 });
	}
}

async function dispatchGitHubAction({ env, eventType, clientPayload }: { env: Env; eventType: string; clientPayload: unknown }) {
	const githubToken = await env.GITHUB_TOKEN.get();

	if (!githubToken) {
		console.log('Missing GitHub token');
		throw new Error('Missing GitHub token');
	}

	const githubRepo = env.GITHUB_REPO;

	if (!githubRepo) {
		console.log('Missing GitHub repository');
		throw new Error('Missing GitHub repository');
	}

	const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${githubToken}`,
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'cloudflare-workers',
		},
		body: JSON.stringify({
			event_type: eventType,
			client_payload: clientPayload,
		}),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
	}

	return response;
}

function validateRailwayWebhook(env: Env, payload: unknown): payload is RailwayPayload {
	if (payload && typeof payload === 'object' && 'project' in payload) {
		const { project } = payload;

		if (project && typeof project === 'object' && 'id' in project) {
			return project.id === env.RAILWAY_PROJECT_ID;
		}
	}

	return false;
}

function validatePayloadWebhook(env: Env, payload: unknown, headers: Headers): payload is PayloadCMSPayload {
	const secret = headers.get('X-Payload-Secret');

	if (!secret) {
		return false;
	}

	if (secret !== env.PAYLOAD_SECRET) {
		return false;
	}

	if (payload && typeof payload === 'object' && 'collection' in payload && 'docId' in payload && 'timestamp' in payload) {
		return true;
	}
	return false;
}

async function handleContentUpdateDebounce(env: Env, payload: PayloadCMSPayload) {
	const currentDebounce = await env.ZILANG_REBUILD.get<{ lastUpdate: number; pendingChanges: PayloadCMSPayload[] }>(DEBOUNCE_KEY, 'json');
	const now = Date.now();

	const newDebounce = {
		lastUpdate: now,
		pendingChanges: [
			...(currentDebounce?.pendingChanges || []),
			{
				collection: payload.collection,
				docId: payload.docId,
				timestamp: now,
			} as PayloadCMSPayload & { timestamp: number },
		],
	};

	await env.ZILANG_REBUILD.put(DEBOUNCE_KEY, JSON.stringify(newDebounce), {
		expirationTtl: Math.ceil(DEBOUNCE_DELAY / 1000) + 60, // Extra buffer
	});

	if (!currentDebounce || now - currentDebounce.lastUpdate > DEBOUNCE_DELAY) {
		await scheduleDelayedRebuild(env, DEBOUNCE_DELAY);
		return false;
	}

	return false;
}

async function scheduleDelayedRebuild(env: Env, delay: number) {
	const triggerTime = Date.now() + delay;
	await env.ZILANG_REBUILD.put(
		'scheduled_rebuild',
		JSON.stringify({
			triggerTime,
			type: 'content_update',
		}),
		{
			expirationTtl: Math.ceil(delay / 1000) + 300, // 5 min buffer
		}
	);
}

async function handleScheduledRebuilds(env: Env) {
	const scheduled = await env.ZILANG_REBUILD.get<{ triggerTime: number; type: string }>('scheduled_rebuild', 'json');

	if (scheduled && Date.now() >= scheduled.triggerTime) {
		const debounceData = await env.ZILANG_REBUILD.get<{ pendingChanges: PayloadCMSPayload[] }>('content_update_debounce', 'json');

		if (debounceData && debounceData.pendingChanges.length > 0) {
			await dispatchGitHubAction({
				env,
				eventType: 'content_update',
				clientPayload: {
					batchedChanges: debounceData.pendingChanges,
					totalChanges: debounceData.pendingChanges.length,
					timestamp: new Date().toISOString(),
				},
			});

			await env.ZILANG_REBUILD.delete('content_update_debounce');
			await env.ZILANG_REBUILD.delete('scheduled_rebuild');

			return Response.json({
				success: true,
				message: 'Scheduled rebuild triggered',
			});
		}
	}

	return Response.json({
		success: true,
		message: 'No scheduled rebuild needed',
	});
}

export { handleScheduledRebuilds };
