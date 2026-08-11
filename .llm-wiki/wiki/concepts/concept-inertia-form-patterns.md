---
type: concept
slug: concept-inertia-form-patterns
status: active
created: 2026-08-03
updated: 2026-08-11
---

# Inertia Form Patterns (Create / Update Data)

Convention for CRUD form submissions in kilat using Inertia.js v3 + Vue 3
(`@inertiajs/vue3`). Server side is adapter-agnostic — only the client syntax
differs from the React/Svelte adapters.

Related: [[entities/inertia-v3]]

## Decision Rule

| Need | Use |
|------|-----|
| Simple form — just collect data and submit | `<Form>` component |
| Pre-submit validation (check password match, etc.) | `useForm` + `<form>` |
| `fetch()` integration (avatar upload then save URL) | `useForm` + `<form>` |
| Reactive `v-model` (live preview, dirty tracking) | `useForm` + `<form>` |
| Programmatic submit (trigger from outside form) | `useForm` + `<form>` |

**Default:** if unsure, use `useForm` + `<form>` — it handles more cases.
This is the pattern every form in kilat uses today (`Login`, `Register`,
`ResetPassword`, `ForgotPassword`, `Profile`).

## Pattern A: `<Form>` Component — Simple Forms

No `v-model` needed — `<Form>` collects data from `name` attributes. Least
boilerplate. Not currently used in kilat but valid for throwaway admin
forms.

```vue
<script setup lang="ts">
import { Form } from "@inertiajs/vue3";
</script>

<!-- CREATE -->
<Form action="/users" method="post">
  <input type="text" name="name" />
  <input type="email" name="email" />
  <button type="submit">Create User</button>
</Form>

<!-- UPDATE -->
<Form :action="`/users/${user.id}`" method="put">
  <input type="text" name="name" :value="user.name" />
  <button type="submit">Update</button>
</Form>
```

Slot props for errors/processing:

```vue
<Form action="/users" method="post" v-slot="{ errors, processing, wasSuccessful }">
  <input type="text" name="name" />
  <div v-if="errors.name">{{ errors.name }}</div>
  <button :disabled="processing">
    {{ processing ? "Creating..." : "Create User" }}
  </button>
  <div v-if="wasSuccessful">Created!</div>
</Form>
```

## Pattern B: `useForm` + `<form>` — Forms with Validation/Control

Auto-tracks `processing`, `errors`, `isDirty`, `wasSuccessful`. Allows
pre-submit validation and `fetch()` integration. **This is the kilat
convention** — see `src/client/pages/Login.vue`, `Register.vue`,
`Profile.vue`.

### Create

```vue
<script setup lang="ts">
import { Head, Link, useForm } from "@inertiajs/vue3";

const form = useForm({ name: "", email: "", password: "" });

function submit() {
  form.post("/register");
}
</script>

<template>
  <form @submit.prevent="submit" novalidate>
    <input
      type="text"
      name="name"
      v-model="form.name"
      @change="form.clearErrors('name')"
    />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>
    <button :disabled="form.processing">
      {{ form.processing ? "Creating account…" : "Create account" }}
    </button>
  </form>
</template>
```

### Update

```vue
<script setup lang="ts">
import { useForm, usePage } from "@inertiajs/vue3";
import { computed, ref } from "vue";

const page = usePage();
const user = computed(() => page.props.auth.user);

// Optional remember-key persists form data + errors across navigations.
// Use a stable unique key per editable entity: `EditUser:${user.id}`.
const info = ref(
  useForm(`EditUser:${user.id}`, {
    name: user.value.name,
    email: user.value.email,
  })
);

function submitInfo() {
  info.value.patch("/profile");
}
</script>

<template>
  <form @submit.prevent="submitInfo" novalidate>
    <input
      name="name"
      v-model="info.name"
      @change="info.clearErrors('name')"
    />
    <span v-if="info.isDirty">Unsaved changes</span>
    <span v-if="info.errors.name">{{ info.errors.name }}</span>
    <button :disabled="info.processing">Save</button>
  </form>
</template>
```

> kilat `Profile.vue` uses `info.value.patch('/profile')` (not `put`) and
> wraps `useForm` in a `ref()` so the form object is reactive in `<script setup>`.
> Access fields via `info.value.name` in script, `info.name` in template.
> Add the remember-key only when the same form component renders for
> different entities.

### File Upload + Form Save (two-step)

Inertia forms cannot send files directly. kilat uploads avatars via the
tus protocol (`src/server/routes/uploads.routes.ts`) in three steps —
create upload, PATCH chunks, then POST a link endpoint — and finally
`router.reload()` to refresh shared props so the header avatar updates.
See `src/client/pages/Profile.vue` `runUpload` for the full
chunked/resumable implementation. Sketch:

```vue
<script setup lang="ts">
import { router, usePage } from "@inertiajs/vue3";
import { computed } from "vue";

const page = usePage();
const user = computed(() => page.props.auth.user);

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

  // 2. PATCH the bytes (chunked; see Profile.vue for the resume loop).
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
| `:disabled="form.processing"` | Prevent double-submit |
| `form.errors.field` | Server validation errors auto-populate |
| `@submit.prevent="submit"` — NO `e.preventDefault()` in handler | Vue's `.prevent` modifier handles it; calling it manually is redundant |
| `@change="form.clearErrors('field')"` | Clears a field error as soon as the user edits it (kilat convention) |
| File upload: separate `fetch()` upload then `router.reload()` | Inertia forms can't send files directly |
| `v-model="form.field"` | Vue two-way binding — not React's `value`/`onChange` or Svelte's `bind:value` |

## Vue vs React vs Svelte cheat-sheet

The same Inertia v3 concepts apply across adapters; only the binding syntax
differs. If you are porting from a React or Svelte example:

| React 19 | Svelte 5 (`@inertiajs/svelte`) | Vue 3 (`@inertiajs/vue3`) |
|----------|------------------------------|--------------------------|
| `import { useForm } from '@inertiajs/react'` | `import { useForm } from '@inertiajs/svelte'` | `import { useForm } from '@inertiajs/vue3'` |
| `const { data, setData, post, ... } = useForm({...})` | `const form = useForm({...})` → `form.data`, `form.errors` | `const form = useForm({...})` → `form.data`, `form.errors` |
| `<input value={data.name} onChange={(e) => setData('name', e.target.value)} />` | `<input bind:value={form.name} />` | `<input v-model="form.name" />` |
| `onSubmit={submit}` | `onsubmit={submit}` | `@submit.prevent="submit"` |
| `e.preventDefault()` in handler | `e.preventDefault()` in handler | NOT needed — `@submit.prevent` modifier handles it |
| `{errors.name && <span>{errors.name}</span>}` | `{#if form.errors.name}<span>{form.errors.name}</span>{/if}` | `<div v-if="form.errors.email">{{ form.errors.email }}</div>` |
| `{({ errors, processing }) => (...)}` render-prop | `{#snippet children({ errors, processing })}` | `<template #default="{ errors, processing }">` or `v-slot` |

## Sources

- [Inertia.js Forms Documentation (v3)](https://inertiajs.com/docs/v3/the-basics/forms)
- [Inertia.js Manual Visits (v3)](https://inertiajs.com/docs/v3/the-basics/manual-visits)
- [Inertia.js Remembering State (v3)](https://inertiajs.com/docs/v3/data-props/remembering-state)
- [Inertia.js File Uploads (v3)](https://inertiajs.com/docs/v3/the-basics/file-uploads)
- kilat: `src/client/pages/Login.vue`, `Register.vue`, `Profile.vue`
- kilat: `src/server/routes/uploads.routes.ts` (tus protocol), `src/server/routes/profile.routes.ts`
