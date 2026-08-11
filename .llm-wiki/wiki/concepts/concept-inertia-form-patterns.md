---
type: concept
slug: concept-inertia-form-patterns
status: active
created: 2026-08-03
updated: 2026-08-11
---

# Inertia Form Patterns (Create / Update Data)

Convention for CRUD form submissions in kilat using Inertia.js v3 + Svelte 5
(`@inertiajs/svelte`). Server side is adapter-agnostic — only the client syntax
differs from the React/Vue adapters.

Related: [[entities/inertia-v3]]

## Decision Rule

| Need | Use |
|------|-----|
| Simple form — just collect data and submit | `<Form>` component |
| Pre-submit validation (check password match, etc.) | `useForm` + `<form>` |
| `fetch()` integration (avatar upload then save URL) | `useForm` + `<form>` |
| Reactive `bind:value` (live preview, dirty tracking) | `useForm` + `<form>` |
| Programmatic submit (trigger from outside form) | `useForm` + `<form>` |

**Default:** if unsure, use `useForm` + `<form>` — it handles more cases.
This is the pattern every form in kilat uses today (`Login`, `Register`,
`ResetPassword`, `ForgotPassword`, `Profile`).

## Pattern A: `<Form>` Component — Simple Forms

No `bind:` needed — `<Form>` collects data from `name` attributes. Least
boilerplate. Not currently used in kilat but valid for throwaway admin
forms.

```svelte
<script lang="ts">
  import { Form } from '@inertiajs/svelte'
</script>

<!-- CREATE -->
<Form action="/users" method="post">
  <input type="text" name="name" />
  <input type="email" name="email" />
  <button type="submit">Create User</button>
</Form>

<!-- UPDATE -->
<Form action="/users/{user.id}" method="put">
  <input type="text" name="name" value={user.name} />
  <button type="submit">Update</button>
</Form>
```

Slot props for errors/processing (Svelte 5 snippet syntax):

```svelte
<Form action="/users" method="post">
  {#snippet children({ errors, processing, wasSuccessful })}
    <input type="text" name="name" />
    {#if errors.name}<div>{errors.name}</div>{/if}
    <button disabled={processing}>
      {processing ? 'Creating...' : 'Create User'}
    </button>
    {#if wasSuccessful}<div>Created!</div>{/if}
  {/snippet}
</Form>
```

## Pattern B: `useForm` + `<form>` — Forms with Validation/Control

Auto-tracks `processing`, `errors`, `isDirty`, `wasSuccessful`. Allows
pre-submit validation and `fetch()` integration. **This is the kilat
convention** — see `src/client/pages/Login.svelte`, `Register.svelte`,
`Profile.svelte`.

### Create

```svelte
<script lang="ts">
  import { Head, Link, useForm } from '@inertiajs/svelte'
  import type { SubmitEvent } from 'svelte/elements'

  const form = useForm({ name: '', email: '', password: '' })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    form.post('/register')
  }
</script>

<form onsubmit={submit} novalidate>
  <input
    type="text"
    name="name"
    bind:value={form.name}
    onchange={() => form.clearErrors('name')}
  />
  {#if form.errors.name}<span>{form.errors.name}</span>{/if}
  <button disabled={form.processing}>
    {form.processing ? 'Creating account…' : 'Create account'}
  </button>
</form>
```

### Update

```svelte
<script lang="ts">
  import { useForm, usePage } from '@inertiajs/svelte'

  const page = usePage()
  const user = $derived(page.props.auth.user)

  // Optional remember-key persists form data + errors across navigations.
  // Use a stable unique key per editable entity: `EditUser:${user.id}`.
  let info = $state(useForm(`EditUser:${user.id}`, {
    name: user.name,
    email: user.email,
  }))

  function submitInfo(e: SubmitEvent) {
    e.preventDefault()
    info.patch('/profile')
  }
</script>

<form onsubmit={submitInfo} novalidate>
  <input
    name="name"
    bind:value={info.name}
    onchange={() => info.clearErrors('name')}
  />
  {#if info.isDirty}<span>Unsaved changes</span>{/if}
  {#if info.errors.name}<span>{info.errors.name}</span>{/if}
  <button disabled={info.processing}>Save</button>
</form>
```

> kilat `Profile.svelte` uses `info.patch('/profile')` (not `put`) and
> initializes the form inside a `$state()` rune. The live code seeds form
> defaults from the user in a `$effect` once the page props are available.
> Add the remember-key only when the same form component renders for
> different entities.

### File Upload + Form Save (two-step)

Inertia forms cannot send files directly. kilat uploads avatars via the
tus protocol (`src/server/routes/uploads.routes.ts`) in three steps —
create upload, PATCH chunks, then POST a link endpoint — and finally
`router.reload()` to refresh shared props so the header avatar updates.
See `src/client/pages/Profile.svelte` `runUpload` for the full
chunked/resumable implementation. Sketch:

```svelte
<script lang="ts">
  import { router, usePage } from '@inertiajs/svelte'

  const page = usePage()
  const user = $derived(page.props.auth.user)

  async function runUpload(file: File) {
    // 1. Create the tus upload resource.
    const create = await fetch('/uploads', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(file.size),
        'Upload-Metadata': `filename ${toBase64(file.name)},filetype ${toBase64(file.type)}`,
      },
    })
    const location = create.headers.get('Location')
    const uploadId = location?.split('/').pop() ?? ''

    // 2. PATCH the bytes (chunked; see Profile.svelte for the resume loop).
    await fetch(`/uploads/${uploadId}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
      },
      body: file,
    })

    // 3. Link the uploaded file to the user, then refresh shared props.
    await fetch('/profile/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    })
    router.reload()
  }
</script>
```

For a simpler (non-resumable) upload, `fetch() + FormData` then `form.put()`
also works — but kilat standardised on tus for resumability, so prefer
the tus path above for any new upload feature.

## Key Rules (both patterns)

| Rule | Why |
|------|-----|
| `form.post()` for create, `form.put()`/`form.patch()` for update | Correct HTTP method, server knows intent |
| Unique key for edit forms: `useForm('EditUser:${id}', data)` | Persists form data + errors to history state |
| `disabled={form.processing}` | Prevent double-submit |
| `form.errors.field` | Server validation errors auto-populate |
| `e.preventDefault()` in the `useForm` submit handler | Prevents full page reload — Inertia sends XHR instead |
| `onchange={() => form.clearErrors('field')}` | Clears a field error as soon as the user edits it (kilat convention) |
| File upload: separate `fetch()` upload then `router.reload()` | Inertia forms can't send files directly |
| `onsubmit={submit}` (lowercase) | Svelte event attribute convention — not React's `onSubmit` |

## Svelte vs React vs Vue cheat-sheet

The same Inertia v3 concepts apply across adapters; only the binding syntax
differs. If you are porting from a React or Vue example:

| React 19 | Svelte 5 (`@inertiajs/svelte`) | Vue 3 (`@inertiajs/vue3`) |
|----------|------------------------------|--------------------------|
| `import { useForm } from '@inertiajs/react'` | `import { useForm } from '@inertiajs/svelte'` | `import { useForm } from '@inertiajs/vue3'` |
| `const { data, setData, post, ... } = useForm({...})` | `const form = useForm({...})` → `form.data`, `form.errors` | `const form = useForm({...})` → `form.data`, `form.errors` |
| `<input value={data.name} onChange={(e) => setData('name', e.target.value)} />` | `<input bind:value={form.name} />` | `<input v-model="form.name" />` |
| `onSubmit={submit}` | `onsubmit={submit}` | `@submit.prevent="submit"` |
| `e.preventDefault()` in handler | `e.preventDefault()` in handler | NOT needed — `@submit.prevent` modifier handles it |
| `{errors.name && <span>{errors.name}</span>}` | `{#if form.errors.name}<span>{form.errors.name}</span>{/if}` | `<div v-if="form.errors.email">{{ form.errors.email }}</div>` |
| `{({ errors, processing }) => (...)}` render-prop | `{#snippet children({ errors, processing })}` | `<template #default="{ errors, processing }">` |

## Sources

- [Inertia.js Forms Documentation (v3)](https://inertiajs.com/docs/v3/the-basics/forms)
- [Inertia.js Manual Visits (v3)](https://inertiajs.com/docs/v3/the-basics/manual-visits)
- [Inertia.js Remembering State (v3)](https://inertiajs.com/docs/v3/data-props/remembering-state)
- [Inertia.js File Uploads (v3)](https://inertiajs.com/docs/v3/the-basics/file-uploads)
- kilat: `src/client/pages/Login.svelte`, `Register.svelte`, `Profile.svelte`
- kilat: `src/server/routes/uploads.routes.ts` (tus protocol), `src/server/routes/profile.routes.ts`
