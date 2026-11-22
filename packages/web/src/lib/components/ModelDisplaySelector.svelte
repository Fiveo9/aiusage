<script>
  import { modelDisplayMode } from '../stores.js'
  import { t } from '../i18n.js'
  import { Info } from 'lucide-svelte'
</script>

<div class="model-display-selector" title={$t('models.displayModeHint')}>
  <span class="mode-caption">
    <span>{$t('models.displayMode')}</span>
    <span class="hint-icon" aria-hidden="true"><Info size={12} strokeWidth={1.8} /></span>
  </span>
  <div class="segmented" role="group" aria-label={$t('models.displayMode')}>
    <button
      type="button"
      class="segmented-btn"
      class:active={$modelDisplayMode === 'full'}
      aria-pressed={$modelDisplayMode === 'full'}
      on:click={() => { $modelDisplayMode = 'full' }}
    >
      {$t('models.keepPrefixes')}
    </button>
    <button
      type="button"
      class="segmented-btn"
      class:active={$modelDisplayMode === 'merged'}
      aria-pressed={$modelDisplayMode === 'merged'}
      on:click={() => { $modelDisplayMode = 'merged' }}
    >
      {$t('models.mergePrefixes')}
    </button>
  </div>
</div>

<style>
  .model-display-selector {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .mode-caption {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: help;
  }

  .hint-icon {
    display: inline-flex;
    align-items: center;
    opacity: 0.75;
  }
</style>
