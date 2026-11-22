<script>
  import { t } from '$lib/i18n.js'
  import { ArrowUpRight, X } from 'lucide-svelte'

  let qrOpen = false

  function openQr() {
    qrOpen = true
  }

  function closeQr() {
    qrOpen = false
  }

  function handleKeydown(e) {
    if (e.key === 'Escape' && qrOpen) closeQr()
  }

  function handleScrimClick(e) {
    if (e.target === e.currentTarget) closeQr()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<svelte:head>
  <title>{$t('support.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('support.title')}</h1>
  <p>{$t('support.desc')}</p>
</div>

<div class="support-layout">
  <section class="card support-section wechat-section">
    <h2>{$t('support.personal')}</h2>
    <div class="wechat-block">
      <button type="button" class="qr-trigger" on:click={openQr} aria-label={$t('support.qrExpand')}>
        <img src="/wechat-support-qr.jpg" alt="WeChat QR" width="180" height="180" />
      </button>
      <div>
        <h3>{$t('support.wechat')}</h3>
        <p>{$t('support.wechatHint')}</p>
      </div>
    </div>
    <a class="support-row" href="mailto:hi@jtanx.com">
      <span>
        <strong>{$t('support.email')}</strong>
        <small class="mono">hi@jtanx.com</small>
      </span>
      <span class="open-label">
        <span>{$t('support.open')}</span>
        <ArrowUpRight size={13} strokeWidth={2} />
      </span>
    </a>
  </section>

  <section class="card support-section">
    <h2>{$t('support.community')}</h2>
    <a class="support-row" href="https://discord.gg/freMjPK478" target="_blank" rel="noopener">
      <span>
        <strong>{$t('support.discord')}</strong>
        <small>{$t('support.discordHint')}</small>
      </span>
      <span class="open-label">
        <span>{$t('support.open')}</span>
        <ArrowUpRight size={13} strokeWidth={2} />
      </span>
    </a>
    <a class="support-row" href="https://t.me/+DWaxtoPB7CY2Yjc1" target="_blank" rel="noopener">
      <span>
        <strong>{$t('support.telegram')}</strong>
        <small>{$t('support.telegramHint')}</small>
      </span>
      <span class="open-label">
        <span>{$t('support.open')}</span>
        <ArrowUpRight size={13} strokeWidth={2} />
      </span>
    </a>
  </section>
</div>

{#if qrOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="qr-overlay" role="dialog" aria-modal="true" aria-label={$t('support.wechat')} on:click={handleScrimClick}>
    <div class="qr-card">
      <img src="/wechat-support-qr.jpg" alt="WeChat QR" width="280" height="280" />
      <p class="qr-card-hint">{$t('support.qrScanHint')}</p>
      <button type="button" class="qr-close" on:click={closeQr} aria-label="Close">
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  </div>
{/if}

<style>
  .support-layout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 1rem;
  }

  .support-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .support-section h2 {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .wechat-block {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 0.875rem;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }

  .qr-trigger {
    flex-shrink: 0;
    padding: 0;
    border: 1px solid var(--border-subtle);
    background: var(--surface);
    cursor: pointer;
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: border-color 0.14s ease;
  }

  .qr-trigger:hover {
    border-color: var(--border-medium);
  }

  .qr-trigger img {
    display: block;
    width: 128px;
    height: 128px;
    object-fit: contain;
    background: var(--surface);
  }

  .wechat-block h3 {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .wechat-block p {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 1.5;
    margin: 0;
  }

  .support-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    text-decoration: none;
    color: var(--text);
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .support-row:hover {
    background: var(--hover);
    border-color: var(--border-medium);
  }

  .support-row strong {
    display: block;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.15rem;
  }

  .support-row small {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.4;
  }

  .open-label {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .qr-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--overlay);
    backdrop-filter: blur(4px);
    animation: fadeIn 0.12s ease;
  }

  .qr-card {
    position: relative;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
    box-shadow: var(--shadow-lg);
    animation: popIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes popIn {
    from { opacity: 0; transform: scale(0.97); }
    to { opacity: 1; transform: scale(1); }
  }

  .qr-card img {
    display: block;
    width: 260px;
    height: 260px;
    object-fit: contain;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }

  .qr-card-hint {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    text-align: center;
    margin: 0;
  }

  .qr-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-xs);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .qr-close:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border-medium);
  }

  @media (max-width: 640px) {
    .support-layout {
      grid-template-columns: 1fr;
    }
    .wechat-block {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
