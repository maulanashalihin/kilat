import { Head, router, useForm, usePage } from "@inertiajs/react";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import Layout from "../components/Layout";
import Field, { inputClass } from "../components/Field";

function statusMessage(res: Response): string {
	return `Request failed (HTTP ${res.status})`;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export default function Profile() {
	const { props } = usePage();
	const user = props.auth.user;

	const info = useForm({ name: user?.name ?? "", email: user?.email ?? "" });
	const pass = useForm({
		currentPassword: "",
		password: "",
		passwordConfirmation: "",
	});
	const inputRef = useRef<HTMLInputElement>(null);

	const [phase, setPhase] = useState<"idle" | "uploading" | "done" | "error">(
		"idle",
	);
	const [message, setMessage] = useState<string | null>(null);

	/** Upload avatar via multipart form-data to /profile/avatar (R2 direct). */
	async function uploadAvatar(file: File) {
		setPhase("uploading");
		setMessage(null);

		const form = new FormData();
		form.append("file", file);

		const res = await fetch("/profile/avatar", {
			method: "POST",
			body: form,
		});
		if (!res.ok) {
			setPhase("error");
			const text = await res.text().catch(() => "");
			setMessage(text || statusMessage(res));
			return;
		}
		setPhase("done");
		router.reload(); // refresh shared props so the header avatar updates
	}

	function onFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = ""; // allow re-selecting the same file
		if (!file) return;
		void uploadAvatar(file);
	}

	const submitInfo = (e: FormEvent) => {
		e.preventDefault();
		info.patch("/profile");
	};

	const submitPass = (e: FormEvent) => {
		e.preventDefault();
		pass.post("/profile/password");
	};

	if (!user) return null; // guarded server-side by requireAuth

	const btnPrimary =
		"inline-flex items-center justify-center gap-1.5 px-4 py-2.5 border border-primary rounded-lg bg-primary text-white font-semibold text-sm cursor-pointer transition-colors hover:bg-primary-hover hover:border-primary-hover hover:no-underline disabled:opacity-60 disabled:cursor-not-allowed";
	return (
		<Layout>
			<Head title="Profile" />
			<h1 className="text-[1.6rem] m-0 mb-1 tracking-tight">Profile</h1>
			<p className="text-muted mb-3">
				Manage your account — avatar, profile information and password.
			</p>

			<div className="grid grid-cols-[300px_1fr] gap-5 items-start max-md:grid-cols-1">
				<aside className="flex flex-col gap-4">
					<section className="bg-surface border border-border rounded-radius p-6 flex flex-col items-center text-center gap-2">
						{user.avatarUrl ? (
							<img
								className="w-11 h-11 rounded-full object-cover"
								src={user.avatarUrl}
								alt=""
							/>
						) : (
							<span className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-primary text-white text-sm font-bold shrink-0">
								{user.name
									.split(/\s+/)
									.filter(Boolean)
									.slice(0, 2)
									.map((s) => s[0]?.toUpperCase() ?? "")
									.join("") || "?"}
							</span>
						)}
						<h2 className="m-0 text-[1.1rem]">{user.name}</h2>
						<p className="text-muted m-0">{user.email}</p>
						<div className="flex items-center justify-center gap-2 flex-wrap">
							<span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold capitalize bg-primary-soft text-primary">
								{user.role}
							</span>
							<span className="text-muted text-sm">
								Member since {formatDate(user.createdAt)}
							</span>
						</div>

						<div className="flex flex-col items-center gap-2 w-full mt-3">
							<input
								ref={inputRef}
								type="file"
								accept="image/png,image/jpeg,image/gif,image/webp"
								hidden
								onChange={onFile}
							/>
							<button
								type="button"
								className={btnPrimary}
								disabled={phase === "uploading"}
								onClick={() => inputRef.current?.click()}
							>
								{phase === "uploading" ? "Uploading…" : "Change avatar"}
							</button>
							{message ? <p className="upload-error">{message}</p> : null}
							{phase === "done" ? (
								<p className="text-green-700 font-semibold mt-3 m-0">
									Avatar updated.
								</p>
							) : null}
						</div>
					</section>
				</aside>

				<div className="flex flex-col gap-5">
					<section className="bg-surface border border-border rounded-radius p-6">
						<h2 className="text-[1.1rem] m-0 mb-3">Profile information</h2>
						<form onSubmit={submitInfo} noValidate>
							<Field id="name" label="Name" error={info.errors.name}>
								<input
									id="name"
									type="text"
									name="name"
									autoComplete="name"
									className={inputClass}
									value={info.data.name}
									onChange={(e) => {
										info.clearErrors("name");
										info.setData("name", e.target.value);
									}}
								/>
							</Field>
							<Field id="email" label="Email" error={info.errors.email}>
								<input
									id="email"
									type="email"
									name="email"
									autoComplete="email"
									className={inputClass}
									value={info.data.email}
									onChange={(e) => {
										info.clearErrors("email");
										info.setData("email", e.target.value);
									}}
								/>
							</Field>
							<button
								className={btnPrimary}
								type="submit"
								disabled={info.processing}
							>
								{info.processing ? "Saving…" : "Save changes"}
							</button>
						</form>
					</section>

					<section className="bg-surface border border-border rounded-radius p-6">
						<h2 className="text-[1.1rem] m-0 mb-3">Change password</h2>
						<form onSubmit={submitPass} noValidate>
							<Field
								id="currentPassword"
								label="Current password"
								error={pass.errors.currentPassword}
							>
								<input
									id="currentPassword"
									type="password"
									name="currentPassword"
									autoComplete="current-password"
									className={inputClass}
									value={pass.data.currentPassword}
									onChange={(e) => {
										pass.clearErrors("currentPassword");
										pass.setData("currentPassword", e.target.value);
									}}
								/>
							</Field>
							<Field
								id="password"
								label="New password"
								error={pass.errors.password}
							>
								<input
									id="password"
									type="password"
									name="password"
									autoComplete="new-password"
									className={inputClass}
									value={pass.data.password}
									onChange={(e) => {
										pass.clearErrors("password");
										pass.setData("password", e.target.value);
									}}
								/>
							</Field>
							<Field
								id="passwordConfirmation"
								label="Confirm new password"
								error={pass.errors.passwordConfirmation}
							>
								<input
									id="passwordConfirmation"
									type="password"
									name="passwordConfirmation"
									autoComplete="new-password"
									className={inputClass}
									value={pass.data.passwordConfirmation}
									onChange={(e) => {
										pass.clearErrors("passwordConfirmation");
										pass.setData("passwordConfirmation", e.target.value);
									}}
								/>
							</Field>
							<button
								className={btnPrimary}
								type="submit"
								disabled={pass.processing}
							>
								{pass.processing ? "Updating…" : "Update password"}
							</button>
						</form>
					</section>
				</div>
			</div>
		</Layout>
	);
}
