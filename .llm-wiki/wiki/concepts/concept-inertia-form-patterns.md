---
type: concept
slug: concept-inertia-form-patterns
status: active
created: 2026-08-03
updated: 2026-08-11
---

# Inertia Form Patterns (Create / Update Data)

Convention for CRUD form submissions in kilat using Inertia.js v3 + React 19
(`@inertiajs/react`). Server side is adapter-agnostic — only the client syntax
differs from the Vue/Svelte adapters.

Related: [[entities/inertia-v3]], [[entities/inertiajsreact]]

## Decision Rule

| Need | Use |
|------|-----|
| Simple form — just collect data and submit | `<Form>` component |
| Pre-submit validation (check password match, etc.) | `useForm` + `<form>` |
| `fetch()` integration (avatar upload then save URL) | `useForm` + `<form>` |
| Reactive `value`/`onChange` (live preview, dirty tracking) | `useForm` + `<form>` |
| Programmatic submit (trigger from outside form) | `useForm` + `<form>` |

**Default:** if unsure, use `useForm` + `<form>` — it handles more cases.
This is the pattern every form in kilat uses today (`Login`, `Register`,
`ResetPassword`, `ForgotPassword`, `Profile`).

## Pattern A: `<Form>` Component — Simple Forms

No `value`/`onChange` needed — `<Form>` collects data from `name` attributes.
Least boilerplate. Not currently used in kilat but valid for throwaway
admin forms.

```tsx
import { Form } from "@inertiajs/react";

// CREATE
<Form action="/users" method="post">
  <input type="text" name="name" />
  <input type="email" name="email" />
  <button type="submit">Create User</button>
</Form>

// UPDATE
<Form action={`/users/${user.id}`} method="put">
  <input type="text" name="name" defaultValue={user.name} />
  <button type="submit">Update</button>
</Form>
```

Render-prop children for errors/processing:

```tsx
<Form action="/users" method="post">
  {({ errors, processing, wasSuccessful }) => (
    <>
      <input type="text" name="name" />
      {errors.name && <div>{errors.name}</div>}
      <button disabled={processing}>
        {processing ? "Creating..." : "Create User"}
      </button>
      {wasSuccessful && <div>Created!</div>}
    </>
  )}
</Form>
```

## Pattern B: `useForm` + `<form>` — Forms with Validation/Control

Auto-tracks `processing`, `errors`, `isDirty`, `wasSuccessful`. Allows
pre-submit validation and `fetch()` integration. **This is the kilat
convention** — see `src/client/pages/Login.tsx`, `Register.tsx`, `Profile.tsx`.

### Create

```tsx
import { Head, Link, useForm } from "@inertiajs/react";
import type { FormEvent } from "react";

export default function Register() {
  const { data, setData, post, processing, errors, clearErrors } = useForm({
    name: "",
    email: "",
    password: "",
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    post("/register");
  };

  return (
    <form onSubmit={submit} noValidate>
      <input
        type="text"
        name="name"
        value={data.name}
        onChange={(e) => {
          clearErrors("name");
          setData("name", e.target.value);
        }}
      />
      {errors.name && <span>{errors.name}</span>}
      <button disabled={processing}>
        {processing ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
```

### Update

```tsx
import { useForm } from "@inertiajs/react";
import type { FormEvent } from "react";

export default function Profile({ user }: { user: User }) {
  // Optional remember-key persists form data + errors across navigations.
  // Use a stable unique key per editable entity: `EditUser:${user.id}`.
  const info = useForm(`EditUser:${user.id}`, {
    name: user.name,
    email: user.email,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    info.patch("/profile");
  };

  return (
    <form onSubmit={submit}>
      <input
        name="name"
        value={info.data.name}
        onChange={(e) => info.setData("name", e.target.value)}
      />
      {info.isDirty && <span>Unsaved changes</span>}
      {info.errors.name && <span>{info.errors.name}</span>}
      <button disabled={info.processing}>Save</button>
    </form>
  );
}
```

> kilat `Profile.tsx` uses `info.patch("/profile")` (not `put`) and keeps
> the remember-key optional — the live code calls `useForm({...})` without a
> key because the profile page is single-instance. Add the key only when the
> same form component renders for different entities.

### File Upload + Form Save (two-step)

Inertia forms cannot send files directly. kilat uploads avatars via the
tus protocol (`src/server/routes/uploads.routes.ts`) in three steps —
create upload, PATCH chunks, then POST a link endpoint — and finally
`router.reload()` to refresh shared props so the header avatar updates.
See `src/client/pages/Profile.tsx` `runUpload` for the full chunked/resumable
implementation. Sketch:

```tsx
import { router, useForm, usePage } from "@inertiajs/react";

const { props } = usePage();
const user = props.auth.user;

async function runUpload(file: File) {
  // 1. Create the tus upload resource.
  const create = await fetch("/uploads", {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(file.size),
      "Upload-Metadata": `filename ${toBase64(file.name)},filetype ${toBase64(file.type)}`,
    },
  });
  const location = create.headers.get("Location");
  const uploadId = location?.split("/").pop() ?? "";

  // 2. PATCH the bytes (chunked; see Profile.tsx for the resume loop).
  await fetch(`/uploads/${uploadId}`, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": "0",
    },
    body: file,
  });

  // 3. Link the uploaded file to the user, then refresh shared props.
  await fetch("/profile/avatar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  router.reload();
}
```

For a simpler (non-resumable) upload, `fetch() + FormData` then `form.put()`
also works — but kilat standardised on tus for resumability, so prefer
the tus path above for any new upload feature.

## Key Rules (both patterns)

| Rule | Why |
|------|-----|
| `form.post()` for create, `form.put()`/`form.patch()` for update | Correct HTTP method, server knows intent |
| Unique key for edit forms: `useForm('EditUser:${id}', data)` | Persists form data + errors to history state |
| `disabled={processing}` | Prevent double-submit |
| `errors.field` (or `form.errors.field`) | Server validation errors auto-populate |
| `e.preventDefault()` in the `useForm` submit handler | Prevents full page reload — Inertia sends XHR instead |
| `clearErrors("field")` in `onChange` | Clears a field error as soon as the user edits it (kilat convention) |
| File upload: separate `fetch()` upload then `router.reload()` | Inertia forms can't send files directly |
| `onSubmit={submit}` (camelCase) | React event prop convention — not Svelte's `onsubmit` |

## React vs Svelte cheat-sheet

The same Inertia v3 concepts apply across adapters; only the binding syntax
differs. If you are porting from a Svelte example:

| Svelte 5 | React 19 (`@inertiajs/react`) |
|----------|------------------------------|
| `import { useForm } from '@inertiajs/svelte'` | `import { useForm } from '@inertiajs/react'` |
| `const form = useForm({...})` → `form.data`, `form.errors` | `const { data, setData, post, processing, errors, clearErrors } = useForm({...})` |
| `<input bind:value={form.name} />` | `<input value={data.name} onChange={(e) => setData("name", e.target.value)} />` |
| `onsubmit={submit}` | `onSubmit={submit}` |
| `{#if form.errors.name}` | `{errors.name && <span>{errors.name}</span>}` |
| `{#snippet children({ errors, processing })}` | `{({ errors, processing }) => (...)}` render-prop |

## Sources

- [Inertia.js Forms Documentation (v3)](https://inertiajs.com/docs/v3/the-basics/forms)
- [Inertia.js Manual Visits (v3)](https://inertiajs.com/docs/v3/the-basics/manual-visits)
- [Inertia.js Remembering State (v3)](https://inertiajs.com/docs/v3/data-props/remembering-state)
- [Inertia.js File Uploads (v3)](https://inertiajs.com/docs/v3/the-basics/file-uploads)
- kilat: `src/client/pages/Login.tsx`, `Register.tsx`, `Profile.tsx`
- kilat: `src/server/routes/uploads.routes.ts` (tus protocol), `src/server/routes/profile.routes.ts`
