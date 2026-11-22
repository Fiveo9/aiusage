<script>
  import { t } from '$lib/i18n.js'
  import { formatCost, formatNumber, formatTokens } from '$lib/stores.js'
  export let provenance
</script>

{#if provenance}
  <section class="card provenance" aria-labelledby="cost-sources-title">
    <div class="prov-header">
      <h2 class="section-title" id="cost-sources-title">{$t('cost.sourcesTitle')}</h2>
      <div class="coverage">
        <span class="coverage-label">{$t('cost.coverage')}:</span>
        <strong class="numeric">{provenance.coverage === null ? '—' : `${(provenance.coverage * 100).toFixed(1)}%`}</strong>
        <span class="coverage-count numeric">({formatNumber(provenance.knownRecords)} / {formatNumber(provenance.totalRecords)} {$t('cost.records')})</span>
      </div>
    </div>

    <p class="explanation">{$t('cost.coverageHint')}</p>

    <div class="source-list">
      {#each ['log', 'pricing', 'unknown'] as source}
        <div class="source-row">
          <span class="source-name">{$t(`cost.source.${source}`)}</span>
          <span class="mono source-records">{formatNumber(provenance.sources[source].records)} {$t('cost.records')}</span>
          <span class="mono source-cost">{source === 'unknown' ? $t('cost.unpriced') : formatCost(provenance.sources[source].cost)}</span>
        </div>
      {/each}
    </div>

    <p class="explanation">{$t('cost.sourcesHint')}</p>

    {#if provenance.sources.unknown.records > 0}
      <div class="unpriced-notice" role="status">
        <div class="unpriced-head">
          <h3>{$t('cost.unpricedTitle')} · {formatNumber(provenance.unpricedModels.length)}</h3>
          <a href="/pricing">{$t('cost.managePricing')} →</a>
        </div>
        <p>{$t('cost.unpricedHint')}</p>
      </div>
      <!-- Keyboard focus lets users scroll the model table at narrow widths. -->
      <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
      <div class="model-list" role="region" aria-label={$t('cost.unpricedTitle')} tabindex="0">
        <table>
          <thead><tr><th>{$t('cost.model')}</th><th>{$t('cost.records')}</th><th>Token</th></tr></thead>
          <tbody>
            {#each provenance.unpricedModels as row}
              <tr>
                <td class="model mono">{row.model || $t('cost.unknownModel')}</td>
                <td class="mono">{formatNumber(row.records)}</td>
                <td class="mono">{formatTokens(row.tokens)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<style>
  .provenance {
    margin-bottom: 0;
  }

  .prov-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-bottom: 0.375rem;
  }

  .prov-header .section-title {
    margin-bottom: 0;
  }

  .coverage {
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .coverage strong {
    color: var(--text);
    font-weight: 650;
  }

  .coverage-count {
    color: var(--text-muted);
  }

  .explanation {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .source-list {
    margin: 0.75rem 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .source-row {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) auto auto;
    gap: 1rem;
    padding: 0.55rem 0.85rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--text-xs);
    align-items: center;
  }

  .source-row:last-child {
    border-bottom: none;
  }

  .source-name {
    color: var(--text);
    font-weight: 500;
  }

  .source-records {
    color: var(--text-secondary);
  }

  .source-cost {
    min-width: 6rem;
    text-align: right;
    font-weight: 600;
    color: var(--text);
  }

  .unpriced-notice {
    margin-top: 1rem;
    padding: 0.85rem 1rem;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--amber);
    border-radius: var(--radius-sm);
  }

  .unpriced-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
  }

  .unpriced-notice h3 {
    font-size: var(--text-sm);
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }

  .unpriced-notice p {
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-secondary);
    margin: 0;
  }

  .unpriced-notice a {
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }

  .unpriced-notice a:hover {
    text-decoration: underline;
  }

  .model-list {
    overflow: auto;
    max-height: 18rem;
    margin-top: 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-xs);
  }

  th {
    background: var(--raised);
  }

  th, td {
    padding: 0.5rem 0.8rem;
    text-align: right;
    border-bottom: 1px solid var(--border-subtle);
  }

  tr:last-child td {
    border-bottom: none;
  }

  th:first-child, td:first-child {
    text-align: left;
  }

  .model {
    overflow-wrap: anywhere;
    min-width: 10rem;
    color: var(--text);
    font-weight: 500;
  }

  @media (max-width: 500px) {
    .source-row {
      gap: 0.5rem;
    }
  }
</style>
