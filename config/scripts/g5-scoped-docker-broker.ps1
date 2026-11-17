# G5 constrained Windows named-pipe Docker capability broker.
# Without a pinned deployment configuration, only the read-only probe is available.
# Broker must run under a dedicated account that ALREADY has Docker access.
# Never add the SSH account to Administrators or Docker daemon ACLs.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-(?:[0-9]+-)+[0-9]+$')][string]$AuthorizedSid,
  [Parameter(Mandatory)][ValidatePattern('^g5-[a-z0-9-]{8,52}$')][string]$PipeName,
  [ValidateRange(1,10)][int]$MaxRequests=1,
  [string]$Container = '',
  [string]$ExpectedImageId = '',
  [string]$ExpectedContainerId = '',
  [switch]$UseFixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'G5 broker requires Windows PowerShell/Windows.'
}
$allowed=[Security.Principal.SecurityIdentifier]::new($AuthorizedSid)
$serverSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if($null -eq $serverSid){throw 'Broker service user SID absent'}
if($serverSid.Value -eq $allowed.Value){throw 'Broker and SSH client SID must be different to enforce separation'}
$pipeSecurity=[IO.Pipes.PipeSecurity]::new()
$pipeSecurity.SetAccessRuleProtection($true,$false)
$pipeSecurity.SetOwner($serverSid)
foreach($sid in @($serverSid,$allowed,[Security.Principal.SecurityIdentifier]'S-1-5-18')){
  $rule=[IO.Pipes.PipeAccessRule]::new($sid,[IO.Pipes.PipeAccessRights]::ReadWrite,[Security.AccessControl.AccessControlType]::Allow)
  $pipeSecurity.AddAccessRule($rule)
}
$serverRights=[IO.Pipes.PipeAccessRule]::new($serverSid,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
$pipeSecurity.AddAccessRule($serverRights)
# Capability verbs are fixed. No arbitrary command, Docker flags, paths, image IDs or mutation.
$allowedVerbs=@('engine-linux')
$deploymentVerbs = @()
if ($Container -or $ExpectedImageId -or $ExpectedContainerId) {
  if ($UseFixture -or $Container -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$' -or
      $ExpectedImageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or
      $ExpectedContainerId -cnotmatch '^[a-f0-9]{64}$') {
    throw 'G5_BROKER_INVALID_DEPLOYMENT_CONFIGURATION'
  }
  $deploymentVerbs = @('Status', 'Ensure', 'Recover', 'Rollback')
  $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$AuthorizedSid"
  $profile = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath).ProfileImagePath
  $profileRoot = [Environment]::ExpandEnvironmentVariables($profile)
  if ($profileRoot -notmatch '^[A-Za-z]:\\') { throw 'G5_BROKER_INVALID_SSH_PROFILE' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Container))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  $lockDir = Join-Path (Join-Path $profileRoot '.orca-remote') ('.g5-container-' + $hash.Substring(0, 24) + '.lock')
  $adapter = Join-Path $PSScriptRoot 'G5-Windows-DockerUpdater.ps1'
  if (-not (Test-Path -LiteralPath $adapter -PathType Leaf)) { throw 'G5_BROKER_ADAPTER_MISSING' }
}

# The broker never resolves a command named 'docker' from PATH or SSH input.
# Skrog installs the daemon client at this runner-admin-controlled system location.
$dockerExe=Join-Path $env:WINDIR 'System32\docker.exe'
if(-not $UseFixture){
  if(-not(Test-Path -LiteralPath $dockerExe -PathType Leaf)){throw 'G5_BROKER_PINNED_DOCKER_EXECUTABLE_MISSING'}
  $file=Get-Item -LiteralPath $dockerExe -Force
  if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'G5_BROKER_DOCKER_REPARSE_FORBIDDEN'}
  # The Skrog context is expected to be local npipe transport, never TCP/SSH.
  [Console]::WriteLine("G5_BROKER_CONTEXT_START {0:o}", [DateTime]::UtcNow)
  $beforePreference=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    $endpointOutput=& $dockerExe context inspect skrog --format '{{.Endpoints.docker.Host}}' 2>&1
    $endpointExitCode=$LASTEXITCODE
  }finally{$ErrorActionPreference=$beforePreference}
  $contextEndpoint=($endpointOutput|Out-String).Trim()
  if($endpointExitCode -ne 0 -or $contextEndpoint -cnotin @(
    'npipe:////./pipe/docker_engine','npipe:////./pipe/skrog_engine')){
    throw 'G5_BROKER_UNTRUSTED_DOCKER_CONTEXT_ENDPOINT'
  }
}
[Console]::WriteLine("G5_BROKER_CONTEXT_READY {0:o}", [DateTime]::UtcNow)
for($n=0;$n -lt $MaxRequests;$n++){
  $pipe=New-Object IO.Pipes.NamedPipeServerStream -ArgumentList @(
    $PipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$pipeSecurity
  )
  try{
    [Console]::WriteLine("G5_BROKER_PIPE_READY {0:o}", [DateTime]::UtcNow)
    $acceptTask=$pipe.WaitForConnectionAsync()
    if(-not $acceptTask.Wait(12000)){throw 'G5_BROKER_ACCEPT_TIMEOUT'}
    [Console]::WriteLine("G5_BROKER_CONNECTED {0:o}", [DateTime]::UtcNow)
    $reader=[IO.StreamReader]::new($pipe,[Text.Encoding]::UTF8,$false,1024,$true)
    $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true)
    $writer.AutoFlush=$true
    try{
      # Windows named-pipe impersonation is only available AFTER client bytes arrive.
      # Reading an untrusted request never grants authorization or runs Docker.
      $buffer=New-Object char[] 1
      $chars=[Text.StringBuilder]::new()
      $deadline=[DateTime]::UtcNow.AddSeconds(6)
      while($chars.Length -le 256){
        $remaining=[int]([Math]::Max(1,($deadline-[DateTime]::UtcNow).TotalMilliseconds))
        if($remaining -le 1){throw 'G5_BROKER_REQUEST_TIMEOUT'}
        $readTask=$reader.ReadAsync($buffer,0,1)
        if(-not $readTask.Wait($remaining)){throw 'G5_BROKER_REQUEST_TIMEOUT'}
        if($readTask.Result -ne 1){throw 'G5_BROKER_REQUEST_INCOMPLETE'}
        if($buffer[0] -eq [char]10){break}
        if($buffer[0] -ne [char]13){$null=$chars.Append($buffer[0])}
      }
      if($chars.Length -gt 256){throw 'G5_BROKER_REQUEST_TOO_LONG'}
      [Console]::WriteLine("G5_BROKER_REQUEST_READ {0:o}", [DateTime]::UtcNow)
      $request=$chars.ToString()
      $script:principalSid=$null
      $pipe.RunAsClient([IO.Pipes.PipeStreamImpersonationWorker]{
        $script:principalSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      })
      [Console]::WriteLine("G5_BROKER_IDENTITY_READ {0:o}", [DateTime]::UtcNow)
      $body=$null
      if($request){try{$body=$request|ConvertFrom-Json}catch{}}
      $properties = if ($body -is [pscustomobject]) { @($body.PSObject.Properties.Name) }
      $op = if ($properties -ccontains 'op' -and $body.op -is [string]) { $body.op }
      $isProbe = @($properties).Count -eq 1 -and $op -cin $allowedVerbs
      $hasToken = $properties -ccontains 'ownerToken' -and $body.ownerToken -is [string] -and
        $body.ownerToken -cmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      $hasExpectedId = $properties -ccontains 'containerId' -and
        $body.containerId -is [string] -and $body.containerId -ceq $ExpectedContainerId
      $isDeployment = $op -cin $deploymentVerbs -and $hasToken -and (
        ($op -ceq 'Status' -and @($properties).Count -eq 2) -or
        (@($properties).Count -eq 3 -and $hasExpectedId)
      )
      if ($principalSid -cne $AuthorizedSid -or (-not $isProbe -and -not $isDeployment)) {
        [Console]::WriteLine("G5_BROKER_NOT_AUTHORIZED {0:o}", [DateTime]::UtcNow)
        $writer.WriteLine('{"ok":false,"code":"NOT_AUTHORIZED"}')
        continue
      }
      if ($isDeployment) {
        $parameters = @{
          Action = $op
          Container = $Container
          ExpectedImageId = $ExpectedImageId
          ExpectedContainerId = $ExpectedContainerId
          CoordinationLock = $lockDir
          OwnerToken = $body.ownerToken
          BrokerClientSid = $AuthorizedSid
          BrokerDockerEndpoint = $contextEndpoint
        }
        if ($op -cne 'Status') { $parameters.Apply = $true }
        $result = @(& $adapter @parameters)
        if ($result.Count -ne 1 -or $result[0] -isnot [string] -or $result[0].Length -gt 768) {
          throw 'G5_BROKER_INVALID_ADAPTER_RECEIPT'
        }
        $receipt = $result[0] | ConvertFrom-Json -ErrorAction Stop
        $writer.WriteLine((@{ok=$true; operation=$op; receipt=$receipt} | ConvertTo-Json -Compress -Depth 5))
        continue
      }
      if($UseFixture){
        $reply='linux'
      }else{
        [Console]::WriteLine("G5_BROKER_DOCKER_START {0:o}", [DateTime]::UtcNow)
        $p=$ErrorActionPreference
        try{
          $ErrorActionPreference='Continue'
          $output=& $dockerExe -H $contextEndpoint info --format '{{.OSType}}' 2>&1
          $status=$LASTEXITCODE
        }finally{$ErrorActionPreference=$p}
        [Console]::WriteLine("G5_BROKER_DOCKER_END {0:o}", [DateTime]::UtcNow)
        if($status -ne 0){throw 'DOCKER_ENGINE_UNAVAILABLE'}
        $reply=($output|Out-String).Trim()
      }
      if($reply -cne 'linux'){throw 'G5_DOCKER_NOT_LINUX'}
      [Console]::WriteLine("G5_BROKER_REPLY_START {0:o}", [DateTime]::UtcNow)
      $writer.WriteLine('{"ok":true,"dockerOS":"linux","authorization":"read-only-scoped-broker"}')
      [Console]::WriteLine("G5_BROKER_REPLY_FLUSHED {0:o}", [DateTime]::UtcNow)
    }finally{$writer.Dispose();$reader.Dispose()}
  }catch{
    [Console]::Error.WriteLine("G5_BROKER_REQUEST_FAILED {0:o} {1}", [DateTime]::UtcNow, $_.Exception.GetType().Name)
    try{
      if($pipe.IsConnected){
        $writer2=[IO.StreamWriter]::new($pipe)
        $writer2.AutoFlush=$true
        $writer2.WriteLine('{"ok":false,"code":"BROKER_REJECTED"}')
        $writer2.Dispose()
      }
    }catch{}
    Write-Warning ('G5 broker request failed closed: '+$_.Exception.GetType().Name+': '+$_.Exception.Message)
  }finally{$pipe.Dispose()}
}
