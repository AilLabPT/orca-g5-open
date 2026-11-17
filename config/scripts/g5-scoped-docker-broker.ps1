# G5 constrained Windows named-pipe Docker capability broker.
# EXPERIMENTAL: a narrowly scoped read-only proof; mutation intentionally unsupported.
# Broker must run under a dedicated account that ALREADY has Docker access.
# Never add the SSH account to Administrators or Docker daemon ACLs.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-(?:[0-9]+-)+[0-9]+$')][string]$AuthorizedSid,
  [Parameter(Mandatory)][ValidatePattern('^g5-[a-z0-9-]{8,52}$')][string]$PipeName,
  [ValidateRange(1,10)][int]$MaxRequests=1,
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
# The broker never resolves a command named 'docker' from PATH or SSH input.
# Skrog installs the daemon client at this runner-admin-controlled system location.
$dockerExe=Join-Path $env:WINDIR 'System32\docker.exe'
if(-not $UseFixture){
  if(-not(Test-Path -LiteralPath $dockerExe -PathType Leaf)){throw 'G5_BROKER_PINNED_DOCKER_EXECUTABLE_MISSING'}
  $file=Get-Item -LiteralPath $dockerExe -Force
  if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'G5_BROKER_DOCKER_REPARSE_FORBIDDEN'}
  # The Skrog context is expected to be local npipe transport, never TCP/SSH.
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
for($n=0;$n -lt $MaxRequests;$n++){
  $pipe=New-Object IO.Pipes.NamedPipeServerStream -ArgumentList @(
    $PipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$pipeSecurity
  )
  try{
    $pipe.WaitForConnection()
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
      $request=$chars.ToString()
      $script:principalSid=$null
      $pipe.RunAsClient([IO.Pipes.PipeStreamImpersonationWorker]{
        $script:principalSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      })
      $body=$null
      if($request){try{$body=$request|ConvertFrom-Json}catch{}}
      if($principalSid -cne $AuthorizedSid -or !$body -or
         @($body.PSObject.Properties).Count -ne 1 -or
         $body.PSObject.Properties.Name -notcontains 'op' -or
         $body.op -cnotin $allowedVerbs){
        $writer.WriteLine('{"ok":false,"code":"NOT_AUTHORIZED"}')
        continue
      }
      if($UseFixture){
        $reply='linux'
      }else{
        $p=$ErrorActionPreference
        try{
          $ErrorActionPreference='Continue'
          $output=& $dockerExe --context skrog info --format '{{.OSType}}' 2>&1
          $status=$LASTEXITCODE
        }finally{$ErrorActionPreference=$p}
        if($status -ne 0){throw 'DOCKER_ENGINE_UNAVAILABLE'}
        $reply=($output|Out-String).Trim()
      }
      if($reply -cne 'linux'){throw 'G5_DOCKER_NOT_LINUX'}
      $writer.WriteLine('{"ok":true,"dockerOS":"linux","authorization":"read-only-scoped-broker"}')
    }finally{$writer.Dispose();$reader.Dispose()}
  }catch{
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
