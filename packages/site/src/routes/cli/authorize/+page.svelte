<script>
  import { csrfHeaders } from '$lib/csrf'
  import { readApiResponse } from '$lib/api-response'
  import { page } from '$app/stores'
  import { onMount } from 'svelte'
  import { lang } from '$lib/lang'

  let userCode = ''
  let loading = false
  let error = ''
  let approvedCode = ''
  $: approved = Boolean(approvedCode) && approvedCode === userCode.trim().toUpperCase()
  let codeFromUrl
  $: if (codeFromUrl !== $page.url.searchParams.get('code')) {
    codeFromUrl = $page.url.searchParams.get('code')
    userCode = codeFromUrl || ''
    approvedCode = ''
    error = ''
  }
  let notLoggedIn = false
  $: zh = $lang === 'zh'
  $: loginHref = `/login?redirect=${encodeURIComponent(`/cli/authorize?code=${userCode}`)}`

  onMount(async () => {
    try {
      const res = await fetch('/api/me')
      notLoggedIn = res.status === 401
      if (!res.ok && !notLoggedIn) error = (await readApiResponse(res)).error
    } catch { error = zh ? '网络错误' : 'Network error' }
  })

  async function approveDevice() {
    if (!userCode || loading) return
    const requestedCode = userCode.trim().toUpperCase()
    loading = true
    error = ''
    try {
      const res = await fetch('/api/cli/device/approve-by-code', {
        method: 'POST',
        headers: csrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ user_code: requestedCode })
      })
      if (requestedCode !== userCode.trim().toUpperCase()) return
      if (res.ok) {
        approvedCode = requestedCode
      } else {
        const data = await readApiResponse(res)
        if (res.status === 401) {
          notLoggedIn = true
          error = ''
        } else {
          error = data?.error || data?.message || (zh ? `授权失败（HTTP ${res.status}）` : `Failed to approve (HTTP ${res.status})`)
        }
      }
    } catch {
      error = zh ? '网络错误' : 'Network error'
    } finally {
      loading = false
    }
  }
</script>

<svelte:head>
  <title>{zh ? '授权 CLI 设备' : 'Authorize CLI Device'} — AIUsage</title>
</svelte:head>

<div class="authorize-page">
  <div class="authorize-card">
    {#if notLoggedIn}
      <h1>{zh ? '需要登录' : 'Sign In Required'}</h1>
      <p>{zh ? '授权 CLI 设备前，请先登录你的 AIUsage 账号。' : 'You need to sign in before authorizing a CLI device.'}</p>
      <a href={loginHref} class="btn-primary">{zh ? '登录' : 'Sign In'}</a>
    {:else if approved}
      <div class="success-icon">&#10003;</div>
      <h1>{zh ? '设备已授权' : 'Device Authorized'}</h1>
      <p>{zh ? '你的 CLI 设备已完成授权。可以关闭此页面并返回本地界面或终端。' : 'Your CLI device has been authorized. You can close this page and return to your local app or terminal.'}</p>
    {:else}
      <h1>{zh ? '授权 CLI 设备' : 'Authorize CLI Device'}</h1>
      <p class="authorize-desc">
        {zh
          ? '本机 AIUsage 正在请求设备授权，以使用你账号下的云同步。'
          : 'Your local AIUsage instance is requesting device authorization for cloud sync under your account.'}
      </p>

      {#if userCode}
        <div class="code-display">
          <span class="code-label">{zh ? '设备验证码' : 'Device Code'}</span>
          <span class="code-value">{userCode}</span>
        </div>
      {/if}

      <div class="authorize-info">
        <h3>{zh ? '授权后将允许本机执行：' : 'This will allow the CLI to:'}</h3>
        <ul>
          <li>{zh ? '配置并启用云同步后，上传和拉取用量记录' : 'Upload and pull usage records after cloud sync is configured and enabled'}</li>
          <li>{zh ? '同步记录可能包含工具、模型、Token、费用、会话标题以及项目和路径元数据' : 'Synced records may include tools, models, tokens, costs, session titles, and project or path metadata'}</li>
        </ul>
        <h3>{zh ? '以下数据不会上传：' : 'Data that will NOT be uploaded:'}</h3>
        <ul>
          <li>{zh ? 'Prompt 或 completion 内容' : 'Prompt or completion content'}</li>
          <li>{zh ? '源代码文件内容' : 'Source code file contents'}</li>
        </ul>
      </div>

      {#if error}
        <div class="error-msg">{error}</div>
      {/if}

      <button class="btn-primary" on:click={approveDevice} disabled={loading || !userCode}>
        {loading ? (zh ? '授权中...' : 'Authorizing...') : (zh ? '授权设备' : 'Authorize Device')}
      </button>
    {/if}
  </div>
</div>

<style>
  .authorize-page { min-height: calc(100vh - 200px); display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .authorize-card { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 2rem; box-shadow: var(--shadow-md); text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.75rem; }
  .authorize-desc { color: var(--text-secondary); font-size: 0.9375rem; margin-bottom: 1.5rem; }
  .success-icon { font-size: 3rem; color: var(--green); margin-bottom: 1rem; }
  .code-display { background: var(--raised); border: 1px solid var(--border-medium); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .code-label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 0.5rem; }
  .code-value { font-family: var(--mono); font-size: 1.5rem; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); }
  .authorize-info { text-align: left; margin-bottom: 1.5rem; }
  .authorize-info h3 { font-size: 0.875rem; font-weight: 600; margin: 1rem 0 0.5rem; }
  .authorize-info h3:first-child { margin-top: 0; }
  .authorize-info ul { padding-left: 1.25rem; font-size: 0.875rem; color: var(--text-secondary); }
  .authorize-info li { margin-bottom: 0.25rem; }
  .error-msg { background: oklch(0.55 0.22 25 / 0.08); color: var(--rose); padding: 0.75rem; border-radius: 8px; font-size: 0.875rem; margin-bottom: 1rem; }
  .btn-primary { display: inline-block; padding: 0.75rem 2rem; font-size: 0.9375rem; font-weight: 600; color: oklch(0.99 0.002 85); background: var(--accent); border: none; border-radius: 8px; cursor: pointer; text-decoration: none; transition: background 0.15s; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
