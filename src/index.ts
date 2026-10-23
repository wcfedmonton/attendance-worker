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

import Client from "@notionhq/client/build/src/Client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
interface Env {
	NOTION_API_KEY: string;
	ATTENDANCE_KEY: string;
	MEMBER_KEY: string;
}

export default {

	/*async scheduled (
		controller: ScheduledController, 
		env: Env,
		ctx: ExecutionContext) {
			console.log("Scheduled event fired at " + new Date(controller.scheduledTime).toISOString());
	},*/

	async fetch(request, env, ctx): Promise<Response> {
		const notion = new Client({ auth: env.NOTION_API_KEY, dangerouslyAllowBrowser: true });

		/*
			- Get attendance data (get all where 'Member' is empty) [CHECK]
			- For each result returned, check Memmber db to see if that email exists
				- If it does, *update* attendance row
				- Else, skip
			- Return a count of connected and skipped.
		*/

		// get data from attendance db
		const response = await notion.dataSources.query({
			data_source_id: env.ATTENDANCE_KEY, // ID for attendance Data Source
			filter_properties: ['Email'], // only what we actually read
			filter: {
				property: 'Member',
				relation: {
					is_empty: true,
				},
			},
			sorts: [
				{
					property: 'Date',
					direction: 'descending',
				},
			],
		});

		const results = response.results;

		//Collect valid emails first
		const rows: Array<{ pageId: string; email: string }> = []; //put email results here

		for (const res of results) {
			if (res.object !== 'page' || !('properties' in res)) continue;

			const emailProp = res.properties['Email'];
			const email = emailProp?.type === 'title' ? emailProp.title[0]?.plain_text?.trim() : undefined; //title guard for emails

			if (!email) {
				console.log(`Skipping page ${res.id}: no email`); //error message for fields without emails (likely not to happen)
				continue;
			}

			rows.push({ pageId: res.id, email }); //append emails to array
		}

		//Batch-resolve emails -> member page ids (chunked to stay under filter limits) (more efficient than using a timer)
		const CHUNK_SIZE = 50;
		const uniqueEmails = [...new Set(rows.map((r) => r.email))];
		const memberByEmail = new Map<string, string>();

		for (let i = 0; i < uniqueEmails.length; i += CHUNK_SIZE) { // for every iteration we move 50 steps ahead
			const chunk = uniqueEmails.slice(i, i + CHUNK_SIZE); // we take 50 emails and start with those

			const memberResponse = await notion.dataSources.query({
				data_source_id: env.MEMBER_KEY, // ID for Members' DB
				filter_properties: ['Email'],
				filter: {
					or: chunk.map((email) => ({ //checks multiple emails identities at once and finds the match
						property: 'Email',
						email: { equals: email },
					})),
				},
			});

			for (const member of memberResponse.results) {
				if (member.object !== 'page' || !('properties' in member)) continue;

				const memberEmailProp = member.properties['Email']; //title guard for emails
				const memberEmail =
					memberEmailProp?.type === 'email'
						? memberEmailProp.email?.trim().toLowerCase()
						: memberEmailProp?.type === 'title'
							? memberEmailProp.title[0]?.plain_text?.trim().toLowerCase()
							: undefined;

				if (memberEmail) memberByEmail.set(memberEmail, member.id);
			}
		}

		//Update each attendance page, isolating failures
		const update_results: Array<{
			id: string;
			ok: boolean;
			email: string;
			error?: string;
		}> = []; //putting the results in an array is a little better. Now I can display my counts without making them different objects

		for (const { pageId, email } of rows) {
			const memberId = memberByEmail.get(email.toLowerCase()); //getting email from the map

			if (!memberId) {
				console.log('No member found for email: ' + email);
				update_results.push({ id: pageId, ok: false, email, error: 'member_not_found' });
				continue;
			}

			try {
				await notion.pages.update({
					page_id: pageId,
					properties: {
						Member: {
							relation: [{ id: memberId }],
						},
					},
				});
				update_results.push({ id: pageId, ok: true, email });
			} catch (err) { //in case of any other errors that don't involve one not being a member
				const message = err instanceof Error ? err.message : String(err);
				console.log(`Failed to update page ${pageId}: ${message}`);
				update_results.push({ id: pageId, ok: false, email, error: message });
			}
		}

		return Response.json({
			total: rows.length,
			updated: update_results.filter((r) => r.ok).length,
			failed: update_results.filter((r) => !r.ok).length,
			results: update_results,
		});

	},
} satisfies ExportedHandler<Env>;
