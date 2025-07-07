/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const PROJECT_REPO_MAPS: Record<string, string> = {
	'd73fee56-5f41-422d-9865-99a3133ae456': 'escwxyz/zilang',
};

// TODO: don't really know what the payload looks like, so we're just going to assume it's a Railway payload
interface RailwayPayload {
	type: string;
	timestamp: string;
	project: {
		id: string;
		name: string;
	};
}

interface Env {
	GITHUB_TOKEN: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		let payload: RailwayPayload;

		try {
			payload = (await request.json()) as RailwayPayload;
		} catch (error) {
			console.log("Invalid payload", error);
			return new Response('Invalid payload', { status: 400 });
		}

		const projectId = payload.project?.id;
	

		if (!projectId) {
			console.log("Missing project ID in payload");
			return new Response("Missing project ID in payload", { status: 400 });
		}

		const repo = PROJECT_REPO_MAPS[projectId];

		if (!repo) {
			console.log(`Project not found: ${projectId}`);
			return new Response('Project not found', { status: 404 });
		}

		const githubToken = env.GITHUB_TOKEN;

		if (!githubToken) {
			console.log("Missing GitHub token");
			return new Response('Missing GitHub token', { status: 500 });
		}

		const githubRes = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${githubToken}`,
				Accept: 'application/vnd.github+json',
				'Content-Type': 'application/json',
				'X-GitHub-Api-Version': '2022-11-28',
				"User-Agent": "cloudflare-workers",
			},
			body: JSON.stringify({
				event_type: 'railway_deploy',
				client_payload: payload, 
			}),
		});

		console.log("Github response", githubRes);

		if (githubRes.ok) {
			console.log(`Triggered GitHub repository_dispatch for ${repo}`);
			return new Response('Triggered GitHub repository_dispatch', { status: 200 });
		} else {
			const error = await githubRes.text();
			return new Response(`Failed: ${error}`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
