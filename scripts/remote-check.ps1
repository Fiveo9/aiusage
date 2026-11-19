[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('test', 'build', 'install')][string]$Task,
    [Parameter(Mandatory)][ValidateSet('linux', 'android14')][string]$Target,
    [ValidateSet('review', 'full', 'linux-resources')][string]$Scope = 'review',
    [string]$Machine,
    [string]$CliPath,
    [string]$ResumeRunId,
    [string]$ReuseRunId,
    [switch]$ResumeMachine,
    [ValidateRange(1, 120)][int]$TimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\', '/') -ne $workspace.TrimEnd('\', '/')) {
    throw 'Run remote-check.ps1 from the repository root.'
}
$stamp = (Get-Date).ToUniversalTime()
$runId = if ($ResumeRunId) { $ResumeRunId } else { $stamp.ToString('yyyyMMdd') + 'T' + $stamp.ToString('HHmmss') + 'Z-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
if ($runId -notmatch '^\d{8}T\d{6}Z-[a-f0-9]{8}$') { throw 'Invalid run ID.' }
$runDir = Join-Path $workspace ".artifacts/remote-check/$runId"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$summaryPath = Join-Path $runDir 'summary.json'
$summary = [ordered]@{ runId = $runId; task = $Task; target = $Target; scope = $Scope; status = 'starting'; category = $null; exitCode = $null; machineId = $null; jobId = $null; evidence = $runDir }
if ($ResumeRunId) {
    if (-not (Test-Path -LiteralPath $summaryPath)) { throw 'Resume summary not found.' }
    $previous = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -AsHashtable
    if ($previous.task -ne $Task -or $previous.target -ne $Target -or $previous.scope -ne $Scope -or -not $previous.jobId) { throw 'Resume arguments must match a submitted run.' }
    $summary = $previous
    if ($Machine -and $Machine -ne $previous.machineId) { throw 'Resume must use the recorded machine ID.' }
    $Machine = $previous.machineId
}
function Save-Summary { $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding utf8NoBOM }
function Invoke-Instabox([string[]]$Arguments, [int]$Seconds = 60) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:cli
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['INSTABOX_NO_UPDATE_CHECK'] = '1'
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($Seconds * 1000)) {
        $process.Kill($true)
        throw 'Instabox transport timed out. A previously started remote job may still be running; use -ResumeRunId.'
    }
    $text = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    $code = $process.ExitCode
    $process.Dispose()
    $data = try { $text | ConvertFrom-Json -AsHashtable } catch { $null }
    return @{ code = $code; data = $data }
}
function Assert-Transport($result, [string]$operation) {
    if ($null -eq $result.data -or $result.data.ContainsKey('error')) {
        $errorCode = if ($result.data -is [System.Collections.IDictionary] -and $result.data['error']) { [string]$result.data['error']['code'] } else { "exit-$($result.code)" }
        throw "Instabox $operation failed ($errorCode). Check authentication/network; no platform fallback was attempted."
    }
}

try {
    if ($Target -ne 'linux' -or $Task -eq 'install') { throw 'This repository has no Android APK target. Only -Target linux with -Task test/build is supported.' }
    $cli = if ($CliPath) { [IO.Path]::GetFullPath($CliPath) } else {
        $command = Get-Command instabox.exe -ErrorAction SilentlyContinue
        if ($command) { $command.Source } else { Join-Path $workspace '.artifacts/tools/instabox/0.8.309/package/cli/instabox-windows-amd64.exe' }
    }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw 'Instabox CLI missing. Install the official CLI or pass -CliPath; credentials are read only by the CLI from INSTABOX_API_KEY or its existing session.'
    }
    $summary.category = 'remote-connection'
    $listed = Invoke-Instabox @('ls', '--json')
    if ($listed.code -ne 0) { Assert-Transport $listed 'list'; throw "Instabox list failed (exit $($listed.code))." }
    $machines = if ($listed.data -is [array]) { $listed.data } elseif ($listed.data.ContainsKey('machines')) { $listed.data.machines } elseif ($listed.data.ContainsKey('items')) { $listed.data.items } else { @($listed.data) }
    $safeMachines = @($machines | ForEach-Object { [pscustomobject]@{ id = $_['id']; name = $_['name']; status = if ($_['status']) { $_['status'] } else { $_['state'] } } })
    $safeMachines | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDir 'machines.json') -Encoding utf8NoBOM
    if (-not $Machine) {
        $candidates = @($safeMachines | Where-Object { $_.name -match '(^|[-_])(linux|dev|build)([-_]|$)' -and $_.name -notmatch 'android|andorid' })
        if ($candidates.Count -ne 1) {
            $summary.status = 'machine-selection-required'
            $summary.category = 'configuration'
            $summary.exitCode = 2
            Save-Summary
            $safeMachines | Format-Table id, name, status
            throw 'Pass -Machine with one of the existing Linux instances; no machine was created or changed.'
        }
        $Machine = $candidates[0].id
    }
    if ($Machine -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid machine identifier.' }
    $selected = @($safeMachines | Where-Object { $_.id -eq $Machine -or $_.name -eq $Machine })
    if ($selected.Count -ne 1) { throw 'The specified machine is not in the accessible instance list.' }
    $summary.machineId = $selected[0].id
    if ($selected[0].status -eq 'suspended') {
        if (-not $ResumeMachine) { throw 'Instance is suspended. Retry with -ResumeMachine to explicitly resume this existing instance.' }
        $resumed = Invoke-Instabox @('resume', $Machine, '--json') 90
        Assert-Transport $resumed 'resume'
        if ($resumed.code -ne 0) { throw "Instance resume failed (exit $($resumed.code))." }
    }
    $probeCommand = 'set -eu; printf "os="; uname -s; printf "arch="; uname -m; printf "workdir="; pwd; for tool in node npm pnpm python3 tar gcc make psql initdb pg_ctl; do printf "%s=" "$tool"; command -v "$tool" || true; printf "\n"; done; head -1 /proc/meminfo; df -Pk . /tmp /data; df -Pi . /tmp /data; for dir in /data/home /data/home/ubuntu /data/home/user; do if test -w "$dir"; then printf "writable=%s\n" "$dir"; fi; done'
    $probe = Invoke-Instabox @('exec', $Machine, '--timeout', '30', '--json', '--', 'bash', '-c', $probeCommand)
    Assert-Transport $probe 'probe'
    if ($probe.code -ne 0 -or $probe.data.exitCode -ne 0) { throw 'Linux resource probe failed; the instance may be offline. No fallback was attempted.' }
    if ($probe.data.stdout -notmatch '(?m)^os=Linux\r?$') { throw 'The selected target is not Linux.' }
    $probe.data | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'resources.json') -Encoding utf8NoBOM
    if ($Scope -eq 'linux-resources') {
        $summary.status = 'passed'; $summary.category = 'resource-probe'; $summary.exitCode = 0
        Save-Summary
        Write-Output $probe.data.stdout
        Write-Output "Evidence: $runDir"
        exit 0
    }
    $remoteRoot = if ($ResumeRunId) { $summary.remoteRoot } else { "/data/home/aiusage-check/$runId" }
    $remoteResults = if ($ResumeRunId -and $summary.Contains('remoteResults')) { $summary.remoteResults } else { "$remoteRoot/results" }
    if ($ReuseRunId) {
        if ($ResumeRunId -or $ReuseRunId -notmatch '^\d{8}T\d{6}Z-[a-f0-9]{8}$') { throw 'Invalid reuse arguments.' }
        $prior = Get-Content -LiteralPath (Join-Path $workspace ".artifacts/remote-check/$ReuseRunId/summary.json") -Raw | ConvertFrom-Json -AsHashtable
        if ($prior.machineId -ne $summary.machineId -or $prior.status -notin @('passed', 'failed') -or -not $prior.ContainsKey('remoteExitCode') -or $null -eq $prior.remoteExitCode) { throw 'Reuse requires a confirmed completed run on the same instance.' }
        $remoteRoot = $prior.remoteRoot
        if ($remoteRoot -notmatch '^/data/home/aiusage-check/\d{8}T\d{6}Z-[a-f0-9]{8}$') { throw 'Unsupported reuse directory.' }
        $remoteResults = "$remoteRoot/attempts/$runId"
        $summary.reusedRunId = $ReuseRunId
    }
    if (-not $ResumeRunId) {
        $summary.category = 'local-packaging'
        $packageOutput = & node (Join-Path $PSScriptRoot 'remote-check-package.mjs') $runDir
        if ($LASTEXITCODE -ne 0) { throw 'Local source packaging failed; no source was uploaded.' }
        $package = $packageOutput | ConvertFrom-Json -AsHashtable
        $summary.sourceFiles = $package.files
        $summary.sourceSha256 = $package.sha256
        $summary.remoteRoot = $remoteRoot
        $summary.remoteResults = $remoteResults
        Save-Summary
        $summary.category = 'remote-transfer'
        $prepareCommand = if ($ReuseRunId) {
            'set -eu; test -O "$1"; test ! -L "$1"; test -d "$1/source/node_modules"; available=$(df -Pk "$1" | tail -1 | tr -s " " | cut -d " " -f4); test "$available" -ge 262144 || { printf "Insufficient persistent disk space for reuse.\n" >&2; exit 72; }'
        } else {
            'set -eu; umask 077; test ! -L /data/home/aiusage-check; mkdir -p /data/home/aiusage-check; test -O /data/home/aiusage-check; available=$(df -Pk /data/home/aiusage-check | tail -1 | tr -s " " | cut -d " " -f4); test "$available" -ge 5242880 || { printf "At least 5 GiB persistent disk space is required for a fresh dependency install; reuse a completed run.\n" >&2; exit 72; }; test ! -e "$1"; mkdir "$1"'
        }
        $prepared = Invoke-Instabox @('exec', $Machine, '--json', '--', 'bash', '-c', $prepareCommand, 'prepare', $remoteRoot)
        Assert-Transport $prepared 'prepare-run'
        $prepared.data | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'prepare.json') -Encoding utf8NoBOM
        if ($prepared.code -ne 0) { throw "Remote run directory preparation failed: $($prepared.data.stderr)" }
        $archiveName = if ($ReuseRunId) { "source-$runId.tar.gz" } else { 'source.tar.gz' }
        $uploaded = Invoke-Instabox @('push', $Machine, $package.archive, "$remoteRoot/$archiveName", '--json') 180
        Assert-Transport $uploaded 'upload'
        if ($uploaded.code -ne 0) { throw "Source upload failed (exit $($uploaded.code))." }
        $bootstrap = @'
set -eu
root="$1"
expected="$2"
task="$3"
scope="$4"
archive="$5"
attempt="$6"
reuse="$7"
exec 9>"$root/run.lock"
flock -n 9 || { printf 'Another verification job is using this run directory.\n' >&2; exit 73; }
actual=$(sha256sum "$root/$archive")
actual=${actual%% *}
test "$actual" = "$expected"
if test "$reuse" = 1; then
  mkdir "$root/incoming-$attempt"
  tar -xzf "$root/$archive" -C "$root/incoming-$attempt"
  node "$root/incoming-$attempt/scripts/remote-check-reuse.mjs" "$root" "$attempt"
else
  mkdir "$root/source"
  tar -xzf "$root/$archive" -C "$root/source"
fi
mkdir -p "$root/home" "$root/tmp" "$root/results"
cd "$root/source"
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$root/home" TMPDIR="$root/tmp" AIUSAGE_CHECK_ROOT="$root" AIUSAGE_CHECK_ATTEMPT="$attempt" AIUSAGE_CHECK_REUSE="$reuse" node scripts/remote-check-linux.mjs "$task" "$scope"
'@
        $attemptId = if ($ReuseRunId) { $runId } else { '' }
        $reuseFlag = if ($ReuseRunId) { '1' } else { '0' }
        $submitted = Invoke-Instabox @('exec', '--background', $Machine, '--json', '--', 'bash', '-c', $bootstrap, 'remote-check', $remoteRoot, $package.sha256, $Task, $Scope, $archiveName, $attemptId, $reuseFlag)
        Assert-Transport $submitted 'submit'
        if ($submitted.code -ne 0 -or -not $submitted.data.jobId) { throw 'Remote job submission failed.' }
        $summary.jobId = $submitted.data.jobId
        $summary.status = 'running'; $summary.category = 'remote-execution'
        Save-Summary
        Write-Output "Submitted job $($summary.jobId) on $Machine; run $runId."
    }
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $waited = Invoke-Instabox @('jobs', 'wait', $Machine, $summary.jobId, '--timeout', '20s', '--json') 45
        if ($waited.code -ne 124) {
            Assert-Transport $waited 'wait'
            $summary.remoteExitCode = $waited.data.exitCode
            break
        }
        Write-Output "Remote job still running: $($summary.jobId)"
        if ((Get-Date) -ge $deadline) {
            $summary.status = 'running'; $summary.category = 'execution-timeout'; $summary.exitCode = 124
            Save-Summary
            Write-Output "Wait timed out; remote job retained. Resume with -Task $Task -Target $Target -Scope $Scope -ResumeRunId $runId"
            exit 124
        }
    }
    $logs = Invoke-Instabox @('jobs', 'logs', $Machine, $summary.jobId, '--json') 90
    Assert-Transport $logs 'logs'
    [string]$logs.data.output | Set-Content -LiteralPath (Join-Path $runDir 'remote.log') -Encoding utf8NoBOM
    $summary.logTruncated = [bool]$logs.data['truncated']
    $collected = Invoke-Instabox @('pull', $Machine, "$remoteResults/summary.json", (Join-Path $runDir 'remote-summary.json'), '--json') 90
    Assert-Transport $collected 'summary-download'
    if ($collected.code -ne 0) { throw 'Remote result summary missing; inspect remote.log.' }
    $remoteSummary = Get-Content -LiteralPath (Join-Path $runDir 'remote-summary.json') -Raw | ConvertFrom-Json -AsHashtable
    $summary.tests = $remoteSummary.tests
    $summary.category = $remoteSummary.category
    foreach ($entry in $remoteSummary.steps) {
        if ($entry.name -notmatch '^[a-z0-9-]+$') { throw 'Invalid remote evidence name.' }
        $download = Invoke-Instabox @('pull', $Machine, "$remoteResults/$($entry.name).log", (Join-Path $runDir "$($entry.name).log"), '--json') 90
        Assert-Transport $download 'log-download'
        if ($download.code -ne 0) { throw 'Step evidence download failed.' }
        if ($entry.name -match '-tests$') {
            $download = Invoke-Instabox @('pull', $Machine, "$remoteResults/$($entry.name).json", (Join-Path $runDir "$($entry.name).json"), '--json') 90
            Assert-Transport $download 'test-report-download'
            if ($download.code -ne 0) { throw 'Test report download failed.' }
        }
    }
    $passed = $summary.remoteExitCode -eq 0 -and $remoteSummary.exitCode -eq 0 -and $remoteSummary.status -eq 'passed'
    $summary.status = if ($passed) { 'passed' } else { 'failed' }
    $summary.exitCode = if ($passed) { 0 } else { 1 }
    if ($remoteSummary.ContainsKey('message')) { $summary.message = $remoteSummary.message }
    Save-Summary
    Write-Output "Status: $($summary.status); remote exit: $($summary.remoteExitCode); tests: $($summary.tests | ConvertTo-Json -Compress)"
    if (-not $passed) { ([string]$logs.data.output -split "`n" | Select-Object -Last 20) | Write-Output }
    Write-Output "Evidence: $runDir"
    exit $summary.exitCode
} catch {
    $summary.status = if ($summary.status -eq 'machine-selection-required') { $summary.status } elseif ($summary.jobId -and (-not $summary.Contains('remoteExitCode') -or $null -eq $summary.remoteExitCode)) { 'unknown' } else { 'failed' }
    $summary.exitCode = 1
    $summary.message = $_.Exception.Message
    Save-Summary
    Write-Error "$( $_.Exception.Message ) Evidence: $runDir" -ErrorAction Continue
    exit 1
}
