<script>
  import { createEventDispatcher } from 'svelte'
  export let sections = []
  export let activeSection = ''
  export let expandedSections = new Set()
  export let zh = false

  const dispatch = createEventDispatcher()

  function scrollTo(id) {
    dispatch('navigate', { id })
  }

  function toggleExpand(id) {
    dispatch('toggle', { id })
  }
</script>

<nav class="toc">
  <div class="toc-head">
    <span class="toc-head-icon">§</span>
    <span class="toc-head-text">{zh ? '目录' : 'On this page'}</span>
  </div>

  <div class="toc-list">
    {#each sections as s, i}
      <div class="toc-group">
        <button
          class="toc-l1"
          class:active={activeSection === s.id || s.children?.some(c => c.id === activeSection)}
          on:click={() => { if (s.children?.length) toggleExpand(s.id); else scrollTo(s.id) }}
        >
          <span class="toc-idx">{String(i + 1).padStart(2, '0')}</span>
          <span class="toc-label">{zh ? s.zh : s.en}</span>
          {#if s.children?.length}
            <span class="toc-arrow" class:open={expandedSections.has(s.id)}>›</span>
          {/if}
        </button>

        {#if s.children?.length && expandedSections.has(s.id)}
          <div class="toc-children">
            {#each s.children as c}
              <button
                class="toc-l2"
                class:active={activeSection === c.id}
                on:click={() => scrollTo(c.id)}
              >
                <span class="toc-dot" class:active={activeSection === c.id}></span>
                {zh ? c.zh : c.en}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</nav>

<style>
  .toc {
    padding: 0 1rem 0 0;
    border-right: 1px solid var(--border-subtle);
  }

  .toc-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem 0.75rem;
    margin-bottom: 0.25rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .toc-head-icon {
    font-family: var(--mono);
    font-size: 0.8125rem;
    color: var(--accent);
    font-weight: 700;
  }

  .toc-head-text {
    font-family: var(--mono);
    font-size: 0.6875rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .toc-list {
    display: flex;
    flex-direction: column;
    padding-top: 0.5rem;
  }

  .toc-group {
    margin-bottom: 1px;
  }

  .toc-l1 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    font-family: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
    background: transparent;
    border: none;
  }

  .toc-l1:hover {
    color: var(--text);
    background: var(--hover);
  }

  .toc-l1.active {
    color: var(--text);
    font-weight: 700;
    background: var(--hover);
  }

  .toc-idx {
    font-family: var(--mono);
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    opacity: 0.5;
    min-width: 1.25rem;
    letter-spacing: 0.02em;
  }

  .toc-l1.active .toc-idx {
    color: var(--accent);
    opacity: 1;
  }

  .toc-label {
    flex: 1;
  }

  .toc-arrow {
    font-size: 0.75rem;
    color: var(--text-muted);
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
    transform: rotate(0deg);
    display: inline-block;
    flex-shrink: 0;
  }

  .toc-arrow.open {
    transform: rotate(90deg);
  }

  .toc-children {
    padding-left: 1.5rem;
    padding-right: 0.75rem;
    margin-bottom: 0.25rem;
    animation: tocFade 0.15s ease-out;
  }

  @keyframes tocFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .toc-l2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
    background: transparent;
    border: none;
  }

  .toc-l2:hover {
    color: var(--text-secondary);
    background: var(--hover);
  }

  .toc-l2.active {
    color: var(--accent);
    font-weight: 600;
  }

  .toc-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--border-medium);
    flex-shrink: 0;
    transition: background 0.15s ease, width 0.15s ease, height 0.15s ease;
  }

  .toc-dot.active {
    background: var(--accent);
    width: 6px;
    height: 6px;
  }
</style>
