<script>
  import { modelDisplayMode } from '../stores.js'
  import { t } from '../i18n.js'
</script>

<div class="model-display-selector">
  <label>
    <span>{$t('models.displayMode')}</span>
    <select bind:value={$modelDisplayMode}>
      <option value="full">{$t('models.keepPrefixes')}</option>
      <option value="merged">{$t('models.mergePrefixes')}</option>
    </select>
  </label>
  <span class="display-hint">{$t('models.displayModeHint')}</span>
</div>

<style>
  .model-display-selector {
    display: flex;
    align-items: center;
    gap: 0.5rem 0.75rem;
    flex-wrap: wrap;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }
  select {
    min-height: var(--control-height);
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .display-hint {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
