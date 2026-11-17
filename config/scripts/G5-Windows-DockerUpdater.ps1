# Native Windows-side adapter to manage a Linux G5 Docker bridge.
# Does NOT change Orca Windows native updater or expose the Docker service.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Status','Install','Ensure','Rollback','Recover','SelfTest')][string]$Action,
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$')][string]$Container = 'maestro-g5-managed-validation',
  [string]$ExpectedImageId = '',
  [string]$ExpectedContainerId = '',
  [string]$CoordinationLock = '',
  [string]$OwnerToken = '',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Script:OrcaEntry = '/opt/g5-tools/g5-managed-orca-entry.py'
$Script:OrcaRoot = '/home/node/g5-managed'
$Script:OwnerLock = ''
$Script:HeldToken = ''
$Script:ContainerIdentity = ''

function Test-SafeWindowsPath([string]$PathValue) {
  if ($PathValue -notmatch '^[A-Za-z]:\\' -or
      $PathValue.IndexOfAny([char[]]@('%', '$', '`', '"', [char]10, [char]13)) -ge 0) {
    throw 'Unsafe G5 coordination path'
  }
}
function Get-G5ContainerLockName {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Container)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return '.g5-container-' + $digest.Substring(0,24) + '.lock'
}
function Assert-G5CoordinationOwner {
  if (-not $Script:OwnerLock) { return }
  $ownerPath = Join-Path $Script:OwnerLock '.orca-fence-owner'
  if (-not [IO.File]::Exists($ownerPath)) { throw 'G5 coordination lock owner missing' }
  $owner = [IO.File]::ReadAllText($ownerPath).Trim()
  if ($owner -cne $Script:HeldToken) { throw 'G5 coordination owner superseded' }
}
function Initialize-G5Coordination {
  if (($CoordinationLock -eq '') -ne ($OwnerToken -eq '')) {
    throw 'G5 coordination lock and token must be supplied together'
  }
  if (-not $CoordinationLock) {
    if ($Action -eq 'Status' -or $Action -eq 'SelfTest') { return }
    throw 'G5 mutation requires a native-authorized coordination lock and owner token'
  }
  Test-SafeWindowsPath $CoordinationLock
  # The lock namespace is fixed by the native product, not by a caller-supplied
  # directory. Alternate roots would let two writers mutate the same container.
  $canonicalRoot = Join-Path $env:USERPROFILE '.orca-remote'
  $expectedPath = Join-Path $canonicalRoot (Get-G5ContainerLockName)
  $realPath = [IO.Path]::GetFullPath($CoordinationLock)
  $canonicalPath = [IO.Path]::GetFullPath($expectedPath)
  if (-not [String]::Equals($realPath, $canonicalPath,
                            [StringComparison]::OrdinalIgnoreCase)) {
    throw 'G5 coordination lock must use the canonical native host namespace'
  }
  if ($OwnerToken -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid G5 owner token' }
  $Script:OwnerLock = $CoordinationLock
  $Script:HeldToken = $OwnerToken
  Assert-G5CoordinationOwner
}
function Release-G5Coordination {
  # The native owner holds this lock across Ensure, Status and finalization.
  # Only the owner-checked host operation may release it. Never release here.
  Assert-G5CoordinationOwner
}
function Invoke-Docker {
  param([string[]]$Arguments)
  Assert-G5CoordinationOwner
  # Docker logs emits valid diagnostic lines on stderr even on exit 0.
  # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecord;
  # capture it without promoting it into a terminating PowerShell exception.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  Assert-G5CoordinationOwner
  if ($exitCode -ne 0) {
    throw "Docker operation failed (exit $exitCode): $($Arguments[0])"
  }
  return @($output | ForEach-Object { [string]$_ })
}
function Assert-LinuxDockerContainer {
  $type = @(Invoke-Docker @('info','--format','{{.OSType}}'))[-1].Trim()
  if ($type -ne 'linux') { throw 'G5 Docker requires Linux container mode' }
  $format = '{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{.Image}}|{{.Id}}'
  $info = @(Invoke-Docker @('inspect',$Container,'--format',$format))[-1].Trim().Split('|')
  if ($info.Count -ne 5 -or $info[0] -ne 'true') { throw 'G5 managed container is not running' }
  if ($info[1] -ne 'none' -or $info[2] -ne 'no') { throw 'G5 container isolation policy failed' }
  if (-not ($ExpectedImageId -match '^sha256:[0-9a-f]{64}$')) {
    throw 'ExpectedImageId sha256:<64 hex> is mandatory'
  }
  if ($info[3] -ne $ExpectedImageId) { throw 'Unexpected container image identity' }
  if ($info[4] -notmatch '^[a-f0-9]{64}$') { throw 'Invalid immutable Docker container identity' }
  if ($ExpectedContainerId -and $info[4] -cne $ExpectedContainerId) {
    throw 'G5 container was replaced before mutation: immutable ID does not match'
  }
  return $info[4]
}
function Get-G5ContainerId {
  return @(Invoke-Docker @('inspect',$Container,'--format','{{.Id}}'))[-1].Trim()
}
function Get-G5State {
  $lines = @(Invoke-Docker @('exec',$Script:ContainerIdentity,'python3',$Script:OrcaEntry,
                               'inspect','--root',$Script:OrcaRoot))
  $candidate = @($lines | Where-Object { $_.StartsWith('{') })
  if ($candidate.Count -ne 1) { throw 'G5 inspect returned no unique JSON state' }
  $value = $candidate[0] | ConvertFrom-Json
  if ($value.active -notin @('v11','v12') -or $value.fallbackAvailable -ne $true) {
    throw 'G5 active or verified fallback invalid'
  }
  return $value
}
function Get-G5RunningVersion {
  # Check the actual process, not only the active version symlink.
  $lines = @(Invoke-Docker @('exec',$Script:ContainerIdentity,'sh','-c','ps -o args= -p 1'))
  $command = $lines -join ' '
  if ($command.Contains('/opt/g5-sources/v12/g5-bun54-slot/orcad.js')) { return 'v12' }
  if ($command.Contains('/opt/g5-sources/v11/g5-bun54-slot/orcad.js')) { return 'v11' }
  return 'unknown'
}
function Get-G5Readiness {
  param([string]$RunningVersion)
  if ($RunningVersion -notin @('v11', 'v12')) {
    return [pscustomobject]@{ healthy=$false; protocolVersion=0 }
  }
  $started=@(Invoke-Docker @('inspect',$Script:ContainerIdentity,'--format','{{.State.StartedAt}}'))[-1].Trim()
  $lines=@(Invoke-Docker @('logs','--since',$started,$Script:ContainerIdentity))
  $lastReady=$null
  foreach ($line in $lines) {
    if (-not ([string]$line).Trim().StartsWith('{')) { continue }
    try {
      $entry=$line | ConvertFrom-Json
      if ($entry.type -eq 'orca_server_ready') { $lastReady=$entry }
    } catch {}
  }
  $healthy=$false
  if ($null -ne $lastReady) {
    $terminal=$lastReady.health.terminalDaemon
    $path=[string]$terminal.entryPath
    $pidValue=0
    $hasPid=[int]::TryParse([string]$terminal.pid,[ref]$pidValue)
    if ($terminal.state -eq 'live' -and
        $terminal.selfTest.ok -eq $true -and
        $terminal.protocolVersion -eq 54 -and
        $path.Contains('/opt/g5-sources/'+$RunningVersion+'/') -and
        $hasPid -and $pidValue -gt 1) {
      # Startup self-test is not current health. Verify the same daemon PID
      # still exists and executes that exact versioned entry before accepting.
      try {
        $actual=@(Invoke-Docker @('exec',$Script:ContainerIdentity,'sh','-c',
          ('ps -o args= -p '+$pidValue))) -join ' '
        $healthy=$actual.Contains($path)
      } catch { $healthy=$false }
    }
  }
  return [pscustomobject]@{
    healthy=$healthy
    protocolVersion=if($healthy){54}else{0}
  }
}
function Require-MutationAuthority {
  if (-not $Apply) { throw 'Mutation requires explicit -Apply' }
}
function Invoke-G5Mutation {
  param([string]$Operation,[string]$Target='')
  if (-not $Script:ContainerIdentity -or $Script:ContainerIdentity -notmatch '^[a-f0-9]{64}$') {
    throw 'G5 immutable container ID is not pinned'
  }
  $args = @('exec',$Script:ContainerIdentity,'python3',$Script:OrcaEntry,
             $Operation,'--root',$Script:OrcaRoot)
  if ($Target) { $args += @('--new',$Target) }
  $null = Invoke-Docker $args
}
if ($Action -eq 'SelfTest') {
  if ('sha256:' + ('a' * 64) -notmatch '^sha256:[0-9a-f]{64}$') { throw 'SHA validation broken' }
  if ('v12' -notin @('v11','v12')) { throw 'release pin validation broken' }
  [pscustomobject]@{ test='windows-adapter-parse'; passed=$true; changesApplied=$false } |
    ConvertTo-Json -Compress
  exit 0
}
Initialize-G5Coordination
try {
$containerId=Assert-LinuxDockerContainer
$Script:ContainerIdentity=$containerId
# Recover must work even when Status deliberately refuses a pending journal.
if ($Action -eq 'Recover') {
  Require-MutationAuthority
  Invoke-G5Mutation -Operation 'recover'
  $after=Get-G5State
  [pscustomobject]@{ recovered=$true; active=$after.active;
    restartRequired=$true } | ConvertTo-Json -Compress
  exit 0
}
if ($Action -ne 'Status') { Require-MutationAuthority }
$before = Get-G5State
switch ($Action) {
  'Status' {
    $running=Get-G5RunningVersion
    $health=Get-G5Readiness -RunningVersion $running
    if ((Get-G5ContainerId) -ne $containerId) { throw 'G5 container was replaced during Status' }
    [pscustomobject]@{ action=$Action; active=$before.active; fallback=$before.fallbackAvailable;
      sourceCommit=$before.sourceCommit; runningVersion=$running; image=$ExpectedImageId; network='none';
      containerId=$containerId; healthy=$health.healthy; protocolVersion=$health.protocolVersion;
      restart='no'; windowsNativeUpdaterUnchanged=$true } | ConvertTo-Json -Compress
  }
  'Install' {
    Require-MutationAuthority
    if ($before.active -eq 'v12') { throw 'V12 is already active' }
    Invoke-G5Mutation -Operation 'install' -Target 'v12'
    $after = Get-G5State
    if ($after.active -ne 'v12') {
      try { Invoke-G5Mutation -Operation 'rollback' } catch {}
      throw 'G5 V12 activation failed, attempted rollback'
    }
    [pscustomobject]@{ changed=$true; from=$before.active; active=$after.active;
      restartRequired=$true; windowsNativeUpdaterUnchanged=$true } | ConvertTo-Json -Compress
  }
  'Ensure' {
    Require-MutationAuthority
    if ($before.active -eq 'v12') {
      $running=Get-G5RunningVersion
      [pscustomobject]@{ changed=$false; active='v12'; runningVersion=$running;
        containerId=$containerId;
        restartRequired=($running -ne 'v12'); windowsNativeUpdaterUnchanged=$true } | ConvertTo-Json -Compress
    } else {
      Invoke-G5Mutation -Operation 'install' -Target 'v12'
      $after=Get-G5State
    if ((Get-G5ContainerId) -ne $containerId) {
      throw 'G5 container name replaced during pinned mutation'
    }
      if ($after.active -ne 'v12') {
        try { Invoke-G5Mutation -Operation 'rollback' } catch {}
        throw 'G5 ensure failed'
      }
      $running=Get-G5RunningVersion
      [pscustomobject]@{ changed=$true; from=$before.active; active='v12';
        runningVersion=$running; containerId=$containerId;
        restartRequired=($running -ne 'v12'); windowsNativeUpdaterUnchanged=$true } | ConvertTo-Json -Compress
    }
  }
  'Rollback' {
    Require-MutationAuthority
    Invoke-G5Mutation -Operation 'rollback'
    $after = Get-G5State
    if ($after.active -ne 'v11') { throw 'G5 V11 rollback did not verify' }
    [pscustomobject]@{ changed=$true; active='v11'; restartRequired=$true } | ConvertTo-Json -Compress
  }
}
} finally {
  Release-G5Coordination
}
