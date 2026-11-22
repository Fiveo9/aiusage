<script>
  import { createEventDispatcher, tick } from 'svelte'
  import { ChevronDown, Check } from 'lucide-svelte'

  export let options = []
  export let value = ''
  export let placeholder = ''
  export let disabled = false
  export let active = false
  export let icon = null
  export let ariaLabel = ''
  export let title = ''
  export let align = 'left'
  export let minWidth = '11rem'

  const dispatch = createEventDispatcher()

  let open = false
  let rootEl = null
  let triggerEl = null
  let focusIndex = -1

  $: selectedOption = options.find((o) => o.value === value)
  $: displayLabel = selectedOption ? selectedOption.label : placeholder

  function toggle() {
    if (disabled) return
    open = !open
    if (open) {
      const currentIdx = options.findIndex((o) => o.value === value)
      focusIndex = currentIdx >= 0 ? currentIdx : 0
    }
  }

  function close({ restoreFocus = false } = {}) {
    if (!open) return
    open = false
    focusIndex = -1
    if (restoreFocus) triggerEl?.focus()
  }

  function selectOption(opt) {
    value = opt.value
    dispatch('change', opt.value)
    close({ restoreFocus: true })
  }

  function handleWindowClick(e) {
    if (open && rootEl && !rootEl.contains(e.target)) {
      close()
    }
  }

  async function handleKeydown(e) {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        if (document.activeElement === triggerEl) {
          e.preventDefault()
          toggle()
          await tick()
        }
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      close({ restoreFocus: true })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (options.length > 0) focusIndex = (focusIndex + 1) % options.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length > 0) focusIndex = (focusIndex - 1 + options.length) % options.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      if (options.length > 0) focusIndex = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      if (options.length > 0) focusIndex = options.length - 1
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = options[focusIndex]
      if (target) selectOption(target)
    } else if (e.key === 'Tab') {
      close()
    }
  }
</script>

<svelte:window on:mousedown={handleWindowClick} on:keydown={handleKeydown} />

<div class="dropdown" bind:this={rootEl}>
  <button
    type="button"
    class="dropdown-trigger"
    class:open
    class:active
    bind:this={triggerEl}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel || title || placeholder}
    title={title || selectedOption?.title || displayLabel}
    on:click={toggle}
  >
    {#if icon}
      <span class="trigger-icon" aria-hidden="true">
        <svelte:component this={icon} size={13} strokeWidth={1.85} />
      </span>
    {/if}
    <span class="trigger-label">{displayLabel}</span>
    <span class="trigger-chevron" class:rotated={open} aria-hidden="true">
      <ChevronDown size={13} strokeWidth={1.85} />
    </span>
  </button>

  {#if open}
    <div
      class="dropdown-menu"
      class:align-right={align === 'right'}
      role="listbox"
      style="min-width: {minWidth};"
    >
      {#each options as opt, i (opt.value)}
        {@const isSelected = opt.value === value}
        <button
          type="button"
          role="option"
          aria-selected={isSelected}
          class="dropdown-item"
          class:selected={isSelected}
          class:focused={focusIndex === i}
          title={opt.title}
          on:mouseenter={() => { focusIndex = i }}
          on:click={() => selectOption(opt)}
        >
          <span class="item-main">
            <span class="item-label">{opt.label}</span>
            {#if opt.meta}
              <span class="item-meta numeric">{opt.meta}</span>
            {/if}
          </span>
          <span class="item-check" aria-hidden="true">
            {#if isSelected}
              <Check size={13} strokeWidth={2.2} />
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
    display: inline-flex;
    max-width: 100%;
  }

  .dropdown-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: var(--control-height);
    max-width: 100%;
    padding: 0 0.625rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.14s ease, color 0.14s ease, background-color 0.14s ease;
  }

  .dropdown-trigger:hover:not(:disabled) {
    border-color: var(--border-medium);
    color: var(--text);
    background: var(--raised);
  }

  .dropdown-trigger.open {
    border-color: var(--accent);
    color: var(--text);
  }

  .dropdown-trigger.active {
    background: var(--accent-dim);
    border-color: color-mix(in oklch, var(--accent) 45%, transparent);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .dropdown-trigger:disabled {
    opacity: 0.48;
    cursor: not-allowed;
  }

  .trigger-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .dropdown-trigger.active .trigger-icon {
    color: var(--accent);
  }

  .trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-chevron {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    flex-shrink: 0;
    margin-left: 0.1rem;
    transition: transform 0.15s ease;
  }

  .trigger-chevron.rotated {
    transform: rotate(180deg);
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    z-index: 260;
    max-width: min(320px, 88vw);
    max-height: 260px;
    overflow-y: auto;
    padding: 0.25rem;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: menuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .dropdown-menu.align-right {
    left: auto;
    right: 0;
  }

  @keyframes menuIn {
    from { opacity: 0; transform: translateY(-3px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: none;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .dropdown-item.focused,
  .dropdown-item:hover {
    background: var(--hover);
    color: var(--text);
  }

  .dropdown-item.selected {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .item-main {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    flex: 1;
  }

  .item-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-meta {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    flex-shrink: 0;
  }

  .item-check {
    width: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    flex-shrink: 0;
  }
</style>
