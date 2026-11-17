# Nonprivileged Windows SSH identity client for the G5 scoped broker.
# Does not grant Docker access or accept arbitrary Docker parameters.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^g5-[a-z0-9-]{8,52}$')][string]$PipeName,
  [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$ExpectedServerPid,
  [ValidateSet('engine-linux','docker-run','docker-exec','docker-socket','ensure','rollback')][string]$Operation='engine-linux',
  [ValidateRange(1000,10000)][int]$TimeoutMs=5000
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Kernel-provided server PID prevents acceptance of a same-name spoofed pipe.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class G5PipeServerIdentity {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
}
'@
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',$PipeName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::None)
try{
  $pipe.Connect($TimeoutMs)
  [uint32]$remotePid=0
  if(-not [G5PipeServerIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$remotePid) -or
     $remotePid -ne [uint32]$ExpectedServerPid){throw 'G5_BROKER_SERVER_IDENTITY_MISMATCH'}
  $read=[IO.StreamReader]::new($pipe,[Text.Encoding]::UTF8,$false,1024,$true)
  $write=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true)
  $write.AutoFlush=$true
  try{
    $write.WriteLine((@{op=$Operation}|ConvertTo-Json -Compress))
    $pending=$read.ReadLineAsync()
    if(-not $pending.Wait($TimeoutMs)){throw 'G5_BROKER_RESPONSE_DEADLINE'}
    $answer=$pending.Result
    if(!$answer -or $answer.Length -gt 1024){throw 'G5_BROKER_REPLY_INVALID'}
    $parsed=$answer|ConvertFrom-Json
    if($parsed.ok -ne $true -or $parsed.dockerOS -cne 'linux' -or
       $parsed.authorization -cne 'read-only-scoped-broker'){
      throw 'G5_BROKER_OPERATION_REJECTED'
    }
    Write-Output 'G5_SCOPED_BROKER_ENGINE_LINUX_OK'
  }finally{
    try{$write.Dispose()}catch{}
    try{$read.Dispose()}catch{}
  }
}finally{try{$pipe.Dispose()}catch{}}
