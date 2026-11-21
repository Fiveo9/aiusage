<script>
  import { onMount } from 'svelte'
  import { selectedDevice, setDevice } from '../stores.js'
  import { t } from '../i18n.js'
  import DropdownSelect from './ui/DropdownSelect.svelte'
  import { Monitor } from 'lucide-svelte'

  let devices = []
  let loading = true

  onMount(async () => {
    try {
      const res = await fetch('/api/devices')
      const data = await res.json()
      devices = data.devices || []
    } catch {
      devices = []
    } finally {
      loading = false
    }
  })

  function handleChange(e) {
    setDevice(e.detail)
  }

  function formatLabel(d) {
    const parts = []
    parts.push(d.platform || 'Unknown')
    parts.push(d.displayName)
    return parts.join(' ')
  }

  function getTooltip(d) {
    const lines = [`Name: ${d.displayName}`]
    if (d.platform) lines.push(`Platform: ${d.platform}`)
    lines.push(`Records: ${d.recordCount}`)
    lines.push(`ID: ${d.deviceInstanceId}`)
    return lines.join('\n')
  }

  $: selectedInfo = devices.find((d) => d.deviceInstanceId === $selectedDevice)
  $: deviceOptions = [
    { value: '', label: $t('device.allDevices') },
    ...devices.map((d) => ({
      value: d.deviceInstanceId,
      label: formatLabel(d),
      meta: String(d.recordCount),
      title: getTooltip(d),
    })),
  ]
</script>

<div class="device-selector">
  <DropdownSelect
    options={deviceOptions}
    value={$selectedDevice}
    placeholder={$t('device.allDevices')}
    disabled={loading}
    active={Boolean($selectedDevice)}
    icon={Monitor}
    minWidth="13.5rem"
    ariaLabel={$t('device.allDevices')}
    title={selectedInfo ? getTooltip(selectedInfo) : $t('device.allDevices')}
    on:change={handleChange}
  />
</div>

<style>
  .device-selector {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
  }
</style>
