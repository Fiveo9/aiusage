<script>
  import { t } from '$lib/i18n.js'
  import { formatCost, formatNumber, formatTokens } from '$lib/stores.js'
  export let provenance
</script>

{#if provenance}
  <section class="card provenance" aria-labelledby="cost-sources-title">
    <h2 class="section-title" id="cost-sources-title">{$t('cost.sourcesTitle')}</h2>
    <p class="coverage">
      {$t('cost.coverage')}:
      <strong>{provenance.coverage === null ? '—' : `${(provenance.coverage * 100).toFixed(1)}%`}</strong>
      ({formatNumber(provenance.knownRecords)} / {formatNumber(provenance.totalRecords)} {$t('cost.records')})
    </p>
    <p class="explanation">{$t('cost.coverageHint')}</p>
    <div class="source-list">
      {#each ['log', 'pricing', 'unknown'] as source}
        <div class="source-row">
          <span>{$t(`cost.source.${source}`)}</span>
          <span class="mono">{formatNumber(provenance.sources[source].records)} {$t('cost.records')}</span>
          <span class="mono">{source === 'unknown' ? $t('cost.unpriced') : formatCost(provenance.sources[source].cost)}</span>
        </div>
      {/each}
    </div>
    <p class="explanation">{$t('cost.sourcesHint')}</p>
    {#if provenance.sources.unknown.records > 0}
      <div class="unpriced-notice" role="status">
        <h3>{$t('cost.unpricedTitle')} · {formatNumber(provenance.unpricedModels.length)}</h3>
        <p>{$t('cost.unpricedHint')}</p>
        <a href="/pricing">{$t('cost.managePricing')} →</a>
      </div>
      <!-- Keyboard focus lets users scroll the model table at narrow widths. -->
      <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
      <div class="model-list" role="region" aria-label={$t('cost.unpricedTitle')} tabindex="0">
        <table>
          <thead><tr><th>{$t('cost.model')}</th><th>{$t('cost.records')}</th><th>Token</th></tr></thead>
          <tbody>
            {#each provenance.unpricedModels as row}
              <tr><td class="model mono">{row.model || $t('cost.unknownModel')}</td><td class="mono">{formatNumber(row.records)}</td><td class="mono">{formatTokens(row.tokens)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<style>
  .provenance { margin-bottom: 1.5rem; }
  .coverage { margin: 0.5rem 0; }
  .explanation { color: var(--text-muted); font-size: 0.85rem; line-height: 1.6; }
  .source-row { display: grid; grid-template-columns: minmax(8rem, 1fr) auto auto; gap: 1rem; padding: 0.65rem 0; border-bottom: 1px solid var(--border-subtle); }
  .source-row > :last-child { min-width: 6rem; text-align: right; }
  .unpriced-notice { margin-top: 1rem; padding: 0.75rem; background: var(--surface); border-left: 3px solid var(--accent); }
  .unpriced-notice h3 { font-size: 0.95rem; margin: 0; }
  .unpriced-notice p { font-size: 0.85rem; line-height: 1.6; }
  .unpriced-notice a { color: var(--accent); }
  .model-list { overflow: auto; max-height: 20rem; margin-top: 0.75rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-subtle); }
  th:first-child, td:first-child { text-align: left; }
  .model { overflow-wrap: anywhere; min-width: 10rem; }
  @media (max-width: 500px) { .source-row { gap: 0.5rem; font-size: 0.8rem; } }
</style>
