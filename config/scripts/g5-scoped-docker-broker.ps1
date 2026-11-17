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
for($n=0;$n -lt $MaxRequests;$n++){
  $pipe=New-Object IO.Pipes.NamedPipeServerStream -ArgumentList @(
    $PipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::None,4096,4096,$pipeSecurity
  )
  try{
    $pipe.WaitForConnection()
    $reader=[IO.StreamReader]::new($pipe,[Text.Encoding]::UTF8,$false,1024,$true)
    $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true)
    $writer.AutoFlush=$true
    try{
      # Windows named-pipe impersonation is only available AFTER client bytes arrive.
      # Reading an untrusted request never grants authorization or runs Docker.
      $request=$reader.ReadLine()
      $script:principalSid=$null
      $pipe.RunAsClient([IO.Pipes.PipeStreamImpersonationWorker]{
        $script:principalSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      })
      if($request -and $request.Length -gt 256){throw 'G5_BROKER_REQUEST_TOO_LONG'}
      $body=$null
      if($request){try{$body=$request|ConvertFrom-Json}catch{}}
      if($principalSid -cne $AuthorizedSid -or !$body -or
         $body.PSObject.Properties.Name.Count -ne 1 -or
         $body.PSObject.Properties.Name -notcontains 'op' -or
         $body.op -notin $allowedVerbs){
        $writer.WriteLine('{"ok":false,"code":"NOT_AUTHORIZED"}')
        continue
      }
      if($UseFixture){
        $reply='linux'
      }else{
        $p=$ErrorActionPreference
        try{
          $ErrorActionPreference='Continue'
          $output=& docker info --format '{{.OSType}}' 2>&1
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
