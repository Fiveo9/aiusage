<script>
  import { t } from '$lib/i18n.js'

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
  <title>{$t('support.title')} · AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('support.title')}</h1>
  <p>{$t('support.desc')}</p>
</div>

<div class="support-layout">
  <section class="support-section wechat-section">
    <h2>{$t('support.personal')}</h2>
    <div class="wechat-block">
      <button class="qr-trigger" on:click={openQr} aria-label={$t('support.qrExpand')}>
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
        <small>hi@jtanx.com</small>
      </span>
      <span class="open-label">{$t('support.open')} ↗</span>
    </a>
  </section>

  <section class="support-section">
    <h2>{$t('support.community')}</h2>
    <a class="support-row" href="https://discord.gg/freMjPK478" target="_blank" rel="noopener">
      <span>
        <strong>{$t('support.discord')}</strong>
        <small>{$t('support.discordHint')}</small>
      </span>
      <span class="open-label">{$t('support.open')} ↗</span>
    </a>
    <a class="support-row" href="https://t.me/+DWaxtoPB7CY2Yjc1" target="_blank" rel="noopener">
      <span>
        <strong>{$t('support.telegram')}</strong>
        <small>{$t('support.telegramHint')}</small>
      </span>
      <span class="open-label">{$t('support.open')} ↗</span>
    </a>
  </section>
</div>

{#if qrOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="qr-overlay" role="dialog" aria-modal="true" aria-label={$t('support.wechat')} on:click={handleScrimClick}>
    <div class="qr-card">
      <img src="/wechat-support-qr.jpg" alt="WeChat QR" width="280" height="280" />
      <p class="qr-card-hint">{$t('support.qrScanHint')}</p>
      <button class="qr-close" on:click={closeQr} aria-label="Close">&times;</button>
    </div>
  </div>
{/if}

<style>
  .support-layout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 1.25rem;
  }

  .support-section {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 1.35rem 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .support-section h2 {
    font-family: var(--font-sans);
    font-size: 0.95rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .wechat-block {
    display: flex;
    gap: 1.25rem;
    align-items: center;
    padding: 1rem;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }

  .qr-trigger {
    flex-shrink: 0;
    padding: 0;
    border: 1px solid var(--border-subtle);
    background: var(--surface);
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .qr-trigger:hover {
    transform: scale(1.02);
    box-shadow: var(--shadow-md);
  }

  .qr-trigger img {
    display: block;
    width: 140px;
    height: 140px;
    object-fit: contain;
    background: var(--surface);
  }

  .wechat-block h3 {
    font-size: 0.9rem;
    font-weight: 650;
    color: var(--text);
    margin: 0 0 0.35rem;
  }

  .wechat-block p {
    color: var(--text-secondary);
    font-size: 0.8rem;
    line-height: 1.55;
    margin: 0;
  }

  .support-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: var(--surface);
    text-decoration: none;
    color: var(--text);
    transition: all 0.15s ease;
  }

  .support-row:hover {
    background: var(--hover);
    border-color: var(--border);
    transform: translateX(2px);
  }

  .support-row strong {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.2rem;
  }

  .support-row small {
    display: block;
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .open-label {
    flex-shrink: 0;
    color: var(--accent);
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
  }

  /* ── QR Lightbox Modal ──────────────────────────────────── */
  .qr-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0 0 0 / 0.5);
    backdrop-filter: blur(12px);
    animation: fadeIn 0.15s ease;
  }

  .qr-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    box-shadow: var(--shadow-lg);
    animation: popIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes popIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .qr-card img {
    display: block;
    width: 260px;
    height: 260px;
    object-fit: contain;
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
  }

  .qr-card-hint {
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-align: center;
    margin: 0;
  }

  .qr-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    width: 32px;
    height: 32px;
    border-radius: 9999px;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    font-size: 1.25rem;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition: all 0.15s ease;
  }

  .qr-close:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border);
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
