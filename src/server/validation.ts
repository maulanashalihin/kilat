/**
 * Route-level request validation via TypeBox (schemas live in the route
 * files). Wraps the JSON body in a typed middleware so TypeBox failures
 * surface as a `ValidationFailed` error carrying per-field messages; app.ts
 * maps that to Inertia 422 page payloads (same contract as the Elysia era).
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./inertia-middleware";

// Elysia's TypeBox wrapper pre-registered the standard string formats; plain
// @sinclair/typebox does not. The boilerplate only uses 'email' today —
// register more formats here if a schema starts using them.
FormatRegistry.Set("email", (value) =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)),
);

const JSON_CONTENT_TYPE =
	/^application\/([a-z-.+]+(\+json)|json)(;\s*[a-zA-Z0-9-]+=[^;]+)*$/i;

export interface FieldError {
	/** TypeBox path, e.g. "/email" — matched against VALIDATION_MESSAGES. */
	path: string;
	message: string;
}

/** Thrown by `validateJson` when the JSON body fails its TypeBox schema. */
export class ValidationFailed extends Error {
	constructor(readonly errors: FieldError[]) {
		super("Request validation failed");
		this.name = "ValidationFailed";
	}
}

/** Parse + validate a JSON body against `schema`. The handler's
 *  `c.req.valid("json")` is typed as the schema's static type. */
export const validateJson = <T extends TSchema>(schema: T) =>
	createMiddleware<
		AppEnv,
		string,
		{ in: { json: Static<T> }; out: { json: Static<T> } }
	>(async (c, next) => {
		let value: unknown = {};
		const contentType = c.req.header("content-type") ?? "";
		if (JSON_CONTENT_TYPE.test(contentType)) {
			try {
				value = await c.req.json();
			} catch {
				throw new HTTPException(400, {
					message: "Malformed JSON in request body",
				});
			}
		}
		if (Value.Check(schema, value)) {
			c.req.addValidatedData("json", value as Static<T> as Record<string, unknown>);
			await next();
			return;
		}
		throw new ValidationFailed(
			[...Value.Errors(schema, value)].map((e) => ({
				path: e.path,
				message: e.message,
			})),
		);
	});
