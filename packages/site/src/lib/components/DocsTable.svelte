<script>
  export let headers = []
  export let rows = []
</script>

<div class="dt-wrap">
  <table class="dt">
    <thead>
      <tr>
        {#each headers as h}
          <th>{h}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row}
        <tr>
          {#each row as cell, i}
            <td class:first={i === 0}>{@html cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .dt-wrap {
    overflow-x: auto;
    margin: 0.75rem 0;
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
  }

  .dt {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .dt th {
    font-family: var(--mono);
    font-size: 0.6875rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-align: left;
    padding: 0.65rem 0.875rem;
    border-bottom: 1px solid var(--border-medium);
    background: var(--raised);
    white-space: nowrap;
  }

  .dt td {
    padding: 0.6rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    vertical-align: top;
    line-height: 1.6;
  }

  .dt tr:last-child td {
    border-bottom: none;
  }

  .dt tr:hover td {
    background: var(--hover);
  }

  .dt td.first {
    font-family: var(--mono);
    font-size: 0.875rem;
    color: var(--text);
    white-space: nowrap;
  }

  .dt :global(code) {
    font-family: var(--mono);
    font-size: 0.8125rem;
    background: var(--raised);
    border-radius: 3px;
    padding: 0.1em 0.35em;
    color: var(--accent);
  }
</style>
