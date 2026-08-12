<script lang="ts">
  import { router, useForm, usePage } from '@inertiajs/svelte'
  import Layout from '../components/Layout.svelte'
  import Field from '../components/Field.svelte'

  const page = usePage()
  const user = $derived(page.props.auth.user)

  type Phase = 'idle' | 'uploading' | 'done' | 'error'

  let info = $state(useForm({ name: '', email: '' }))
  let pass = $state(useForm({
    currentPassword: '',
    password: '',
    passwordConfirmation: '',
  }))
  let inputRef = $state<HTMLInputElement | null>(null)
  let phase = $state<Phase>('idle')
  let message = $state<string | null>(null)

  // Initialize form defaults from user once available.
  $effect(() => {
    if (user) {
      info = useForm({ name: user.name, email: user.email })
    }
  })

  function statusMessage(res: Response): string {
    return `Request failed (HTTP ${res.status})`
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  /** Upload avatar via multipart form-data to /profile/avatar (R2 direct). */
  async function uploadAvatar(file: File) {
    phase = 'uploading'
    message = null

    const form = new FormData()
    form.append('file', file)

    const res = await fetch('/profile/avatar', {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      phase = 'error'
      const text = await res.text().catch(() => '')
      message = text || statusMessage(res)
      return
    }
    phase = 'done'
    router.reload()
  }

  function onFile(e: Event) {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = '' // allow re-selecting the same file
    if (!file) return
    void uploadAvatar(file)
  }

  function submitInfo(e: SubmitEvent) {
    e.preventDefault()
    info.patch('/profile')
  }

  function submitPass(e: SubmitEvent) {
    e.preventDefault()
    pass.post('/profile/password', { onSuccess: () => pass.reset() })
  }
</script>

<svelte:head><title>Profile</title></svelte:head>

{#if user}
  <Layout>
    <h1>Profile</h1>
    <p class="page-sub">
      Manage your account — avatar, profile information and password.
    </p>

    <div class="profile-grid">
      <aside class="profile-aside">
        <section class="panel profile-card">
          {#if user.avatarUrl}
            <img
              class="avatar avatar-lg avatar-img"
              src={user.avatarUrl}
              alt=""
            />
          {:else}
            <span class="avatar avatar-lg" aria-hidden="true">
              {user.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((s) => s[0]?.toUpperCase() ?? '')
                .join('') || '?'}
            </span>
          {/if}
          <h2 class="profile-name">{user.name}</h2>
          <p class="page-sub">{user.email}</p>
          <div class="profile-meta">
            <span class="badge badge-user">{user.role}</span>
            <span class="profile-since">
              Member since {formatDate(user.createdAt)}
            </span>
          </div>

          <div class="profile-upload">
            <input
              bind:this={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onchange={onFile}
            />
            <button
              type="button"
              class="btn btn-primary"
              disabled={phase === 'uploading'}
              onclick={() => inputRef?.click()}
            >
              {phase === 'uploading' ? 'Uploading…' : 'Change avatar'}
            </button>
            {#if message}
              <p class="upload-error">{message}</p>
            {/if}
            {#if phase === 'done'}
              <p class="upload-done">Avatar updated.</p>
            {/if}
          </div>
        </section>
      </aside>

      <div class="profile-forms">
        <section class="panel">
          <h2>Profile information</h2>
          <form onsubmit={submitInfo} novalidate>
            <Field id="name" label="Name" error={info.errors.name}>
              <input
                id="name"
                type="text"
                name="name"
                autocomplete="name"
                bind:value={info.name}
                onchange={() => info.clearErrors('name')}
              />
            </Field>
            <Field id="email" label="Email" error={info.errors.email}>
              <input
                id="email"
                type="email"
                name="email"
                autocomplete="email"
                bind:value={info.email}
                onchange={() => info.clearErrors('email')}
              />
            </Field>
            <button class="btn btn-primary" type="submit" disabled={info.processing}>
              {info.processing ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        </section>

        <section class="panel">
          <h2>Change password</h2>
          <form onsubmit={submitPass} novalidate>
            <Field
              id="currentPassword"
              label="Current password"
              error={pass.errors.currentPassword}
            >
              <input
                id="currentPassword"
                type="password"
                name="currentPassword"
                autocomplete="current-password"
                bind:value={pass.currentPassword}
                onchange={() => pass.clearErrors('currentPassword')}
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
                autocomplete="new-password"
                bind:value={pass.password}
                onchange={() => pass.clearErrors('password')}
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
                autocomplete="new-password"
                bind:value={pass.passwordConfirmation}
                onchange={() => pass.clearErrors('passwordConfirmation')}
              />
            </Field>
            <button class="btn btn-primary" type="submit" disabled={pass.processing}>
              {pass.processing ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </section>
      </div>
    </div>
  </Layout>
{/if}

<style>
  .profile-grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 1.25rem;
    align-items: start;
  }

  .profile-aside {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .profile-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.5rem;
  }

  .profile-name {
    margin: 0;
  }

  .profile-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .profile-since {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .profile-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    margin-top: 0.75rem;
  }

  .profile-forms {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  @media (max-width: 768px) {
    .profile-grid {
      grid-template-columns: 1fr;
    }
  }

  .upload-file {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .upload-error {
    color: #b91c1c;
    font-size: 0.85rem;
    margin: 0;
  }

  .upload-done {
    color: #15803d;
    font-weight: 600;
    margin-top: 0.75rem;
  }

  .progress {
    margin-top: 1rem;
    height: 8px;
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    border-radius: 999px;
    background: var(--primary);
    transition: width 120ms ease;
  }
</style>
